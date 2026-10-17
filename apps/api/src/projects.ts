import { createHash, randomUUID } from 'node:crypto';
import type { Screenplay } from '@finaler-draft/screenplay';
import { screenplaySchema } from '@finaler-draft/screenplay';
import {
  roleCanEdit,
  ROLE_PRECEDENCE_SQL,
  screenplayRoleLateral,
  type EffectiveRole,
} from '@finaler-draft/database';
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

/**
 * The screenplay-invitations slice splits this interface's methods into two groups, and which group
 * a method is in is the whole of its screenplay-scoped authorization story:
 *
 * **Project-scoped, deliberately unchanged** -- `listProjects`, `createProject`, `renameProject`,
 * `deleteProject`, `restoreProject`, `createScreenplay`, and `listDeleted`'s `projects` collection.
 * These resolve membership from `project_members` alone, exactly as before. A member invited to one
 * screenplay has no `project_members` row, so every one of them refuses that member with no change
 * to their SQL at all: they cannot rename the project, delete it, restore it, create a new
 * screenplay in it, or see it in their project list. That is the fail-closed half of the modelling
 * choice recorded on `screenplayMembers` in packages/database/src/schema.ts -- a path nobody
 * remembered to widen denies, it does not over-grant.
 *
 * **Screenplay-scoped, widened through `screenplayRoleLateral`** -- `listScreenplays`,
 * `getScreenplay`, `renameScreenplay`, `deleteScreenplay`, `restoreScreenplay`, `listDeleted`'s
 * `screenplays` collection, and the new `listSharedScreenplays`. Each resolves the actor's
 * effective role on one specific screenplay, so a screenplay-scoped member reaches exactly the
 * screenplay they were invited to and no sibling in the same project. There is one definition of
 * that resolution (`@finaler-draft/database`'s `membership.ts`), shared with `revisions.ts`,
 * `entitlementStore.ts` and `apps/collab/src/authenticate.ts`.
 */
export interface ProjectStore {
  // Project membership only -- see the interface comment above. A screenplay-scoped member's
  // shared screenplay reaches their dashboard through `listSharedScreenplays` instead, as a
  // screenplay rather than as a project, which is also why this needed no new wire field: they
  // never land on the project page, so no project-level control is ever shown to someone who
  // cannot use it.
  listProjects(
    actorId: string,
  ): Promise<Array<{ id: string; title: string; updatedAt: string; role: string }>>;
  /**
   * Every screenplay this actor can reach *only* through screenplay-scoped membership -- the
   * "Shared with you" section of the dashboard. Deliberately excludes any screenplay whose project
   * the actor is already a member of: that project is already in `listProjects`, and listing its
   * screenplays a second time here would show the same work twice under two different headings.
   *
   * Carries `projectId` because the editor's route is `/projects/$projectId/screenplays/
   * $screenplayId` -- the invitee navigates straight into the screenplay, never through the project
   * page they have no access to -- and `projectTitle` so the row can say where the screenplay
   * lives without implying the project itself is theirs.
   */
  listSharedScreenplays(actorId: string): Promise<
    Array<{
      id: string;
      title: string;
      updatedAt: string;
      projectId: string;
      projectTitle: string;
      role: EffectiveRole;
    }>
  >;
  createProject(actorId: string, title: string): Promise<{ id: string; title: string }>;
  renameProject(actorId: string, projectId: string, title: string): Promise<RenameResult>;
  // Soft delete only: nothing this store adds ever removes a row. Owner-only, because deleting a
  // project is the one action here whose blast radius is the whole project and everything under it.
  deleteProject(actorId: string, projectId: string): Promise<DeleteResult>;
  // Authorised identically to deleteProject. Restoring a project never reaches into its
  // screenplays: their own `deletedAt` was never touched by the delete (see the read-path
  // comment below), so unsetting the project's `deletedAt` is the complete operation.
  restoreProject(actorId: string, projectId: string): Promise<RestoreResult>;
  // `role` is the actor's own effective role on each listed screenplay, which the widened lateral
  // already resolves for free. It exists so the per-row three-dot menu can decide whether to offer
  // "Share…" at all rather than rendering a control that always answers 403 -- the broken-control
  // mistake `listDeleted`'s own interface comment already names.
  listScreenplays(
    actorId: string,
    projectId: string,
  ): Promise<Array<{ id: string; title: string; updatedAt: string; role: EffectiveRole }>>;
  createScreenplay(
    actorId: string,
    projectId: string,
    input: CreateScreenplayInput,
  ): Promise<{ id: string }>;
  getScreenplay(
    actorId: string,
    screenplayId: string,
  ): Promise<
    | {
        id: string;
        projectId: string;
        title: string;
        screenplay: Screenplay;
        /** The screenplay's current collaboration epoch (`screenplays.current_epoch`) --
         * collaboration slice 5. The browser cannot name the Hocuspocus document to connect to, or
         * key its own offline store, without it; see `app.ts`'s `screenplayResponseSchema`. */
        currentEpoch: number;
        /** The actor's own effective role on this screenplay, resolved by the same lateral that
         * authorized the read. The editor's File menu uses it to decide whether "Share…" is
         * offered; it is never what gates a write, which stays the server's decision on every
         * path. */
        role: EffectiveRole;
      }
    | 'missing'
  >;
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
//
// Since the screenplay-invitations slice this also resolves the actor's **effective role** on that
// screenplay, in the same statement and under the same row lock, via
// `@finaler-draft/database`'s `screenplayRoleLateral` -- so `renameScreenplay`/`deleteScreenplay`/
// `restoreScreenplay` no longer each run their own `select role from project_members ... for
// update` afterwards. Two things improve: the role is read from the same snapshot as the row it
// authorizes rather than a statement later, and there is exactly one place a screenplay-scoped
// membership has to be honoured for all three operations instead of three.
//
// `for update of s, p` rather than a bare `for update`: the lateral subquery is a derived table, and
// a locking clause cannot be applied to one. Naming the two base tables keeps precisely the locks
// the bare form already took (the screenplay row these operations update, and the project row whose
// `deleted_at` they just checked -- which is what makes a concurrent `deleteProject` serialize
// against a rename rather than interleave with it) and takes no lock on the role lookup, which
// needs none.
async function lockScreenplayRow(
  client: Pick<PoolClient, 'query'>,
  screenplayId: string,
  actorId: string,
  deleted = false,
): Promise<{ projectId: string; role: string } | 'missing'> {
  const result = await client.query(
    `select s.project_id as "projectId", m.role
       from screenplays s
       join projects p on p.id = s.project_id
       cross join lateral ${screenplayRoleLateral('$2')} m
      where s.id = $1
        and p.deleted_at is null
        and s.deleted_at is ${deleted ? 'not null' : 'null'}
      for update of s, p`,
    [screenplayId, actorId],
  );
  if (result.rowCount !== 1) return 'missing';
  return result.rows[0] as { projectId: string; role: string };
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
    async listSharedScreenplays(actorId) {
      // Driven by `screenplay_members_user_id_index`, the same shape `listProjects` above is
      // driven by `project_members_user_id_index` -- deliberately not a `cross join lateral` over
      // `screenplays`, which would have no actor predicate to start from and so would scan every
      // screenplay in the installation.
      //
      // `not exists (... project_members ...)` is what keeps this disjoint from `listProjects`: a
      // project member who *also* holds a screenplay-scoped grant inside the same project sees that
      // project in their project list and reaches the screenplay through it, so repeating it here
      // would show one piece of work twice under two headings. It is not an authorization
      // predicate -- removing it would widen nothing -- it is the de-duplication the dashboard's
      // two sections need.
      //
      // `distinct on (s.id)` with the shared precedence ordering collapses the (impossible today,
      // but structurally permitted) case of a screenplay reachable through more than one
      // screenplay-scoped row to its most privileged, matching `screenplayRoleLateral`'s own rule
      // rather than inventing a second one.
      const result = await pool.query(
        `select id, title, "updatedAt", "projectId", "projectTitle", role
           from (
             select distinct on (candidates.id)
                    candidates.id, candidates.title, candidates."updatedAt",
                    candidates."projectId", candidates."projectTitle", candidates.role
               from (
                 select s.id, s.title, s.updated_at as "updatedAt",
                        s.project_id as "projectId", p.title as "projectTitle",
                        sm.role::text as role
                   from screenplay_members sm
                   join screenplays s on s.id = sm.screenplay_id
                   join projects p on p.id = s.project_id
                  where sm.user_id = $1
                    and s.deleted_at is null
                    and p.deleted_at is null
                    and not exists (
                      select 1 from project_members pm
                       where pm.project_id = s.project_id and pm.user_id = $1
                    )
               ) candidates
              order by candidates.id, ${ROLE_PRECEDENCE_SQL}
           ) shared
          order by "updatedAt" desc`,
        [actorId],
      );
      return result.rows.map((row) => ({
        ...row,
        updatedAt: new Date(row.updatedAt as Date).toISOString(),
      })) as Array<{
        id: string;
        title: string;
        updatedAt: string;
        projectId: string;
        projectTitle: string;
        role: EffectiveRole;
      }>;
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
      // Resolved per screenplay through `screenplayRoleLateral`, not once per project through a
      // `project_members` join: that is the difference between "a screenplay-scoped member who
      // reaches this endpoint sees the one screenplay they were invited to" and "they see every
      // screenplay in the project." A project member's own result is unchanged -- their
      // `project_members` row satisfies the lateral for every screenplay under the project, so they
      // still see all of them.
      //
      // Driven by `screenplays_project_id_index` on `s.project_id = $1`, so the lateral runs once
      // per screenplay in one project (two index lookups each), never once per screenplay in the
      // installation.
      const result = await pool.query(
        `select s.id, s.title, s.updated_at as "updatedAt", m.role
           from screenplays s
           join projects p on p.id = s.project_id
           cross join lateral ${screenplayRoleLateral('$2')} m
          where s.project_id = $1
            and s.deleted_at is null
            and p.deleted_at is null
          order by s.updated_at desc`,
        [projectId, actorId],
      );
      return result.rows.map((row) => ({
        ...row,
        updatedAt: new Date(row.updatedAt as Date).toISOString(),
      })) as Array<{ id: string; title: string; updatedAt: string; role: EffectiveRole }>;
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
        //
        // `project_members` alone, deliberately, and not `screenplayRoleLateral`: creating a new
        // screenplay is a project-level act, and there is no screenplay for a screenplay-scoped
        // role to be resolved against in the first place. Someone invited to edit one screenplay
        // has no `project_members` row, so this finds no role and the existing 403 path refuses
        // them -- see the interface comment above on which methods are project-scoped and why.
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
      // The REST read half of the screenplay-scoped security property: `screenplayRoleLateral`
      // resolves a role for *this* screenplay only, so a member invited to one screenplay gets the
      // same `'missing'` -> 404 for a sibling screenplay in the same project that a complete
      // stranger gets. The former `join project_members m on m.project_id = s.project_id` would
      // have been satisfied by any membership anywhere in the project, which is exactly the
      // over-grant the separate-table modelling choice exists to make impossible to write by
      // accident.
      const result = await pool.query(
        `select s.id, s.project_id as "projectId", s.title,
                s.canonical_screenplay as screenplay, s.current_epoch as "currentEpoch", m.role
           from screenplays s
           join projects p on p.id = s.project_id
           cross join lateral ${screenplayRoleLateral('$2')} m
          where s.id = $1
            and s.deleted_at is null and p.deleted_at is null`,
        [screenplayId, actorId],
      );
      if (result.rowCount !== 1) return 'missing';
      const row = result.rows[0] as {
        id: string;
        projectId: string;
        screenplay: unknown;
        title: string;
        currentEpoch: number;
        role: EffectiveRole;
      };
      return {
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        screenplay: screenplaySchema.parse(row.screenplay),
        currentEpoch: row.currentEpoch,
        role: row.role,
      };
    },
    async renameScreenplay(actorId, screenplayId, title) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const screenplay = await lockScreenplayRow(client, screenplayId, actorId);
        if (screenplay === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        if (!canEdit(screenplay.role)) {
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
        const screenplay = await lockScreenplayRow(client, screenplayId, actorId);
        if (screenplay === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        if (!canEdit(screenplay.role)) {
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
        const screenplay = await lockScreenplayRow(client, screenplayId, actorId, true);
        if (screenplay === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        if (!canEdit(screenplay.role)) {
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
        // Resolved per screenplay through `screenplayRoleLateral`, matching `restoreScreenplay`'s
        // own authorization exactly -- which is the whole point of this collection (a listed row's
        // Restore button must never come back 403, see the interface comment). Both directions
        // matter: a screenplay-scoped editor's deleted screenplay now appears here, because they
        // genuinely can restore it; and a screenplay-scoped member's deleted *sibling* screenplays
        // do not, because they genuinely cannot. The former `join project_members ... and m.role in
        // (...)` would have shown them every deleted screenplay in the project.
        const screenplays = await client.query(
          `select s.id, s.title, s.updated_at as "updatedAt", s.deleted_at as "deletedAt",
                  s.project_id as "projectId", p.title as "projectTitle"
             from screenplays s
             join projects p on p.id = s.project_id
             cross join lateral ${screenplayRoleLateral('$1')} m
            where m.role in ('owner', 'editor')
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

// Delegates to `@finaler-draft/database`'s `roleCanEdit` rather than restating the predicate: a
// role reaching this function can now come from either `project_members` or `screenplay_members`
// (see `screenplayRoleLateral`), and "which roles may write" must mean the same thing in both
// services. The local name is kept because every call site in this file reads better with it.
function canEdit(role: unknown) {
  return roleCanEdit(role);
}

export class ForbiddenError extends Error {}
