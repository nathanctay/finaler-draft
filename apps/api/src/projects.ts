import { createHash, randomUUID } from 'node:crypto';
import type { Screenplay } from '@finaler-draft/screenplay';
import { screenplaySchema } from '@finaler-draft/screenplay';
import type { Pool } from 'pg';
import { z } from 'zod';

const projectTitle = z.string().trim().min(1).max(200);
export const createProjectInput = z.object({ title: projectTitle }).strict();
// The nested `screenplay` field is the canonical screenplaySchema itself, not z.unknown(), so
// this schema is a complete, directly usable Fastify body schema: declaring it as a route's
// `body` validates title and screenplay together in one pass, with no separate manual
// `screenplaySchema.parse()` call needed in the handler.
export const createScreenplayInput = z
  .object({ title: projectTitle, screenplay: screenplaySchema })
  .strict();
export const updateScreenplayInput = z
  .object({ expectedVersion: z.number().int().positive(), screenplay: screenplaySchema })
  .strict();
export type CreateScreenplayInput = z.infer<typeof createScreenplayInput>;
export type UpdateScreenplayInput = z.infer<typeof updateScreenplayInput>;

export interface ProjectStore {
  listProjects(
    actorId: string,
  ): Promise<Array<{ id: string; title: string; updatedAt: string; role: string }>>;
  createProject(actorId: string, title: string): Promise<{ id: string; title: string }>;
  listScreenplays(
    actorId: string,
    projectId: string,
  ): Promise<Array<{ id: string; title: string; version: number; updatedAt: string }>>;
  createScreenplay(
    actorId: string,
    projectId: string,
    input: CreateScreenplayInput,
  ): Promise<{ id: string; version: number }>;
  getScreenplay(
    actorId: string,
    screenplayId: string,
  ): Promise<
    | { id: string; projectId: string; title: string; version: number; screenplay: Screenplay }
    | 'missing'
  >;
  updateScreenplay(
    actorId: string,
    screenplayId: string,
    input: UpdateScreenplayInput,
  ): Promise<{ version: number } | 'forbidden' | 'conflict' | 'invalid' | 'missing'>;
}

function screenplayHash(screenplay: Screenplay) {
  return createHash('sha256').update(JSON.stringify(screenplay)).digest('hex');
}

export function createPostgresProjectStore(pool: Pool): ProjectStore {
  return {
    async listProjects(actorId) {
      const result = await pool.query(
        'select p.id, p.title, p.updated_at as "updatedAt", m.role from projects p join project_members m on m.project_id = p.id where m.user_id = $1 order by p.updated_at desc',
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
    async listScreenplays(actorId, projectId) {
      const result = await pool.query(
        'select s.id, s.title, s.version, s.updated_at as "updatedAt" from screenplays s join project_members m on m.project_id = s.project_id where s.project_id = $1 and m.user_id = $2 order by s.updated_at desc',
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
        const membership = await client.query(
          'select role from project_members where project_id = $1 and user_id = $2 for update',
          [projectId, actorId],
        );
        if (!canEdit(membership.rows[0]?.role)) throw new ForbiddenError();
        // The database primary key is also the canonical document identity.  Do not
        // trust a client-provided root id when creating a persisted screenplay.
        const screenplayId = randomUUID();
        const screenplay = { ...input.screenplay, id: screenplayId };
        const result = await client.query(
          'insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash) values ($1, $2, $3, $4::jsonb, $5) returning id, version',
          [
            screenplayId,
            projectId,
            input.title,
            JSON.stringify(screenplay),
            screenplayHash(screenplay),
          ],
        );
        await client.query('update projects set updated_at = now() where id = $1', [projectId]);
        await client.query('commit');
        return result.rows[0] as { id: string; version: number };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async getScreenplay(actorId, screenplayId) {
      const result = await pool.query(
        `select s.id, s.project_id as "projectId", s.title, s.version,
                s.canonical_screenplay as screenplay
           from screenplays s
           join project_members m on m.project_id = s.project_id
          where s.id = $1 and m.user_id = $2`,
        [screenplayId, actorId],
      );
      if (result.rowCount !== 1) return 'missing';
      const row = result.rows[0] as {
        id: string;
        projectId: string;
        screenplay: unknown;
        title: string;
        version: number;
      };
      return {
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        version: row.version,
        screenplay: screenplaySchema.parse(row.screenplay),
      };
    },
    async updateScreenplay(actorId, screenplayId, input) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const screenplay = await client.query(
          'select project_id, version from screenplays where id = $1 for update',
          [screenplayId],
        );
        if (screenplay.rowCount !== 1) {
          await client.query('rollback');
          return 'missing';
        }
        const row = screenplay.rows[0] as { project_id: string; version: number };
        const membership = await client.query(
          'select role from project_members where project_id = $1 and user_id = $2 for update',
          [row.project_id, actorId],
        );
        if (!membership.rowCount) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canEdit(membership.rows[0]?.role)) {
          await client.query('rollback');
          return 'forbidden';
        }
        if (input.screenplay.id !== screenplayId) {
          await client.query('rollback');
          return 'invalid';
        }
        if (row.version !== input.expectedVersion) {
          await client.query('rollback');
          return 'conflict';
        }
        const result = await client.query(
          'update screenplays set canonical_screenplay = $1::jsonb, canonical_hash = $2, version = version + 1, updated_at = now() where id = $3 returning version',
          [JSON.stringify(input.screenplay), screenplayHash(input.screenplay), screenplayId],
        );
        await client.query('update projects set updated_at = now() where id = $1', [
          row.project_id,
        ]);
        await client.query('commit');
        return { version: result.rows[0]?.version as number };
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
