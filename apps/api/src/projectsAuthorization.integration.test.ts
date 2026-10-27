import { createHash, randomUUID } from 'node:crypto';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresProjectStore, type ProjectStore } from './projects.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';

/**
 * The owner-only-rename slice (progress/owner-only-rename.md), against a real migrated Postgres --
 * the half `projects.test.ts` deliberately mocks away with a fake pool, and the half
 * `packages/database/src/membership.test.ts` deliberately leaves to its caller (that suite asserts
 * `roleIsOwner`'s predicate and `screenplayRoleLateral`'s SQL shape; this suite is what would fail
 * if either one's real-world wiring were wrong).
 *
 * The property this suite exists to prove: `renameProject`, `deleteProject`, `restoreProject`,
 * `renameScreenplay`, `deleteScreenplay`, and `restoreScreenplay` all admit only an owner, and
 * refuse both an editor and a reviewer -- through **both** membership paths a role can be resolved
 * from. `screenplayRoleLateral` unions `project_members` and `screenplay_members` with
 * most-privileged-wins precedence, so a fixture that only ever grants `project_members` rows would
 * never exercise the `screenplay_members` branch at all, and a regression that widened *that*
 * branch specifically (e.g. a stray `roleCanEdit` left in place of `roleIsOwner` on the
 * screenplay-scoped path) would pass every project-membership-only test while still letting a
 * screenplay-scoped editor rename, delete, or restore a screenplay they do not own.
 *
 * `renameProject`/`deleteProject`/`restoreProject` are project-scoped only (see `ProjectStore`'s
 * own interface comment in `projects.ts`) -- there is no screenplay-scoped equivalent of "a member
 * invited to one screenplay" for a project-level operation, so those three are proven against
 * `project_members` alone. The three screenplay operations are proven against both tables.
 *
 * A screenplay-scoped membership can never itself be `'owner'` -- `shared_role` (the
 * `screenplay_members.role` enum) has no such value, enforced by the database itself (see
 * `sharing.integration.test.ts`'s "the database itself refuses a screenplay membership that names
 * the owner role"). So the owner-admitted case for a screenplay operation is proven only through
 * `project_members`; the `screenplay_members` path is proven on its two real roles, editor and
 * reviewer, both refused.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;

let admin: Pool | undefined;
let pool: Pool | undefined;
let store: ProjectStore | undefined;
let databaseCreated = false;
let userSequence = 0;

describe.skipIf(!databaseUrl)('owner-only rename/delete/restore authorization (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);
    pool = createIntegrationPool({ connectionString: databaseUrl });
    store = createPostgresProjectStore(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  describe('renameProject', () => {
    it('allows the owner', async () => {
      const owner = await createUser();
      const { projectId } = await createProject(owner);
      await expect(store!.renameProject(owner, projectId, 'Renamed')).resolves.toMatchObject({
        title: 'Renamed',
      });
    });

    it.each(['editor', 'reviewer'] as const)('refuses a project %s', async (role) => {
      const owner = await createUser();
      const { projectId } = await createProject(owner);
      const actor = await createUser();
      await addProjectMember(projectId, actor, role);
      await expect(store!.renameProject(actor, projectId, 'Renamed')).resolves.toBe('forbidden');
    });
  });

  describe('deleteProject', () => {
    it('allows the owner', async () => {
      const owner = await createUser();
      const { projectId } = await createProject(owner);
      await expect(store!.deleteProject(owner, projectId)).resolves.toEqual({ id: projectId });
    });

    it.each(['editor', 'reviewer'] as const)('refuses a project %s', async (role) => {
      const owner = await createUser();
      const { projectId } = await createProject(owner);
      const actor = await createUser();
      await addProjectMember(projectId, actor, role);
      await expect(store!.deleteProject(actor, projectId)).resolves.toBe('forbidden');
    });
  });

  describe('restoreProject', () => {
    it('allows the owner', async () => {
      const owner = await createUser();
      const { projectId } = await createProject(owner);
      await pool!.query('update projects set deleted_at = now() where id = $1', [projectId]);
      await expect(store!.restoreProject(owner, projectId)).resolves.toMatchObject({
        id: projectId,
      });
    });

    it.each(['editor', 'reviewer'] as const)('refuses a project %s', async (role) => {
      const owner = await createUser();
      const { projectId } = await createProject(owner);
      const actor = await createUser();
      await addProjectMember(projectId, actor, role);
      await pool!.query('update projects set deleted_at = now() where id = $1', [projectId]);
      await expect(store!.restoreProject(actor, projectId)).resolves.toBe('forbidden');
    });
  });

  describe('renameScreenplay', () => {
    it('allows the owner, resolved through project_members', async () => {
      const owner = await createUser();
      const { screenplayId } = await createProject(owner);
      await expect(store!.renameScreenplay(owner, screenplayId, 'Renamed')).resolves.toMatchObject({
        title: 'Renamed',
      });
    });

    it.each(['editor', 'reviewer'] as const)(
      'refuses a project %s, resolved through project_members',
      async (role) => {
        const owner = await createUser();
        const { projectId, screenplayId } = await createProject(owner);
        const actor = await createUser();
        await addProjectMember(projectId, actor, role);
        await expect(store!.renameScreenplay(actor, screenplayId, 'Renamed')).resolves.toBe(
          'forbidden',
        );
      },
    );

    it.each(['editor', 'reviewer'] as const)(
      'refuses a screenplay-scoped %s, resolved through screenplay_members -- not just project_members',
      async (role) => {
        const owner = await createUser();
        const { screenplayId } = await createProject(owner);
        // The actor is deliberately *not* a project member at all: they hold screenplay-scoped
        // membership only, which is exactly the shape `screenplayRoleLateral`'s `screenplay_members`
        // branch exists to resolve. A fixture that always granted a project_members row too would
        // never actually exercise that branch.
        const actor = await createUser();
        await addScreenplayMember(screenplayId, actor, role);
        await expect(store!.renameScreenplay(actor, screenplayId, 'Renamed')).resolves.toBe(
          'forbidden',
        );
      },
    );
  });

  describe('deleteScreenplay', () => {
    it('allows the owner, resolved through project_members', async () => {
      const owner = await createUser();
      const { screenplayId } = await createProject(owner);
      await expect(store!.deleteScreenplay(owner, screenplayId)).resolves.toEqual({
        id: screenplayId,
      });
    });

    it.each(['editor', 'reviewer'] as const)(
      'refuses a project %s, resolved through project_members',
      async (role) => {
        const owner = await createUser();
        const { projectId, screenplayId } = await createProject(owner);
        const actor = await createUser();
        await addProjectMember(projectId, actor, role);
        await expect(store!.deleteScreenplay(actor, screenplayId)).resolves.toBe('forbidden');
      },
    );

    it.each(['editor', 'reviewer'] as const)(
      'refuses a screenplay-scoped %s, resolved through screenplay_members -- not just project_members',
      async (role) => {
        const owner = await createUser();
        const { screenplayId } = await createProject(owner);
        const actor = await createUser();
        await addScreenplayMember(screenplayId, actor, role);
        await expect(store!.deleteScreenplay(actor, screenplayId)).resolves.toBe('forbidden');
      },
    );
  });

  describe('restoreScreenplay', () => {
    it('allows the owner, resolved through project_members', async () => {
      const owner = await createUser();
      const { screenplayId } = await createProject(owner);
      await pool!.query('update screenplays set deleted_at = now() where id = $1', [screenplayId]);
      await expect(store!.restoreScreenplay(owner, screenplayId)).resolves.toMatchObject({
        id: screenplayId,
      });
    });

    it.each(['editor', 'reviewer'] as const)(
      'refuses a project %s, resolved through project_members',
      async (role) => {
        const owner = await createUser();
        const { projectId, screenplayId } = await createProject(owner);
        const actor = await createUser();
        await addProjectMember(projectId, actor, role);
        await pool!.query('update screenplays set deleted_at = now() where id = $1', [
          screenplayId,
        ]);
        await expect(store!.restoreScreenplay(actor, screenplayId)).resolves.toBe('forbidden');
      },
    );

    it.each(['editor', 'reviewer'] as const)(
      'refuses a screenplay-scoped %s, resolved through screenplay_members -- not just project_members',
      async (role) => {
        const owner = await createUser();
        const { screenplayId } = await createProject(owner);
        const actor = await createUser();
        await addScreenplayMember(screenplayId, actor, role);
        await pool!.query('update screenplays set deleted_at = now() where id = $1', [
          screenplayId,
        ]);
        await expect(store!.restoreScreenplay(actor, screenplayId)).resolves.toBe('forbidden');
      },
    );
  });

  /**
   * `listDeleted`'s screenplay collection must agree with `restoreScreenplay`'s own narrowed bar:
   * an owner's deleted screenplay is listed, an editor's (even one who deleted it themselves under
   * the old rules, modelled here simply as "an editor member whose project has a deleted
   * screenplay") is not -- the exact broken-control shape this slice's interface comment warns
   * against in the other direction.
   */
  it('listDeleted lists a deleted screenplay for its owner, and omits it for an editor member of the same project', async () => {
    const owner = await createUser();
    const { projectId, screenplayId } = await createProject(owner);
    const editor = await createUser();
    await addProjectMember(projectId, editor, 'editor');
    await pool!.query('update screenplays set deleted_at = now() where id = $1', [screenplayId]);

    const ownerView = await store!.listDeleted(owner);
    expect(ownerView.screenplays.map((s) => s.id)).toContain(screenplayId);

    const editorView = await store!.listDeleted(editor);
    expect(editorView.screenplays.map((s) => s.id)).not.toContain(screenplayId);
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

async function addProjectMember(
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

/** `shared_role` has no `'owner'` value -- enforced by the database itself, see this file's own
 * module comment -- so `role` here is deliberately narrower than `addProjectMember`'s. */
async function addScreenplayMember(
  screenplayId: string,
  userId: string,
  role: 'editor' | 'reviewer',
): Promise<void> {
  await pool!.query(
    'insert into screenplay_members (screenplay_id, user_id, role) values ($1, $2, $3)',
    [screenplayId, userId, role],
  );
}

async function createProject(
  ownerUserId: string,
): Promise<{ projectId: string; screenplayId: string }> {
  const projectId = randomUUID();
  const screenplayId = randomUUID();
  const screenplay = { ...screenplayFixture, id: screenplayId };
  const canonicalJson = JSON.stringify(screenplay);
  await pool!.query('insert into projects (id, title) values ($1, $2)', [
    projectId,
    'Test Project',
  ]);
  await addProjectMember(projectId, ownerUserId, 'owner');
  await pool!.query(
    `insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [
      screenplayId,
      projectId,
      'Test Screenplay',
      canonicalJson,
      createHash('sha256').update(canonicalJson).digest('hex'),
    ],
  );
  return { projectId, screenplayId };
}
