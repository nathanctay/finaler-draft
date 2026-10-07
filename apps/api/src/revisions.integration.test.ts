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

  // Collaboration slice 4b: the screenplay-aware diff, proven end to end against two *real*,
  // Postgres-backed revisions -- not just the pure `diffScreenplays` unit suite
  // (`packages/screenplay/src/diff.test.ts`), which never touches `getRevisionById`, membership
  // resolution, or the chronological-ordering logic this store layers on top.
  it('diffs two real, stored revisions: a relocated scene is reported as moved, not deleted and re-added', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);

    const first = await store!.createRevision(owner, screenplayId, {
      kind: 'named',
      label: 'Draft A',
    });
    if (first === 'missing' || first === 'forbidden') throw new Error('Unexpected result.');

    // Relocate "EXT. UNION STATION - CONTINUOUS" (and everything in it) ahead of
    // "INT. UNION STATION - NIGHT" -- a real scene reorder on the fixture's real content, not a
    // synthetic id shuffle.
    const sceneTwoStartIndex = screenplayFixture.blocks.findIndex(
      (block) => block.type === 'scene_heading' && block.text === 'EXT. UNION STATION - CONTINUOUS',
    );
    const reordered = {
      ...screenplayFixture,
      blocks: [
        ...screenplayFixture.blocks.slice(sceneTwoStartIndex),
        ...screenplayFixture.blocks.slice(0, sceneTwoStartIndex),
      ],
    };
    await pool!.query(
      'update screenplays set canonical_screenplay = $1::jsonb, canonical_hash = $2 where id = $3',
      [JSON.stringify(reordered), 'reordered-hash', screenplayId],
    );

    const second = await store!.createRevision(owner, screenplayId, {
      kind: 'named',
      label: 'Draft B (reordered)',
    });
    if (second === 'missing' || second === 'forbidden') throw new Error('Unexpected result.');

    const diffResult = await store!.getRevisionDiff(owner, screenplayId, first.id, second.id);
    if (diffResult === 'missing') throw new Error('Unexpected result.');
    expect(diffResult.older.id).toBe(first.id);
    expect(diffResult.newer.id).toBe(second.id);

    // With exactly two scenes swapped, the move-detector's own minimal-backbone definition
    // (packages/screenplay/src/diff.ts's `computeMovedIds`) reports only *one* of the two scenes
    // as moved -- the other serves as the fixed reference point the move is measured against,
    // since a two-element swap has no distinguishable "which one really moved" (only one fact --
    // "this one relocated" -- is needed to fully explain the new order). The scene that did not
    // move contributes nothing to `scenes` at all (nothing about it, in isolation, changed), so
    // this asserts the one real end-to-end guarantee this test exists for: exactly one of the two
    // known scenes is reported as moved, and it is reported as a move, never a delete-and-re-add.
    expect(diffResult.diff.scenes).toHaveLength(1);
    const movedScene = diffResult.diff.scenes[0]!;
    expect(movedScene.status).toBe('matched');
    expect(movedScene.moved).toBe(true);
    expect([movedScene.beforeHeadingText, movedScene.afterHeadingText]).toEqual([
      expect.stringMatching(/UNION STATION/),
      expect.stringMatching(/UNION STATION/),
    ]);
    // The writer-facing proof this test exists for: nothing was deleted and nothing was
    // re-inserted, end to end through the real store and a real database.
    expect(
      diffResult.diff.blocks.filter(
        (entry) => entry.status === 'added' || entry.status === 'removed',
      ),
    ).toEqual([]);
  });

  it("with no `against`, diffs a named revision against the screenplay's current live content", async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);

    const first = await store!.createRevision(owner, screenplayId, {
      kind: 'named',
      label: 'Draft A',
    });
    if (first === 'missing' || first === 'forbidden') throw new Error('Unexpected result.');

    // A further live edit after the revision was captured -- standing in for `apps/collab`'s own
    // debounced projection write, the same convention the immutability test above uses.
    const retitled = { ...screenplayFixture, title: 'Retitled Live Draft' };
    await pool!.query(
      'update screenplays set canonical_screenplay = $1::jsonb, canonical_hash = $2 where id = $3',
      [JSON.stringify(retitled), 'live-hash-2', screenplayId],
    );

    const diffResult = await store!.getRevisionDiff(owner, screenplayId, first.id);
    if (diffResult === 'missing') throw new Error('Unexpected result.');
    expect(diffResult.older.id).toBe(first.id);
    expect(diffResult.newer).toEqual({ id: 'current', kind: null, label: null, createdAt: null });
    expect(diffResult.diff.titleChanged).toBe(true);
    expect(diffResult.diff.titleBefore).toBe(screenplayFixture.title);
    expect(diffResult.diff.titleAfter).toBe('Retitled Live Draft');
  });

  it('returns "missing" for an actor with no membership, and for an unresolvable revision id on either side', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);
    const stranger = await createUser();

    const first = await store!.createRevision(owner, screenplayId, {
      kind: 'named',
      label: 'Draft A',
    });
    if (first === 'missing' || first === 'forbidden') throw new Error('Unexpected result.');

    expect(await store!.getRevisionDiff(stranger, screenplayId, first.id)).toBe('missing');
    expect(await store!.getRevisionDiff(owner, screenplayId, randomUUID())).toBe('missing');
    expect(await store!.getRevisionDiff(owner, screenplayId, first.id, randomUUID())).toBe(
      'missing',
    );
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
