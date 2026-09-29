import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { mintConnectionToken } from '@finaler-draft/collab-token';
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

    const killOutcome = await runEditThenSignal(
      killSeed,
      'SIGKILL',
      'A line that survives even a kill -9.',
    );
    expect(killOutcome.exitedWithinTimeout).toBe(true);
    // The defining contrast: no graceful hook ran, so compaction never happened here --
    // confirming the checkpoint in the SIGTERM case above is really attributable to the signal
    // handling, not to something that would have happened regardless.
    expect(killOutcome.checkpointExists).toBe(false);
    // And yet the edit itself is still fully recoverable, from the append-only log alone.
    expect(killOutcome.reconstructedText).toContain('A line that survives even a kill -9.');
  }, 30_000);
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
    const provider = new HocuspocusProvider({ websocketProvider, name: screenplayId, token });
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

    // Give the update a brief moment to actually reach the server and be applied/appended before
    // signalling -- not waiting anywhere near the 2s debounce, just enough for one WebSocket round
    // trip, confirmed generous by this suite's own repeated runs.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));

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
    const reconstruction = await reconstructDocumentState(pool!, screenplayId, 0);
    const reconstructedText = reconstruction
      ? reconstruction.doc.getXmlFragment('default').toString()
      : '';

    return {
      exitedWithinTimeout: exited,
      checkpointExists: checkpointCount >= 2,
      reconstructedText,
    };
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
}
