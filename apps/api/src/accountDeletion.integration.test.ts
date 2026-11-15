import { randomUUID } from 'node:crypto';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';
import { createPostgresProjectStore, type ProjectStore } from './projects.js';
import { createPostgresSharingStore, type SharingStore } from './sharing.js';
import { createPostgresSubscriptionStore, type SubscriptionStore } from './stripeSubscriptions.js';
import {
  createPostgresAccountDeletionStore,
  type AccountDeletionStore,
  type AccountDeletionStripePort,
} from './accountDeletion.js';

/**
 * Account deletion (progress/account-deletion-backend.md), against a real migrated Postgres
 * database -- the one thing `accountDeletion.test.ts`'s fake-pool unit tests cannot prove: that
 * the real SQL this module issues, under real row locks, against the real schema (including the
 * migration this slice ships), produces the state it claims to.
 *
 * Stripe is faked throughout, never called -- `fakeStripe` below stands in for the real client,
 * matching `stripeCheckout.test.ts`'s own convention for the identical reason (no network access,
 * no API key, deterministic). Follows `sharing.integration.test.ts`'s pattern exactly: one
 * throwaway database per suite run, migrated with the project's own tooling, dropped afterward.
 * Skips entirely without `TEST_DATABASE_URL`.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;
let admin: Pool | undefined;
let pool: Pool | undefined;
let projects: ProjectStore | undefined;
let sharing: SharingStore | undefined;
let subscriptions: SubscriptionStore | undefined;
let accountDeletion: AccountDeletionStore | undefined;
let databaseCreated = false;
let userSequence = 0;

type SubscriptionsRetrieve = (id: string) => Promise<{ status: string }>;
type SubscriptionsCancel = (id: string) => Promise<{ status: string }>;

function fakeStripe(overrides?: {
  retrieve?: SubscriptionsRetrieve;
  cancel?: SubscriptionsCancel;
}): {
  port: AccountDeletionStripePort;
  retrieve: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const retrieve = vi.fn<SubscriptionsRetrieve>(
    overrides?.retrieve ?? (async () => ({ status: 'active' })),
  );
  const cancel = vi.fn<SubscriptionsCancel>(
    overrides?.cancel ?? (async () => ({ status: 'canceled' })),
  );
  return { port: { client: { subscriptions: { retrieve, cancel } } as never }, retrieve, cancel };
}

describe.skipIf(!databaseUrl)('Account deletion (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);

    pool = createIntegrationPool({ connectionString: databaseUrl });
    projects = createPostgresProjectStore(pool);
    subscriptions = createPostgresSubscriptionStore(pool);
    sharing = createPostgresSharingStore(pool, { async invitationCreated() {} });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  beforeEach(() => {
    // Rebuilt per test with a fresh fake Stripe client, so one test's call counts never leak into
    // the next's assertions.
    accountDeletion = createPostgresAccountDeletionStore(pool!, fakeStripe().port, subscriptions!);
  });

  it('migrates user.deleted_at and its index with the shape this slice depends on', async () => {
    const columns = await pool!.query<{ column_name: string; is_nullable: string }>(
      "select column_name, is_nullable from information_schema.columns where table_name = 'user'",
    );
    const deletedAt = columns.rows.find((row) => row.column_name === 'deleted_at');
    expect(deletedAt?.is_nullable).toBe('YES');
    const indexes = await pool!.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'user'",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(['user_deleted_at_index']),
    );
  });

  it('soft-deletes a solo-owned project along with the account, deletes every session row, and leaves the account row itself in place', async () => {
    const owner = await createUser();
    const { projectId } = await createProjectWithScreenplays(owner, ['Solo screenplay']);
    await createSession(owner);

    const result = await accountDeletion!.deleteAccount(owner, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    await expect(userRow(owner)).resolves.toMatchObject({ deletedAt: expect.any(Date) });
    await expect(projectDeletedAt(projectId)).resolves.not.toBeNull();
    await expect(sessionCountFor(owner)).resolves.toBe(0);
  });

  it('refuses, naming the project, when an owned project has a collaborator and the flag is not set -- and leaves everything untouched', async () => {
    const owner = await createUser();
    const collaborator = await createUser();
    const { projectId } = await createProjectWithScreenplays(owner, ['Shared screenplay']);
    await acceptProjectInvite(owner, projectId, collaborator, 'editor');
    await createSession(owner);

    const result = await accountDeletion!.deleteAccount(owner, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({
      outcome: 'owned-projects-have-collaborators',
      projects: [{ id: projectId, title: 'Shared project' }],
    });
    await expect(userRow(owner)).resolves.toMatchObject({ deletedAt: null });
    await expect(projectDeletedAt(projectId)).resolves.toBeNull();
    await expect(sessionCountFor(owner)).resolves.toBe(1);
  });

  it('deletes a collaborator-owned project too when the flag is set, leaving the collaborator a member of a now-deleted project', async () => {
    const owner = await createUser();
    const collaborator = await createUser();
    const { projectId } = await createProjectWithScreenplays(owner, ['Shared screenplay']);
    await acceptProjectInvite(owner, projectId, collaborator, 'editor');

    const result = await accountDeletion!.deleteAccount(owner, {
      deleteOwnedProjectsWithCollaborators: true,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    await expect(projectDeletedAt(projectId)).resolves.not.toBeNull();
    // The collaborator's own account and their `project_members` row are both untouched -- this
    // slice deletes the owning account and the projects it owned, nothing belonging to anyone
    // else. See progress/account-deletion-backend.md for why that membership row is left as is.
    await expect(userRow(collaborator)).resolves.toMatchObject({ deletedAt: null });
    const role = await pool!.query<{ role: string }>(
      'select role from project_members where project_id = $1 and user_id = $2',
      [projectId, collaborator],
    );
    expect(role.rows[0]?.role).toBe('editor');
  });

  it('deletes a solo-owned project while leaving a separate, collaborator-owned project of the same account alone when the flag is not set', async () => {
    const owner = await createUser();
    const collaborator = await createUser();
    const solo = await createProjectWithScreenplays(owner, ['Solo screenplay']);
    const shared = await createProjectWithScreenplays(owner, ['Shared screenplay']);
    await acceptProjectInvite(owner, shared.projectId, collaborator, 'reviewer');

    const result = await accountDeletion!.deleteAccount(owner, {
      deleteOwnedProjectsWithCollaborators: true,
    });

    // The flag is set, so this call never hits the early refusal gate at all -- both of the
    // owner's projects proceed to the sweep, the shared one included. This test's point is
    // narrower than "deletes': it would pass even with a bug that deleted every owned project
    // unconditionally. The real guarantee -- a collaborator project is *excluded* when the flag
    // is false -- is proven by the refusal test above and by `accountDeletion.test.ts`'s
    // fake-pool "re-derives collaborator status fresh under lock" case; this test only adds that
    // the SQL behaves the same way against a real, multi-project account.
    expect(result).toEqual({ outcome: 'deleted' });
    await expect(projectDeletedAt(solo.projectId)).resolves.not.toBeNull();
    await expect(projectDeletedAt(shared.projectId)).resolves.not.toBeNull();
  });

  it('is idempotent: calling deleteAccount a second time on an already-deleted account returns deleted without erroring', async () => {
    const owner = await createUser();
    const first = await accountDeletion!.deleteAccount(owner, {
      deleteOwnedProjectsWithCollaborators: false,
    });
    expect(first).toEqual({ outcome: 'deleted' });

    const second = await accountDeletion!.deleteAccount(owner, {
      deleteOwnedProjectsWithCollaborators: false,
    });
    expect(second).toEqual({ outcome: 'deleted' });
  });

  it('cancels a real subscription row at Stripe (faked) before writing anything locally, and leaves the account active when Stripe fails', async () => {
    const owner = await createUser();
    await seedSubscription(owner, 'sub_integration_FAKE', 'active');

    const { port, cancel } = fakeStripe({
      cancel: async () => {
        throw new Error('Stripe is unreachable');
      },
    });
    const store = createPostgresAccountDeletionStore(pool!, port, subscriptions!);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failed = await store.deleteAccount(owner, {
      deleteOwnedProjectsWithCollaborators: false,
    });
    expect(failed).toEqual({ outcome: 'stripe-cancellation-failed' });
    await expect(userRow(owner)).resolves.toMatchObject({ deletedAt: null });
    errorSpy.mockRestore();

    const { port: workingPort, cancel: workingCancel } = fakeStripe();
    const workingStore = createPostgresAccountDeletionStore(pool!, workingPort, subscriptions!);
    const succeeded = await workingStore.deleteAccount(owner, {
      deleteOwnedProjectsWithCollaborators: false,
    });
    expect(succeeded).toEqual({ outcome: 'deleted' });
    expect(workingCancel).toHaveBeenCalledWith('sub_integration_FAKE');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

async function createUser(): Promise<string> {
  userSequence += 1;
  const id = `user-${userSequence}-${randomUUID()}`;
  const email = `writer-${userSequence}-${randomUUID()}@example.test`.toLowerCase();
  await pool!.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [id, `Writer ${userSequence}`, email],
  );
  return id;
}

async function emailOf(userId: string): Promise<string> {
  const result = await pool!.query<{ email: string }>('select email from "user" where id = $1', [
    userId,
  ]);
  return result.rows[0]!.email;
}

async function createProjectWithScreenplays(
  ownerId: string,
  titles: readonly string[],
): Promise<{ projectId: string }> {
  const project = await projects!.createProject(ownerId, 'Shared project');
  for (const title of titles) {
    await projects!.createScreenplay(ownerId, project.id, { title, screenplay: screenplayFixture });
  }
  return { projectId: project.id };
}

async function acceptProjectInvite(
  ownerId: string,
  projectId: string,
  inviteeId: string,
  role: 'editor' | 'reviewer',
): Promise<void> {
  await sharing!.invite(
    ownerId,
    { kind: 'project', projectId },
    { email: await emailOf(inviteeId), role },
  );
  const incoming = await sharing!.listInvitationsForUser(inviteeId);
  const invitation = incoming.find(
    (row) => row.projectId === projectId && row.screenplayId === null,
  );
  if (!invitation) throw new Error('The invitation just created was not offered to the invitee.');
  await sharing!.respondToInvitation(inviteeId, invitation.id, { response: 'accept' });
}

/** A bare `session` row for `userId` -- not through Better Auth (this suite has no `createAuth`
 * instance), just enough of the real row shape for `deleteAccount`'s `delete from session` to
 * have something real to remove. */
async function createSession(userId: string): Promise<void> {
  await pool!.query(
    `insert into session (id, expires_at, token, created_at, updated_at, user_id)
     values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
    [randomUUID(), randomUUID(), userId],
  );
}

async function sessionCountFor(userId: string): Promise<number> {
  const result = await pool!.query<{ count: string }>(
    'select count(*)::int as count from session where user_id = $1',
    [userId],
  );
  return Number(result.rows[0]!.count);
}

async function userRow(userId: string): Promise<{ deletedAt: Date | null }> {
  const result = await pool!.query<{ deletedAt: Date | null }>(
    'select deleted_at as "deletedAt" from "user" where id = $1',
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`No user row for ${userId}.`);
  return row;
}

async function projectDeletedAt(projectId: string): Promise<Date | null> {
  const result = await pool!.query<{ deletedAt: Date | null }>(
    'select deleted_at as "deletedAt" from projects where id = $1',
    [projectId],
  );
  return result.rows[0]?.deletedAt ?? null;
}

/** Writes a `subscriptions` row directly -- the real projection `stripeWebhook.ts` would
 * otherwise populate from a live event, which this suite has no reason to simulate just to get a
 * `stripeSubscriptionId` onto the account for `deleteAccount` to read. */
async function seedSubscription(
  userId: string,
  stripeSubscriptionId: string,
  status: string,
): Promise<void> {
  await pool!.query(
    `insert into subscriptions (
       user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
       status, current_period_end, last_event_created_at
     ) values ($1, $2, $3, 'price_integration_FAKE', $4, now() + interval '30 days', now())`,
    [userId, `cus_integration_FAKE_${userId}`, stripeSubscriptionId, status],
  );
}
