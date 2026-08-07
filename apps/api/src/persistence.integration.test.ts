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
      expect.arrayContaining(['canonical_screenplay', 'canonical_hash', 'version']),
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
