import type { Pool } from 'pg';
import { z } from 'zod';
import {
  computeRevisionPreviewMetadata,
  screenplaySchema,
  screenplayToPlainText,
  type Screenplay,
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
export const createRevisionInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('named'), label: revisionLabel }).strict(),
  z.object({ kind: z.literal('export'), format: exportFormatSchema }).strict(),
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

type ListResult = RevisionListItem[] | 'missing';
type GetResult = RevisionDetail | 'missing';
/** `created: true` when this call actually inserted a new row; `false` when
 * `insertRevisionIfChanged`'s dedupe reused the screenplay's already-existing latest revision
 * because nothing had changed -- see that function's own comment on why reusing, rather than
 * refusing, is what lets an export or a named-milestone attempt always resolve to a concrete
 * revision id. */
type CreateResult = (RevisionListItem & { created: boolean }) | 'missing' | 'forbidden';

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
}

function canEdit(role: unknown): boolean {
  return role === 'owner' || role === 'editor';
}

/** Resolves whether `actorId` may read `screenplayId` at all -- the identical join
 * `getScreenplay` (`projects.ts`) already uses: any project role, screenplay and project both
 * active. Returns the actor's role so `createRevision` can additionally check `canEdit` for the
 * `named` case without a second query. */
async function resolveMembership(
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

      const current = await pool.query<{ canonicalScreenplay: unknown; canonicalHash: string }>(
        `select canonical_screenplay as "canonicalScreenplay", canonical_hash as "canonicalHash"
           from screenplays
          where id = $1 and deleted_at is null`,
        [screenplayId],
      );
      const row = current.rows[0];
      // Deleted between the membership check above and this read -- a genuine, if narrow, race;
      // treated the same as "missing" everywhere else in this codebase treats a vanished row.
      if (!row) return 'missing';

      const screenplay = screenplaySchema.parse(row.canonicalScreenplay);
      const canonicalScreenplayJson = JSON.stringify(screenplay);

      const result = await insertRevisionIfChanged(pool, {
        screenplayId,
        // `apps/collab`'s own `DEFAULT_EPOCH` is `0` and not (yet) varied by anything in this
        // codebase -- see that constant's own comment. Not imported from `apps/collab` (apps do
        // not depend on one another in this monorepo); restated here as the same literal, for the
        // same reason `canonicalHash`'s own sha256 wrapper is restated rather than shared.
        sourceEpoch: 0,
        kind: input.kind,
        label: input.kind === 'named' ? input.label : null,
        // Both `named` and `export` are explicit actions by a specific, authenticated actor --
        // unlike `idle_session`/`structural_change`, which `apps/collab/src/revisions.ts` creates
        // with no single human author to attribute.
        authoredBy: actorId,
        canonicalScreenplayJson,
        canonicalHash: row.canonicalHash,
        renderedText: screenplayToPlainText(screenplay),
        previewMetadata: computeRevisionPreviewMetadata(screenplay),
      });
      return { ...toListItem(result), created: result.created };
    },
  };
}
