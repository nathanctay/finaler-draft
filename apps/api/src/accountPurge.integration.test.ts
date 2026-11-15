import { randomUUID } from 'node:crypto';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_PURGE_BATCH_SIZE,
  ACCOUNT_PURGE_GRACE_PERIOD_DAYS,
  createPostgresAccountPurgeStore,
  type AccountPurgeStore,
} from './accountPurge.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';
import { createPostgresProjectStore, type ProjectStore } from './projects.js';
import { createPostgresSharingStore, type SharingStore } from './sharing.js';

/**
 * `accountPurge.ts` against a real, migrated Postgres database -- the layer a fake pool cannot
 * prove (progress/account-purge-cron.md's "Verification discipline" section cites exactly this:
 * "cascades, soft-delete predicates and ordering cannot be proven against a fake"). Three things
 * get the most coverage here, deliberately, because getting any of them wrong either destroys a
 * writer's work that was never supposed to be touched, or silently leaks storage forever:
 *
 *  1. **The project-before-user ordering** -- `"The ordering trap"` below reproduces the failure
 *     mode directly (reversing the order by hand, with raw SQL) before showing the real function
 *     avoids it, so the test would fail for the right reason if the ordering in `accountPurge.ts`
 *     ever regressed.
 *  2. **Everything this module must never purge** -- a live account's own soft-deleted project
 *     and screenplay, a live screenplay's retired-epoch Yjs history, and the narrow
 *     collaborator-race anomaly `accountDeletion.ts` already documents.
 *  3. **The grace-window boundary**, tested on both sides, against a real `<=` comparison in SQL,
 *     not a mocked assertion.
 *
 * Follows `accountDeletion.integration.test.ts`'s pattern exactly: one throwaway database per
 * suite run, migrated with the project's own tooling, dropped afterward. Skips entirely without
 * `TEST_DATABASE_URL`.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;
let admin: Pool | undefined;
let pool: Pool | undefined;
let projects: ProjectStore | undefined;
let sharing: SharingStore | undefined;
let purge: AccountPurgeStore | undefined;
let databaseCreated = false;
let userSequence = 0;

describe.skipIf(!databaseUrl)('Account purge (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);

    pool = createIntegrationPool({ connectionString: databaseUrl });
    projects = createPostgresProjectStore(pool);
    sharing = createPostgresSharingStore(pool, { async invitationCreated() {} });
    purge = createPostgresAccountPurgeStore(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the ordering trap', () => {
    it('reproduces the failure directly: deleting "user" before its owned project orphans the project, unreachable forever', async () => {
      const owner = await createUser();
      const { projectId } = await createProjectWithScreenplays(owner, ['Solo screenplay']);
      await softDeleteProject(projectId, daysAgo(31));
      await softDeleteUser(owner, daysAgo(31));

      // The join `accountPurge.ts`'s `fetchOwnedProjects` runs, executed by hand *before* the
      // user row is destroyed -- this is the identifying link the real function reads while it
      // still exists.
      const ownedBefore = await ownedProjectIds(owner);
      expect(ownedBefore).toEqual([projectId]);

      // The trap: delete "user" first, the wrong order.
      await pool!.query('delete from "user" where id = $1', [owner]);

      // The identifying link is gone -- this is not "zero because the project was deleted," the
      // project row is still sitting right there, soft-deleted, forever unreachable by ownership.
      const ownedAfter = await pool!.query(
        `select p.id from projects p join project_members m on m.project_id = p.id
          where m.user_id = $1 and m.role = 'owner'`,
        [owner],
      );
      expect(ownedAfter.rowCount).toBe(0);
      await expect(projectExists(projectId)).resolves.toBe(true);
    });

    it('the real purge avoids the trap: the project is gone, not orphaned, after a real run', async () => {
      const owner = await createUser();
      const { projectId } = await createProjectWithScreenplays(owner, ['Solo screenplay']);
      await softDeleteProject(projectId, daysAgo(31));
      await softDeleteUser(owner, daysAgo(31));

      await purge!.run({ dryRun: false });

      await expect(projectExists(projectId)).resolves.toBe(false);
      await expect(userExists(owner)).resolves.toBe(false);
    });
  });

  describe('purging an expired account', () => {
    it('cascades a solo-owned, soft-deleted project away entirely -- screenplay, revisions, and every Yjs row', async () => {
      const owner = await createUser();
      const { projectId, screenplayId } = await createProjectWithScreenplays(owner, [
        'Solo screenplay',
      ]);
      await insertYjsUpdate(screenplayId, 0);
      await insertYjsUpdate(screenplayId, 1);
      await softDeleteProject(projectId, daysAgo(31));
      await softDeleteUser(owner, daysAgo(31));

      const result = await purge!.run({ dryRun: false });

      expect(result.accountsPurged).toBe(1);
      expect(result.projectsPurged).toBe(1);
      await expect(userExists(owner)).resolves.toBe(false);
      await expect(projectExists(projectId)).resolves.toBe(false);
      await expect(screenplayExists(screenplayId)).resolves.toBe(false);
      await expect(yjsUpdateCountFor(screenplayId)).resolves.toBe(0);
    });

    it('deletes every session row for the purged account along with the account itself', async () => {
      const owner = await createUser();
      await createSession(owner);
      await softDeleteUser(owner, daysAgo(31));

      await purge!.run({ dryRun: false });

      await expect(userExists(owner)).resolves.toBe(false);
      await expect(sessionCountFor(owner)).resolves.toBe(0);
    });

    // All three boundary tests below pin a single `now` and pass it straight through to
    // `run({ now })`, rather than letting the test compute `deletedAt` from its own `Date.now()`
    // call and `run` compute `cutoff` from a separate one a few milliseconds later. Without this,
    // the "exactly at the boundary" case is not actually exact: the clock has moved on by the
    // time `run` reads it, so `deletedAt` ends up *strictly before* whatever cutoff `run`
    // computes regardless of whether its own comparison is `<=` or `<` -- which is precisely the
    // kind of test that would still pass with the boundary's `<=` mutated to `<`. Confirmed by
    // running that exact mutation against the original (unpinned) version of this test before
    // writing this comment: it passed. Pinning `now` removes the skew and makes the `<=` itself
    // load-bearing.
    const fixedNow = new Date('2026-11-14T12:00:00.000Z');

    it('does not purge an account still inside its grace window -- just inside the boundary', async () => {
      const owner = await createUser();
      await softDeleteUser(owner, daysBeforeFixed(fixedNow, ACCOUNT_PURGE_GRACE_PERIOD_DAYS - 1));

      const result = await purge!.run({ dryRun: false, now: fixedNow });

      expect(result.accountsPurged).toBe(0);
      await expect(userExists(owner)).resolves.toBe(true);
    });

    it('purges an account exactly at the boundary -- deleted_at precisely GRACE_PERIOD_DAYS days before the same instant run() uses as "now"', async () => {
      const owner = await createUser();
      await softDeleteUser(owner, daysBeforeFixed(fixedNow, ACCOUNT_PURGE_GRACE_PERIOD_DAYS));

      const result = await purge!.run({ dryRun: false, now: fixedNow });

      expect(result.accountsPurged).toBe(1);
      await expect(userExists(owner)).resolves.toBe(false);
    });

    it('purges an account comfortably past the boundary', async () => {
      const owner = await createUser();
      await softDeleteUser(owner, daysBeforeFixed(fixedNow, ACCOUNT_PURGE_GRACE_PERIOD_DAYS + 1));

      const result = await purge!.run({ dryRun: false, now: fixedNow });

      expect(result.accountsPurged).toBe(1);
      await expect(userExists(owner)).resolves.toBe(false);
    });
  });

  describe('what must never be purged', () => {
    it("never touches a live account's own soft-deleted project or screenplay", async () => {
      const owner = await createUser();
      const { projectId, screenplayId } = await createProjectWithScreenplays(owner, [
        'Deleted six months ago',
      ]);
      await softDeleteProject(projectId, daysAgo(180));
      // The owner's account itself is never soft-deleted -- this is the load-bearing distinction:
      // plan.md's "There is no retention window and nothing is purged" for a live account's own
      // Deleted-items entries.

      const result = await purge!.run({ dryRun: false });

      expect(result.projectsPurged).toBe(0);
      await expect(projectExists(projectId)).resolves.toBe(true);
      await expect(screenplayExists(screenplayId)).resolves.toBe(true);
      await expect(userExists(owner)).resolves.toBe(true);
    });

    it("never touches a retired epoch's Yjs updates for a live screenplay", async () => {
      const owner = await createUser();
      const { screenplayId } = await createProjectWithScreenplays(owner, ['Restored screenplay']);
      // Simulates the state restore-as-current (progress/restore-as-current.md) leaves behind: a
      // retired epoch's update rows, still present, next to the live epoch's own rows. Nothing
      // about this account or project is soft-deleted -- it is simply a live screenplay with
      // history, which is exactly the shape this module must never reach into directly.
      await insertYjsUpdate(screenplayId, 0);
      await insertYjsUpdate(screenplayId, 1);

      await purge!.run({ dryRun: false });

      await expect(yjsUpdateCountFor(screenplayId)).resolves.toBe(2);
    });

    it("never hard-deletes an owned project that was never soft-deleted, even once its owner is purged -- the documented race -- and leaves the collaborator's access alone", async () => {
      const owner = await createUser();
      const collaborator = await createUser();
      const { projectId } = await createProjectWithScreenplays(owner, ['Shared, un-soft-deleted']);
      await acceptProjectInvite(owner, projectId, collaborator, 'editor');
      // The narrow race `accountDeletion.ts` already documents: this project's owner is about to
      // be purged, but the project itself was never soft-deleted (as if the collaborator had been
      // accepted in the gap between that transaction's read and its commit). Reproduced here
      // directly rather than through that race, since the resulting state -- owned, not deleted,
      // has a live collaborator -- is what this module actually has to handle.
      await softDeleteUser(owner, daysAgo(31));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = await purge!.run({ dryRun: false });

      expect(result.ownedProjectsSkippedNotSoftDeleted).toBe(1);
      expect(result.projectsPurged).toBe(0);
      await expect(projectExists(projectId)).resolves.toBe(true);
      await expect(userExists(owner)).resolves.toBe(false);
      const collaboratorRole = await pool!.query<{ role: string }>(
        'select role from project_members where project_id = $1 and user_id = $2',
        [projectId, collaborator],
      );
      expect(collaboratorRole.rows[0]?.role).toBe('editor');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('account_purge_owned_project_not_soft_deleted'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('hygiene categories', () => {
    it('purges an expired session but keeps a live one', async () => {
      const owner = await createUser();
      const expired = await createSessionWithExpiry(owner, hoursFromNow(-1));
      const live = await createSessionWithExpiry(owner, hoursFromNow(24));

      await purge!.run({ dryRun: false });

      await expect(sessionRowExists(expired)).resolves.toBe(false);
      await expect(sessionRowExists(live)).resolves.toBe(true);
    });

    it('purges an expired verification row but keeps a live one', async () => {
      const expired = await createVerification(hoursFromNow(-1));
      const live = await createVerification(hoursFromNow(1));

      await purge!.run({ dryRun: false });

      await expect(verificationRowExists(expired)).resolves.toBe(false);
      await expect(verificationRowExists(live)).resolves.toBe(true);
    });

    it('purges a stripe processed-event row past retention but keeps a recent one', async () => {
      const stale = await createStripeProcessedEvent(daysAgo(91));
      const recent = await createStripeProcessedEvent(daysAgo(1));

      await purge!.run({ dryRun: false });

      await expect(stripeEventExists(stale)).resolves.toBe(false);
      await expect(stripeEventExists(recent)).resolves.toBe(true);
    });

    it('purges a resolved membership invitation past retention but keeps a recent one and a pending one, regardless of age', async () => {
      const owner = await createUser();
      const invitee1 = await createUser();
      const invitee2 = await createUser();
      const invitee3 = await createUser();
      const { projectId } = await createProjectWithScreenplays(owner, ['Invites']);
      const staleAccepted = await createMembershipInvitation(
        projectId,
        invitee1,
        'accepted',
        daysAgo(91),
      );
      const recentDeclined = await createMembershipInvitation(
        projectId,
        invitee2,
        'declined',
        daysAgo(1),
      );
      const oldPending = await createMembershipInvitation(
        projectId,
        invitee3,
        'pending',
        daysAgo(365),
      );

      await purge!.run({ dryRun: false });

      await expect(invitationExists(staleAccepted)).resolves.toBe(false);
      await expect(invitationExists(recentDeclined)).resolves.toBe(true);
      await expect(invitationExists(oldPending)).resolves.toBe(true);
    });
  });

  describe('dry run', () => {
    it('reports accurate counts and writes nothing at all', async () => {
      const owner = await createUser();
      const { projectId } = await createProjectWithScreenplays(owner, ['Solo screenplay']);
      await softDeleteProject(projectId, daysAgo(31));
      await softDeleteUser(owner, daysAgo(31));
      const expiredSession = await createSessionWithExpiry(owner, hoursFromNow(-1));

      const result = await purge!.run({ dryRun: true });

      expect(result.accountsPurged).toBe(1);
      expect(result.projectsPurged).toBe(1);
      expect(result.sessionsPurged).toBeGreaterThanOrEqual(1);
      await expect(userExists(owner)).resolves.toBe(true);
      await expect(projectExists(projectId)).resolves.toBe(true);
      await expect(sessionRowExists(expiredSession)).resolves.toBe(true);
    });
  });

  describe('idempotency', () => {
    it('running twice in a row purges nothing the second time', async () => {
      const owner = await createUser();
      const { projectId } = await createProjectWithScreenplays(owner, ['Solo screenplay']);
      await softDeleteProject(projectId, daysAgo(31));
      await softDeleteUser(owner, daysAgo(31));
      await createSessionWithExpiry(owner, hoursFromNow(-1));
      await createVerification(hoursFromNow(-1));
      await createStripeProcessedEvent(daysAgo(91));

      const first = await purge!.run({ dryRun: false });
      expect(first.accountsPurged).toBeGreaterThanOrEqual(1);

      const second = await purge!.run({ dryRun: false });

      expect(second).toEqual({
        accountsPurged: 0,
        projectsPurged: 0,
        ownedProjectsSkippedNotSoftDeleted: 0,
        sessionsPurged: 0,
        verificationsPurged: 0,
        stripeProcessedEventsPurged: 0,
        membershipInvitationsPurged: 0,
      });
    });
  });

  describe('bounded work per run', () => {
    it('purges at most ACCOUNT_PURGE_BATCH_SIZE accounts in one run, and the remainder on the next', async () => {
      const overflow = 5;
      const ids = await createManyDeletedUsers(ACCOUNT_PURGE_BATCH_SIZE + overflow);

      const first = await purge!.run({ dryRun: false });
      expect(first.accountsPurged).toBe(ACCOUNT_PURGE_BATCH_SIZE);

      const remainingAfterFirst = await countExistingUsers(ids);
      expect(remainingAfterFirst).toBe(overflow);

      const second = await purge!.run({ dryRun: false });
      expect(second.accountsPurged).toBe(overflow);
      await expect(countExistingUsers(ids)).resolves.toBe(0);
    }, 30_000);
  });

  describe('concurrency: skip locked, never block', () => {
    it('skips an account another transaction currently holds, rather than waiting on it', async () => {
      const owner = await createUser();
      await softDeleteUser(owner, daysAgo(31));

      const holder = await pool!.connect();
      await holder.query('begin');
      await holder.query('select * from "user" where id = $1 for update', [owner]);
      try {
        const result = await purge!.run({ dryRun: false });
        // The row is locked by `holder`'s open transaction -- `for update skip locked` must see
        // zero rows for this account rather than blocking until `holder` releases it. If this ever
        // blocked instead, this test would simply time out rather than complete fast.
        expect(result.accountsPurged).toBe(0);
        await expect(userExists(owner)).resolves.toBe(true);
      } finally {
        await holder.query('rollback');
        holder.release();
      }

      const second = await purge!.run({ dryRun: false });
      expect(second.accountsPurged).toBe(1);
      await expect(userExists(owner)).resolves.toBe(false);
    });
  });
});

// -- fixtures --

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
): Promise<{ projectId: string; screenplayId: string }> {
  const project = await projects!.createProject(ownerId, 'Purge test project');
  let screenplayId = '';
  for (const title of titles) {
    const screenplay = await projects!.createScreenplay(ownerId, project.id, {
      title,
      screenplay: screenplayFixture,
    });
    screenplayId = screenplay.id;
  }
  return { projectId: project.id, screenplayId };
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

async function createSession(userId: string): Promise<void> {
  await pool!.query(
    `insert into session (id, expires_at, token, created_at, updated_at, user_id)
     values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
    [randomUUID(), randomUUID(), userId],
  );
}

async function createSessionWithExpiry(userId: string, expiresAt: Date): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `insert into session (id, expires_at, token, created_at, updated_at, user_id)
     values ($1, $2, $3, now(), now(), $4)`,
    [id, expiresAt, randomUUID(), userId],
  );
  return id;
}

async function createVerification(expiresAt: Date): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `insert into verification (id, identifier, value, expires_at, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())`,
    [id, `identifier-${id}`, `value-${id}`, expiresAt],
  );
  return id;
}

async function createStripeProcessedEvent(processedAt: Date): Promise<string> {
  const id = `evt_${randomUUID()}`;
  await pool!.query(
    `insert into stripe_processed_events (id, type, processed_at) values ($1, $2, $3)`,
    [id, 'customer.subscription.deleted', processedAt],
  );
  return id;
}

async function createMembershipInvitation(
  projectId: string,
  invitedUserId: string,
  status: 'pending' | 'accepted' | 'declined',
  updatedAt: Date,
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `insert into membership_invitations
       (id, project_id, invited_user_id, role, status, created_at, updated_at)
     values ($1, $2, $3, 'editor', $4, $5, $5)`,
    [id, projectId, invitedUserId, status, updatedAt],
  );
  return id;
}

async function insertYjsUpdate(screenplayId: string, epoch: number): Promise<void> {
  await pool!.query(
    `insert into document_yjs_updates (screenplay_id, epoch, update) values ($1, $2, $3)`,
    [screenplayId, epoch, Buffer.from([1, 2, 3])],
  );
}

async function softDeleteUser(userId: string, deletedAt: Date): Promise<void> {
  await pool!.query('update "user" set deleted_at = $2 where id = $1', [userId, deletedAt]);
}

async function softDeleteProject(projectId: string, deletedAt: Date): Promise<void> {
  await pool!.query('update projects set deleted_at = $2 where id = $1', [projectId, deletedAt]);
}

async function createManyDeletedUsers(count: number): Promise<string[]> {
  const ids: string[] = [];
  const names: string[] = [];
  const emails: string[] = [];
  const deletedAts: Date[] = [];
  const when = daysAgo(31);
  for (let index = 0; index < count; index += 1) {
    userSequence += 1;
    const id = `bulk-user-${userSequence}-${randomUUID()}`;
    ids.push(id);
    names.push(`Bulk writer ${userSequence}`);
    emails.push(`bulk-${userSequence}-${randomUUID()}@example.test`.toLowerCase());
    deletedAts.push(when);
  }
  await pool!.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at, deleted_at)
     select * from unnest($1::text[], $2::text[], $3::text[], array_fill(true, array[$4::int]),
                           array_fill(now(), array[$4::int]), array_fill(now(), array[$4::int]),
                           $5::timestamptz[])`,
    [ids, names, emails, count, deletedAts],
  );
  return ids;
}

async function countExistingUsers(ids: readonly string[]): Promise<number> {
  const result = await pool!.query<{ count: string }>(
    'select count(*)::int as count from "user" where id = any($1)',
    [ids],
  );
  return Number(result.rows[0]!.count);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Like `daysAgo`, but relative to a pinned instant rather than `Date.now()` -- see the boundary
 * tests' own comment for why the exact-boundary case needs this instead. */
function daysBeforeFixed(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function ownedProjectIds(userId: string): Promise<string[]> {
  const result = await pool!.query<{ id: string }>(
    `select p.id from projects p join project_members m on m.project_id = p.id
      where m.user_id = $1 and m.role = 'owner'`,
    [userId],
  );
  return result.rows.map((row) => row.id);
}

async function userExists(userId: string): Promise<boolean> {
  const result = await pool!.query('select 1 from "user" where id = $1', [userId]);
  return result.rowCount === 1;
}

async function projectExists(projectId: string): Promise<boolean> {
  const result = await pool!.query('select 1 from projects where id = $1', [projectId]);
  return result.rowCount === 1;
}

async function screenplayExists(screenplayId: string): Promise<boolean> {
  const result = await pool!.query('select 1 from screenplays where id = $1', [screenplayId]);
  return result.rowCount === 1;
}

async function yjsUpdateCountFor(screenplayId: string): Promise<number> {
  const result = await pool!.query<{ count: string }>(
    'select count(*)::int as count from document_yjs_updates where screenplay_id = $1',
    [screenplayId],
  );
  return Number(result.rows[0]!.count);
}

async function sessionCountFor(userId: string): Promise<number> {
  const result = await pool!.query<{ count: string }>(
    'select count(*)::int as count from session where user_id = $1',
    [userId],
  );
  return Number(result.rows[0]!.count);
}

async function sessionRowExists(sessionId: string): Promise<boolean> {
  const result = await pool!.query('select 1 from session where id = $1', [sessionId]);
  return result.rowCount === 1;
}

async function verificationRowExists(verificationId: string): Promise<boolean> {
  const result = await pool!.query('select 1 from verification where id = $1', [verificationId]);
  return result.rowCount === 1;
}

async function stripeEventExists(eventId: string): Promise<boolean> {
  const result = await pool!.query('select 1 from stripe_processed_events where id = $1', [
    eventId,
  ]);
  return result.rowCount === 1;
}

async function invitationExists(invitationId: string): Promise<boolean> {
  const result = await pool!.query('select 1 from membership_invitations where id = $1', [
    invitationId,
  ]);
  return result.rowCount === 1;
}
