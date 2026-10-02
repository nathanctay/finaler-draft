import type { Pool, PoolClient } from 'pg';

/** Mirrors `packages/database/src/schema.ts`'s `revisionKind` pgEnum exactly. */
export type RevisionKind = 'named' | 'idle_session' | 'structural_change' | 'export';

/** Structurally compatible with both `Pool` and `PoolClient` -- the identical convention
 * `apps/collab/src/updateLog.ts`'s own `Queryable` establishes, reused here rather than
 * duplicated (that module lives in `apps/collab`, which has no reason to depend on `apps/api`
 * or vice versa, so the *shape* is shared by convention, not the type itself). */
export interface Queryable {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

/** One revision row, without its (potentially large) `canonicalScreenplay` payload -- what a
 * revision list needs. */
export interface RevisionRow {
  id: string;
  screenplayId: string;
  sourceEpoch: number;
  kind: RevisionKind;
  label: string | null;
  authoredBy: string | null;
  canonicalHash: string;
  renderedText: string;
  previewMetadata: unknown;
  createdAt: Date;
}

/** A revision row plus its full canonical projection -- what historical preview and the
 * structural-change trigger's own "compare against the baseline" step both need.
 * `canonicalScreenplay` is returned exactly as Postgres's `jsonb` decodes it (already a parsed
 * JS value via `pg`'s own driver, never a string a caller has to `JSON.parse` again); it is
 * `unknown` here, not `Screenplay`, because this package has no dependency on
 * `@finaler-draft/screenplay` and never validates the shape itself -- every caller that needs a
 * typed `Screenplay` runs `screenplaySchema.parse` on it, the same discipline
 * `apps/api/src/projects.ts`'s `getScreenplay` already applies to the sibling
 * `screenplays.canonical_screenplay` column. */
export interface RevisionWithScreenplay extends RevisionRow {
  canonicalScreenplay: unknown;
}

// A second, distinct advisory-lock namespace from `apps/collab/src/updateLog.ts`'s
// `acquireDocumentEpochLock` (`pg_advisory_xact_lock(hashtext(screenplayId), epoch)`).  That
// lock's second key is always a real `epoch` -- a small non-negative integer, `0` today, and
// still not large for years even once restore-as-current starts incrementing it. `-1` can never
// collide with a real epoch (epochs never go negative), so this lock serializes revision writers
// for a screenplay without ever contending with, or being confused for, the update-log lock for
// the identical screenplay id.
const REVISION_LOCK_NAMESPACE = -1;

async function acquireRevisionLock(client: PoolClient, screenplayId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtext($1), $2)', [
    screenplayId,
    REVISION_LOCK_NAMESPACE,
  ]);
}

const REVISION_ROW_COLUMNS = `id, screenplay_id as "screenplayId", source_epoch as "sourceEpoch",
  kind, label, authored_by as "authoredBy", canonical_hash as "canonicalHash",
  rendered_text as "renderedText", preview_metadata as "previewMetadata",
  created_at as "createdAt"`;

/** The most recently created revision for a screenplay (any kind), or `undefined` if none exists
 * yet -- ordered by `createdAt` (not `id`, a random `uuid` with no chronological meaning; see
 * `schema.ts`'s own comment on the table's index). This is both the dedupe baseline
 * `insertRevisionIfChanged` checks against and the structural-change trigger's own comparison
 * target (`apps/collab/src/revisions.ts`). */
export async function latestRevision(
  queryable: Queryable,
  screenplayId: string,
): Promise<RevisionWithScreenplay | undefined> {
  const result = await queryable.query<RevisionWithScreenplay>(
    `select ${REVISION_ROW_COLUMNS}, canonical_screenplay as "canonicalScreenplay"
       from document_revisions
      where screenplay_id = $1
      order by created_at desc, id desc
      limit 1`,
    [screenplayId],
  );
  return result.rows[0];
}

/** Every revision for a screenplay, newest first -- powers a revision-history list. Deliberately
 * omits `canonicalScreenplay`: a list of (possibly many) revisions has no reason to pull a full
 * canonical document per row over the wire. */
export async function listRevisionsForScreenplay(
  queryable: Queryable,
  screenplayId: string,
): Promise<RevisionRow[]> {
  const result = await queryable.query<RevisionRow>(
    `select ${REVISION_ROW_COLUMNS}
       from document_revisions
      where screenplay_id = $1
      order by created_at desc, id desc`,
    [screenplayId],
  );
  return result.rows;
}

/** One revision by id, scoped to the screenplay it must belong to (a revision id alone is never
 * trusted to resolve across screenplays -- callers pass both, the same "id plus its known parent"
 * shape `lockScreenplayRow` uses in `apps/api/src/projects.ts`). Carries the full
 * `canonicalScreenplay`, for historical preview. */
export async function getRevisionById(
  queryable: Queryable,
  screenplayId: string,
  revisionId: string,
): Promise<RevisionWithScreenplay | undefined> {
  const result = await queryable.query<RevisionWithScreenplay>(
    `select ${REVISION_ROW_COLUMNS}, canonical_screenplay as "canonicalScreenplay"
       from document_revisions
      where screenplay_id = $1 and id = $2`,
    [screenplayId, revisionId],
  );
  return result.rows[0];
}

export interface InsertRevisionParams {
  screenplayId: string;
  sourceEpoch: number;
  kind: RevisionKind;
  /** Non-null only for `kind: 'named'`; every automatic kind passes `null`. Enforced by callers
   * (`apps/api/src/revisions.ts`'s zod input, `apps/collab/src/revisions.ts`'s own triggers),
   * not by this function -- this layer stays a thin, ungated write path, matching
   * `apps/collab/src/updateLog.ts`'s `appendUpdate`. */
  label: string | null;
  authoredBy: string | null;
  /** Already-serialized `JSON.stringify(screenplay)` -- every caller needs the identical string
   * to also compute `canonicalHash` from, so this function takes the string once rather than
   * stringifying a second time on the hot path (the same reasoning `apps/api/src/projects.ts`'s
   * own `canonicalHash` doc comment gives for its sibling `screenplays` writes). */
  canonicalScreenplayJson: string;
  canonicalHash: string;
  renderedText: string;
  // `object`, not `Record<string, unknown>`: this function only ever `JSON.stringify`s the value,
  // never reads a property off it, so it stays deliberately loose about the shape -- every real
  // caller passes `@finaler-draft/screenplay`'s `RevisionPreviewMetadata`
  // (`{ sceneCount, blockCount }`), a plain object type with no index signature, which a
  // `Record<string, unknown>` parameter would reject without a needless cast at every call site.
  previewMetadata: object | null;
}

export interface InsertRevisionResult extends RevisionRow {
  /** `true`: a new row was actually inserted. `false`: `canonicalHash` matched the screenplay's
   * latest existing revision exactly, so nothing new was written and every other field describes
   * *that* pre-existing revision instead. Every caller that needs a revision id to point at
   * (an export's `source_revision_id`, a named milestone's confirmation) can use the result
   * either way -- `created` only distinguishes "new" from "reused" for a caller that cares (a
   * test, or a UI that wants to say "nothing changed since your last revision"). */
  created: boolean;
}

// `named` is the one kind this choke point never dedupes: a writer who explicitly asks to label
// *this exact moment* needs that label to survive, even when the content happens to be
// byte-identical to an existing automatic revision. Deduping it anyway was this module's own
// original design -- caught wrong by `revision-history-persistence.spec.ts` (apps/web/e2e), a
// real browser test: typing a writer's first words into an empty screenplay already crosses the
// structural-change threshold (0 blocks to 1 is a 100% block-change ratio), so by the time a
// writer opens "Save named revision..." moments later, `screenplays.canonical_hash` already
// matches an automatic `structural_change` revision `createStore` just wrote. Deduping the named
// save against it silently discarded the writer's own label and returned the automatic row
// instead -- content-correct, but the one thing a named milestone exists to add (a findable,
// writer-chosen name) was gone. `idle_session`, `structural_change`, and `export` all carry no
// label of their own, so deduping them loses nothing observable; `named` is categorically
// different, and is excluded here rather than papered over by the caller.
const KINDS_DEDUPED_ON_UNCHANGED_HASH: ReadonlySet<RevisionKind> = new Set([
  'idle_session',
  'structural_change',
  'export',
]);

/**
 * The one place `document_revisions` is ever inserted into, from either process that writes
 * automatic or explicit revisions (`apps/collab/src/revisions.ts` for `idle_session`/
 * `structural_change`, `apps/api/src/revisions.ts` for `named`/`export`). This is deliberately a
 * single shared choke point rather than duplicated per-caller insert logic: plan.md's sharp
 * warning -- "If pagination mutates the document, the hash changes when nobody edited anything,
 * and revision history fills with automatic commits" -- names a correctness invariant
 * ("never create a revision when the canonical projection is unchanged"), and a codebase that
 * enforced it twice, once per writer, would risk exactly the "two copies drifting" failure this
 * repo's own conventions warn against elsewhere (see `progress/collaboration-offline-durable.md`'s
 * quarantine-generalization reasoning).
 *
 * The dedupe itself applies to every kind in `KINDS_DEDUPED_ON_UNCHANGED_HASH` above -- a new row
 * is never inserted for one of those kinds when its `canonicalHash` equals the screenplay's
 * current latest revision's hash; the reused, pre-existing revision is returned instead (see
 * `InsertRevisionResult.created`'s own comment for why that, not a silent no-op, is what lets an
 * export caller always get back a concrete revision id to reference). `kind: 'named'` is never
 * deduped -- see that constant's own comment for the real defect this fixed.
 *
 * Takes the dedicated `REVISION_LOCK_NAMESPACE` advisory lock (held for this transaction's whole
 * lifetime) before reading the current latest revision, so two concurrent writers for the same
 * screenplay -- the collab server's own idle-session timer and structural-change check racing each
 * other, or a writer exporting while an automatic trigger fires -- cannot both read the same
 * "latest" row and both decide, independently, to insert: the second transaction blocks until the
 * first commits, then re-reads a now-current "latest" that already reflects whatever the first one
 * did. This is the same shape `apps/collab/src/updateLog.ts`'s `acquireDocumentEpochLock` uses for
 * the identical class of problem, applied to a different table. The lock is still taken
 * unconditionally, including for `named`, so a concurrent dedupe-checking writer always sees a
 * `named` insert that landed first.
 */
export async function insertRevisionIfChanged(
  pool: Pool,
  params: InsertRevisionParams,
): Promise<InsertRevisionResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await acquireRevisionLock(client, params.screenplayId);
    if (KINDS_DEDUPED_ON_UNCHANGED_HASH.has(params.kind)) {
      // Deliberately the lighter `RevisionRow` query, not `latestRevision` (which also pulls
      // `canonicalScreenplay`): the only thing this dedupe check needs is the hash, and a
      // revision's full canonical projection can be large -- no reason to pull it over the wire on
      // every write attempt, including the common case where nothing changed and it is discarded
      // immediately.
      const existingResult = await client.query<RevisionRow>(
        `select ${REVISION_ROW_COLUMNS}
           from document_revisions
          where screenplay_id = $1
          order by created_at desc, id desc
          limit 1`,
        [params.screenplayId],
      );
      const existing = existingResult.rows[0];
      if (existing && existing.canonicalHash === params.canonicalHash) {
        await client.query('commit');
        return { ...existing, created: false };
      }
    }
    const inserted = await client.query<RevisionRow>(
      `insert into document_revisions
         (screenplay_id, source_epoch, kind, label, authored_by, canonical_screenplay,
          canonical_hash, rendered_text, preview_metadata)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)
       returning ${REVISION_ROW_COLUMNS}`,
      [
        params.screenplayId,
        params.sourceEpoch,
        params.kind,
        params.label,
        params.authoredBy,
        params.canonicalScreenplayJson,
        params.canonicalHash,
        params.renderedText,
        params.previewMetadata ? JSON.stringify(params.previewMetadata) : null,
      ],
    );
    await client.query('commit');
    return { ...inserted.rows[0]!, created: true };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
