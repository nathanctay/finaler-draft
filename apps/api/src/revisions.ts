import type { Pool } from 'pg';
import { z } from 'zod';
import {
  computeRevisionPreviewMetadata,
  diffScreenplays,
  screenplaySchema,
  screenplayToPlainText,
  type Screenplay,
  type ScreenplayDiff,
} from '@finaler-draft/screenplay';
import {
  getRevisionById,
  insertRevisionIfChanged,
  listRevisionsForScreenplay,
  type RevisionKind,
  type RevisionRow,
} from '@finaler-draft/database';

/**
 * Collaboration slice 4a: the two *explicit* revision-creation triggers (plan.md's "named
 * milestones" and "exports" -- the other two, `idle_session` and `structural_change`, are created
 * automatically by `apps/collab/src/revisions.ts`, which has the live Yjs document this REST layer
 * deliberately never touches) plus read access to a screenplay's revision history for historical
 * preview.
 *
 * Every write here reads the screenplay's *current* `canonical_screenplay`/`canonical_hash` --
 * `apps/collab`'s own debounced projection, unchanged from what `GET /api/screenplays/:id` already
 * reads -- rather than opening a Yjs connection of its own. A named milestone or an export both
 * describe "capture what this screenplay looks like right now," and the collaboration server
 * already keeps that column current; there is no reason a REST action needs the live document to
 * answer that.
 */

const revisionLabel = z.string().trim().min(1).max(200);
export const exportFormatSchema = z.enum(['fdx', 'docx', 'pdf']);
/**
 * `epoch` is collaboration slice 5's stale-epoch rejection on the HTTP write path (plan.md step 4:
 * "The server rejects writes to the old epoch", on both paths). Required, not optional: the whole
 * point is that a client which still believes it is looking at a superseded epoch must be refused,
 * and an optional field would let exactly that client omit it and be accepted. The content such a
 * client would capture is never *wrong* -- `createRevision` always reads the screenplay's current
 * canonical projection, never the client's -- but a writer naming "this moment" after a restore has
 * replaced what they were looking at is labelling content they never saw, which is precisely the
 * silent mislabelling an audit trail must not contain. A 409 sends them back to the restored
 * document first.
 */
const revisionEpoch = z.number().int().min(0);
export const createRevisionInput = z.discriminatedUnion('kind', [
  z.object({ epoch: revisionEpoch, kind: z.literal('named'), label: revisionLabel }).strict(),
  z
    .object({ epoch: revisionEpoch, format: exportFormatSchema, kind: z.literal('export') })
    .strict(),
]);
export type CreateRevisionInput = z.infer<typeof createRevisionInput>;

export interface RevisionListItem {
  id: string;
  kind: RevisionKind;
  label: string | null;
  authoredBy: string | null;
  createdAt: string;
  previewMetadata: unknown;
}

export interface RevisionDetail extends RevisionListItem {
  screenplayId: string;
  /** The revision's own immutable canonical projection -- never the live, mutable
   * `screenplays.canonical_screenplay` -- see `getRevision`'s own comment. */
  screenplay: Screenplay;
}

/**
 * Collaboration slice 4b: one side of a screenplay-aware diff. `id: 'current'` is the one
 * non-revision value this field ever takes -- the live, mutable `screenplays.canonical_screenplay`
 * row, which has no revision id, kind, label, or fixed `createdAt` of its own (it is whatever the
 * document looks like right now). Every other value is a real `document_revisions.id`.
 */
export interface RevisionDiffSide {
  id: string;
  kind: RevisionKind | null;
  label: string | null;
  createdAt: string | null;
}

export interface RevisionDiffResult {
  screenplayId: string;
  /** The chronologically earlier side -- see `getRevisionDiff`'s own comment on why ordering is
   * decided by timestamp, not by which id the caller happened to pass as the primary revision. */
  older: RevisionDiffSide;
  newer: RevisionDiffSide;
  diff: ScreenplayDiff;
  /**
   * Both sides' full canonical projections, alongside the diff computed from them.
   *
   * The diff alone cannot be rendered as a document. `ScreenplayDiff` deliberately reports only
   * what is *interesting* (`diff.ts`'s own `isEntryInteresting` -- "what keeps a feature-length
   * script's diff proportional to the actual amount of change"), so an untouched block appears in it
   * nowhere at all. That is exactly right for a change report and exactly wrong for the inline view
   * the web app now renders, which shows the screenplay itself in document order with changes marked
   * in place: the unchanged lines between the changes are most of what the reader reads.
   *
   * Returned here rather than fetched by the client in two further requests for one reason that is
   * not convenience: **consistency**. When `against` is omitted the newer side is the screenplay's
   * *live* projection, which collaborators may be editing continuously. A client that fetched it
   * again separately could render a document that the diff beside it was never computed from, and the
   * resulting view would be quietly, unreproducibly wrong. These two values are the exact inputs
   * `diffScreenplays` was given, read in the same request, so the rendered document and the marks on
   * it can never disagree.
   *
   * The cost, stated plainly: this response now carries two whole screenplays. That is inherent to
   * serving a document view rather than a summary -- there is no smaller payload from which the
   * unchanged majority of a script could be reconstructed -- and it is the same order of payload
   * `GET /api/screenplays/:id/revisions/:revisionId` (historical preview) already returns for one.
   */
  olderScreenplay: Screenplay;
  newerScreenplay: Screenplay;
}

type ListResult = RevisionListItem[] | 'missing';
type GetResult = RevisionDetail | 'missing';
type DiffResult = RevisionDiffResult | 'missing';
/** `created: true` when this call actually inserted a new row; `false` when
 * `insertRevisionIfChanged`'s dedupe reused the screenplay's already-existing latest revision
 * because nothing had changed -- see that function's own comment on why reusing, rather than
 * refusing, is what lets an export or a named-milestone attempt always resolve to a concrete
 * revision id. */
type CreateResult =
  | (RevisionListItem & { created: boolean })
  | 'missing'
  | 'forbidden'
  /** The request's `epoch` is not this screenplay's current one -- see `createRevisionInput`'s own
   * comment. A flat literal rather than an object carrying the real epoch: the only remedy is for the
   * client to reload the screenplay, which re-reads the epoch from `GET /api/screenplays/:id`
   * alongside the content it also now needs, so a number here would be a value nothing would use. */
  | 'stale-epoch';

export interface RevisionStore {
  listRevisions(actorId: string, screenplayId: string): Promise<ListResult>;
  /**
   * A revision id alone is never trusted to resolve on its own -- always scoped to the
   * `screenplayId` the caller already knows (and was already authorized against), the identical
   * "id plus its known parent" discipline `apps/api/src/projects.ts`'s `lockScreenplayRow` uses.
   * This is what historical preview reads: a read-only projection of one immutable revision, never
   * the live document.
   */
  getRevision(actorId: string, screenplayId: string, revisionId: string): Promise<GetResult>;
  /**
   * `kind: 'named'` requires owner/editor membership -- an authored label is a deliberate act, the
   * same bar `renameScreenplay`/`deleteScreenplay` already set for this project. `kind: 'export'`
   * requires only membership (any role, reviewer included): plan.md is explicit that a lapsed or
   * read-only account still "keeps every screenplay readable and exportable," so exporting must
   * never be gated behind edit rights that reading and exporting themselves never required.
   */
  createRevision(
    actorId: string,
    screenplayId: string,
    input: CreateRevisionInput,
  ): Promise<CreateResult>;
  /**
   * Collaboration slice 4b's screenplay-aware diff (`@finaler-draft/screenplay`'s
   * `diffScreenplays`): compares `revisionId`'s own immutable canonical projection against either
   * another revision (`against`, a second `document_revisions.id`) or, when `against` is omitted,
   * the screenplay's *current* live projection -- `plan.md`'s restore flow, step 1, needs exactly
   * that comparison ("An authorized owner/editor previews a screenplay-aware diff and confirms the
   * target revision"), and this is what makes it available without building restore itself.
   *
   * Membership-only, the same bar `getRevision`/`listRevisions` already set: a diff is a read-only
   * comparison of two immutable (or, for "current," merely read-only-to-this-endpoint) snapshots,
   * never a write, so there is no reason to require edit rights to view one.
   */
  getRevisionDiff(
    actorId: string,
    screenplayId: string,
    revisionId: string,
    against?: string,
  ): Promise<DiffResult>;
}

export function canEdit(role: unknown): boolean {
  return role === 'owner' || role === 'editor';
}

/** Resolves whether `actorId` may read `screenplayId` at all -- the identical join
 * `getScreenplay` (`projects.ts`) already uses: any project role, screenplay and project both
 * active. Returns the actor's role so `createRevision` can additionally check `canEdit` for the
 * `named` case without a second query. */
export async function resolveMembership(
  pool: Pool,
  screenplayId: string,
  actorId: string,
): Promise<{ role: string } | 'missing'> {
  const result = await pool.query<{ role: string }>(
    `select m.role
       from screenplays s
       join projects p on p.id = s.project_id
       join project_members m on m.project_id = s.project_id
      where s.id = $1 and m.user_id = $2
        and s.deleted_at is null and p.deleted_at is null`,
    [screenplayId, actorId],
  );
  if (result.rowCount !== 1) return 'missing';
  return result.rows[0] as { role: string };
}

/** The screenplay's current, live canonical projection and hash -- `apps/collab`'s own debounced
 * projection, the same column `GET /api/screenplays/:id` reads. Shared by `createRevision` (an
 * export/named-milestone write always captures "what this screenplay looks like right now") and
 * `getRevisionDiff` (comparing a historical revision against "right now" is the default, no-
 * `against` case) rather than each duplicating the identical query. */
async function fetchCurrentScreenplay(
  pool: Pool,
  screenplayId: string,
): Promise<{ screenplay: Screenplay; canonicalHash: string; currentEpoch: number } | undefined> {
  const current = await pool.query<{
    canonicalScreenplay: unknown;
    canonicalHash: string;
    currentEpoch: number;
  }>(
    `select canonical_screenplay as "canonicalScreenplay", canonical_hash as "canonicalHash",
            current_epoch as "currentEpoch"
       from screenplays
      where id = $1 and deleted_at is null`,
    [screenplayId],
  );
  const row = current.rows[0];
  if (!row) return undefined;
  return {
    screenplay: screenplaySchema.parse(row.canonicalScreenplay),
    canonicalHash: row.canonicalHash,
    // Collaboration slice 5: every caller that writes on behalf of a client needs this to reject a
    // write confirmed against an epoch a restore has since retired. Read here, in the one helper
    // that already fetches the live row, rather than by a second query beside it.
    currentEpoch: row.currentEpoch,
  };
}

function toListItem(row: RevisionRow): RevisionListItem {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    authoredBy: row.authoredBy,
    createdAt: row.createdAt.toISOString(),
    previewMetadata: row.previewMetadata,
  };
}

export function createPostgresRevisionStore(pool: Pool): RevisionStore {
  return {
    async listRevisions(actorId, screenplayId) {
      const membership = await resolveMembership(pool, screenplayId, actorId);
      if (membership === 'missing') return 'missing';
      const rows = await listRevisionsForScreenplay(pool, screenplayId);
      return rows.map(toListItem);
    },

    async getRevision(actorId, screenplayId, revisionId) {
      const membership = await resolveMembership(pool, screenplayId, actorId);
      if (membership === 'missing') return 'missing';
      const row = await getRevisionById(pool, screenplayId, revisionId);
      if (!row) return 'missing';
      // A row this table itself wrote should always parse -- `screenplaySchema.parse` validated
      // it (directly or via the projection it was captured from) before it was ever inserted. A
      // failure here means something wrote to this table outside the paths this codebase
      // controls; treating that as "missing" rather than a 500 is the same fail-closed choice
      // `createFetch` (apps/collab/src/database.ts) makes for a screenplay row it cannot represent.
      const parsed = screenplaySchema.safeParse(row.canonicalScreenplay);
      if (!parsed.success) return 'missing';
      return { ...toListItem(row), screenplayId, screenplay: parsed.data };
    },

    async createRevision(actorId, screenplayId, input) {
      const membership = await resolveMembership(pool, screenplayId, actorId);
      if (membership === 'missing') return 'missing';
      if (input.kind === 'named' && !canEdit(membership.role)) return 'forbidden';

      const current = await fetchCurrentScreenplay(pool, screenplayId);
      // Deleted between the membership check above and this read -- a genuine, if narrow, race;
      // treated the same as "missing" everywhere else in this codebase treats a vanished row.
      if (!current) return 'missing';
      // Collaboration slice 5's HTTP half of "the server rejects writes to the old epoch": this
      // client confirmed against an epoch a restore has since retired, so what it is asking to
      // record describes a document state that no longer exists.
      if (input.epoch !== current.currentEpoch) return 'stale-epoch';
      const { screenplay, canonicalHash } = current;
      const canonicalScreenplayJson = JSON.stringify(screenplay);

      const result = await insertRevisionIfChanged(pool, {
        screenplayId,
        // The screenplay's real current epoch, read in the same query as the canonical projection
        // this revision captures -- not the literal `0` this line held before collaboration slice 5,
        // and not the client's `input.epoch` either (that is only ever a claim to be checked, never
        // a value to be written; the check above has already refused it if it disagreed).
        sourceEpoch: current.currentEpoch,
        kind: input.kind,
        label: input.kind === 'named' ? input.label : null,
        // Both `named` and `export` are explicit actions by a specific, authenticated actor --
        // unlike `idle_session`/`structural_change`, which `apps/collab/src/revisions.ts` creates
        // with no single human author to attribute.
        authoredBy: actorId,
        canonicalScreenplayJson,
        canonicalHash,
        renderedText: screenplayToPlainText(screenplay),
        previewMetadata: computeRevisionPreviewMetadata(screenplay),
      });
      return { ...toListItem(result), created: result.created };
    },

    async getRevisionDiff(actorId, screenplayId, revisionId, against) {
      const membership = await resolveMembership(pool, screenplayId, actorId);
      if (membership === 'missing') return 'missing';

      const baseRow = await getRevisionById(pool, screenplayId, revisionId);
      if (!baseRow) return 'missing';
      const baseParsed = screenplaySchema.safeParse(baseRow.canonicalScreenplay);
      // See `getRevision`'s own comment on why a row this table wrote failing to parse is treated
      // as "missing" rather than a 500.
      if (!baseParsed.success) return 'missing';
      const baseSide: RevisionDiffSide = {
        id: baseRow.id,
        kind: baseRow.kind,
        label: baseRow.label,
        createdAt: baseRow.createdAt.toISOString(),
      };

      let otherScreenplay: Screenplay;
      let otherSide: RevisionDiffSide;
      // `Number.POSITIVE_INFINITY` for "current": the live document is, by construction, never
      // older than any stored revision -- it is whatever the screenplay looks like right now, and
      // every revision is a snapshot of some earlier (or, at the very least, not-later) moment.
      let otherCreatedAtMs: number;
      if (against === undefined) {
        const current = await fetchCurrentScreenplay(pool, screenplayId);
        if (!current) return 'missing';
        otherScreenplay = current.screenplay;
        otherSide = { id: 'current', kind: null, label: null, createdAt: null };
        otherCreatedAtMs = Number.POSITIVE_INFINITY;
      } else {
        const otherRow = await getRevisionById(pool, screenplayId, against);
        if (!otherRow) return 'missing';
        const otherParsed = screenplaySchema.safeParse(otherRow.canonicalScreenplay);
        if (!otherParsed.success) return 'missing';
        otherScreenplay = otherParsed.data;
        otherSide = {
          id: otherRow.id,
          kind: otherRow.kind,
          label: otherRow.label,
          createdAt: otherRow.createdAt.toISOString(),
        };
        otherCreatedAtMs = otherRow.createdAt.getTime();
      }

      // Ordered by timestamp, not by which id the caller passed as `revisionId` vs. `against` --
      // "moved from position 3 to 7" and "added"/"removed" only read correctly in forward
      // chronological order. A tie (two rows with the identical millisecond `createdAt`, which
      // `insertRevisionIfChanged`'s advisory lock makes exceedingly unlikely but not provably
      // impossible) keeps `revisionId` as the older side -- an arbitrary but deterministic
      // tie-break, not a correctness-bearing choice.
      const baseIsOlder = baseRow.createdAt.getTime() <= otherCreatedAtMs;
      const older = baseIsOlder ? baseSide : otherSide;
      const newer = baseIsOlder ? otherSide : baseSide;
      const olderScreenplay = baseIsOlder ? baseParsed.data : otherScreenplay;
      const newerScreenplay = baseIsOlder ? otherScreenplay : baseParsed.data;

      return {
        screenplayId,
        older,
        newer,
        diff: diffScreenplays(olderScreenplay, newerScreenplay),
        olderScreenplay,
        newerScreenplay,
      };
    },
  };
}
