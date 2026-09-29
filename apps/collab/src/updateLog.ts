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
 * Deliberately reads the checkpoint and the tail as two separate queries rather than one join --
 * `updatesAfter` needs `checkpoint.throughSequence` as an input, so the second query cannot run
 * until the first resolves. No transaction or lock is taken here: reading a checkpoint that is
 * concurrently being superseded by a new one is safe by construction, because
 * `createCheckpoint`'s deletes only ever remove rows the *new* checkpoint already absorbs, so a
 * reader who read an older checkpoint and an now-slightly-stale tail either reconstructs the same
 * state a moment sooner, or -- if a row it was about to read got deleted between the two queries
 * -- has already read a checkpoint recent enough that the deleted row's content was already
 * folded into some checkpoint at or before the one this reader is using. See
 * `updateLog.test.ts`'s reconstruction tests for this exact interleaving made concrete.
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
  const checkpoint = await latestCheckpoint(queryable, screenplayId, epoch);
  if (!checkpoint) return undefined;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, checkpoint.mergedUpdate);
  const tail = await updatesAfter(queryable, screenplayId, epoch, checkpoint.throughSequence);
  for (const row of tail) {
    Y.applyUpdate(doc, row.update);
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
