import { randomUUID } from 'node:crypto';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { MEMBERSHIP_CHANGED_NOTIFY_CHANNEL } from '@finaler-draft/database';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';
import { createPostgresProjectStore, type ProjectStore } from './projects.js';
import { createPostgresRevisionStore, type RevisionStore } from './revisions.js';
import { createPostgresEntitlementStore, type EntitlementStore } from './entitlementStore.js';
import { createPostgresSubscriptionStore } from './stripeSubscriptions.js';
import {
  createPostgresSharingStore,
  type InvitationNotification,
  type SharingStore,
} from './sharing.js';

/**
 * The screenplay-invitations slice, against a real migrated Postgres database -- the invite /
 * accept / decline / re-invite / role-change / removal flow, the unknown-address case, and the two
 * properties the brief names as the ones that matter more than the feature:
 *
 *  1. **A screenplay-scoped member cannot reach a sibling screenplay by any REST path.** Proven
 *     here against every REST path that joins membership, by id, one assertion per path. The
 *     collaboration-socket half of the same property lives in
 *     `apps/collab/src/collaboration.integration.test.ts`, at the layer that enforces it there.
 *  2. **A pending invitation grants nothing.** Proven against the same full set of REST paths,
 *     before the invitation is ever answered.
 *
 * Follows `entitlements.integration.test.ts`'s pattern exactly: one throwaway database per suite
 * run, migrated with the project's own tooling, dropped afterward. Skips entirely without
 * `TEST_DATABASE_URL`.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;
let admin: Pool | undefined;
let pool: Pool | undefined;
let projects: ProjectStore | undefined;
let revisions: RevisionStore | undefined;
let entitlements: EntitlementStore | undefined;
let sharing: SharingStore | undefined;
let databaseCreated = false;
let userSequence = 0;

/** Every notification the sharing store handed its mail port, in order. Reset before each test. */
let sentInvitations: InvitationNotification[] = [];

describe.skipIf(!databaseUrl)('Screenplay invitations and membership (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);

    pool = createIntegrationPool({ connectionString: databaseUrl });
    projects = createPostgresProjectStore(pool);
    revisions = createPostgresRevisionStore(pool);
    entitlements = createPostgresEntitlementStore(pool, createPostgresSubscriptionStore(pool));
    sharing = createPostgresSharingStore(pool, {
      async invitationCreated(notification) {
        sentInvitations.push(notification);
      },
    });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  beforeEach(() => {
    sentInvitations = [];
  });

  it('migrates screenplay_members and membership_invitations with the shape the slice depends on', async () => {
    const memberColumns = await pool!.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'screenplay_members'",
    );
    expect(memberColumns.rows.map((row) => row.column_name).sort()).toEqual([
      'created_at',
      'role',
      'screenplay_id',
      'user_id',
    ]);
    // The whole reason `shared_role` is a separate enum from `project_role`: there is no `'owner'`
    // value, so an owner-granting invitation or screenplay membership cannot be expressed at all.
    const sharedRoleValues = await pool!.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'shared_role' order by e.enumsortorder`,
    );
    expect(sharedRoleValues.rows.map((row) => row.enumlabel)).toEqual(['editor', 'reviewer']);
    const indexes = await pool!.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'membership_invitations'",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'membership_invitation_project_scope_unique',
        'membership_invitation_screenplay_scope_unique',
      ]),
    );
  });

  it('the database itself refuses a screenplay membership that names the owner role', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectWithScreenplays(owner, ['One']);
    const invitee = await createUser();
    await expect(
      pool!.query(
        "insert into screenplay_members (screenplay_id, user_id, role) values ($1, $2, 'owner')",
        [screenplayId, invitee],
      ),
    ).rejects.toThrow();
  });

  it('invites to a whole project, and accepting makes the invitee a project member', async () => {
    const owner = await createUser();
    const { projectId } = await createProjectWithScreenplays(owner, ['One', 'Two']);
    const invitee = await createUser();

    const invited = await sharing!.invite(
      owner,
      { kind: 'project', projectId },
      { email: emailOf(invitee), role: 'editor' },
    );
    expect(invited).toMatchObject({ outcome: 'invited', created: true });

    // The notification email is sent, carries no token, and names what was shared.
    expect(sentInvitations).toHaveLength(1);
    expect(sentInvitations[0]).toMatchObject({
      toEmail: emailOf(invitee),
      role: 'editor',
      screenplayTitle: null,
    });

    const incoming = await sharing!.listInvitationsForUser(invitee);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ projectId, screenplayId: null, role: 'editor' });

    const accepted = await sharing!.respondToInvitation(invitee, incoming[0]!.id, {
      response: 'accept',
    });
    expect(accepted).toMatchObject({ outcome: 'accepted', screenplayId: null, role: 'editor' });

    // A project-scoped member sees the project and every screenplay under it.
    expect((await projects!.listProjects(invitee)).map((row) => row.id)).toEqual([projectId]);
    expect(await projects!.listScreenplays(invitee, projectId)).toHaveLength(2);
    // ...and nothing appears under "Shared with you", which is for screenplay-scoped access only.
    expect(await projects!.listSharedScreenplays(invitee)).toEqual([]);
  });

  it('invites to one screenplay, and accepting grants exactly that screenplay -- never a sibling', async () => {
    const owner = await createUser();
    const { projectId, screenplayId, siblingScreenplayId } = await createProjectWithScreenplays(
      owner,
      ['Shared one', 'Sibling'],
    );
    const invitee = await createUser();

    const invited = await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'editor' },
    );
    expect(invited).toMatchObject({ outcome: 'invited', created: true });
    expect(sentInvitations[0]).toMatchObject({ screenplayTitle: 'Shared one' });

    const incoming = await sharing!.listInvitationsForUser(invitee);
    expect(incoming[0]).toMatchObject({ projectId, screenplayId, screenplayTitle: 'Shared one' });
    await sharing!.respondToInvitation(invitee, incoming[0]!.id, { response: 'accept' });

    // What they gained: the one screenplay, reachable as a shared screenplay rather than as a
    // project they do not have.
    const shared = await projects!.listSharedScreenplays(invitee);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ id: screenplayId, projectId, role: 'editor' });
    expect(await projects!.listProjects(invitee)).toEqual([]);
    expect(await projects!.getScreenplay(invitee, screenplayId)).toMatchObject({
      id: screenplayId,
      role: 'editor',
    });

    // *** The privilege negative, path by path. Every REST path that joins membership is asserted
    // *** here against the sibling screenplay the invitee was never invited to.
    await expectNoRestAccess(invitee, siblingScreenplayId, projectId);

    // The one thing a screenplay-scoped editor genuinely may do to their own screenplay, so the
    // negatives above are not passing merely because this account can do nothing at all.
    expect(await revisions!.listRevisions(invitee, screenplayId)).toEqual([]);
    expect(
      await projects!.renameScreenplay(invitee, screenplayId, 'Renamed by invitee'),
    ).toMatchObject({ id: screenplayId, title: 'Renamed by invitee' });
  });

  it('a pending invitation grants no access at all -- the same refusals a stranger gets', async () => {
    const owner = await createUser();
    const { projectId, screenplayId } = await createProjectWithScreenplays(owner, [
      'Offered',
      'Sibling',
    ]);
    const invitee = await createUser();

    await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'editor' },
    );
    // Deliberately not answered. The invitation exists and is visible to the invitee...
    expect(await sharing!.listInvitationsForUser(invitee)).toHaveLength(1);
    // ...and grants nothing on the screenplay it is about.
    await expectNoRestAccess(invitee, screenplayId, projectId);
    expect(await projects!.listSharedScreenplays(invitee)).toEqual([]);
    expect(
      (await entitlements!.getSnapshot(invitee, new Date())).candidateScreenplayIds,
    ).not.toContain(screenplayId);
  });

  it('declining leaves no access, and the invitation stops being outstanding on both sides', async () => {
    const owner = await createUser();
    const { projectId, screenplayId } = await createProjectWithScreenplays(owner, ['Offered']);
    const invitee = await createUser();

    await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'editor' },
    );
    const incoming = await sharing!.listInvitationsForUser(invitee);
    expect(
      await sharing!.respondToInvitation(invitee, incoming[0]!.id, { response: 'decline' }),
    ).toEqual({ outcome: 'declined' });

    await expectNoRestAccess(invitee, screenplayId, projectId);
    expect(await sharing!.listInvitationsForUser(invitee)).toEqual([]);
    const view = await sharing!.listSharing(owner, { kind: 'screenplay', screenplayId });
    expect(view).not.toBe('missing');
    expect((view as { invitations: unknown[] }).invitations).toEqual([]);

    // Replaying the answered response is reported as such, not as a second decline or an error.
    expect(
      await sharing!.respondToInvitation(invitee, incoming[0]!.id, { response: 'accept' }),
    ).toEqual({ outcome: 'not-pending' });
  });

  it('re-inviting is idempotent: one row, a changeable role, and no second invitation', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectWithScreenplays(owner, ['Offered']);
    const invitee = await createUser();

    const first = await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'reviewer' },
    );
    expect(first).toMatchObject({ outcome: 'invited', created: true });
    const second = await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'reviewer' },
    );
    expect(second).toMatchObject({ outcome: 'invited', created: false });
    // Re-inviting with a different role updates the offer rather than adding a second one.
    const third = await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'editor' },
    );
    expect(third).toMatchObject({ outcome: 'invited', created: false });

    const rows = await pool!.query<{ count: string }>(
      'select count(*) as count from membership_invitations where screenplay_id = $1 and invited_user_id = $2',
      [screenplayId, invitee],
    );
    expect(rows.rows[0]!.count).toBe('1');
    const incoming = await sharing!.listInvitationsForUser(invitee);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.role).toBe('editor');
    // The invitation id never changed across the three calls -- it really is one row being reused.
    expect((first as { invitation: { id: string } }).invitation.id).toBe(incoming[0]!.id);
  });

  it('re-inviting someone who already declined re-opens the same row rather than writing a second', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectWithScreenplays(owner, ['Offered']);
    const invitee = await createUser();

    await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'editor' },
    );
    const first = await sharing!.listInvitationsForUser(invitee);
    await sharing!.respondToInvitation(invitee, first[0]!.id, { response: 'decline' });

    const reinvited = await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'editor' },
    );
    expect(reinvited).toMatchObject({ outcome: 'invited', created: false });
    const rows = await pool!.query<{ count: string }>(
      'select count(*) as count from membership_invitations where screenplay_id = $1',
      [screenplayId],
    );
    expect(rows.rows[0]!.count).toBe('1');
    const again = await sharing!.listInvitationsForUser(invitee);
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(first[0]!.id);
  });

  it('re-inviting an existing member reports what they already hold, and never resets the editable-slot cooldown', async () => {
    const owner = await createUser();
    const { projectId, screenplayId } = await createProjectWithScreenplays(owner, ['One']);
    const invitee = await createUser();

    await sharing!.invite(
      owner,
      { kind: 'project', projectId },
      { email: emailOf(invitee), role: 'editor' },
    );
    const incoming = await sharing!.listInvitationsForUser(invitee);
    await sharing!.respondToInvitation(invitee, incoming[0]!.id, { response: 'accept' });

    // A free invitee can make the shared screenplay their one editable slot -- plan.md's own
    // reason the second `union` branch exists in `fetchCandidateScreenplayIds`.
    const slotChosen = await entitlements!.switchEditableScreenplay(
      invitee,
      screenplayId,
      new Date(),
    );
    expect(slotChosen).toMatchObject({ outcome: 'applied', screenplayId });
    const cooldownBefore = await slotUpdatedAt(invitee);

    // Already an editor project-wide, so neither an editor nor a reviewer invitation has anything
    // to offer -- at either scope.
    expect(
      await sharing!.invite(
        owner,
        { kind: 'project', projectId },
        { email: emailOf(invitee), role: 'reviewer' },
      ),
    ).toEqual({ outcome: 'already-member', role: 'editor', scope: 'project' });
    expect(
      await sharing!.invite(
        owner,
        { kind: 'screenplay', screenplayId },
        { email: emailOf(invitee), role: 'editor' },
      ),
    ).toEqual({ outcome: 'already-member', role: 'editor', scope: 'project' });

    // plan.md: "Do not add an exception for newly shared screenplays; re-sharing would reset it."
    expect(await slotUpdatedAt(invitee)).toEqual(cooldownBefore);
    expect(sentInvitations).toHaveLength(1);
  });

  it('an unknown email address is reported honestly, and writes nothing', async () => {
    const owner = await createUser();
    const { projectId } = await createProjectWithScreenplays(owner, ['One']);

    expect(
      await sharing!.invite(
        owner,
        { kind: 'project', projectId },
        { email: `nobody-${randomUUID()}@example.test`, role: 'editor' },
      ),
    ).toEqual({ outcome: 'no-account' });

    const rows = await pool!.query<{ count: string }>(
      'select count(*) as count from membership_invitations where project_id = $1',
      [projectId],
    );
    expect(rows.rows[0]!.count).toBe('0');
    // No email is sent to an address that has no account -- the endpoint answers the inviter, it
    // does not post mail to an arbitrary address.
    expect(sentInvitations).toEqual([]);
  });

  it('inviting yourself is refused, and a mixed-case address still resolves to the same account', async () => {
    const owner = await createUser();
    const { projectId } = await createProjectWithScreenplays(owner, ['One']);
    const invitee = await createUser();

    expect(
      await sharing!.invite(
        owner,
        { kind: 'project', projectId },
        { email: emailOf(owner), role: 'editor' },
      ),
    ).toEqual({ outcome: 'self' });
    // `inviteInput` lowercases before this store ever sees the address; this asserts the store's
    // own comparison matches what Better Auth actually stored.
    expect(
      await sharing!.invite(
        owner,
        { kind: 'project', projectId },
        { email: emailOf(invitee).toLowerCase(), role: 'editor' },
      ),
    ).toMatchObject({ outcome: 'invited', created: true });
  });

  it('changes a role and removes a member, notifying apps/collab of both so a live connection cannot outlive them', async () => {
    const owner = await createUser();
    const { projectId, screenplayId, siblingScreenplayId } = await createProjectWithScreenplays(
      owner,
      ['Shared one', 'Sibling'],
    );
    const invitee = await createUser();
    await acceptScreenplayInvite(owner, screenplayId, invitee, 'editor');

    const notifications = await captureNotifications(async () => {
      expect(
        await sharing!.changeMemberRole(
          owner,
          { kind: 'screenplay', screenplayId },
          invitee,
          'reviewer',
        ),
      ).toEqual({ outcome: 'changed', role: 'reviewer' });
    });
    expect(notifications).toEqual([JSON.stringify({ userId: invitee })]);

    // Demoted: still reads, no longer edits -- and the demotion is visible to the entitlement
    // layer too, so the screenplay stops being a candidate for their editable slot.
    expect(await projects!.getScreenplay(invitee, screenplayId)).toMatchObject({
      role: 'reviewer',
    });
    expect(await projects!.renameScreenplay(invitee, screenplayId, 'Nope')).toBe('forbidden');
    expect(
      (await entitlements!.getSnapshot(invitee, new Date())).candidateScreenplayIds,
    ).not.toContain(screenplayId);

    const removalNotifications = await captureNotifications(async () => {
      expect(
        await sharing!.removeMember(owner, { kind: 'screenplay', screenplayId }, invitee),
      ).toEqual({ outcome: 'removed' });
    });
    expect(removalNotifications).toEqual([JSON.stringify({ userId: invitee })]);

    // Removed: the same refusals a stranger gets, on the screenplay they used to hold.
    await expectNoRestAccess(invitee, screenplayId, projectId);
    await expectNoRestAccess(invitee, siblingScreenplayId, projectId);
    expect(
      await sharing!.removeMember(owner, { kind: 'screenplay', screenplayId }, invitee),
    ).toEqual({ outcome: 'not-a-member' });
  });

  it('never demotes or removes the project owner', async () => {
    const owner = await createUser();
    const { projectId } = await createProjectWithScreenplays(owner, ['One']);
    const editor = await createUser();
    await acceptProjectInvite(owner, projectId, editor, 'editor');

    // Even a project editor -- who may otherwise share and manage membership -- cannot touch the
    // owner. Without this, an editor could leave a project nobody can delete, rename or share.
    expect(
      await sharing!.changeMemberRole(editor, { kind: 'project', projectId }, owner, 'reviewer'),
    ).toEqual({ outcome: 'owner-immutable' });
    expect(await sharing!.removeMember(editor, { kind: 'project', projectId }, owner)).toEqual({
      outcome: 'owner-immutable',
    });
    const ownerRow = await pool!.query<{ role: string }>(
      'select role from project_members where project_id = $1 and user_id = $2',
      [projectId, owner],
    );
    expect(ownerRow.rows[0]!.role).toBe('owner');
  });

  it('a screenplay-scoped editor cannot share anything, and a project reviewer is refused with 403-shaped forbidden', async () => {
    const owner = await createUser();
    const { projectId, screenplayId, siblingScreenplayId } = await createProjectWithScreenplays(
      owner,
      ['Shared one', 'Sibling'],
    );
    const screenplayEditor = await createUser();
    await acceptScreenplayInvite(owner, screenplayId, screenplayEditor, 'editor');
    const outsider = await createUser();

    // No `project_members` row at all, so sharing resolves to `'missing'` -- they are not told the
    // project exists, let alone offered a way to grant access to it.
    expect(
      await sharing!.invite(
        screenplayEditor,
        { kind: 'screenplay', screenplayId },
        { email: emailOf(outsider), role: 'editor' },
      ),
    ).toBe('missing');
    expect(
      await sharing!.invite(
        screenplayEditor,
        { kind: 'project', projectId },
        { email: emailOf(outsider), role: 'editor' },
      ),
    ).toBe('missing');
    expect(await sharing!.listSharing(screenplayEditor, { kind: 'screenplay', screenplayId })).toBe(
      'missing',
    );
    // And they cannot reach a sibling to try sharing that either.
    expect(
      await sharing!.invite(
        screenplayEditor,
        { kind: 'screenplay', screenplayId: siblingScreenplayId },
        { email: emailOf(outsider), role: 'editor' },
      ),
    ).toBe('missing');

    // A project *reviewer* demonstrably can see the project, so they get `'forbidden'` rather than
    // `'missing'` -- the distinction the rest of this API already draws.
    const reviewer = await createUser();
    await acceptProjectInvite(owner, projectId, reviewer, 'reviewer');
    expect(await sharing!.listSharing(reviewer, { kind: 'project', projectId })).toBe('forbidden');
    expect(
      await sharing!.invite(
        reviewer,
        { kind: 'project', projectId },
        { email: emailOf(outsider), role: 'editor' },
      ),
    ).toBe('forbidden');
  });

  it("the sharing view shows inherited project access at screenplay scope, and never another scope's invitations", async () => {
    const owner = await createUser();
    const { projectId, screenplayId, siblingScreenplayId } = await createProjectWithScreenplays(
      owner,
      ['Shared one', 'Sibling'],
    );
    const projectReviewer = await createUser();
    await acceptProjectInvite(owner, projectId, projectReviewer, 'reviewer');
    const screenplayGuest = await createUser();
    await acceptScreenplayInvite(owner, screenplayId, screenplayGuest, 'editor');
    const pendingOnSibling = await createUser();
    await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId: siblingScreenplayId },
      { email: emailOf(pendingOnSibling), role: 'editor' },
    );

    const view = await sharing!.listSharing(owner, { kind: 'screenplay', screenplayId });
    expect(view).not.toBe('missing');
    const resolved = view as Awaited<ReturnType<SharingStore['listSharing']>> & {
      members: Array<{ userId: string; scope: string; role: string }>;
      invitations: unknown[];
    };
    expect(resolved.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: owner, role: 'owner', scope: 'project' }),
        expect.objectContaining({ userId: projectReviewer, role: 'reviewer', scope: 'project' }),
        expect.objectContaining({ userId: screenplayGuest, role: 'editor', scope: 'screenplay' }),
      ]),
    );
    // The sibling screenplay's pending invitation must not appear on this screenplay's view.
    expect(resolved.invitations).toEqual([]);
    // Nor on the project's view, which owns only project-scoped invitations.
    const projectView = (await sharing!.listSharing(owner, { kind: 'project', projectId })) as {
      invitations: unknown[];
    };
    expect(projectView.invitations).toEqual([]);
  });

  it('revokes a pending invitation, and a revoked invitation can never be accepted', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectWithScreenplays(owner, ['Offered']);
    const invitee = await createUser();
    await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'editor' },
    );
    const incoming = await sharing!.listInvitationsForUser(invitee);

    expect(await sharing!.revokeInvitation(owner, incoming[0]!.id)).toEqual({ outcome: 'revoked' });
    expect(await sharing!.listInvitationsForUser(invitee)).toEqual([]);
    expect(
      await sharing!.respondToInvitation(invitee, incoming[0]!.id, { response: 'accept' }),
    ).toBe('missing');
  });

  it('an invitation id belonging to someone else is simply not found, never forbidden', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectWithScreenplays(owner, ['Offered']);
    const invitee = await createUser();
    const bystander = await createUser();
    await sharing!.invite(
      owner,
      { kind: 'screenplay', screenplayId },
      { email: emailOf(invitee), role: 'editor' },
    );
    const incoming = await sharing!.listInvitationsForUser(invitee);

    expect(await sharing!.listInvitationsForUser(bystander)).toEqual([]);
    expect(
      await sharing!.respondToInvitation(bystander, incoming[0]!.id, { response: 'accept' }),
    ).toBe('missing');
    // The real invitee is unaffected by the attempt.
    expect(await sharing!.listInvitationsForUser(invitee)).toHaveLength(1);
  });

  it('a screenplay-scoped member sees only their own screenplay in the deleted list, never a deleted sibling', async () => {
    const owner = await createUser();
    const { screenplayId, siblingScreenplayId } = await createProjectWithScreenplays(owner, [
      'Shared one',
      'Sibling',
    ]);
    const invitee = await createUser();
    await acceptScreenplayInvite(owner, screenplayId, invitee, 'editor');

    await projects!.deleteScreenplay(owner, siblingScreenplayId);
    expect((await projects!.listDeleted(invitee)).screenplays).toEqual([]);

    await projects!.deleteScreenplay(owner, screenplayId);
    const deleted = await projects!.listDeleted(invitee);
    expect(deleted.screenplays.map((row) => row.id)).toEqual([screenplayId]);
    expect(deleted.projects).toEqual([]);
  });
});

/**
 * The REST privilege negative, as one reusable assertion over **every** `apps/api` path that
 * resolves membership by id. Reused by the sibling-screenplay case, the pending-invitation case and
 * the post-removal case, so all three prove the identical, complete set rather than whichever
 * subset each test happened to remember.
 *
 * `listRevisions`/`getRevision`/`getRevisionDiff`/`createRevision` and `restoreRevision` all share
 * `revisions.ts`'s `resolveMembership`, so a single widened definition covers them -- but they are
 * each asserted anyway, because "they share a helper today" is a fact about the current code, not a
 * property a test should assume on behalf of a future refactor.
 */
async function expectNoRestAccess(
  actorId: string,
  screenplayId: string,
  projectId: string,
): Promise<void> {
  // Read
  expect(await projects!.getScreenplay(actorId, screenplayId)).toBe('missing');
  // Listing. Deliberately "does not contain this screenplay" rather than "is empty": a
  // screenplay-scoped member legitimately *does* see their own screenplay in this listing, so
  // asserting emptiness here would be asserting the wrong property and would fail on the very
  // case this helper exists to check. Where the listing really should be empty -- a pending
  // invitation, or a removed member -- the calling test covers every screenplay in the project, so
  // "contains none of them" is exactly emptiness.
  expect((await projects!.listScreenplays(actorId, projectId)).map((row) => row.id)).not.toContain(
    screenplayId,
  );
  expect((await projects!.listProjects(actorId)).map((row) => row.id)).not.toContain(projectId);
  expect((await projects!.listSharedScreenplays(actorId)).map((row) => row.id)).not.toContain(
    screenplayId,
  );
  // Metadata writes
  expect(await projects!.renameScreenplay(actorId, screenplayId, 'Nope')).toBe('missing');
  expect(await projects!.deleteScreenplay(actorId, screenplayId)).toBe('missing');
  expect(await projects!.restoreScreenplay(actorId, screenplayId)).toBe('missing');
  // Project-level writes
  expect(await projects!.renameProject(actorId, projectId, 'Nope')).toBe('missing');
  expect(await projects!.deleteProject(actorId, projectId)).toBe('missing');
  expect(
    await projects!
      .createScreenplay(actorId, projectId, { title: 'Nope', screenplay: screenplayFixture })
      .then(
        () => 'created',
        () => 'refused',
      ),
  ).toBe('refused');
  // Revision history: list, read, diff, and the named-milestone write
  expect(await revisions!.listRevisions(actorId, screenplayId)).toBe('missing');
  expect(await revisions!.getRevision(actorId, screenplayId, randomUUID())).toBe('missing');
  expect(await revisions!.getRevisionDiff(actorId, screenplayId, randomUUID())).toBe('missing');
  expect(
    await revisions!.createRevision(actorId, screenplayId, {
      epoch: 0,
      kind: 'named',
      label: 'Nope',
    }),
  ).toBe('missing');
  // Export revisions, which are membership-only (any role) rather than editor-only -- so this is
  // the weakest bar in the revision surface and the one most worth proving separately.
  expect(
    await revisions!.createRevision(actorId, screenplayId, {
      epoch: 0,
      format: 'fdx',
      kind: 'export',
    }),
  ).toBe('missing');
  // The editable-slot universe: an unreachable screenplay must never be selectable as the one
  // screenplay a restricted account may edit, which would be a write grant by another route.
  expect(
    (await entitlements!.getSnapshot(actorId, new Date())).candidateScreenplayIds,
  ).not.toContain(screenplayId);
  expect(await entitlements!.switchEditableScreenplay(actorId, screenplayId, new Date())).toEqual({
    outcome: 'not-a-candidate',
  });
}

/**
 * Collects every `MEMBERSHIP_CHANGED_NOTIFY_CHANNEL` payload Postgres delivers while `action` runs,
 * over a dedicated `LISTEN` connection -- the same mechanism `apps/collab` uses in production. This
 * is what proves a role change and a removal actually announce themselves across the process
 * boundary, rather than the store merely intending to.
 */
async function captureNotifications(action: () => Promise<void>): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const payloads: string[] = [];
  client.on('notification', (message) => {
    if (message.payload !== undefined) payloads.push(message.payload);
  });
  try {
    await client.query(`listen ${MEMBERSHIP_CHANGED_NOTIFY_CHANNEL}`);
    await action();
    // One round trip after the committing transaction returned: `pg` surfaces notifications when it
    // next reads from the socket, so a query here is what flushes anything already queued. A fixed
    // sleep would be both slower and less reliable.
    await client.query('select 1');
    return payloads;
  } finally {
    await client.end();
  }
}

const emails = new Map<string, string>();

function emailOf(userId: string): string {
  const email = emails.get(userId);
  if (!email) throw new Error(`No email recorded for ${userId}.`);
  return email;
}

async function createUser(): Promise<string> {
  userSequence += 1;
  const id = `user-${userSequence}-${randomUUID()}`;
  // Lowercased, matching what Better Auth's own sign-up stores (see `inviteInput`'s comment) --
  // a fixture that wrote a mixed-case address would be testing against a row shape the real
  // sign-up path never produces.
  const email = `writer-${userSequence}-${randomUUID()}@example.test`.toLowerCase();
  await pool!.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [id, `Writer ${userSequence}`, email],
  );
  emails.set(id, email);
  return id;
}

/** A project owned by `ownerId` with one screenplay per title. The first two are named
 * `screenplayId`/`siblingScreenplayId` because almost every test here is about the difference
 * between them. */
async function createProjectWithScreenplays(
  ownerId: string,
  titles: readonly string[],
): Promise<{
  projectId: string;
  screenplayId: string;
  siblingScreenplayId: string;
}> {
  const project = await projects!.createProject(ownerId, 'Shared project');
  const created: string[] = [];
  for (const title of titles) {
    const screenplay = await projects!.createScreenplay(ownerId, project.id, {
      title,
      screenplay: screenplayFixture,
    });
    created.push(screenplay.id);
  }
  return {
    projectId: project.id,
    screenplayId: created[0]!,
    siblingScreenplayId: created[1] ?? created[0]!,
  };
}

/** Invite plus accept, through the real store on both sides -- never a direct membership insert, so
 * every test that needs a member gets one the only way the product can actually produce one. */
async function acceptScreenplayInvite(
  ownerId: string,
  screenplayId: string,
  inviteeId: string,
  role: 'editor' | 'reviewer',
): Promise<void> {
  await sharing!.invite(
    ownerId,
    { kind: 'screenplay', screenplayId },
    { email: emailOf(inviteeId), role },
  );
  const incoming = await sharing!.listInvitationsForUser(inviteeId);
  const invitation = incoming.find((row) => row.screenplayId === screenplayId);
  if (!invitation) throw new Error('The invitation just created was not offered to the invitee.');
  await sharing!.respondToInvitation(inviteeId, invitation.id, { response: 'accept' });
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
    { email: emailOf(inviteeId), role },
  );
  const incoming = await sharing!.listInvitationsForUser(inviteeId);
  const invitation = incoming.find(
    (row) => row.projectId === projectId && row.screenplayId === null,
  );
  if (!invitation) throw new Error('The invitation just created was not offered to the invitee.');
  await sharing!.respondToInvitation(inviteeId, invitation.id, { response: 'accept' });
}

async function slotUpdatedAt(userId: string): Promise<string | undefined> {
  const result = await pool!.query<{ updatedAt: Date }>(
    'select updated_at as "updatedAt" from editable_slots where user_id = $1',
    [userId],
  );
  const row = result.rows[0];
  return row ? new Date(row.updatedAt).toISOString() : undefined;
}
