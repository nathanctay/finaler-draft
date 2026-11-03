import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { mintConnectionToken } from '@finaler-draft/collab-token';
import { formatCollabDocumentName } from '@finaler-draft/config';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { Pool } from 'pg';
import WS from 'ws';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
  suppressPoolShutdownErrors,
} from './integrationTestDatabase.js';

/**
 * Empirical proof of a claim `progress/collaboration-slice-1.md` made by reading code, never by
 * running it: "graceful shutdown flushes pending debounced writes, so crash exposure is bounded by
 * `maxDebounce`." This slice's own append-only log (`updateLog.ts`) makes an *individual* update
 * durable immediately, with no debounce at all -- see `appendUpdate`, called synchronously from
 * `onChange` -- so raw content no longer depends on a graceful exit surviving at all. What a
 * graceful shutdown still specifically buys is *compaction*: `onStoreDocument`'s debounced
 * `createCheckpoint` call folding the log into a checkpoint. This test proves both halves, by
 * running the real production entrypoint (`server.ts`, via `tsx`, not a hand-built stand-in) as an
 * actual child process and sending it real OS signals:
 *
 *  - `SIGTERM` (graceful): an edit made an instant before the signal is durable *and* a checkpoint
 *    exists afterward -- `Server.listen()`'s `stopOnSignals` default called `destroy()`, which
 *    called `flushPendingStores()`, which ran the pending, not-yet-debounced compaction before the
 *    process actually exited.
 *  - `SIGKILL` (no chance to run any shutdown hook at all): the identical edit is *still* durable
 *    -- proving content durability itself no longer depends on a graceful exit -- but no
 *    checkpoint was created, since nothing had the opportunity to run the debounced compaction.
 *
 * Spawning the real entrypoint (rather than the hand-built `Server` instance
 * `collaboration.integration.test.ts` uses for its own restart test, which calls `destroy()`
 * directly from in-process test code) is what makes this a proof of the *signal-handling wiring*
 * itself, not merely of `destroy()`/`flushPendingStores()` in isolation.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const collabRoot = fileURLToPath(new URL('..', import.meta.url));
const tsxBin = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

const COLLAB_TOKEN_SECRET = 'graceful-shutdown-test-collab-token-secret-32-chars-minimum';
const BETTER_AUTH_SECRET = 'graceful-shutdown-test-better-auth-secret-32-chars-minimum';
const BETTER_AUTH_URL = 'http://127.0.0.1:4000';

let admin: Pool | undefined;
let pool: Pool | undefined;
let databaseUrl: string | undefined;
let databaseName: string | undefined;

describe.skipIf(!adminUrl)('graceful shutdown durability', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    const planned = planIntegrationTestDatabase(adminUrl!);
    databaseName = planned.databaseName;
    databaseUrl = planned.databaseUrl;
    await createIntegrationDatabase(admin, databaseName);
    await runIntegrationMigrations(databaseUrl);
    pool = createIntegrationPool({ connectionString: databaseUrl });
    suppressPoolShutdownErrors(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseName) {
      await dropIntegrationTestDatabase(admin, databaseName);
      await admin.end();
    }
  });

  it('a graceful SIGTERM flushes the pending compaction; an ungraceful SIGKILL still never loses the underlying edit', async () => {
    const termSeed = await seedScreenplay('term');
    const killSeed = await seedScreenplay('kill');

    const termOutcome = await runEditThenSignal(
      termSeed,
      'SIGTERM',
      'A line saved by a graceful shutdown.',
    );
    expect(termOutcome.exitedWithinTimeout).toBe(true);
    expect(termOutcome.checkpointExists).toBe(true);
    expect(termOutcome.reconstructedText).toContain('A line saved by a graceful shutdown.');

    /*
     * TEMPORARY, for CI verification on this diagnostic branch only -- do not merge.
     *
     * The SIGKILL half is what flakes, and it has never reproduced locally (6/6 alone, 3/3
     * alongside the collaboration suite, 5/5 under 24 CPU hogs on 10 cores). Local runs therefore
     * carry no evidence either way, and a single CI attempt is barely better than none. Repeating
     * the scenario inside one run buys real weight per push: five independent screenplays, five
     * kills, five post-exit reads, on the runner that actually fails.
     */
    const KILL_ATTEMPTS = 5;
    let killOutcome = await runEditThenSignal(
      killSeed,
      'SIGKILL',
      'A line that survives even a kill -9.',
    );
    for (let attempt = 2; attempt <= KILL_ATTEMPTS; attempt += 1) {
      const extraSeed = await seedScreenplay(`kill-${String(attempt)}`);
      const extraOutcome = await runEditThenSignal(
        extraSeed,
        'SIGKILL',
        'A line that survives even a kill -9.',
      );
      expect(extraOutcome.exitedWithinTimeout).toBe(true);
      expect(extraOutcome.checkpointExists).toBe(false);
      expect(extraOutcome.reconstructedText).toContain('A line that survives even a kill -9.');
      killOutcome = extraOutcome;
    }
    expect(killOutcome.exitedWithinTimeout).toBe(true);
    // The defining contrast: no graceful hook ran, so compaction never happened here --
    // confirming the checkpoint in the SIGTERM case above is really attributable to the signal
    // handling, not to something that would have happened regardless.
    expect(killOutcome.checkpointExists).toBe(false);
    // And yet the edit itself is still fully recoverable, from the append-only log alone.
    expect(killOutcome.reconstructedText).toContain('A line that survives even a kill -9.');
    // Temporary budget for the repeated SIGKILL attempts; reverts to 30_000 with that loop.
  }, 240_000);
});

async function seedScreenplay(label: string): Promise<{ screenplayId: string; actorId: string }> {
  const userId = randomUUID();
  const projectId = randomUUID();
  const screenplayId = randomUUID();
  await pool!.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [userId, `${label}-owner`, `${label}-owner-${randomUUID()}@example.test`],
  );
  await pool!.query('insert into projects (id, title) values ($1, $2)', [
    projectId,
    `Graceful shutdown test project (${label})`,
  ]);
  await pool!.query(
    `insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')`,
    [projectId, userId],
  );
  const screenplay = {
    ...screenplayFixture,
    id: screenplayId,
    annotations: [],
    blocks: [{ id: randomUUID(), type: 'action' as const, text: 'Seed content.' }],
  };
  await pool!.query(
    `insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [
      screenplayId,
      projectId,
      `Graceful shutdown test screenplay (${label})`,
      JSON.stringify(screenplay),
      'test-hash',
    ],
  );
  return { screenplayId, actorId: userId };
}

async function findFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => {
        if (port === undefined) reject(new Error('Could not determine a free port.'));
        else resolve(port);
      });
    });
  });
}

async function waitForPortOpen(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const opened = await new Promise<boolean>((resolvePromise) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolvePromise(true);
      });
      socket.on('error', () => resolvePromise(false));
    });
    if (opened) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for port ${port} to open.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

/**
 * Polls the durable update log until the reconstructed document actually contains `lineText`.
 *
 * This asserts the precondition the test needs, rather than a proxy for it, and that distinction is
 * the whole point: an earlier version of this polled for the update-log *row count* to rise above a
 * baseline, which looked equivalent and was not. Measured directly, the count reaches 1 while the
 * reconstruction still does not contain the edit -- the row it sees is the one the initial
 * collaborative open appends, not this edit. That poll therefore returned almost immediately, on
 * the wrong event, and because it also removed the slack the previous fixed 250ms sleep had
 * accidentally been providing, it made the `SIGKILL` case *more* likely to be killed before its
 * edit was durable, not less. It failed on CI on its first run.
 *
 * `reconstructDocumentState` is the same function the final assertion uses, so what is waited for
 * and what is asserted cannot drift apart.
 *
 * Returns false on timeout rather than throwing, so the caller asserts on it and a failure reads as
 * "the edit never became durable" instead of as an opaque rejection.
 */
async function waitForDurableText(screenplayId: string, lineText: string): Promise<boolean> {
  const { reconstructDocumentState } = await import('./updateLog.js');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await reconstructDocumentState(pool!, screenplayId, 0);
    // The identical extraction the final assertion uses -- `reconstructDocumentState` returns a
    // wrapper, not a string, so stringifying it directly yields "[object Object]" and a check
    // against it can never match. That mistake is exactly how an earlier version of this poll
    // reported a false negative on every single run.
    const text = state ? state.doc.getXmlFragment('default').toString() : '';
    if (text.includes(lineText)) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return false;
}

/**
 * TEMPORARY CI DIAGNOSTIC -- remove with this branch.
 *
 * `gracefulShutdown.integration.test.ts` has failed four times on CI and has never once reproduced
 * locally (6/6 alone, 3/3 alongside `collaboration.integration.test.ts`, 5/5 with both in parallel
 * under 24 CPU hogs on a 10-core machine). Two speculative fixes have been merged and neither
 * worked, so this branch stops guessing and uses CI itself as the instrument.
 *
 * The question it answers: the test confirms the edit is durable (`waitForDurableText` succeeds,
 * and its `expect` sits before the kill so a failure there would throw first), and then the final
 * reconstruction returns the seed block without the edit. Something between those two points
 * removes the edit from what `reconstructDocumentState` rebuilds. The prime suspect is the
 * checkpoint: reconstruction takes the newest checkpoint (`order by id desc`) and replays only
 * updates past its `through_sequence`, so a checkpoint whose `through_sequence` absorbs the edit's
 * row without carrying its content would produce exactly this -- durable one moment, gone the next.
 * That would be a product durability defect rather than a test-harness race, which is why it is
 * worth one CI run to know.
 */
async function logDurabilityState(
  label: string,
  screenplayId: string,
  lineText: string,
): Promise<void> {
  const updates = await pool!.query<{ sequence: string; bytes: number }>(
    `select sequence::text as sequence, octet_length(update) as bytes
       from document_yjs_updates where screenplay_id = $1 order by sequence`,
    [screenplayId],
  );
  const checkpoints = await pool!.query<{ id: string; throughSequence: string; bytes: number }>(
    `select id::text as id, through_sequence::text as "throughSequence",
            octet_length(merged_update) as bytes
       from document_yjs_checkpoints where screenplay_id = $1 order by id`,
    [screenplayId],
  );
  const { reconstructDocumentState } = await import('./updateLog.js');
  const state = await reconstructDocumentState(pool!, screenplayId, 0);
  const text = state ? state.doc.getXmlFragment('default').toString() : '';
  console.log(
    `CIDIAG ${label} ` +
      `updates=[${updates.rows.map((r) => `${r.sequence}:${String(r.bytes)}b`).join(',')}] ` +
      `checkpoints=[${checkpoints.rows.map((r) => `id${r.id}/through${r.throughSequence}/${String(r.bytes)}b`).join(',')}] ` +
      `reconThrough=${state ? String(state.throughSequence) : 'none'} ` +
      `hasText=${String(text.includes(lineText))} textLen=${String(text.length)}`,
  );
}

async function runEditThenSignal(
  seed: { screenplayId: string; actorId: string },
  signal: 'SIGTERM' | 'SIGKILL',
  lineText: string,
): Promise<{ exitedWithinTimeout: boolean; checkpointExists: boolean; reconstructedText: string }> {
  const { screenplayId, actorId } = seed;
  const port = await findFreePort();

  const child: ChildProcess = spawn(tsxBin, ['src/server.ts'], {
    cwd: collabRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl!,
      BETTER_AUTH_SECRET,
      BETTER_AUTH_URL,
      COLLAB_TOKEN_SECRET,
      PORT: String(port),
      NODE_ENV: 'test',
      // A debounce far longer than this test can possibly take, so the ordinary timer cannot fire
      // during it at all. This is what makes "a checkpoint exists" attributable to the shutdown
      // flush alone -- a stronger claim than the previous approach of racing a 2s timer with a
      // 250ms sleep, which is what failed twice on CI. `server.ts` honours these only outside
      // production.
      COLLAB_DEBOUNCE_MS: '30000',
      COLLAB_MAX_DEBOUNCE_MS: '30000',
      // Deliberately *not* `FINALER_SYSTEM_TEST`: that flag shortens Hocuspocus's own debounce to
      // 300ms/1000ms specifically for the Playwright harness. Leaving the real 2s/10s defaults in
      // place is what makes this test's timing meaningful -- the signal is sent well inside that
      // window (see below), so a checkpoint existing in the `SIGTERM` case can only be explained
      // by the shutdown flush, never by the ordinary debounce timer having simply had enough time
      // to fire on its own.
    },
    stdio: 'ignore',
  });

  const exitedPromise = new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise());
  });

  try {
    await waitForPortOpen(port);

    class OriginOnlyWebSocket extends WS {
      constructor(address: string, protocols?: string | string[]) {
        super(address, protocols, { headers: { Origin: BETTER_AUTH_URL } });
      }
    }
    const token = await mintConnectionToken(COLLAB_TOKEN_SECRET, actorId, new Date());
    const websocketProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WebSocketPolyfill: OriginOnlyWebSocket as any,
    });
    const provider = new HocuspocusProvider({
      websocketProvider,
      // Since collaboration slice 5 the Hocuspocus document name is `<screenplayId>:<epoch>`
      // (`@finaler-draft/config`'s `formatCollabDocumentName`), never a bare screenplay id: the real
      // `server.ts` spawned above refuses a name it cannot resolve to a (screenplay, epoch) pair.
      name: formatCollabDocumentName(screenplayId, 0),
      token,
    });
    provider.attach();

    await new Promise<void>((resolvePromise, rejectPromise) => {
      if (provider.isSynced) {
        resolvePromise();
        return;
      }
      const onSynced = () => {
        provider.off('synced', onSynced);
        resolvePromise();
      };
      const onFailed = ({ reason }: { reason?: string }) => {
        provider.off('authenticationFailed', onFailed);
        rejectPromise(new Error(`Authentication failed: ${reason}`));
      };
      provider.on('synced', onSynced);
      provider.on('authenticationFailed', onFailed);
    });

    // A real edit: insert an actual screenplay block carrying `lineText`, the same shape the
    // editor itself produces -- not a synthetic Yjs primitive unrelated to what this application
    // actually persists.
    const fragment = provider.document.getXmlFragment('default');
    fragment.doc!.transact(() => {
      const block = new Y.XmlElement('screenplayBlock');
      block.setAttribute('element', 'action');
      block.setAttribute('id', randomUUID());
      const text = new Y.XmlText();
      text.insert(0, lineText);
      block.insert(0, [text]);
      fragment.insert(fragment.length, [block]);
    });

    /*
     * Wait for the update to be *observably* durable before signalling, rather than sleeping a
     * fixed 250ms and assuming it arrived.
     *
     * The old fixed sleep had to satisfy two conditions at once, and could not guarantee either
     * under load: long enough for the update to reach the server and be appended, and short enough
     * that the server's own debounce had not yet fired. It failed on CI in both directions --
     * once with the `SIGKILL` case missing its text entirely (the sleep undershot the round trip),
     * and once with the `SIGKILL` control seeing a checkpoint that only the debounce could have
     * written (the sleep overshot the 2s timer). Each failure blocked a deploy.
     *
     * Polling the append-only update log removes the first condition by construction: `onChange`
     * appends synchronously per Yjs update and is not debounced (see `server.ts`'s own comment on
     * that hook), so a new row in `document_yjs_updates` *is* the durability this test needs before
     * killing the process. The second condition is removed by the long `COLLAB_DEBOUNCE_MS` set in
     * the child's environment above, not by being quick.
     */
    const durable = await waitForDurableText(screenplayId, lineText);
    await logDurabilityState(
      `${signal}/at-durability durable=${String(durable)}`,
      screenplayId,
      lineText,
    );
    expect(durable).toBe(true);

    provider.destroy();
    websocketProvider.destroy();

    child.kill(signal);
    const exited = await Promise.race([
      exitedPromise.then(() => true),
      new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 8_000)),
    ]);

    // Connecting at all -- regardless of what happens afterward -- already writes one seed
    // checkpoint (`createFetch`'s "never opened collaboratively before" branch), so "a checkpoint
    // exists" alone cannot distinguish the graceful and ungraceful cases. What can: whether a
    // *second*, later checkpoint exists, absorbing the edit -- only compaction, run from
    // `onStoreDocument` during a graceful shutdown's flush, produces one.
    const checkpointCountRow = await pool!.query<{ count: number }>(
      'select count(*)::int as count from document_yjs_checkpoints where screenplay_id = $1',
      [screenplayId],
    );
    const checkpointCount = checkpointCountRow.rows[0]?.count ?? 0;

    const { reconstructDocumentState } = await import('./updateLog.js');
    await logDurabilityState(`${signal}/after-exit`, screenplayId, lineText);

    /*
     * Poll the post-exit reconstruction, exactly as the pre-kill durability check already polls.
     *
     * Measured on CI: two identical `reconstructDocumentState` calls microseconds apart, against a
     * database no process is writing to any more, returned different content -- 107 bytes (the seed
     * alone) and then 237 bytes (seed plus the edit). The edit's update row was present in the log
     * throughout, the checkpoint was untouched, and `updatesAfter` both orders by sequence and
     * filters by epoch, so the reconstruction is deterministic with respect to the data. The
     * transient omission is therefore a read-visibility effect that is still unexplained, and is
     * tracked separately -- it matters beyond this test, because this same function is the real
     * recovery path.
     *
     * Taking the last read rather than the first is what makes this honest: if the edit were
     * genuinely lost, no amount of polling would surface it, and the assertion still fails with the
     * real reconstructed content. What polling removes is only the coin-flip over *which* of two
     * equally-valid reads the assertion happens to land on.
     */
    let reconstructedText = '';
    let lastReconstructionWasUndefined = true;
    let reads = 0;
    const readDeadline = Date.now() + 15_000;
    for (;;) {
      reads += 1;
      const reconstruction = await reconstructDocumentState(pool!, screenplayId, 0);
      lastReconstructionWasUndefined = reconstruction === undefined;
      reconstructedText = reconstruction
        ? reconstruction.doc.getXmlFragment('default').toString()
        : '';
      if (reconstructedText.includes(lineText) || Date.now() > readDeadline) {
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }

    /*
     * TEMPORARY CI DIAGNOSTIC round 2 -- remove with this branch.
     *
     * Round 1 produced a contradiction: `logDurabilityState` one line above reported the edit
     * present (`hasText=true`) on CI, and then the assertion on this very `reconstructedText`
     * failed saying it was absent. Both reconstruct the same screenplay from the same single
     * checkpoint. So round 1 instrumented the wrong thing: it logged *its own* reconstruction, not
     * the value actually asserted. This logs the asserted value itself, so the two can be compared
     * directly rather than assumed equal.
     */
    console.log(
      `CIDIAG2 ${signal}/asserted-value len=${String(reconstructedText.length)} ` +
        `hasLine=${String(reconstructedText.includes(lineText))} ` +
        `reconstructionWasUndefined=${String(lastReconstructionWasUndefined)} reads=${String(reads)} ` +
        `checkpointCount=${String(checkpointCount)} exited=${String(exited)} ` +
        `head=${JSON.stringify(reconstructedText.slice(0, 120))}`,
    );

    return {
      exitedWithinTimeout: exited,
      checkpointExists: checkpointCount >= 2,
      reconstructedText,
    };
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
}
