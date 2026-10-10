import type { Pool, PoolClient } from 'pg';
import type { Queryable } from './revisions.js';

/**
 * Collaboration slice 5: restore-as-current, as an epoch cutover (plan.md's "Restore as current").
 *
 * This module is the whole of plan.md's step 3 -- "in one transaction, it records a `restore`
 * revision linked to both the prior head and source revision, increments the document epoch, and
 * makes the new collaboration document active" -- and nothing else. Authorization (step 1) is the
 * caller's (`apps/api/src/restore.ts`); seeding the new collaboration document (step 2) needs no
 * work here at all, for a reason worth stating explicitly rather than leaving as an absence:
 *
 * **Why no Yjs state is written here.** A collaboration document's identity in this codebase is
 * `(screenplayId, epoch)` -- every `document_yjs_updates`/`document_yjs_checkpoints` row is scoped
 * to that pair, and `apps/collab`'s Hocuspocus document name is `<screenplayId>:<epoch>`. So the
 * fresh document plan.md's step 2 asks for is created by the epoch increment itself: the new epoch
 * has no updates and no checkpoint, and `apps/collab/src/database.ts`'s `createFetch` already has
 * exactly one behaviour for a (screenplayId, epoch) pair with no checkpoint -- seed a fresh `Y.Doc`
 * from `screenplays.canonical_screenplay` and persist it as that epoch's first checkpoint. This
 * transaction sets `canonical_screenplay` to the selected revision's own copy, so that existing,
 * already-tested seeding path *is* "seeded from the selected revision's canonical screenplay JSON."
 * Writing a checkpoint here instead would mean this package depending on `yjs` and
 * `@finaler-draft/screenplay-editor` to build a `Y.Doc` -- a second, parallel implementation of a
 * seed that already exists, for no gain.
 *
 * **Why the canonical projection and the hash are copied, never recomputed.** `canonical_screenplay`
 * is `jsonb`, which does not preserve key order, so round-tripping it through `JSON.parse`/
 * `JSON.stringify` cannot be assumed to reproduce the exact string the hash was computed from. Every
 * statement below that moves a canonical projection moves the `jsonb` value and its stored
 * `canonical_hash` together, inside Postgres, as a column copy (`insert ... select`, `update ... from`).
 * That is what makes plan.md's "hash-identical to the selected revision" a copy rather than an
 * argument about serialization stability -- and `restore.integration.test.ts` proves it by
 * comparison afterward rather than trusting this reasoning.
 */

/**
 * The Postgres `NOTIFY` channel a committed restore is announced on, and which `apps/collab` listens
 * to so plan.md's step 4 ("connected clients receive a restore event and reload the new epoch") can
 * reach a process that is not the one performing the restore.
 *
 * Chosen over an HTTP call from `apps/api` to `apps/collab` deliberately: the two services already
 * share one database and one `DATABASE_URL`, so this needs no new environment variable, no
 * service-to-service credential, and no knowledge in `apps/api` of where `apps/collab` is deployed.
 * It lives in this package rather than `@finaler-draft/config` because it is server-only -- that
 * package exists for "shared policy the browser legitimately needs," and the browser has no business
 * knowing the name of a database notification channel.
 */
export const SCREENPLAY_RESTORED_NOTIFY_CHANNEL = 'screenplay_restored';

/** Postgres's SQLSTATE for `unique_violation` -- what the partial unique index on
 * `document_revisions.restore_request_id` raises when two restores race with the same idempotency
 * key and the pre-check below did not see the other one yet. Matched on the code, not the message. */
const UNIQUE_VIOLATION = '23505';

/**
 * The same advisory-lock namespace `revisions.ts`'s `insertRevisionIfChanged` takes
 * (`pg_advisory_xact_lock(hashtext(screenplayId), -1)`), taken here for the identical reason and
 * deliberately not a new one: this transaction inserts into `document_revisions` and reads that
 * table's current latest row to decide the prior head, so it must serialize against every other
 * writer of that table for this screenplay. Without it, an automatic `structural_change` revision
 * committing between this transaction's "latest revision" read and its own insert would leave the
 * `previous_head_revision_id` link pointing at a revision that was no longer the head.
 */
const REVISION_LOCK_NAMESPACE = -1;

async function acquireRevisionLock(client: PoolClient, screenplayId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtext($1), $2)', [
    screenplayId,
    REVISION_LOCK_NAMESPACE,
  ]);
}

/**
 * The two `document_revisions` columns this package cannot compute for itself, supplied by the
 * caller as a pure function over a canonical screenplay. `rendered_text` is
 * `@finaler-draft/screenplay`'s `screenplayToPlainText` and `preview_metadata` is its
 * `computeRevisionPreviewMetadata`; both live in a package `packages/database` has no dependency on
 * and no reason to acquire one on. Injected rather than imported, and called *inside* the
 * transaction while the screenplay row lock is held, so the fields it derives always describe the
 * exact canonical projection this transaction is about to capture -- never one read before the lock
 * that could have moved on since.
 *
 * `undefined` means "this canonical projection could not be read" (it failed
 * `screenplaySchema.parse`). That is not fatal to a restore: it only means the pre-restore head
 * cannot be captured as a new revision row, in which case the restore links its prior head to the
 * screenplay's latest existing revision instead. See `restoreRevisionAsCurrent` below.
 */
export type DeriveRevisionFields = (
  canonicalScreenplay: unknown,
) => { renderedText: string; previewMetadata: object | null } | undefined;

export interface RestoreRevisionAsCurrentParams {
  screenplayId: string;
  /** The revision whose content becomes current. Must belong to `screenplayId` -- a revision id is
   * never trusted to resolve across screenplays, matching `getRevisionById`'s own convention. */
  sourceRevisionId: string;
  /** The owner/editor who confirmed this restore; recorded as the `restore` revision's `authored_by`.
   * Authorization itself is resolved before this is ever called. */
  actorId: string;
  /** The idempotency key -- see `documentRevisions.restoreRequestId`'s schema comment. */
  restoreRequestId: string;
  /** The epoch the confirming client believed was current. A mismatch is `epoch-conflict`, never a
   * silent second cutover: it means the document moved on (another writer restored it) between the
   * client reading the epoch and confirming, and the confirmation it gave was about a document state
   * that no longer exists. */
  expectedEpoch: number;
  derive: DeriveRevisionFields;
  /**
   * Test-only seam, and the only honest way to test plan.md's atomicity requirement ("a crash
   * partway must leave the screenplay exactly as it was, with the old epoch still live"). Called
   * after every statement of this transaction has run and before `commit`; a throw from here
   * reaches the `catch` below and rolls the whole thing back, which is precisely the state a
   * process killed at that instant would leave behind. Never set in production.
   */
  __testOnlyBeforeCommit?: () => Promise<void>;
}

export interface RestoredResult {
  outcome: 'restored';
  /** `false` when this call found an existing `restore` revision with the identical
   * `restoreRequestId` and changed nothing -- the idempotent replay of a retried or double-submitted
   * confirmation. Every other field then describes that already-committed restore. */
  created: boolean;
  /** The new current epoch. */
  epoch: number;
  /** The epoch this restore retired. */
  previousEpoch: number;
  restoreRevisionId: string;
  /** The restored `canonical_hash` -- equal, by column copy, to the source revision's own. */
  canonicalHash: string;
  previousHeadRevisionId: string | null;
}

export type RestoreRevisionAsCurrentResult =
  | RestoredResult
  | { outcome: 'screenplay-missing' }
  | { outcome: 'revision-missing' }
  | { outcome: 'epoch-conflict'; currentEpoch: number }
  /** The supplied `restoreRequestId` already names a restore of a *different* screenplay. Reported
   * rather than treated as a replay: returning that restore's epoch for this screenplay would be a
   * lie, and silently minting a new key would defeat the idempotency the client asked for. */
  | { outcome: 'request-id-conflict' };

interface ExistingRestoreRow {
  id: string;
  screenplayId: string;
  sourceEpoch: number;
  previousEpoch: number | null;
  canonicalHash: string;
  previousHeadRevisionId: string | null;
}

const EXISTING_RESTORE_COLUMNS = `id, screenplay_id as "screenplayId", source_epoch as "sourceEpoch",
  previous_epoch as "previousEpoch", canonical_hash as "canonicalHash",
  previous_head_revision_id as "previousHeadRevisionId"`;

async function findRestoreByRequestId(
  queryable: Queryable,
  restoreRequestId: string,
): Promise<ExistingRestoreRow | undefined> {
  const result = await queryable.query<ExistingRestoreRow>(
    `select ${EXISTING_RESTORE_COLUMNS}
       from document_revisions
      where restore_request_id = $1`,
    [restoreRequestId],
  );
  return result.rows[0];
}

function replayOf(
  existing: ExistingRestoreRow,
  screenplayId: string,
): RestoreRevisionAsCurrentResult {
  if (existing.screenplayId !== screenplayId) return { outcome: 'request-id-conflict' };
  return {
    outcome: 'restored',
    created: false,
    epoch: existing.sourceEpoch,
    // A `restore` row always carries `previousEpoch`; the `?? 0` is only here because the column is
    // nullable for every other kind and this type cannot say "non-null for this kind."
    previousEpoch: existing.previousEpoch ?? 0,
    restoreRevisionId: existing.id,
    canonicalHash: existing.canonicalHash,
    previousHeadRevisionId: existing.previousHeadRevisionId,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * The entire cutover, in one transaction. In order:
 *
 *  1. `select ... for update` on the `screenplays` row. This is the serialization point for the
 *     whole operation: two writers racing a restore of the same screenplay cannot both read the same
 *     `current_epoch`, so they cannot both increment it to the same value, and the second one to
 *     arrive re-reads an epoch that already reflects the first (and so fails its own
 *     `expectedEpoch` check rather than producing a second cutover). Also the lock that makes the
 *     canonical-projection install below atomic with the increment.
 *  2. The revision-table advisory lock (see `REVISION_LOCK_NAMESPACE`).
 *  3. The idempotency pre-check, by `restore_request_id`.
 *  4. `expectedEpoch` against the locked row's `current_epoch`.
 *  5. The prior-head capture. If the screenplay's latest revision already has the live projection's
 *     hash, that revision *is* the prior head and is linked directly. Otherwise the live projection
 *     is copied into a new `pre_restore` revision -- so the content that was current at the instant
 *     of the cutover survives as a first-class revision, not only as a retired epoch's Yjs log.
 *  6. The `restore` revision, its canonical projection and hash copied column-for-column from the
 *     source revision.
 *  7. The epoch increment and the canonical projection install, in one `update`, from the same
 *     source revision row.
 *  8. `pg_notify` on `SCREENPLAY_RESTORED_NOTIFY_CHANNEL`. Issued inside the transaction on purpose:
 *     Postgres delivers a notification if and only if the transaction that queued it commits, so
 *     `apps/collab` can never be told about a restore that rolled back, and no post-commit
 *     bookkeeping step exists to be skipped.
 *
 * Every failure path rolls back before returning, so a rejected restore leaves the screenplay
 * exactly as it was, with the old epoch still live.
 */
export async function restoreRevisionAsCurrent(
  pool: Pool,
  params: RestoreRevisionAsCurrentParams,
): Promise<RestoreRevisionAsCurrentResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const screenplayResult = await client.query<{
      currentEpoch: number;
      canonicalHash: string;
      canonicalScreenplay: unknown;
    }>(
      `select current_epoch as "currentEpoch", canonical_hash as "canonicalHash",
              canonical_screenplay as "canonicalScreenplay"
         from screenplays
        where id = $1 and deleted_at is null
          for update`,
      [params.screenplayId],
    );
    const screenplay = screenplayResult.rows[0];
    if (!screenplay) {
      await client.query('rollback');
      return { outcome: 'screenplay-missing' };
    }

    await acquireRevisionLock(client, params.screenplayId);

    const alreadyRestored = await findRestoreByRequestId(client, params.restoreRequestId);
    if (alreadyRestored) {
      await client.query('rollback');
      return replayOf(alreadyRestored, params.screenplayId);
    }

    if (params.expectedEpoch !== screenplay.currentEpoch) {
      await client.query('rollback');
      return { outcome: 'epoch-conflict', currentEpoch: screenplay.currentEpoch };
    }

    const latestResult = await client.query<{ id: string; canonicalHash: string }>(
      `select id, canonical_hash as "canonicalHash"
         from document_revisions
        where screenplay_id = $1
        order by created_at desc, id desc
        limit 1`,
      [params.screenplayId],
    );
    const latest = latestResult.rows[0];

    let previousHeadRevisionId: string | null = latest?.id ?? null;
    if (!latest || latest.canonicalHash !== screenplay.canonicalHash) {
      const derived = params.derive(screenplay.canonicalScreenplay);
      if (derived) {
        const captured = await client.query<{ id: string }>(
          `insert into document_revisions
             (screenplay_id, source_epoch, kind, label, authored_by, canonical_screenplay,
              canonical_hash, rendered_text, preview_metadata)
           select s.id, $2, 'pre_restore', null, null, s.canonical_screenplay, s.canonical_hash,
                  $3, $4::jsonb
             from screenplays s
            where s.id = $1
           returning id`,
          [
            params.screenplayId,
            screenplay.currentEpoch,
            derived.renderedText,
            derived.previewMetadata ? JSON.stringify(derived.previewMetadata) : null,
          ],
        );
        previousHeadRevisionId = captured.rows[0]?.id ?? previousHeadRevisionId;
      }
      // `derived === undefined` -- the live canonical projection does not parse, so there is nothing
      // honest to capture it as. The prior head link falls back to the latest existing revision (or
      // null), and the retired epoch's own update log still holds the content either way. Logged by
      // the caller, which owns the `derive` that failed.
    }

    const newEpoch = screenplay.currentEpoch + 1;
    let restoreRow: { id: string; canonicalHash: string } | undefined;
    try {
      const inserted = await client.query<{ id: string; canonicalHash: string }>(
        `insert into document_revisions
           (screenplay_id, source_epoch, kind, label, authored_by, canonical_screenplay,
            canonical_hash, rendered_text, preview_metadata, source_revision_id,
            previous_head_revision_id, previous_epoch, restore_request_id)
         select r.screenplay_id, $3, 'restore', null, $4, r.canonical_screenplay, r.canonical_hash,
                r.rendered_text, r.preview_metadata, r.id, $5, $6, $7
           from document_revisions r
          where r.screenplay_id = $1 and r.id = $2
         returning id, canonical_hash as "canonicalHash"`,
        [
          params.screenplayId,
          params.sourceRevisionId,
          newEpoch,
          params.actorId,
          previousHeadRevisionId,
          screenplay.currentEpoch,
          params.restoreRequestId,
        ],
      );
      restoreRow = inserted.rows[0];
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The partial unique index refused a second restore for this request id: another transaction
      // committed one between this one's pre-check and this insert. That is exactly the case the
      // index exists for, and the correct answer is the same replay the pre-check would have given.
      await client.query('rollback');
      const existing = await findRestoreByRequestId(pool, params.restoreRequestId);
      if (!existing) throw error;
      return replayOf(existing, params.screenplayId);
    }

    if (!restoreRow) {
      // No revision with that id under this screenplay. Nothing has been written that the rollback
      // does not undo -- including a `pre_restore` row this transaction may have just inserted.
      await client.query('rollback');
      return { outcome: 'revision-missing' };
    }

    await client.query(
      `update screenplays s
          set current_epoch = $3,
              canonical_screenplay = r.canonical_screenplay,
              canonical_hash = r.canonical_hash,
              updated_at = now()
         from document_revisions r
        where s.id = $1 and r.id = $2 and r.screenplay_id = s.id`,
      [params.screenplayId, params.sourceRevisionId, newEpoch],
    );

    await client.query('select pg_notify($1, $2)', [
      SCREENPLAY_RESTORED_NOTIFY_CHANNEL,
      JSON.stringify({ screenplayId: params.screenplayId, epoch: newEpoch }),
    ]);

    await params.__testOnlyBeforeCommit?.();
    await client.query('commit');
    return {
      outcome: 'restored',
      created: true,
      epoch: newEpoch,
      previousEpoch: screenplay.currentEpoch,
      restoreRevisionId: restoreRow.id,
      canonicalHash: restoreRow.canonicalHash,
      previousHeadRevisionId,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** The screenplay's current collaboration epoch, or `undefined` for a screenplay that is absent or
 * soft-deleted. The one read every epoch-aware path shares: `apps/collab`'s connection
 * authorization, and `apps/api`'s own stale-epoch rejection on the HTTP paths. */
export async function currentEpoch(
  queryable: Queryable,
  screenplayId: string,
): Promise<number | undefined> {
  const result = await queryable.query<{ currentEpoch: number }>(
    `select current_epoch as "currentEpoch"
       from screenplays
      where id = $1 and deleted_at is null`,
    [screenplayId],
  );
  return result.rows[0]?.currentEpoch;
}
