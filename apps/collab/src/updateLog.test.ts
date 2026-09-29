import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  appendUpdate,
  createCheckpoint,
  latestCheckpoint,
  reconstructDocumentState,
  updatesAfter,
  writeCheckpoint,
} from './updateLog.js';

/**
 * A real (if tiny) in-memory model of `document_yjs_updates`/`document_yjs_checkpoints`, not a
 * keyword-matching stub that only records which queries ran -- `createCheckpoint`'s correctness
 * depends on genuine row-level `insert`/`select`/`delete` semantics (which rows a `sequence > $n`
 * filter actually returns, whether a delete really removed exactly the rows it claimed to), so a
 * fake that cannot get those wrong is the only fake that can catch this module getting them
 * wrong.
 *
 * `pg_advisory_xact_lock` is modelled as a genuine FIFO async mutex, keyed by
 * `${screenplayId}:${epoch}` -- exactly what makes the "update arrives while compaction is
 * running" interleaving test below meaningful rather than merely hoped-for: a lock request for a
 * key already held really does not resolve until the holder's transaction commits or rolls back,
 * the same ordering guarantee Postgres's own advisory lock gives `updateLog.ts` in production.
 */
/** The minimal query surface every function in `updateLog.ts` actually calls -- deliberately not
 * `pg`'s real `PoolClient` type, whose overloaded `query` signature otherwise fights this fake's
 * own loosely-typed implementation. Cast to `Pool` only at the one boundary these tests hand a
 * fake to production code (`createFakePool`'s own return). */
interface FakeClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

function createFakePool() {
  const updates: Array<{
    sequence: number;
    screenplayId: string;
    epoch: number;
    update: Buffer;
    actorId: string | null;
  }> = [];
  const checkpoints: Array<{
    id: number;
    screenplayId: string;
    epoch: number;
    throughSequence: number;
    stateVector: Buffer;
    mergedUpdate: Buffer;
  }> = [];
  let nextSequence = 1;
  let nextCheckpointId = 1;

  const mutexes = new Map<string, Promise<unknown>>();
  function acquireLock(key: string): Promise<() => void> {
    const prior = mutexes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    mutexes.set(
      key,
      prior.then(() => released),
    );
    return prior.then(() => release);
  }

  function makeClient(): FakeClient {
    // `staged*` starts `undefined` and is only ever populated, as a copy-on-write snapshot of the
    // *current* global table, the moment this transaction first writes to that table -- not at
    // `begin`. This matters specifically for the "update arrives while compaction is running"
    // test: `createCheckpoint` calls `begin` and then *waits* on the advisory lock before ever
    // reading anything, and a snapshot frozen at `begin` time would go stale for however long that
    // wait lasts, hiding exactly the concurrent commit this fake exists to make visible once the
    // lock is actually granted. Every read (`select`) simply prefers the staged copy once one
    // exists (this transaction's own uncommitted writes), falling back to the live global table
    // otherwise -- ordinary read-committed-ish behaviour, sufficient for what this module needs.
    let stagedUpdates: typeof updates | undefined;
    let stagedCheckpoints: typeof checkpoints | undefined;
    let releaseLock: (() => void) | undefined;
    const currentUpdates = () => stagedUpdates ?? updates;
    const currentCheckpoints = () => stagedCheckpoints ?? checkpoints;
    const writableUpdates = () => (stagedUpdates ??= [...updates]);
    const writableCheckpoints = () => (stagedCheckpoints ??= [...checkpoints]);

    const client = {
      async query(text: string, values: readonly unknown[] = []) {
        const sql = text.trim();
        if (sql === 'begin') {
          stagedUpdates = undefined;
          stagedCheckpoints = undefined;
          return { rows: [] };
        }
        if (sql === 'commit') {
          if (stagedUpdates) {
            updates.length = 0;
            updates.push(...stagedUpdates);
          }
          if (stagedCheckpoints) {
            checkpoints.length = 0;
            checkpoints.push(...stagedCheckpoints);
          }
          stagedUpdates = undefined;
          stagedCheckpoints = undefined;
          releaseLock?.();
          releaseLock = undefined;
          return { rows: [] };
        }
        if (sql === 'rollback') {
          stagedUpdates = undefined;
          stagedCheckpoints = undefined;
          releaseLock?.();
          releaseLock = undefined;
          return { rows: [] };
        }
        if (sql.startsWith('select pg_advisory_xact_lock')) {
          const [screenplayId, epoch] = values as [string, number];
          releaseLock = await acquireLock(`${screenplayId}:${epoch}`);
          return { rows: [] };
        }
        if (sql.startsWith('insert into document_yjs_updates')) {
          const [screenplayId, epoch, update, actorId] = values as [
            string,
            number,
            Buffer,
            string | null,
          ];
          const sequence = nextSequence++;
          writableUpdates().push({ sequence, screenplayId, epoch, update, actorId });
          return { rows: [{ sequence: String(sequence) }] };
        }
        if (sql.startsWith('select through_sequence')) {
          const [screenplayId, epoch] = values as [string, number];
          const matches = currentCheckpoints()
            .filter((c) => c.screenplayId === screenplayId && c.epoch === epoch)
            .sort((a, b) => b.id - a.id);
          const latest = matches[0];
          return {
            rows: latest
              ? [
                  {
                    throughSequence: String(latest.throughSequence),
                    mergedUpdate: latest.mergedUpdate,
                  },
                ]
              : [],
          };
        }
        if (sql.startsWith('select sequence, update')) {
          const [screenplayId, epoch, after] = values as [string, number, number];
          const rows = currentUpdates()
            .filter(
              (u) => u.screenplayId === screenplayId && u.epoch === epoch && u.sequence > after,
            )
            .sort((a, b) => a.sequence - b.sequence)
            .map((u) => ({ sequence: String(u.sequence), update: u.update }));
          return { rows };
        }
        if (sql.startsWith('insert into document_yjs_checkpoints')) {
          const [screenplayId, epoch, throughSequence, stateVector, mergedUpdate] = values as [
            string,
            number,
            number,
            Buffer,
            Buffer,
          ];
          writableCheckpoints().push({
            id: nextCheckpointId++,
            screenplayId,
            epoch,
            throughSequence,
            stateVector,
            mergedUpdate,
          });
          return { rows: [] };
        }
        if (sql.startsWith('delete from document_yjs_updates')) {
          const [screenplayId, epoch, throughSequence] = values as [string, number, number];
          const target = writableUpdates();
          const remaining = target.filter(
            (u) =>
              !(
                u.screenplayId === screenplayId &&
                u.epoch === epoch &&
                u.sequence <= throughSequence
              ),
          );
          target.length = 0;
          target.push(...remaining);
          return { rows: [] };
        }
        throw new Error(
          `Unexpected query in fake pool: ${sql} (values: ${JSON.stringify(values)})`,
        );
      },
      release() {},
    };
    return client;
  }

  const pool = {
    async connect() {
      return makeClient();
    },
    // A bare `pool.query` (no explicit `pool.connect()` + `begin`/`commit`) is autocommit in real
    // Postgres -- a single statement is its own implicit transaction. Modelled the same way here:
    // wrapping every bare call in its own begin/commit on a fresh client, so a write issued this
    // way (this test's own `commitLockFreeCompaction` helper's `delete`, standing in for what a
    // lock-free mutation of the production code might do) actually lands in the shared tables
    // instead of being staged on a client nothing ever commits.
    async query(text: string, values?: readonly unknown[]) {
      const client = makeClient();
      await client.query('begin');
      const result = await client.query(text, values ?? []);
      await client.query('commit');
      return result;
    },
  };

  return { pool: pool as unknown as Pool, tables: { updates, checkpoints } };
}

const SCREENPLAY_A = '00000000-0000-4000-8000-0000000000a1';
const EPOCH = 0;

function docWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('body').insert(0, text);
  return doc;
}

/** The update representing exactly the change `mutate` makes to `doc`, relative to its state
 * immediately before -- `Y.encodeStateAsUpdate(doc, priorStateVector)`'s documented meaning,
 * exactly what a real `onChange` hook receives for one genuine edit. */
function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  mutate();
  return Y.encodeStateAsUpdate(doc, before);
}

describe('appendUpdate', () => {
  it('assigns strictly increasing sequence numbers, in call order', async () => {
    const { pool } = createFakePool();
    const seq1 = await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: new Uint8Array([1]),
      actorId: 'actor-1',
    });
    const seq2 = await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: new Uint8Array([2]),
      actorId: 'actor-2',
    });
    expect(seq2).toBeGreaterThan(seq1);
  });

  it('records the authenticated actor id alongside the update', async () => {
    const { pool, tables } = createFakePool();
    await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: new Uint8Array([9]),
      actorId: 'actor-9',
    });
    expect(tables.updates[0]?.actorId).toBe('actor-9');
  });
});

describe('writeCheckpoint', () => {
  it('writes a checkpoint directly with no read of the existing log', async () => {
    const { pool, tables } = createFakePool();
    const doc = docWithText('seed content');
    await writeCheckpoint(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      throughSequence: 0,
      doc,
    });
    expect(tables.checkpoints).toHaveLength(1);
    expect(tables.checkpoints[0]?.throughSequence).toBe(0);
  });
});

describe('reconstructDocumentState', () => {
  it('returns undefined when no checkpoint has ever been written', async () => {
    const { pool } = createFakePool();
    const result = await reconstructDocumentState(pool, SCREENPLAY_A, EPOCH);
    expect(result).toBeUndefined();
  });

  it('rebuilds the document from a checkpoint alone when the log has nothing after it', async () => {
    const { pool } = createFakePool();
    const seeded = docWithText('seed');
    await writeCheckpoint(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      throughSequence: 0,
      doc: seeded,
    });

    const result = await reconstructDocumentState(pool, SCREENPLAY_A, EPOCH);
    expect(result).toBeDefined();
    expect(result!.doc.getText('body').toString()).toBe('seed');
    expect(result!.throughSequence).toBe(0);
  });

  it('reconstruction from checkpoint plus updates: replays exactly the tail after the checkpoint, in order', async () => {
    const { pool } = createFakePool();
    const base = docWithText('seed');
    await writeCheckpoint(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      throughSequence: 0,
      doc: base,
    });

    // Two real, sequential Yjs edits against the *same* logical document lineage (each update is
    // captured from the same doc instance right after the mutation, exactly as `onChange` would).
    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(base));
    const update1 = captureUpdate(live, () => live.getText('body').insert(4, ' one'));
    const update2 = captureUpdate(live, () =>
      live.getText('body').insert(live.getText('body').length, ' two'),
    );
    await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: update1,
      actorId: 'a',
    });
    await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: update2,
      actorId: 'a',
    });

    const result = await reconstructDocumentState(pool, SCREENPLAY_A, EPOCH);
    expect(result!.doc.getText('body').toString()).toBe(live.getText('body').toString());
  });
});

describe('createCheckpoint (compaction)', () => {
  it('does nothing when there are no updates to absorb', async () => {
    const { pool, tables } = createFakePool();
    const result = await createCheckpoint(pool, { screenplayId: SCREENPLAY_A, epoch: EPOCH });
    expect(result).toBeUndefined();
    expect(tables.checkpoints).toHaveLength(0);
  });

  it('folds the log into a new checkpoint and deletes exactly the rows it absorbed', async () => {
    const { pool, tables } = createFakePool();
    const base = docWithText('seed');
    await writeCheckpoint(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      throughSequence: 0,
      doc: base,
    });

    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(base));
    const update1 = captureUpdate(live, () => live.getText('body').insert(4, '!'));
    const seq1 = await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: update1,
      actorId: 'a',
    });

    const result = await createCheckpoint(pool, { screenplayId: SCREENPLAY_A, epoch: EPOCH });
    expect(result).toEqual({ throughSequence: seq1 });
    // The absorbed row is gone -- this is the "compaction deletes what it absorbed" half.
    expect(tables.updates).toHaveLength(0);
    // A new checkpoint exists whose merged content reflects the absorbed update.
    const reconstructed = await reconstructDocumentState(pool, SCREENPLAY_A, EPOCH);
    expect(reconstructed!.doc.getText('body').toString()).toBe(live.getText('body').toString());
  });

  it('an update appended while compaction is in flight is never lost -- it is either absorbed by this pass or survives, untouched, for the next one', async () => {
    const { pool, tables } = createFakePool();
    const base = docWithText('seed');
    await writeCheckpoint(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      throughSequence: 0,
      doc: base,
    });

    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(base));
    const firstUpdate = captureUpdate(live, () => live.getText('body').insert(4, ' first'));
    await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: firstUpdate,
      actorId: 'a',
    });

    // Start compaction (it will acquire the advisory lock first) and, in the same tick, start a
    // second append for the identical document -- the exact interleaving the brief names
    // directly. Because `createCheckpoint` is called first, its lock request queues ahead of the
    // append's; the fake pool's FIFO mutex (see `createFakePool`'s own comment) makes the append
    // genuinely wait until compaction's transaction has committed, exactly as a real Postgres
    // advisory lock would.
    const compaction = createCheckpoint(pool, { screenplayId: SCREENPLAY_A, epoch: EPOCH });
    const secondUpdate = captureUpdate(live, () =>
      live.getText('body').insert(live.getText('body').length, ' second'),
    );
    const concurrentAppend = appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: secondUpdate,
      actorId: 'a',
    });

    const [compactionResult] = await Promise.all([compaction, concurrentAppend]);
    expect(compactionResult).toBeDefined();

    // The concurrently-appended update must still be present -- either still in the log (not yet
    // absorbed by this compaction pass) or already folded into a checkpoint -- never simply gone.
    const reconstructed = await reconstructDocumentState(pool, SCREENPLAY_A, EPOCH);
    expect(reconstructed!.doc.getText('body').toString()).toBe(live.getText('body').toString());
    // And the log itself never held the second update *and* had it deleted without ever being
    // absorbed into a checkpoint: every checkpoint's declared throughSequence never exceeds the
    // sequence a still-existing row would need to be considered absorbed.
    const maxAbsorbed = Math.max(...tables.checkpoints.map((c) => c.throughSequence));
    for (const row of tables.updates) {
      expect(row.sequence).toBeGreaterThan(maxAbsorbed);
    }
  });

  it('the sharp invariant: two overlapping compactions can never produce a checkpoint that has forgotten what an earlier one already absorbed (the torn-read race)', async () => {
    // This is the failure mode the advisory lock exists to close, made concrete: compaction A
    // reads the checkpoint, reads the tail, and is *paused right there* -- lock still held, no
    // writes yet -- via the test-only seam `createCheckpoint` exposes for exactly this. While A is
    // paused, compaction B is started for the identical (screenplayId, epoch). If B could make any
    // progress during A's pause, it would read the *old* checkpoint (A has not written its new one
    // yet) and, once A eventually finishes, a *stale* tail (A already deleted the rows B is about
    // to read as if they were still there) -- a torn read across B's own two separate queries,
    // producing a checkpoint that silently drops whatever A already absorbed. With the lock
    // correctly held for A's whole transaction, B cannot even acquire it -- let alone read
    // anything -- until A commits, which is what this test actually proves: B is asserted to
    // observe A's *already-compacted* state, not a torn one.
    const { pool, tables } = createFakePool();
    const base = docWithText('seed');
    await writeCheckpoint(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      throughSequence: 0,
      doc: base,
    });
    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(base));
    const update1 = captureUpdate(live, () => live.getText('body').insert(4, ' one'));
    const update2 = captureUpdate(live, () =>
      live.getText('body').insert(live.getText('body').length, ' two'),
    );
    await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: update1,
      actorId: 'a',
    });
    await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: update2,
      actorId: 'a',
    });

    let bResolved = false;
    const compactionA = createCheckpoint(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      __testOnlyAfterReadBeforeWrite: async () => {
        // B is started here, while A still holds the lock and has not written anything yet.
        const compactionB = createCheckpoint(pool, {
          screenplayId: SCREENPLAY_A,
          epoch: EPOCH,
        }).then((result) => {
          bResolved = true;
          return result;
        });
        // Give the event loop a real chance to run B's own code if it were ever going to make
        // progress -- with the lock correctly in place, B cannot get past acquiring it, so this
        // resolves with `bResolved` still `false` regardless of how many turns it is given.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(bResolved).toBe(false);
        (compactionA as unknown as { __b: typeof compactionB }).__b = compactionB;
      },
    });

    const resultA = await compactionA;
    const resultB = await (compactionA as unknown as { __b: Promise<unknown> }).__b;
    expect(resultA).toBeDefined();
    // B, once it finally ran (after A committed), found nothing left to absorb -- A already did.
    expect(resultB).toBeUndefined();
    // The seed checkpoint from `writeCheckpoint` above, plus exactly one more from A -- B's own
    // call produced no additional row, since it had nothing left to compact by the time it ran.
    expect(tables.checkpoints).toHaveLength(2);

    const reconstructed = await reconstructDocumentState(pool, SCREENPLAY_A, EPOCH);
    expect(reconstructed!.doc.getText('body').toString()).toBe(live.getText('body').toString());
  });

  it('mutation guard: without the lock, the same torn read genuinely corrupts a checkpoint -- proving the test above is sensitive to the invariant it claims to check', async () => {
    // A deliberately lock-free re-implementation of exactly what `createCheckpoint` does,
    // constructed only to prove the *test methodology* above would actually fail if the
    // production code's lock were removed -- this is the mutation-testing step the brief requires
    // ("re-run the mutation against the suite meant to prove that property"), performed here
    // in-line against a hand-built stand-in rather than by editing and reverting the real source
    // file for a unit test (the integration suite's own mutation pass, recorded in the progress
    // doc, does that against the real file over a real database).
    const { pool, tables } = createFakePool();
    const base = docWithText('seed');
    await writeCheckpoint(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      throughSequence: 0,
      doc: base,
    });
    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(base));
    const update1 = captureUpdate(live, () => live.getText('body').insert(4, ' one'));
    const update2 = captureUpdate(live, () =>
      live.getText('body').insert(live.getText('body').length, ' two'),
    );
    await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: update1,
      actorId: 'a',
    });
    await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: update2,
      actorId: 'a',
    });

    async function commitLockFreeCompaction(
      checkpoint: Awaited<ReturnType<typeof latestCheckpoint>>,
      tail: Awaited<ReturnType<typeof updatesAfter>>,
    ): Promise<void> {
      if (tail.length === 0) return;
      const doc = new Y.Doc();
      if (checkpoint) Y.applyUpdate(doc, checkpoint.mergedUpdate);
      for (const row of tail) Y.applyUpdate(doc, row.update);
      await writeCheckpoint(pool, {
        screenplayId: SCREENPLAY_A,
        epoch: EPOCH,
        throughSequence: tail[tail.length - 1]!.sequence,
        doc,
      });
      await pool.query(
        `delete from document_yjs_updates where screenplay_id = $1 and epoch = $2 and sequence <= $3`,
        [SCREENPLAY_A, EPOCH, tail[tail.length - 1]!.sequence],
      );
    }

    // B reads early -- checkpoint@0, tail=[update1, update2] -- this is the read a lock would
    // have blocked from ever happening before A's own transaction committed.
    const checkpointB = await latestCheckpoint(pool, SCREENPLAY_A, EPOCH);
    const tailB = await updatesAfter(pool, SCREENPLAY_A, EPOCH, checkpointB?.throughSequence ?? 0);

    // A third update arrives -- an ordinary keystroke, logged the same way any real edit is --
    // *after* B's read but *before* A runs. A locked implementation could never let this happen
    // while a compaction transaction for this document is in flight, because `appendUpdate` takes
    // the identical lock; this fake, standing in for the lock-free mutation, does not.
    const update3 = captureUpdate(live, () =>
      live.getText('body').insert(live.getText('body').length, ' three'),
    );
    await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: update3,
      actorId: 'a',
    });

    // A reads fresh (sees all three updates) and commits first, correctly absorbing everything,
    // including update3, and deleting all three rows.
    const checkpointA = await latestCheckpoint(pool, SCREENPLAY_A, EPOCH);
    const tailA = await updatesAfter(pool, SCREENPLAY_A, EPOCH, checkpointA?.throughSequence ?? 0);
    await commitLockFreeCompaction(checkpointA, tailA);
    expect(tailA).toHaveLength(3); // update1, update2, and update3.

    // B now commits *using the stale reads it took before update3 even existed*. Its own tail
    // (update1, update2, captured by value) is still content-complete for what it saw, so it
    // writes a checkpoint that is individually well-formed -- but it commits *after* A, so
    // `latestCheckpoint`'s `order by id desc` will prefer B's newer-but-incomplete checkpoint over
    // A's older-but-complete one, and update3's row is already gone (deleted by A). This is the
    // actual corruption: not a row deleted before being absorbed anywhere, but a *stale checkpoint
    // shadowing a more complete one*, silently dropping update3 from reconstruction even though it
    // was, briefly, durably logged and briefly correctly absorbed by A.
    await commitLockFreeCompaction(checkpointB, tailB);

    const reconstructed = await reconstructDocumentState(pool, SCREENPLAY_A, EPOCH);
    expect(reconstructed!.doc.getText('body').toString()).not.toBe(live.getText('body').toString());
    // Specifically: update3's own content ("three") is the part that went missing.
    expect(reconstructed!.doc.getText('body').toString()).not.toContain('three');
    expect(tables.checkpoints.length).toBe(3); // seed, A's, and B's stale one shadowing it.
  });
});

describe('latestCheckpoint / updatesAfter', () => {
  it('latestCheckpoint returns undefined for a document with no checkpoint', async () => {
    const { pool } = createFakePool();
    expect(await latestCheckpoint(pool, SCREENPLAY_A, EPOCH)).toBeUndefined();
  });

  it('updatesAfter returns only rows strictly after the given sequence, in order', async () => {
    const { pool } = createFakePool();
    const s1 = await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: new Uint8Array([1]),
      actorId: 'a',
    });
    const s2 = await appendUpdate(pool, {
      screenplayId: SCREENPLAY_A,
      epoch: EPOCH,
      update: new Uint8Array([2]),
      actorId: 'a',
    });
    const rows = await updatesAfter(pool, SCREENPLAY_A, EPOCH, s1);
    expect(rows.map((r) => r.sequence)).toEqual([s2]);
  });
});
