import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from './auth.js';
import { buildApp } from './app.js';
import { createPostgresProjectStore } from './projects.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const executeFile = promisify(execFile);
const databaseName = `finaler_draft_test_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = adminUrl ? databaseUrlFor(adminUrl, databaseName) : undefined;
let admin: Pool | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let pool: Pool | undefined;
let store: ReturnType<typeof createPostgresProjectStore> | undefined;
let databaseCreated = false;

describe.skipIf(!databaseUrl)('PostgreSQL persistence integration', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl });
    await admin.query(`create database ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await runMigrations();
    await runMigrations();

    const authentication = createAuth({
      DATABASE_URL: databaseUrl!,
      BETTER_AUTH_SECRET: 'integration-test-secret-with-at-least-thirty-two-characters',
      BETTER_AUTH_URL: 'http://127.0.0.1:3001',
    });
    pool = authentication.pool;
    store = createPostgresProjectStore(pool);
    app = await buildApp({
      auth: {
        baseUrl: 'http://127.0.0.1:3001',
        handler: authentication.auth.handler,
        getActorId: async (headers) =>
          (await authentication.auth.api.getSession({ headers }))?.user.id ?? null,
      },
      projects: store,
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin && databaseCreated) {
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [databaseName],
      );
      await admin.query(`drop database if exists ${quoteIdentifier(databaseName)}`);
    }
    await admin?.end();
  });

  it('migrates the schema and preserves the database invariants', async () => {
    const tables = await pool!.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'account',
        'project_members',
        'projects',
        'screenplays',
        'session',
        'user',
        'verification',
      ]),
    );
    const ownerIndex = await pool!.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'project_single_owner_unique'",
    );
    expect(ownerIndex.rows[0]?.indexdef).toContain("WHERE (role = 'owner'::project_role)");
    const screenplayColumns = await pool!.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'screenplays'",
    );
    expect(screenplayColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['canonical_screenplay', 'canonical_hash', 'version', 'deleted_at']),
    );
    const projectColumns = await pool!.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'projects'",
    );
    expect(projectColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['deleted_at']),
    );
  });

  it('uses real Better Auth sessions to authorize project and screenplay operations', async () => {
    const owner = await signUp('owner@example.test');
    const unauthenticated = await app!.inject({ method: 'GET', url: '/api/projects' });
    expect(unauthenticated.statusCode).toBe(401);

    const session = await app!.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: owner.cookie },
    });
    expect(session.statusCode).toBe(200);

    const signedOut = await app!.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: owner.cookie },
    });
    expect(signedOut.statusCode).toBe(200);
    const ownerSession = await signIn('owner@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: ownerSession },
      payload: { title: 'Private project' },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json<{ id: string }>().id;

    const screenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: ownerSession },
      payload: { title: 'Private script', screenplay: screenplayFixture },
    });
    expect(screenplay.statusCode).toBe(201);
    const screenplayId = screenplay.json<{ id: string }>().id;

    const loadedByOwner = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: ownerSession },
    });
    expect(loadedByOwner.statusCode).toBe(200);
    expect(loadedByOwner.json()).toMatchObject({
      id: screenplayId,
      screenplay: { id: screenplayId },
    });
    const ownerScreenplay = loadedByOwner.json<{ screenplay: typeof screenplayFixture }>()
      .screenplay;
    const invalidIdentity = await app!.inject({
      method: 'PUT',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: ownerSession },
      payload: {
        expectedVersion: 1,
        screenplay: { ...ownerScreenplay, id: randomUUID() },
      },
    });
    expect(invalidIdentity.statusCode).toBe(400);
    expect(invalidIdentity.json()).toEqual({
      error: 'Screenplay identity must match request path',
    });

    const other = await signUp('other@example.test');
    const deniedCreate = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: other.cookie },
      payload: { title: 'Unauthorized', screenplay: screenplayFixture },
    });
    expect(deniedCreate.statusCode).toBe(403);
    const deniedRead = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: other.cookie },
    });
    const unknownRead = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${randomUUID()}`,
      headers: { cookie: other.cookie },
    });
    expect(deniedRead.statusCode).toBe(404);
    expect(deniedRead.json()).toEqual(unknownRead.json());
    const deniedUpdate = await app!.inject({
      method: 'PUT',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: other.cookie },
      payload: { expectedVersion: 1, screenplay: screenplayFixture },
    });
    expect(deniedUpdate.statusCode).toBe(404);

    const saved = await app!.inject({
      method: 'PUT',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: ownerSession },
      payload: { expectedVersion: 1, screenplay: ownerScreenplay },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ version: 2 });
  });

  it('serializes same-version saves and prevents saves after revocation or role downgrade', async () => {
    await signUp('concurrency-owner@example.test');
    await signUp('concurrency-editor@example.test');
    const ownerId = await userIdFor('concurrency-owner@example.test');
    const editorId = await userIdFor('concurrency-editor@example.test');
    const project = await store!.createProject(ownerId, 'Concurrent project');
    await pool!.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'editor')",
      [project.id, editorId],
    );
    const screenplay = await store!.createScreenplay(ownerId, project.id, {
      title: 'Concurrent script',
      screenplay: screenplayFixture,
    });
    const first = store!.updateScreenplay(editorId, screenplay.id, {
      expectedVersion: 1,
      screenplay: screenplayFor(screenplay.id),
    });
    const second = store!.updateScreenplay(editorId, screenplay.id, {
      expectedVersion: 1,
      screenplay: screenplayFor(screenplay.id),
    });
    const saves = await Promise.all([first, second]);
    expect(saves).toContainEqual({ version: 2 });
    expect(saves).toContain('conflict');

    const revoker = await pool!.connect();
    try {
      await revoker.query('begin');
      await revoker.query('delete from project_members where project_id = $1 and user_id = $2', [
        project.id,
        editorId,
      ]);
      const saveAfterRevocation = store!.updateScreenplay(editorId, screenplay.id, {
        expectedVersion: 2,
        screenplay: screenplayFor(screenplay.id),
      });
      await revoker.query('commit');
      expect(await saveAfterRevocation).toBe('missing');
    } finally {
      await revoker.query('rollback');
      revoker.release();
    }

    await pool!.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'editor')",
      [project.id, editorId],
    );
    const downgradeScreenplay = await store!.createScreenplay(ownerId, project.id, {
      title: 'Downgrade script',
      screenplay: screenplayFixture,
    });
    const downgrader = await pool!.connect();
    try {
      await downgrader.query('begin');
      await downgrader.query(
        "update project_members set role = 'reviewer' where project_id = $1 and user_id = $2",
        [project.id, editorId],
      );
      const saveAfterDowngrade = store!.updateScreenplay(editorId, downgradeScreenplay.id, {
        expectedVersion: 1,
        screenplay: screenplayFor(downgradeScreenplay.id),
      });
      await downgrader.query('commit');
      expect(await saveAfterDowngrade).toBe('forbidden');
    } finally {
      await downgrader.query('rollback');
      downgrader.release();
    }
  });

  it('renames and soft-deletes/restores a project, excluding it and its screenplays from every read path until restored', async () => {
    const owner = await signUp('rename-delete-owner@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Original Title' },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json<{ id: string }>().id;

    const screenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Draft', screenplay: screenplayFixture },
    });
    expect(screenplay.statusCode).toBe(201);
    const screenplayId = screenplay.json<{ id: string }>().id;

    const renamed = await app!.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Renamed Project' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ id: projectId, title: 'Renamed Project' });

    const listedAfterRename = await app!.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
    });
    expect(listedAfterRename.json<Array<{ id: string; title: string }>>()).toContainEqual(
      expect.objectContaining({ id: projectId, title: 'Renamed Project' }),
    );

    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: owner.cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: projectId });

    // A soft-deleted project must not occupy a slot in any list, and its screenplay must be
    // unreachable by direct id even though its own row was never touched.
    const listedAfterDelete = await app!.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
    });
    expect(listedAfterDelete.json<Array<{ id: string }>>()).not.toContainEqual(
      expect.objectContaining({ id: projectId }),
    );
    const screenplaysAfterDelete = await app!.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
    });
    expect(screenplaysAfterDelete.json()).toEqual([]);
    const screenplayAfterDelete = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(screenplayAfterDelete.statusCode).toBe(404);

    const restored = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ id: projectId, title: 'Renamed Project' });

    const listedAfterRestore = await app!.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
    });
    expect(listedAfterRestore.json<Array<{ id: string }>>()).toContainEqual(
      expect.objectContaining({ id: projectId }),
    );
    const screenplayAfterRestore = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(screenplayAfterRestore.statusCode).toBe(200);
  });

  it('returns 404 rather than 403 for a soft-deleted screenplay to a user who could read it before, rejects a save into it with 404 not 409, and renames the screenplay row without touching the canonical document title', async () => {
    const owner = await signUp('screenplay-delete-owner@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Project' },
    });
    const projectId = project.json<{ id: string }>().id;
    const screenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Draft', screenplay: screenplayFixture },
    });
    const screenplayId = screenplay.json<{ id: string }>().id;

    // Prove this user genuinely could read it before deletion — otherwise a 404 proves nothing
    // about the deleted-vs-unauthorised distinction.
    const beforeDelete = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(beforeDelete.statusCode).toBe(200);

    const renamedRow = await app!.inject({
      method: 'PATCH',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Renamed Draft' },
    });
    expect(renamedRow.statusCode).toBe(200);
    expect(renamedRow.json()).toEqual({ id: screenplayId, title: 'Renamed Draft' });
    const afterRowRename = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    // Renaming the row must not touch the canonical document's own `title` field: the two are
    // deliberately independent fields (see the comment in projects.ts). The row title changed;
    // the in-document title, still the fixture's original, did not.
    expect(afterRowRename.json<{ title: string; screenplay: { title: string } }>()).toMatchObject({
      title: 'Renamed Draft',
      screenplay: { title: screenplayFixture.title },
    });

    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: screenplayId });

    const afterDelete = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(afterDelete.statusCode).toBe(404);

    // The realistic failure mode: a stale client autosaving into a screenplay that was just
    // deleted from under it. This must read as "not found," never as a version conflict — a 409
    // would send the client into conflict-recovery for a document that no longer exists.
    const saveAfterDelete = await app!.inject({
      method: 'PUT',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
      payload: { expectedVersion: 1, screenplay: screenplayFor(screenplayId) },
    });
    expect(saveAfterDelete.statusCode).toBe(404);

    // Restore is authorised the same way delete is: an editor can do both, a reviewer can do
    // neither, and both outcomes are proven against the real database and real sessions here.
    const editor = await signUp('screenplay-delete-editor@example.test');
    const editorId = await userIdFor('screenplay-delete-editor@example.test');
    await pool!.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'editor')",
      [projectId, editorId],
    );
    const reviewer = await signUp('screenplay-delete-reviewer@example.test');
    const reviewerId = await userIdFor('screenplay-delete-reviewer@example.test');
    await pool!.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'reviewer')",
      [projectId, reviewerId],
    );

    const reviewerRestore = await app!.inject({
      method: 'POST',
      url: `/api/screenplays/${screenplayId}/restore`,
      headers: { cookie: reviewer.cookie },
    });
    expect(reviewerRestore.statusCode).toBe(403);

    const editorRestore = await app!.inject({
      method: 'POST',
      url: `/api/screenplays/${screenplayId}/restore`,
      headers: { cookie: editor.cookie },
    });
    expect(editorRestore.statusCode).toBe(200);
    expect(editorRestore.json()).toEqual({ id: screenplayId, title: 'Renamed Draft' });

    const afterRestore = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(afterRestore.statusCode).toBe(200);
  });

  it('refuses to restore a screenplay whose project is still deleted, and leaves an independently deleted screenplay deleted after its project is restored', async () => {
    const owner = await signUp('cascade-owner@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Cascade project' },
    });
    const projectId = project.json<{ id: string }>().id;
    const screenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Independently deleted', screenplay: screenplayFixture },
    });
    const screenplayId = screenplay.json<{ id: string }>().id;

    // Delete the screenplay on its own, before the project is ever touched.
    const deletedScreenplay = await app!.inject({
      method: 'DELETE',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(deletedScreenplay.statusCode).toBe(200);

    // Now delete the project too.
    const deletedProject = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: owner.cookie },
    });
    expect(deletedProject.statusCode).toBe(200);

    // Restoring the screenplay must not be the one door left open on an unreachable resource:
    // its project is still deleted, so the project must be restored first.
    const restoreWhileProjectDeleted = await app!.inject({
      method: 'POST',
      url: `/api/screenplays/${screenplayId}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(restoreWhileProjectDeleted.statusCode).toBe(404);

    const restoredProject = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(restoredProject.statusCode).toBe(200);

    // The screenplay was deleted independently of the project, before the project was ever
    // deleted, so restoring the project must not resurrect it: the store never wrote to the
    // screenplay's own `deletedAt`, so restoring the project has nothing to undo for it.
    const screenplaysAfterProjectRestore = await app!.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
    });
    expect(screenplaysAfterProjectRestore.json()).toEqual([]);
    const screenplayAfterProjectRestore = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(screenplayAfterProjectRestore.statusCode).toBe(404);

    // With the project active again, the screenplay's own restore now succeeds.
    const screenplayRestore = await app!.inject({
      method: 'POST',
      url: `/api/screenplays/${screenplayId}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(screenplayRestore.statusCode).toBe(200);
    const screenplayAfterOwnRestore = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(screenplayAfterOwnRestore.statusCode).toBe(200);
  });

  it('refuses to restore a project or screenplay that is not currently deleted', async () => {
    const owner = await signUp('not-deleted-owner@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Active project' },
    });
    const projectId = project.json<{ id: string }>().id;
    const screenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Active screenplay', screenplay: screenplayFixture },
    });
    const screenplayId = screenplay.json<{ id: string }>().id;

    const projectRestore = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(projectRestore.statusCode).toBe(404);

    const screenplayRestore = await app!.inject({
      method: 'POST',
      url: `/api/screenplays/${screenplayId}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(screenplayRestore.statusCode).toBe(404);
  });

  it('authorises project deletion to the owner only, distinct from screenplay deletion which an editor may also do', async () => {
    const owner = await signUp('owner-only-owner@example.test');
    const editor = await signUp('owner-only-editor@example.test');
    const editorId = await userIdFor('owner-only-editor@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Owner-only project' },
    });
    const projectId = project.json<{ id: string }>().id;
    await pool!.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'editor')",
      [projectId, editorId],
    );
    const screenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Draft', screenplay: screenplayFixture },
    });
    const screenplayId = screenplay.json<{ id: string }>().id;

    const editorDeletesProject = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: editor.cookie },
    });
    expect(editorDeletesProject.statusCode).toBe(403);

    const editorDeletesScreenplay = await app!.inject({
      method: 'DELETE',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: editor.cookie },
    });
    expect(editorDeletesScreenplay.statusCode).toBe(200);

    const ownerDeletesProject = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerDeletesProject.statusCode).toBe(200);
  });

  it('excludes soft-deleted rows, and rows under a soft-deleted project, from every list while keeping active siblings visible', async () => {
    const owner = await signUp('list-exclusion-owner@example.test');

    const keptProject = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Kept project' },
    });
    const keptProjectId = keptProject.json<{ id: string }>().id;
    const deletedProject = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Deleted project' },
    });
    const deletedProjectId = deletedProject.json<{ id: string }>().id;

    // A screenplay created under the project that will be soft-deleted: its own row is never
    // touched by the project delete (the filter-based design), so this specifically proves
    // exclusion comes from the parent's state, not the child's own `deletedAt`.
    const orphanedScreenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${deletedProjectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Orphaned by project delete', screenplay: screenplayFixture },
    });
    const orphanedScreenplayId = orphanedScreenplay.json<{ id: string }>().id;

    const keptScreenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${keptProjectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Kept screenplay', screenplay: screenplayFixture },
    });
    const keptScreenplayId = keptScreenplay.json<{ id: string }>().id;
    const deletedScreenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${keptProjectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Deleted screenplay', screenplay: screenplayFixture },
    });
    const deletedScreenplayId = deletedScreenplay.json<{ id: string }>().id;

    const listedBeforeAnyDelete = await app!.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
    });
    expect(listedBeforeAnyDelete.json<Array<{ id: string }>>().map((p) => p.id)).toEqual(
      expect.arrayContaining([keptProjectId, deletedProjectId]),
    );
    const listedScreenplaysBeforeAnyDelete = await app!.inject({
      method: 'GET',
      url: `/api/projects/${keptProjectId}/screenplays`,
      headers: { cookie: owner.cookie },
    });
    expect(listedScreenplaysBeforeAnyDelete.json<Array<{ id: string }>>().map((s) => s.id)).toEqual(
      expect.arrayContaining([keptScreenplayId, deletedScreenplayId]),
    );

    await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${deletedProjectId}`,
      headers: { cookie: owner.cookie },
    });
    await app!.inject({
      method: 'DELETE',
      url: `/api/screenplays/${deletedScreenplayId}`,
      headers: { cookie: owner.cookie },
    });

    const projectIds = (
      await app!.inject({ method: 'GET', url: '/api/projects', headers: { cookie: owner.cookie } })
    )
      .json<Array<{ id: string }>>()
      .map((p) => p.id);
    expect(projectIds).toContain(keptProjectId);
    expect(projectIds).not.toContain(deletedProjectId);

    const keptProjectScreenplayIds = (
      await app!.inject({
        method: 'GET',
        url: `/api/projects/${keptProjectId}/screenplays`,
        headers: { cookie: owner.cookie },
      })
    )
      .json<Array<{ id: string }>>()
      .map((s) => s.id);
    expect(keptProjectScreenplayIds).toContain(keptScreenplayId);
    expect(keptProjectScreenplayIds).not.toContain(deletedScreenplayId);

    // The orphaned screenplay's own `deletedAt` was never written; it is excluded purely because
    // its parent project is soft-deleted.
    const orphanedProjectScreenplayIds = (
      await app!.inject({
        method: 'GET',
        url: `/api/projects/${deletedProjectId}/screenplays`,
        headers: { cookie: owner.cookie },
      })
    )
      .json<Array<{ id: string }>>()
      .map((s) => s.id);
    expect(orphanedProjectScreenplayIds).not.toContain(orphanedScreenplayId);
    const orphanedRow = await pool!.query<{ deleted_at: Date | null }>(
      'select deleted_at from screenplays where id = $1',
      [orphanedScreenplayId],
    );
    expect(orphanedRow.rows[0]?.deleted_at).toBeNull();
  });

  it('404s a direct GET of a screenplay whose project alone is deleted, without touching the screenplay row itself', async () => {
    const owner = await signUp('direct-get-owner@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Direct get project' },
    });
    const projectId = project.json<{ id: string }>().id;
    const screenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Direct get screenplay', screenplay: screenplayFixture },
    });
    const screenplayId = screenplay.json<{ id: string }>().id;

    const before = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(before.statusCode).toBe(200);

    // Delete the project only. The screenplay row itself is never written.
    const projectDelete = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: owner.cookie },
    });
    expect(projectDelete.statusCode).toBe(200);

    const after = await app!.inject({
      method: 'GET',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(after.statusCode).toBe(404);

    const screenplayRow = await pool!.query<{ deleted_at: Date | null }>(
      'select deleted_at from screenplays where id = $1',
      [screenplayId],
    );
    expect(screenplayRow.rows[0]?.deleted_at).toBeNull();
  });

  it('denies project rename, delete, and restore to a non-member with 404, and to a member with an insufficient role with 403', async () => {
    const owner = await signUp('matrix-owner@example.test');
    const editor = await signUp('matrix-editor@example.test');
    const editorId = await userIdFor('matrix-editor@example.test');
    const stranger = await signUp('matrix-stranger@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Matrix project' },
    });
    const projectId = project.json<{ id: string }>().id;
    await pool!.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'editor')",
      [projectId, editorId],
    );

    // A non-member must not learn the project exists.
    const strangerRename = await app!.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      headers: { cookie: stranger.cookie },
      payload: { title: 'Stolen' },
    });
    expect(strangerRename.statusCode).toBe(404);
    const strangerDelete = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: stranger.cookie },
    });
    expect(strangerDelete.statusCode).toBe(404);

    // An editor may rename (canEdit) but not delete (owner-only) — the two operations are
    // deliberately authorised differently.
    const editorRename = await app!.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      headers: { cookie: editor.cookie },
      payload: { title: 'Renamed by editor' },
    });
    expect(editorRename.statusCode).toBe(200);
    const editorDelete = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: editor.cookie },
    });
    expect(editorDelete.statusCode).toBe(403);

    const ownerDelete = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerDelete.statusCode).toBe(200);

    // Restore mirrors delete's authorisation exactly: owner-only, and a non-member still gets
    // 404 even though the project genuinely is deleted (existence must not leak to a stranger).
    const strangerRestore = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/restore`,
      headers: { cookie: stranger.cookie },
    });
    expect(strangerRestore.statusCode).toBe(404);
    const editorRestore = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/restore`,
      headers: { cookie: editor.cookie },
    });
    expect(editorRestore.statusCode).toBe(403);
    const ownerRestore = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerRestore.statusCode).toBe(200);
  });

  it('denies screenplay rename and delete to a non-member with 404', async () => {
    const owner = await signUp('screenplay-stranger-owner@example.test');
    const stranger = await signUp('screenplay-stranger@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Stranger project' },
    });
    const projectId = project.json<{ id: string }>().id;
    const screenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Stranger screenplay', screenplay: screenplayFixture },
    });
    const screenplayId = screenplay.json<{ id: string }>().id;

    const strangerRename = await app!.inject({
      method: 'PATCH',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: stranger.cookie },
      payload: { title: 'Stolen' },
    });
    expect(strangerRename.statusCode).toBe(404);
    const strangerDelete = await app!.inject({
      method: 'DELETE',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: stranger.cookie },
    });
    expect(strangerDelete.statusCode).toBe(404);
  });

  it('refuses to create a screenplay in a soft-deleted project, so a stray click cannot populate a project that is already inaccessible', async () => {
    const owner = await signUp('create-into-deleted-owner@example.test');
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Soon deleted' },
    });
    const projectId = project.json<{ id: string }>().id;
    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: owner.cookie },
    });
    expect(deleted.statusCode).toBe(200);

    const createAttempt = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Should not exist', screenplay: screenplayFixture },
    });
    expect(createAttempt.statusCode).toBe(403);
  });

  it('lists deleted items scoped to who can actually restore them, and excludes a screenplay whose project is also deleted', async () => {
    const owner = await signUp('deleted-list-owner@example.test');
    const editor = await signUp('deleted-list-editor@example.test');
    const editorId = await userIdFor('deleted-list-editor@example.test');
    const reviewer = await signUp('deleted-list-reviewer@example.test');
    const reviewerId = await userIdFor('deleted-list-reviewer@example.test');

    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Restorable project' },
    });
    const projectId = project.json<{ id: string }>().id;
    await pool!.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'reviewer')",
      [projectId, editorId, reviewerId],
    );
    const screenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Restorable screenplay', screenplay: screenplayFixture },
    });
    const screenplayId = screenplay.json<{ id: string }>().id;

    // Deleted independently of its project, before the project is ever touched -- the case a
    // screenplay-under-a-deleted-project listing must still exclude, distinct from an orphaned
    // screenplay whose own `deleted_at` was never written.
    const cascadeProject = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { title: 'Cascade project' },
    });
    const cascadeProjectId = cascadeProject.json<{ id: string }>().id;
    const cascadeScreenplay = await app!.inject({
      method: 'POST',
      url: `/api/projects/${cascadeProjectId}/screenplays`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Independently deleted then orphaned', screenplay: screenplayFixture },
    });
    const cascadeScreenplayId = cascadeScreenplay.json<{ id: string }>().id;
    await app!.inject({
      method: 'DELETE',
      url: `/api/screenplays/${cascadeScreenplayId}`,
      headers: { cookie: owner.cookie },
    });
    await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${cascadeProjectId}`,
      headers: { cookie: owner.cookie },
    });

    // Delete the screenplay before the project, exactly as with the cascade case above: once a
    // project is deleted, `deleteScreenplay` can no longer reach a screenplay under it at all
    // (lockScreenplayRow requires an active project unconditionally), so deleting in the other
    // order would silently leave this screenplay's own `deleted_at` unset and defeat the point of
    // the test.
    const independentDelete = await app!.inject({
      method: 'DELETE',
      url: `/api/screenplays/${screenplayId}`,
      headers: { cookie: owner.cookie },
    });
    expect(independentDelete.statusCode).toBe(200);
    await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: owner.cookie },
    });

    // `screenplayId` is now independently deleted under a project that is itself also deleted --
    // the same cascade shape as `cascadeScreenplayId`: both must be excluded from the
    // deleted-screenplays list, and both restores must be refused until their project is restored
    // first.
    const ownerListed = await app!.inject({
      method: 'GET',
      url: '/api/deleted',
      headers: { cookie: owner.cookie },
    });
    expect(ownerListed.statusCode).toBe(200);
    const ownerBody = ownerListed.json<{
      projects: Array<{ id: string; title: string }>;
      screenplays: Array<{ id: string; title: string; projectId: string; projectTitle: string }>;
    }>();
    expect(ownerBody.projects.map((p) => p.id)).toEqual(
      expect.arrayContaining([projectId, cascadeProjectId]),
    );
    // Both screenplays are excluded: their parent project is deleted, so neither is restorable
    // by id yet. This is the assertion that fails if the store's `p.deleted_at is null` predicate
    // on the screenplays query is ever removed.
    expect(ownerBody.screenplays.map((s) => s.id)).not.toContain(screenplayId);
    expect(ownerBody.screenplays.map((s) => s.id)).not.toContain(cascadeScreenplayId);

    // Restore the first project only, leaving its screenplay independently deleted. Now that
    // screenplay becomes genuinely listable and restorable -- the project no longer blocks it --
    // while the cascade project (and its screenplay) remain excluded.
    await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/restore`,
      headers: { cookie: owner.cookie },
    });
    const afterProjectRestore = await app!.inject({
      method: 'GET',
      url: '/api/deleted',
      headers: { cookie: owner.cookie },
    });
    const afterRestoreBody = afterProjectRestore.json<{
      projects: Array<{ id: string }>;
      screenplays: Array<{ id: string; projectId: string; projectTitle: string }>;
    }>();
    expect(afterRestoreBody.projects.map((p) => p.id)).not.toContain(projectId);
    expect(afterRestoreBody.projects.map((p) => p.id)).toContain(cascadeProjectId);
    const restoredScreenplayEntry = afterRestoreBody.screenplays.find((s) => s.id === screenplayId);
    expect(restoredScreenplayEntry).toMatchObject({
      id: screenplayId,
      projectId,
      projectTitle: 'Restorable project',
    });
    expect(afterRestoreBody.screenplays.map((s) => s.id)).not.toContain(cascadeScreenplayId);

    // Scoping, checked from the editor's own session while `screenplayId` is still genuinely
    // deleted -- not after it has already been restored, which would make "the editor sees
    // nothing" trivially true regardless of whether the scoping rule actually works. The editor
    // must see exactly the one screenplay they are eligible to restore, and their listing of
    // deleted projects must stay empty (they are not `projectId`'s owner, and not a member of
    // `cascadeProjectId` at all).
    const editorListedBeforeRestore = await app!.inject({
      method: 'GET',
      url: '/api/deleted',
      headers: { cookie: editor.cookie },
    });
    const editorBodyBeforeRestore = editorListedBeforeRestore.json<{
      projects: unknown[];
      screenplays: Array<{ id: string }>;
    }>();
    expect(editorBodyBeforeRestore.projects).toEqual([]);
    expect(editorBodyBeforeRestore.screenplays.map((s) => s.id)).toEqual([screenplayId]);

    // The editor restores it themselves, proving they can act on what they can see -- the same
    // "owner or editor" rule restoreScreenplay itself enforces, not just what listDeleted returns.
    const screenplayRestore = await app!.inject({
      method: 'POST',
      url: `/api/screenplays/${screenplayId}/restore`,
      headers: { cookie: editor.cookie },
    });
    expect(screenplayRestore.statusCode).toBe(200);

    // After restoring, the editor's deleted-screenplays list is empty again, and a reviewer --
    // who can restore neither a project nor a screenplay -- sees nothing at all, at any point.
    const editorListedAfterRestore = await app!.inject({
      method: 'GET',
      url: '/api/deleted',
      headers: { cookie: editor.cookie },
    });
    expect(editorListedAfterRestore.json<{ projects: unknown[] }>().projects).toEqual([]);

    const reviewerListed = await app!.inject({
      method: 'GET',
      url: '/api/deleted',
      headers: { cookie: reviewer.cookie },
    });
    expect(reviewerListed.json()).toEqual({ projects: [], screenplays: [] });
  });
});

async function signUp(email: string) {
  const response = await app!.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { name: email.split('@')[0], email, password: 'correct-horse-battery-staple' },
  });
  expect(response.statusCode).toBe(200);
  return { cookie: sessionCookie(response.headers['set-cookie']) };
}

async function signIn(email: string) {
  const response = await app!.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response.headers['set-cookie']);
}

function sessionCookie(value: string | string[] | undefined) {
  const cookie = Array.isArray(value) ? value[0] : value;
  expect(cookie).toBeTypeOf('string');
  return cookie!.split(';', 1)[0]!;
}

function screenplayFor(id: string) {
  return { ...screenplayFixture, id };
}

async function userIdFor(email: string) {
  const result = await pool!.query<{ id: string }>('select id from "user" where email = $1', [
    email,
  ]);
  return result.rows[0]!.id;
}

function databaseUrlFor(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function runMigrations() {
  await executeFile('pnpm', ['--filter', '@finaler-draft/database', 'db:migrate'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
