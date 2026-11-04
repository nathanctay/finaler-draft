import type { Pool, PoolClient } from 'pg';
import * as Y from 'yjs';

/** Structurally compatible with both `Pool` and `PoolClient` -- the identical convention
 * `authenticate.ts`'s own `Queryable` establishes, reused here rather than duplicated. */
export interface Queryable {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

/** One row of the append-only log, as read back for reconstruction. */
export interface StoredUpdate {
  sequence: number;
  update: Buffer;
}

/** The latest compacted snapshot for a (screenplayId, epoch) pair. */
export interface Checkpoint {
  throughSequence: number;
  mergedUpdate: Buffer;
}

/**
 * Every append and every compaction for the *same* (screenplayId, epoch) pair takes this
 * transaction-scoped advisory lock before touching `document_yjs_updates`/
 * `document_yjs_checkpoints` for that pair. This is the mechanism the sharp invariant --
 * "compaction must never lose an update a checkpoint has not yet absorbed" -- actually rests on:
 * `createCheckpoint` below determines its own cutoff (`through_sequence`) and deletes absorbed
 * rows in the *same* transaction that holds this lock, so an `appendUpdate` racing it for the
 * identical document either commits fully before the lock is acquired (and is therefore counted
 * in the cutoff) or blocks until the lock is released (and is therefore never at risk of being
 * deleted, since its own insert cannot even happen until compaction's transaction has already
 * committed or rolled back). Two different documents (or the same document at two different
 * epochs) never contend for this lock at all -- `hashtext` folds the id into a 32-bit key scoped
 * further by `epoch` as the lock's second key, so `pg_advisory_xact_lock`'s two-integer overload
 * only ever serializes work for the identical pair (a hash collision between two different
 * screenplay ids would make them serialize unnecessarily against each other -- a rare performance
 * cost, never a correctness one, since the lock only ever narrows concurrency, never widens it).
 * Held for the lifetime of the caller's transaction (`pg_advisory_xact_lock`, not
 * `pg_advisory_lock` -- released automatically on commit or rollback, never leaked by a client
 * that forgets to unlock explicitly).
 */
async function acquireDocumentEpochLock(
  client: PoolClient,
  screenplayId: string,
  epoch: number,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtext($1), $2)', [screenplayId, epoch]);
}

/**
 * Appends one authenticated Yjs update to the durable log, inside its own short transaction.
 * Called from `server.ts`'s `onChange` hook -- see that file's own comment on why `onChange`,
 * not the debounced `onStoreDocument`, is the correct hook for this: `onChange` fires once per
 * individual update, synchronously with Hocuspocus's own `handleDocumentUpdate`, and hands back
 * the *raw* update bytes Yjs itself produced -- `onStoreDocument` only ever sees the merged,
 * debounced result of possibly many updates, which cannot be un-merged back into the individual
 * writes an append-only log is supposed to preserve.
 *
 * `actorId` is nullable: a server-internal write (there is none yet in this codebase, but
 * `document_yjs_updates.authenticated_actor_id`'s own schema comment anticipates one, e.g. a
 * future restore-seeding step) has no human actor to attribute.
 */
export async function appendUpdate(
  pool: Pool,
  params: {
    screenplayId: string;
    epoch: number;
    update: Uint8Array;
    actorId: string | undefined;
  },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await acquireDocumentEpochLock(client, params.screenplayId, params.epoch);
    const result = await client.query<{ sequence: string }>(
      `insert into document_yjs_updates (screenplay_id, epoch, update, authenticated_actor_id)
       values ($1, $2, $3, $4)
       returning sequence`,
      [params.screenplayId, params.epoch, Buffer.from(params.update), params.actorId ?? null],
    );
    await client.query('commit');
    return Number(result.rows[0]!.sequence);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** The latest checkpoint for (screenplayId, epoch), or `undefined` if this document has never
 * been compacted (including "never opened collaboratively at all"). Latest by `id` -- checkpoints
 * are only ever created one at a time under `acquireDocumentEpochLock` (`createCheckpoint`
 * below), so insertion order and `through_sequence` order agree; `id desc` avoids a tie-break
 * question if two checkpoints were ever written with an identical `through_sequence` (compaction
 * with nothing new to absorb since the last one -- harmless, and not a case this slice's own
 * `createCheckpoint` produces, since it is only ever invoked from a debounced save that implies
 * at least one change, but not a case worth leaving ambiguous either). */
export async function latestCheckpoint(
  queryable: Queryable,
  screenplayId: string,
  epoch: number,
): Promise<Checkpoint | undefined> {
  const result = await queryable.query<{ throughSequence: string; mergedUpdate: Buffer }>(
    `select through_sequence as "throughSequence", merged_update as "mergedUpdate"
       from document_yjs_checkpoints
      where screenplay_id = $1 and epoch = $2
      order by id desc
      limit 1`,
    [screenplayId, epoch],
  );
  const row = result.rows[0];
  return row
    ? { throughSequence: Number(row.throughSequence), mergedUpdate: row.mergedUpdate }
    : undefined;
}

/** Every logged update for (screenplayId, epoch) with `sequence > afterSequence`, oldest first --
 * exactly the tail a checkpoint's own `mergedUpdate` does not yet reflect. */
export async function updatesAfter(
  queryable: Queryable,
  screenplayId: string,
  epoch: number,
  afterSequence: number,
): Promise<StoredUpdate[]> {
  const result = await queryable.query<{ sequence: string; update: Buffer }>(
    `select sequence, update
       from document_yjs_updates
      where screenplay_id = $1 and epoch = $2 and sequence > $3
      order by sequence asc`,
    [screenplayId, epoch, afterSequence],
  );
  return result.rows.map((row) => ({ sequence: Number(row.sequence), update: row.update }));
}

/**
 * Rebuilds this document's current state from its latest checkpoint plus whatever the log holds
 * after it -- "reconstruction from checkpoint-plus-updates," the property the brief names
 * directly. Returns `undefined` when there is no checkpoint at all: a document that has never
 * been opened collaboratively (or never survived its first compaction) has nothing here to
 * reconstruct from, and `database.ts`'s `createFetch` falls back to seeding fresh from
 * `canonical_screenplay` in that case, exactly as it did before this slice.
 *
 * **Read order is load-bearing, and this is the fix for a real defect.** The previous version read
 * the checkpoint and then the tail, and carried a written argument that doing so was safe: that a
 * row deleted between the two queries must already have been "folded into some checkpoint at or
 * before the one this reader is using". That argument is false, and the interleaving it dismissed
 * loses a committed edit outright:
 *
 *  1. this reader reads checkpoint `C1` (say `through_sequence` 0, holding only the seed);
 *  2. a compaction commits -- inserting `C2` (`through_sequence` 7, holding the seed *and* the
 *     writer's edit) and, in the same transaction, deleting update rows 1..7;
 *  3. this reader's tail query asks for rows after sequence 0 and finds none, because they are
 *     gone;
 *  4. it reconstructs `C1` alone. The edit has vanished from the result -- while sitting safely in
 *     `C2`, which this reader never looked at.
 *
 * The deleted rows' content was folded into a checkpoint *after* the one the reader held, not at or
 * before it, which is exactly the case the old reasoning excluded. Nothing is lost on disk; a read
 * silently omits it. That matters well beyond a test, because `database.ts`'s `createFetch` -- the
 * live path that loads a document when a writer opens it -- is one of two production callers, and a
 * load landing in that window hands the writer a document missing their recent edits.
 *
 * The comment it replaced also cited `updateLog.test.ts` for "this exact interleaving made
 * concrete". No such test existed: that file covers compaction against a concurrent *append* and
 * compaction against another *compaction*, both thoroughly, but never reconstruction against a
 * concurrent compaction. A safety argument was asserted, documented as tested, and never exercised.
 *
 * **Why the order below is correct**, resting on two invariants that hold by construction: a
 * checkpoint row is never deleted (confirmed: no `delete from document_yjs_checkpoints` exists
 * anywhere), and an update row is deleted in exactly one place -- `createCheckpoint` -- in the same
 * transaction that inserts the checkpoint absorbing it. So:
 *
 *  - the floor read bounds the tail scan, exactly as before, so this costs one extra single-row
 *    indexed lookup and reads no more update rows than the old version did;
 *  - the tail is read *before* the checkpoint that will actually be applied;
 *  - therefore, for any sequence `s` belonging in the final state, `s` is either covered by that
 *    checkpoint or present in the tail -- never neither. Suppose `s` were missing from both: `s`
 *    passed the tail filter (the floor can only be older than the applied checkpoint, as
 *    `through_sequence` advances monotonically), so it was absent only if deleted before the tail
 *    read, which implies an absorbing checkpoint with `through_sequence >= s` committed before the
 *    tail read -- and the checkpoint read *after* the tail therefore sees it, giving
 *    `through_sequence >= s` and contradicting `s` being uncovered.
 *
 * No transaction, no advisory lock, and no dependence on the isolation level. A read-verify-retry
 * loop was prototyped first and does also close the race, but it is strictly weaker: it is
 * probabilistic rather than proven, and it keeps the window open for however long the retries take.
 *
 * Returns `undefined` when there is no checkpoint at all: a document that has never been opened
 * collaboratively (or never survived its first compaction) has nothing here to reconstruct from,
 * and `createFetch` falls back to seeding fresh from `canonical_screenplay`, exactly as before.
 */
export interface Reconstruction {
  doc: Y.Doc;
  /** The checkpoint's own `throughSequence` this reconstruction started from -- callers that go
   * on to write a *new* checkpoint after enriching `doc` (`database.ts`'s migration backfill)
   * need this to record accurately that no new log rows were absorbed, only the earlier
   * checkpoint's content plus whatever it already had itself absorbed. */
  throughSequence: number;
}

export async function reconstructDocumentState(
  queryable: Queryable,
  screenplayId: string,
  epoch: number,
): Promise<Reconstruction | undefined> {
  // A floor, purely to bound the tail scan. Its `mergedUpdate` is deliberately *not* the one
  // applied -- see this function's own comment for why the applied checkpoint must be read last.
  const floor = await latestCheckpoint(queryable, screenplayId, epoch);
  if (!floor) return undefined;
  const tail = await updatesAfter(queryable, screenplayId, epoch, floor.throughSequence);
  // Read after the tail. A compaction committing in between is now harmless: whatever it deleted,
  // it absorbed into this checkpoint first.
  const checkpoint = await latestCheckpoint(queryable, screenplayId, epoch);
  if (!checkpoint) return undefined;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, checkpoint.mergedUpdate);
  for (const row of tail) {
    // Skip anything the applied checkpoint already absorbed. Re-applying an absorbed update would
    // be harmless -- Yjs updates are idempotent -- but this keeps the replay to real work only.
    if (row.sequence > checkpoint.throughSequence) {
      Y.applyUpdate(doc, row.update);
    }
  }
  return { doc, throughSequence: checkpoint.throughSequence };
}

/**
 * Writes one new checkpoint row directly, with no compaction (no read of the existing log, no
 * delete). Used for the two cases outside ordinary compaction where a checkpoint must exist
 * *before* any client update can be appended relative to it:
 *
 *  - `database.ts`'s `createFetch`, the first time a screenplay is ever opened collaboratively:
 *    the freshly-seeded `Y.Doc` it builds from `canonical_screenplay` is handed to Hocuspocus to
 *    apply via `onLoadDocument`, which -- confirmed by reading the installed
 *    `@hocuspocus/server` source -- runs *before* `document.onUpdate` is ever attached, so that
 *    seed is never captured by `appendUpdate`/`onChange` no matter what. Without writing it here
 *    explicitly, the very first genuine edit afterward would be logged as a delta relative to a
 *    base state that exists only in memory, and `reconstructDocumentState` would later replay
 *    that delta against a *fresh, empty* `Y.Doc` instead -- Yjs updates reference other operations
 *    by id (the YATA algorithm's left/right neighbour pointers), so a delta replayed without the
 *    base it was created against does not merely miss content, it can fail to integrate at all.
 *    `throughSequence` is `0` here: nothing in the log has been absorbed, because nothing has been
 *    logged yet.
 *  - `database.ts`'s title-page/document-settings migration backfill, for a document that
 *    already has a real checkpoint but predates those two Yjs maps existing at all. The migrated
 *    doc is enriched, not replacing any logged update, so `throughSequence` here is the
 *    *existing* checkpoint's own value, unchanged -- this call adds a supplementary checkpoint
 *    that carries the enrichment forward without claiming to have absorbed anything new from the
 *    log.
 *
 * Takes the identical advisory lock `appendUpdate`/`createCheckpoint` use, for the same reason:
 * Hocuspocus already single-flights loading a given document name within one process (confirmed
 * by reading the installed source's `loadingDocuments` map), so this is not defending against a
 * real race in production so much as keeping every writer of this table going through one
 * disciplined path, and giving the unit tests one seam to exercise directly.
 */
export async function writeCheckpoint(
  pool: Pool,
  params: { screenplayId: string; epoch: number; throughSequence: number; doc: Y.Doc },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await acquireDocumentEpochLock(client, params.screenplayId, params.epoch);
    const mergedUpdate = Buffer.from(Y.encodeStateAsUpdate(params.doc));
    const stateVector = Buffer.from(Y.encodeStateVector(params.doc));
    await client.query(
      `insert into document_yjs_checkpoints
         (screenplay_id, epoch, through_sequence, state_vector, merged_update)
       values ($1, $2, $3, $4, $5)`,
      [params.screenplayId, params.epoch, params.throughSequence, stateVector, mergedUpdate],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Compaction: folds every currently-logged update for (screenplayId, epoch) into a fresh
 * checkpoint and deletes exactly the rows it absorbed. Runs inside the same
 * `acquireDocumentEpochLock` transaction `appendUpdate` uses, which is what makes the sharp
 * invariant hold -- see that function's own comment, and `updateLog.test.ts`'s
 * "compaction under a concurrent append" test for the interleaving proven directly:
 *
 *  1. Acquire the lock. Any `appendUpdate` for this exact (screenplayId, epoch) that has not yet
 *     committed now blocks until this transaction ends; any that already committed is visible to
 *     the next step.
 *  2. Read the current checkpoint (if any) and every update after it -- the tail this compaction
 *     is about to absorb. Its highest `sequence`, `throughSequence` below, is the new cutoff.
 *  3. Rebuild the merged state *from the log itself* (old checkpoint's `mergedUpdate` plus the
 *     tail, applied in order) -- not from a live Hocuspocus `Document` object passed in from the
 *     caller. This is deliberate: it means compaction's correctness depends on nothing but what
 *     is durably in Postgres at the moment the lock was acquired, not on exactly when some other
 *     process happened to call this relative to when a keystroke was applied to an in-memory
 *     `Y.Doc`. `database.ts`'s `createStore` still separately reads the live `Document` it was
 *     handed, but only for the unrelated `canonical_screenplay` projection, never for durability.
 *  4. Insert the new checkpoint and delete every row with `sequence <= throughSequence`, in the
 *     same transaction, then commit (releasing the lock).
 *
 * Returns `undefined`, doing nothing, when there is nothing new to absorb (no updates logged
 * since the last checkpoint, including "no checkpoint and no updates at all" for a document that
 * has never been opened collaboratively) -- there is no reason to write an identical checkpoint
 * on every debounced save of a document nobody is actively editing.
 */
export async function createCheckpoint(
  pool: Pool,
  params: {
    screenplayId: string;
    epoch: number;
    /**
     * Test-only seam. Called after this transaction has read the checkpoint and the tail it is
     * about to absorb, but before it writes anything -- while the advisory lock is still held, so
     * in the real (correct) implementation nothing else contending for the identical
     * (screenplayId, epoch) lock can make progress during this window, no matter how long a test
     * makes it wait here. `updateLog.test.ts`'s "torn read" mutation test uses this to prove that
     * property directly: it fires a *second* concurrent `createCheckpoint` call from inside this
     * hook and confirms it cannot complete until this transaction commits, then mutates the lock
     * away and confirms the same setup *does* corrupt a checkpoint once that guarantee is gone.
     * Never set in production -- `database.ts`'s `createStore` never passes it.
     */
    __testOnlyAfterReadBeforeWrite?: () => Promise<void>;
  },
): Promise<{ throughSequence: number } | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await acquireDocumentEpochLock(client, params.screenplayId, params.epoch);

    const checkpoint = await latestCheckpoint(client, params.screenplayId, params.epoch);
    const tail = await updatesAfter(
      client,
      params.screenplayId,
      params.epoch,
      checkpoint?.throughSequence ?? 0,
    );
    await params.__testOnlyAfterReadBeforeWrite?.();
    if (tail.length === 0) {
      await client.query('rollback');
      return undefined;
    }

    const doc = new Y.Doc();
    if (checkpoint) Y.applyUpdate(doc, checkpoint.mergedUpdate);
    for (const row of tail) {
      Y.applyUpdate(doc, row.update);
    }
    const throughSequence = tail[tail.length - 1]!.sequence;
    const mergedUpdate = Buffer.from(Y.encodeStateAsUpdate(doc));
    const stateVector = Buffer.from(Y.encodeStateVector(doc));

    await client.query(
      `insert into document_yjs_checkpoints
         (screenplay_id, epoch, through_sequence, state_vector, merged_update)
       values ($1, $2, $3, $4, $5)`,
      [params.screenplayId, params.epoch, throughSequence, stateVector, mergedUpdate],
    );
    await client.query(
      `delete from document_yjs_updates
        where screenplay_id = $1 and epoch = $2 and sequence <= $3`,
      [params.screenplayId, params.epoch, throughSequence],
    );

    await client.query('commit');
    return { throughSequence };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
