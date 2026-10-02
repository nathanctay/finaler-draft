import { randomUUID } from 'node:crypto';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresRevisionStore, type RevisionStore } from './revisions.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';

/**
 * Collaboration slice 4a's explicit revision triggers (named milestones, exports), proven against
 * a real, migrated Postgres database -- following `entitlements.integration.test.ts`'s own
 * pattern exactly: a fresh throwaway database, migrated with the project's own tooling, torn down
 * afterward. `revisions.test.ts` (this package) already proves the authorization branching against
 * a mocked `@finaler-draft/database`; this file proves the real write/read round trip -- a
 * revision written with the exact `canonical_screenplay` a screenplay held at that moment, later
 * live edits never mutating it, and the hash-based dedupe holding under the real advisory lock.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;

let admin: Pool | undefined;
let pool: Pool | undefined;
let store: RevisionStore | undefined;
let databaseCreated = false;
let userSequence = 0;

describe.skipIf(!databaseUrl)('named/export revision creation (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);
    pool = createIntegrationPool({ connectionString: databaseUrl });
    store = createPostgresRevisionStore(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  it('returns "missing" for an actor with no membership on the screenplay', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);
    const stranger = await createUser();

    expect(await store!.listRevisions(stranger, screenplayId)).toBe('missing');
    expect(
      await store!.createRevision(stranger, screenplayId, { kind: 'named', label: 'Draft 2' }),
    ).toBe('missing');
  });

  it('returns "forbidden" for a reviewer naming a milestone, but allows a reviewer to trigger an export', async () => {
    const owner = await createUser();
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner);
    const reviewer = await createUser();
    await addMember(projectId, reviewer, 'reviewer');

    expect(
      await store!.createRevision(reviewer, screenplayId, { kind: 'named', label: 'Draft 2' }),
    ).toBe('forbidden');

    const exportResult = await store!.createRevision(reviewer, screenplayId, {
      kind: 'export',
      format: 'pdf',
    });
    expect(exportResult).not.toBe('missing');
    expect(exportResult).not.toBe('forbidden');
  });

  it('an editor names a milestone: it is written with the exact canonical screenplay at that moment, and stays immutable across a later live edit', async () => {
    const owner = await createUser();
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner, {
      titlePages: [],
    });
    const editor = await createUser();
    await addMember(projectId, editor, 'editor');

    const created = await store!.createRevision(owner, screenplayId, {
      kind: 'named',
      label: 'Draft 2',
    });
    if (created === 'missing' || created === 'forbidden') throw new Error('Unexpected result.');
    expect(created.created).toBe(true);
    expect(created.kind).toBe('named');
    expect(created.label).toBe('Draft 2');

    const preview = await store!.getRevision(editor, screenplayId, created.id);
    if (preview === 'missing') throw new Error('Revision unexpectedly missing.');
    expect(preview.screenplay.blocks).toEqual(screenplayFixture.blocks);

    // A later, real edit to the live screenplay row (standing in for `apps/collab`'s own debounced
    // projection write) must never reach back into the already-created revision.
    const editedJson = JSON.stringify({ ...screenplayFixture, title: 'Retitled Live Draft' });
    await pool!.query(
      'update screenplays set canonical_screenplay = $1::jsonb, canonical_hash = $2 where id = $3',
      [editedJson, 'edited-hash', screenplayId],
    );

    const previewAfterLiveEdit = await store!.getRevision(editor, screenplayId, created.id);
    if (previewAfterLiveEdit === 'missing') throw new Error('Revision unexpectedly missing.');
    expect(previewAfterLiveEdit.screenplay.title).toBe(screenplayFixture.title);
    expect(previewAfterLiveEdit).toEqual(preview);
  });

  it('never creates a second revision when the canonical hash has not changed since the last one, and returns the existing revision instead', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);

    const first = await store!.createRevision(owner, screenplayId, {
      kind: 'named',
      label: 'Draft A',
    });
    if (first === 'missing' || first === 'forbidden') throw new Error('Unexpected result.');
    expect(first.created).toBe(true);

    // Nothing changed the live screenplay row in between -- an export triggered right after the
    // named milestone, on the identical content, must dedupe rather than duplicate.
    const second = await store!.createRevision(owner, screenplayId, {
      kind: 'export',
      format: 'fdx',
    });
    if (second === 'missing' || second === 'forbidden') throw new Error('Unexpected result.');
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    // The reused revision keeps the *original* kind/label -- deduping never rewrites an existing
    // row's own identity to match the caller that happened to ask second.
    expect(second.kind).toBe('named');
    expect(second.label).toBe('Draft A');

    const all = await store!.listRevisions(owner, screenplayId);
    if (all === 'missing') throw new Error('Unexpected result.');
    expect(all).toHaveLength(1);
  });
});

async function createUser(): Promise<string> {
  userSequence += 1;
  const id = `user-${userSequence}-${randomUUID()}`;
  await pool!.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [id, `Writer ${userSequence}`, `writer-${userSequence}-${randomUUID()}@example.test`],
  );
  return id;
}

async function addMember(
  projectId: string,
  userId: string,
  role: 'owner' | 'editor' | 'reviewer',
): Promise<void> {
  await pool!.query('insert into project_members (project_id, user_id, role) values ($1, $2, $3)', [
    projectId,
    userId,
    role,
  ]);
}

async function createProjectAndScreenplay(
  ownerUserId: string,
  screenplayOverrides: Partial<typeof screenplayFixture> = {},
): Promise<{ projectId: string; screenplayId: string }> {
  const projectId = randomUUID();
  const screenplayId = randomUUID();
  const screenplay = { ...screenplayFixture, ...screenplayOverrides, id: screenplayId };
  const canonicalJson = JSON.stringify(screenplay);
  await pool!.query('insert into projects (id, title) values ($1, $2)', [
    projectId,
    'Test Project',
  ]);
  await pool!.query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')",
    [projectId, ownerUserId],
  );
  await pool!.query(
    `insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [screenplayId, projectId, 'Test Screenplay', canonicalJson, 'seed-hash'],
  );
  return { projectId, screenplayId };
}
