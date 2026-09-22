import { createHash, randomUUID } from 'node:crypto';
import type { Screenplay } from '@finaler-draft/screenplay';
import { screenplaySchema } from '@finaler-draft/screenplay';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const projectTitle = z.string().trim().min(1).max(200);
export const createProjectInput = z.object({ title: projectTitle }).strict();
// Rename shares the exact same title constraints as create (`z.string().trim().min(1).max(200)`,
// matching the `varchar(200)` columns) and is used for both projects and screenplays: the two
// resources have identical title rules, so one schema covers both routes.
export const renameInput = z.object({ title: projectTitle }).strict();
// The nested `screenplay` field is the canonical screenplaySchema itself, not z.unknown(), so
// this schema is a complete, directly usable Fastify body schema: declaring it as a route's
// `body` validates title and screenplay together in one pass, with no separate manual
// `screenplaySchema.parse()` call needed in the handler.
export const createScreenplayInput = z
  .object({ title: projectTitle, screenplay: screenplaySchema })
  .strict();
export type CreateScreenplayInput = z.infer<typeof createScreenplayInput>;

type RenameResult = { id: string; title: string } | 'forbidden' | 'missing';
type DeleteResult = { id: string } | 'forbidden' | 'missing';
type RestoreResult = { id: string; title: string } | 'forbidden' | 'missing';

export interface ProjectStore {
  listProjects(
    actorId: string,
  ): Promise<Array<{ id: string; title: string; updatedAt: string; role: string }>>;
  createProject(actorId: string, title: string): Promise<{ id: string; title: string }>;
  renameProject(actorId: string, projectId: string, title: string): Promise<RenameResult>;
  // Soft delete only: nothing this store adds ever removes a row. Owner-only, because deleting a
  // project is the one action here whose blast radius is the whole project and everything under it.
  deleteProject(actorId: string, projectId: string): Promise<DeleteResult>;
  // Authorised identically to deleteProject. Restoring a project never reaches into its
  // screenplays: their own `deletedAt` was never touched by the delete (see the read-path
  // comment below), so unsetting the project's `deletedAt` is the complete operation.
  restoreProject(actorId: string, projectId: string): Promise<RestoreResult>;
  listScreenplays(
    actorId: string,
    projectId: string,
  ): Promise<Array<{ id: string; title: string; updatedAt: string }>>;
  createScreenplay(
    actorId: string,
    projectId: string,
    input: CreateScreenplayInput,
  ): Promise<{ id: string }>;
  getScreenplay(
    actorId: string,
    screenplayId: string,
  ): Promise<{ id: string; projectId: string; title: string; screenplay: Screenplay } | 'missing'>;
  // Renames only the screenplay row's `title` (the listing/display field). It deliberately never
  // touches `canonicalScreenplay` or `canonicalHash` — see the comment on `renameScreenplay` below
  // for why the two title fields are intentionally independent.
  renameScreenplay(actorId: string, screenplayId: string, title: string): Promise<RenameResult>;
  // Soft delete only. Same authorisation as editing the screenplay (owner or editor), since
  // deletion here is reversible and sits within a project both roles already collaborate on.
  deleteScreenplay(actorId: string, screenplayId: string): Promise<DeleteResult>;
  // Authorised identically to deleteScreenplay. A screenplay cannot be restored while its parent
  // project is itself soft-deleted (the project must be restored first) — the lookup this shares
  // with every other screenplay operation enforces that by construction.
  restoreScreenplay(actorId: string, screenplayId: string): Promise<RestoreResult>;
  // Powers the Deleted page. Each collection is scoped to what the actor may actually restore —
  // projects to owner membership (restoreProject is owner-only), screenplays to owner-or-editor
  // membership (restoreScreenplay's canEdit check) — so a listed row's Restore button can never
  // come back 403. Deleted screenplays additionally require their project to be active
  // (`p.deleted_at is null`): a screenplay independently deleted before its project was, and
  // still sitting under that now-deleted project, is not restorable by id yet (restoreScreenplay
  // shares lockScreenplayRow's project-active requirement), so listing it here would be the same
  // broken-control mistake. A screenplay merely orphaned by its project's deletion (its own
  // `deletedAt` still null) is excluded by `s.deleted_at is not null` alone and never reaches this
  // query in the first place — see the interface comment on deleteProject.
  listDeleted(actorId: string): Promise<{
    projects: Array<{ id: string; title: string; updatedAt: string; deletedAt: string }>;
    screenplays: Array<{
      id: string;
      title: string;
      updatedAt: string;
      deletedAt: string;
      projectId: string;
      projectTitle: string;
    }>;
  }>;
}

// Takes the already-serialized JSON, not the screenplay object, so every caller stringifies it
// exactly once: `JSON.stringify` of a full screenplay document is not free, and both call sites
// below need the identical serialized string anyway, one to store as `canonical_screenplay` and
// one to hash into `canonical_hash`. Stringifying twice per save was pure waste, not a
// correctness issue (the same object always serializes identically within one call), but it is
// on the hot path every autosave takes.
function canonicalHash(canonicalJson: string) {
  return createHash('sha256').update(canonicalJson).digest('hex');
}

// Every screenplay-touching operation in this store locks the screenplay row through this single
// helper rather than writing its own `select ... from screenplays where id = $1` — that is the
// structural guard against a future operation forgetting to join the parent project's state.
// `deleted` selects which side of history is being reached for: `false` (the default) is the
// live document any read/write/rename/delete operates on; `true` is the one used by restore,
// which must find a row that is currently soft-deleted.
//
// The join to `projects` and the `p.deleted_at is null` predicate are unconditional, including
// when `deleted: true`. That is deliberate, not an oversight: a screenplay can never be reached
// by id — for any operation, including restore — while its parent project is itself soft-deleted.
// The project must be restored first. Without this, restore would be the one door left open on an
// otherwise fully inaccessible screenplay.
async function lockScreenplayRow(
  client: Pick<PoolClient, 'query'>,
  screenplayId: string,
  deleted = false,
): Promise<{ projectId: string } | 'missing'> {
  const result = await client.query(
    `select s.project_id as "projectId"
       from screenplays s
       join projects p on p.id = s.project_id
      where s.id = $1
        and p.deleted_at is null
        and s.deleted_at is ${deleted ? 'not null' : 'null'}
      for update`,
    [screenplayId],
  );
  if (result.rowCount !== 1) return 'missing';
  return result.rows[0] as { projectId: string };
}

export function createPostgresProjectStore(pool: Pool): ProjectStore {
  return {
    async listProjects(actorId) {
      const result = await pool.query(
        'select p.id, p.title, p.updated_at as "updatedAt", m.role from projects p join project_members m on m.project_id = p.id where m.user_id = $1 and p.deleted_at is null order by p.updated_at desc',
        [actorId],
      );
      return result.rows.map((row) => ({
        ...row,
        updatedAt: new Date(row.updatedAt as Date).toISOString(),
      }));
    },
    async createProject(actorId, title) {
      const projectId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('insert into projects (id, title) values ($1, $2)', [projectId, title]);
        await client.query(
          "insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')",
          [projectId, actorId],
        );
        await client.query('commit');
        return { id: projectId, title };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async renameProject(actorId, projectId, title) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const project = await client.query(
          'select id from projects where id = $1 and deleted_at is null for update',
          [projectId],
        );
        if (project.rowCount !== 1) {
          await client.query('rollback');
          return 'missing';
        }
        const membership = await client.query(
          'select role from project_members where project_id = $1 and user_id = $2 for update',
          [projectId, actorId],
        );
        if (!membership.rowCount) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canEdit(membership.rows[0]?.role)) {
          await client.query('rollback');
          return 'forbidden';
        }
        const result = await client.query(
          'update projects set title = $1, updated_at = now() where id = $2 returning id, title',
          [title, projectId],
        );
        await client.query('commit');
        return result.rows[0] as { id: string; title: string };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async deleteProject(actorId, projectId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const project = await client.query(
          'select id from projects where id = $1 and deleted_at is null for update',
          [projectId],
        );
        if (project.rowCount !== 1) {
          await client.query('rollback');
          return 'missing';
        }
        const membership = await client.query(
          'select role from project_members where project_id = $1 and user_id = $2 for update',
          [projectId, actorId],
        );
        if (!membership.rowCount) {
          await client.query('rollback');
          return 'missing';
        }
        if (membership.rows[0]?.role !== 'owner') {
          await client.query('rollback');
          return 'forbidden';
        }
        await client.query('update projects set deleted_at = now() where id = $1', [projectId]);
        await client.query('commit');
        return { id: projectId };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async restoreProject(actorId, projectId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const project = await client.query(
          'select id from projects where id = $1 and deleted_at is not null for update',
          [projectId],
        );
        if (project.rowCount !== 1) {
          await client.query('rollback');
          return 'missing';
        }
        const membership = await client.query(
          'select role from project_members where project_id = $1 and user_id = $2 for update',
          [projectId, actorId],
        );
        if (!membership.rowCount) {
          await client.query('rollback');
          return 'missing';
        }
        if (membership.rows[0]?.role !== 'owner') {
          await client.query('rollback');
          return 'forbidden';
        }
        const result = await client.query(
          'update projects set deleted_at = null, updated_at = now() where id = $1 returning id, title',
          [projectId],
        );
        await client.query('commit');
        return result.rows[0] as { id: string; title: string };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async listScreenplays(actorId, projectId) {
      const result = await pool.query(
        'select s.id, s.title, s.updated_at as "updatedAt" from screenplays s join project_members m on m.project_id = s.project_id join projects p on p.id = s.project_id where s.project_id = $1 and m.user_id = $2 and s.deleted_at is null and p.deleted_at is null order by s.updated_at desc',
        [projectId, actorId],
      );
      return result.rows.map((row) => ({
        ...row,
        updatedAt: new Date(row.updatedAt as Date).toISOString(),
      }));
    },
    async createScreenplay(actorId, projectId, input) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Joined to `projects` and requiring it active, so creating into a soft-deleted project
        // is denied the same way creating into a nonexistent project always was: this membership
        // lookup finds no role, `canEdit(undefined)` is false, and the existing ForbiddenError /
        // 403 path below handles it. A soft-deleted project must not be a place new screenplays
        // can be created, or they would be immediately unreachable by every read path added in
        // this slice.
        const membership = await client.query(
          'select m.role from project_members m join projects p on p.id = m.project_id where m.project_id = $1 and m.user_id = $2 and p.deleted_at is null for update',
          [projectId, actorId],
        );
        if (!canEdit(membership.rows[0]?.role)) throw new ForbiddenError();
        // The database primary key is also the canonical document identity.  Do not
        // trust a client-provided root id when creating a persisted screenplay.
        const screenplayId = randomUUID();
        const screenplay = { ...input.screenplay, id: screenplayId };
        const canonicalJson = JSON.stringify(screenplay);
        const result = await client.query(
          'insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash) values ($1, $2, $3, $4::jsonb, $5) returning id',
          [screenplayId, projectId, input.title, canonicalJson, canonicalHash(canonicalJson)],
        );
        await client.query('update projects set updated_at = now() where id = $1', [projectId]);
        await client.query('commit');
        return result.rows[0] as { id: string };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async getScreenplay(actorId, screenplayId) {
      const result = await pool.query(
        `select s.id, s.project_id as "projectId", s.title,
                s.canonical_screenplay as screenplay
           from screenplays s
           join projects p on p.id = s.project_id
           join project_members m on m.project_id = s.project_id
          where s.id = $1 and m.user_id = $2
            and s.deleted_at is null and p.deleted_at is null`,
        [screenplayId, actorId],
      );
      if (result.rowCount !== 1) return 'missing';
      const row = result.rows[0] as {
        id: string;
        projectId: string;
        screenplay: unknown;
        title: string;
      };
      return {
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        screenplay: screenplaySchema.parse(row.screenplay),
      };
    },
    async renameScreenplay(actorId, screenplayId, title) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const screenplay = await lockScreenplayRow(client, screenplayId);
        if (screenplay === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        const membership = await client.query(
          'select role from project_members where project_id = $1 and user_id = $2 for update',
          [screenplay.projectId, actorId],
        );
        if (!membership.rowCount) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canEdit(membership.rows[0]?.role)) {
          await client.query('rollback');
          return 'forbidden';
        }
        // Deliberately touches only the screenplay row's `title`, not `canonicalScreenplay` or
        // `canonicalHash`. Those two title fields are intentionally independent: the row title is
        // listing/display metadata, while any in-document title lives inside the canonical
        // document, which is now a projection of the Yjs document `apps/collab` maintains (see
        // `progress/collaboration-slice-1.md`) and is never written from this REST path. Coupling
        // them would mean this metadata-only rename could race the collaboration server's own
        // debounced projection write.
        const result = await client.query(
          'update screenplays set title = $1, updated_at = now() where id = $2 returning id, title',
          [title, screenplayId],
        );
        await client.query('commit');
        return result.rows[0] as { id: string; title: string };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async deleteScreenplay(actorId, screenplayId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const screenplay = await lockScreenplayRow(client, screenplayId);
        if (screenplay === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        const membership = await client.query(
          'select role from project_members where project_id = $1 and user_id = $2 for update',
          [screenplay.projectId, actorId],
        );
        if (!membership.rowCount) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canEdit(membership.rows[0]?.role)) {
          await client.query('rollback');
          return 'forbidden';
        }
        await client.query('update screenplays set deleted_at = now() where id = $1', [
          screenplayId,
        ]);
        await client.query('commit');
        return { id: screenplayId };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async restoreScreenplay(actorId, screenplayId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const screenplay = await lockScreenplayRow(client, screenplayId, true);
        if (screenplay === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        const membership = await client.query(
          'select role from project_members where project_id = $1 and user_id = $2 for update',
          [screenplay.projectId, actorId],
        );
        if (!membership.rowCount) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canEdit(membership.rows[0]?.role)) {
          await client.query('rollback');
          return 'forbidden';
        }
        const result = await client.query(
          'update screenplays set deleted_at = null, updated_at = now() where id = $1 returning id, title',
          [screenplayId],
        );
        await client.query('commit');
        return result.rows[0] as { id: string; title: string };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async listDeleted(actorId) {
      // A single `repeatable read` transaction, not two independent `pool.query` calls: the
      // response is two separate SELECTs composed into one payload, and without a shared
      // snapshot a concurrent restore between them could produce a response naming a project as
      // deleted while also listing a screenplay whose exclusion depends on that same project
      // being deleted (or vice versa) -- an inconsistent view that never existed in the database
      // at any single instant. `read only` is not just documentation: it lets Postgres skip the
      // write-conflict bookkeeping `repeatable read` otherwise tracks for a transaction that
      // never writes.
      const client = await pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        const projects = await client.query(
          `select p.id, p.title, p.updated_at as "updatedAt", p.deleted_at as "deletedAt"
             from projects p
             join project_members m on m.project_id = p.id
            where m.user_id = $1 and m.role = 'owner' and p.deleted_at is not null
            order by p.deleted_at desc`,
          [actorId],
        );
        // `p.deleted_at is null` is not redundant with `s.deleted_at is not null`: it excludes a
        // screenplay that was independently deleted and whose project was *also* later deleted,
        // which restoreScreenplay cannot reach until the project itself is restored (see the
        // interface comment on listDeleted). A screenplay merely orphaned by its project's
        // deletion never appears here regardless, since its own `deleted_at` stays null.
        const screenplays = await client.query(
          `select s.id, s.title, s.updated_at as "updatedAt", s.deleted_at as "deletedAt",
                  s.project_id as "projectId", p.title as "projectTitle"
             from screenplays s
             join project_members m on m.project_id = s.project_id
             join projects p on p.id = s.project_id
            where m.user_id = $1 and m.role in ('owner', 'editor')
              and s.deleted_at is not null and p.deleted_at is null
            order by s.deleted_at desc`,
          [actorId],
        );
        await client.query('commit');
        return {
          projects: projects.rows.map((row) => ({
            ...row,
            updatedAt: new Date(row.updatedAt as Date).toISOString(),
            deletedAt: new Date(row.deletedAt as Date).toISOString(),
          })),
          screenplays: screenplays.rows.map((row) => ({
            ...row,
            updatedAt: new Date(row.updatedAt as Date).toISOString(),
            deletedAt: new Date(row.deletedAt as Date).toISOString(),
          })),
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function canEdit(role: unknown) {
  return role === 'owner' || role === 'editor';
}

export class ForbiddenError extends Error {}
