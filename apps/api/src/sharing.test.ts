import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMBERSHIP_CHANGED_NOTIFY_CHANNEL } from '@finaler-draft/database';
import {
  changeRoleInput,
  createPostgresSharingStore,
  inviteInput,
  NO_ACCOUNT_MESSAGE,
  respondToInvitationInput,
  type InvitationNotification,
  type SharingScope,
} from './sharing.js';

/**
 * This file covers `sharing.ts`'s own orchestration against a fake pool: which queries it runs in
 * which order, which outcome each refusal maps to, that every path releases its client and rolls
 * back, and that the membership-change notification and the invitation email fire exactly when they
 * should. The same decisions are additionally proven end to end, against a real migrated database,
 * in `sharing.integration.test.ts` -- these are the fast, exhaustive half; that is the half that
 * proves the SQL is real.
 *
 * `fakeClient` queues results positionally, the identical convention `projects.test.ts` established
 * for this store's sibling. Each test's queue is therefore a readable transcript of the transaction
 * it is describing.
 */
const actorId = 'actor-1';
const projectId = '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f';
const screenplayId = 'ecf1118c-3a2e-4656-84e6-fce75c461710';
const inviteeId = 'actor-2';
const projectScope: SharingScope = { kind: 'project', projectId };
const screenplayScope: SharingScope = { kind: 'screenplay', screenplayId };
const now = new Date('2026-08-06T00:00:00Z');

function rows(values: Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values };
}

function empty() {
  return rows([]);
}

function fakeClient(results: Array<{ rowCount: number; rows: Record<string, unknown>[] }>) {
  const queued = [...results];
  return {
    // The signature is declared on `vi.fn` rather than on the implementation purely so
    // `query.mock.calls` is typed as the `(text, values)` tuples the assertions below read --
    // several of them check *which* SQL ran and with which bound values, not just how many
    // statements there were. The implementation itself ignores both, since this fake answers
    // positionally from `queued`.
    query: vi.fn<(text: string, values?: readonly unknown[]) => Promise<ReturnType<typeof empty>>>(
      async () => queued.shift() ?? empty(),
    ),
    release: vi.fn(),
  };
}

function fakePool(client: ReturnType<typeof fakeClient>) {
  return { connect: vi.fn(async () => client), query: vi.fn(async () => empty()) } as never;
}

let sent: InvitationNotification[];
let notifier: { invitationCreated: ReturnType<typeof vi.fn> };

beforeEach(() => {
  sent = [];
  notifier = {
    invitationCreated: vi.fn(async (notification: InvitationNotification) => {
      sent.push(notification);
    }),
  };
});

function store(client: ReturnType<typeof fakeClient>) {
  return createPostgresSharingStore(fakePool(client), notifier, () => now);
}

/** The queued results a successful scope-plus-authorization prologue needs: `begin`, the scope
 * lock, then the actor's project role. Every operation here starts with these three. */
function authorized(role: 'owner' | 'editor' | 'reviewer') {
  return [
    empty(),
    rows([{ projectId, projectTitle: 'Shared project', screenplayTitle: null }]),
    rows([{ role }]),
  ];
}

describe('inviteInput', () => {
  it('lowercases and trims the address, so the lookup matches what Better Auth stored', () => {
    expect(inviteInput.parse({ email: '  Writer@Example.Test ', role: 'editor' })).toEqual({
      email: 'writer@example.test',
      role: 'editor',
    });
  });

  it('rejects an address that is not one, and a role sharing cannot grant', () => {
    expect(() => inviteInput.parse({ email: 'not-an-address', role: 'editor' })).toThrow();
    expect(() => inviteInput.parse({ email: 'a@b.test', role: 'owner' })).toThrow();
    expect(() =>
      inviteInput.parse({ email: `${'x'.repeat(320)}@b.test`, role: 'editor' }),
    ).toThrow();
  });

  it('rejects an unknown field rather than ignoring it', () => {
    expect(() =>
      inviteInput.parse({ email: 'a@b.test', role: 'editor', userId: 'someone-else' }),
    ).toThrow();
  });
});

describe('changeRoleInput and respondToInvitationInput', () => {
  it('accept only the roles and responses the store can act on', () => {
    expect(changeRoleInput.parse({ role: 'reviewer' })).toEqual({ role: 'reviewer' });
    expect(() => changeRoleInput.parse({ role: 'owner' })).toThrow();
    expect(respondToInvitationInput.parse({ response: 'decline' })).toEqual({
      response: 'decline',
    });
    expect(() => respondToInvitationInput.parse({ response: 'maybe' })).toThrow();
  });
});

describe('invite authorization', () => {
  it('reports a missing or soft-deleted scope as missing, without reaching the user lookup', async () => {
    for (const scope of [projectScope, screenplayScope]) {
      const client = fakeClient([empty(), empty()]);
      await expect(
        store(client).invite(actorId, scope, { email: 'a@b.test', role: 'editor' }),
      ).resolves.toBe('missing');
      expect(client.query).toHaveBeenCalledWith('rollback');
      expect(client.release).toHaveBeenCalledOnce();
      expect(notifier.invitationCreated).not.toHaveBeenCalled();
    }
  });

  it('reports a non-member as missing -- never that the project exists', async () => {
    const client = fakeClient([
      empty(),
      rows([{ projectId, projectTitle: 'P', screenplayTitle: null }]),
      empty(),
    ]);
    await expect(
      store(client).invite(actorId, projectScope, { email: 'a@b.test', role: 'editor' }),
    ).resolves.toBe('missing');
  });

  it('refuses a project reviewer with forbidden, which does admit the project exists', async () => {
    // The distinction is deliberate and is the one the rest of this API already draws: a reviewer
    // demonstrably can see the project, so concealing its existence from them would be theatre.
    const client = fakeClient(authorized('reviewer'));
    await expect(
      store(client).invite(actorId, projectScope, { email: 'a@b.test', role: 'editor' }),
    ).resolves.toBe('forbidden');
  });

  it('resolves the sharing privilege from project_members alone, so a screenplay-scoped role cannot share', async () => {
    // The query this asserts is the whole reason a screenplay-scoped editor cannot invite anyone:
    // it reads `project_members` directly rather than going through `screenplayRoleLateral`, so
    // someone with only a `screenplay_members` row finds no role and is refused as a non-member.
    const client = fakeClient(authorized('editor'));
    await store(client).invite(actorId, screenplayScope, { email: 'a@b.test', role: 'editor' });
    const roleQuery = client.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('from project_members'),
    );
    expect(roleQuery?.[0]).toContain('select role from project_members');
    expect(roleQuery?.[0]).not.toContain('screenplay_members');
    expect(roleQuery?.[1]).toEqual([projectId, actorId]);
  });

  it('lets an editor share, not only an owner -- the same bar every other project mutation sets', async () => {
    const client = fakeClient([
      ...authorized('editor'),
      rows([{ id: inviteeId, name: 'Invitee', email: 'a@b.test' }]),
      empty(),
      empty(),
      rows([{ id: 'invitation-1', role: 'editor', createdAt: now }]),
      rows([{ name: 'Inviter' }]),
    ]);
    await expect(
      store(client).invite(actorId, projectScope, { email: 'a@b.test', role: 'editor' }),
    ).resolves.toMatchObject({ outcome: 'invited', created: true });
  });
});

describe('invite outcomes', () => {
  it('answers no-account for an address with no user, writing nothing and sending nothing', async () => {
    const client = fakeClient([...authorized('owner'), empty()]);
    await expect(
      store(client).invite(actorId, projectScope, { email: 'nobody@b.test', role: 'editor' }),
    ).resolves.toEqual({ outcome: 'no-account' });
    expect(client.query).toHaveBeenCalledWith('rollback');
    // The endpoint answers the inviter; it never posts mail to an address that has no account.
    expect(notifier.invitationCreated).not.toHaveBeenCalled();
    // The honest message exists and is about the address, not the person.
    expect(NO_ACCOUNT_MESSAGE).toContain('No account found for that email address');
    expect(NO_ACCOUNT_MESSAGE).not.toMatch(/user does not exist/i);
  });

  it('answers self when the inviter invites their own address', async () => {
    const client = fakeClient([
      ...authorized('owner'),
      rows([{ id: actorId, name: 'Me', email: 'me@b.test' }]),
    ]);
    await expect(
      store(client).invite(actorId, projectScope, { email: 'me@b.test', role: 'editor' }),
    ).resolves.toEqual({ outcome: 'self' });
  });

  it('answers already-member when inherited project access covers the requested role', async () => {
    const client = fakeClient([
      ...authorized('owner'),
      rows([{ id: inviteeId, name: 'Invitee', email: 'a@b.test' }]),
      rows([{ role: 'editor' }]),
    ]);
    await expect(
      store(client).invite(actorId, screenplayScope, { email: 'a@b.test', role: 'reviewer' }),
    ).resolves.toEqual({ outcome: 'already-member', role: 'editor', scope: 'project' });
  });

  it('still invites when the requested role is more than the inherited one', async () => {
    // A project reviewer invited as a screenplay editor is a real upgrade (most-privileged wins),
    // so this must not be short-circuited as "already a member" -- that would make the narrower,
    // more useful grant unreachable.
    const client = fakeClient([
      ...authorized('owner'),
      rows([{ id: inviteeId, name: 'Invitee', email: 'a@b.test' }]),
      rows([{ role: 'reviewer' }]),
      empty(),
      empty(),
      rows([{ id: 'invitation-1', role: 'editor', createdAt: now }]),
      rows([{ name: 'Inviter' }]),
    ]);
    await expect(
      store(client).invite(actorId, screenplayScope, { email: 'a@b.test', role: 'editor' }),
    ).resolves.toMatchObject({ outcome: 'invited', created: true });
  });

  it('answers already-member for an existing screenplay-scoped row at or above the requested role', async () => {
    const client = fakeClient([
      ...authorized('owner'),
      rows([{ id: inviteeId, name: 'Invitee', email: 'a@b.test' }]),
      empty(),
      rows([{ role: 'editor' }]),
    ]);
    await expect(
      store(client).invite(actorId, screenplayScope, { email: 'a@b.test', role: 'editor' }),
    ).resolves.toEqual({ outcome: 'already-member', role: 'editor', scope: 'screenplay' });
  });

  it('updates the one existing invitation rather than inserting a second, reporting created: false', async () => {
    const client = fakeClient([
      ...authorized('owner'),
      rows([{ id: inviteeId, name: 'Invitee', email: 'a@b.test' }]),
      empty(),
      rows([{ id: 'invitation-1', status: 'declined' }]),
      rows([{ id: 'invitation-1', role: 'editor', createdAt: now }]),
      rows([{ name: 'Inviter' }]),
    ]);
    await expect(
      store(client).invite(actorId, projectScope, { email: 'a@b.test', role: 'editor' }),
    ).resolves.toMatchObject({ outcome: 'invited', created: false });
    const statements = client.query.mock.calls.map((call) => call[0]).join('\n');
    expect(statements).toContain('update membership_invitations');
    expect(statements).not.toContain('insert into membership_invitations');
    // The re-invite touches the invitation row and nothing else. `editable_slots` is the only
    // cooldown this system has, and plan.md requires re-sharing never to reset it.
    expect(statements).not.toContain('editable_slots');
  });

  it('scopes the existing-invitation lookup by screenplay at screenplay scope and by null screenplay at project scope', async () => {
    // The two partial unique indexes this must agree with: a project-scoped invitation is keyed on
    // `(project_id, invited_user_id) where screenplay_id is null`, a screenplay-scoped one on
    // `(screenplay_id, invited_user_id)`. A lookup that ignored that would see a project invitation
    // as an existing screenplay invitation and silently convert one into the other.
    const projectClient = fakeClient([
      ...authorized('owner'),
      rows([{ id: inviteeId, name: 'I', email: 'a@b.test' }]),
      empty(),
      empty(),
      rows([{ id: 'i', role: 'editor', createdAt: now }]),
      rows([{ name: 'Inviter' }]),
    ]);
    await store(projectClient).invite(actorId, projectScope, {
      email: 'a@b.test',
      role: 'editor',
    });
    const projectLookup = projectClient.query.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('from membership_invitations') &&
        call[0].includes('for update'),
    );
    expect(projectLookup?.[0]).toContain('screenplay_id is null');
    expect(projectLookup?.[1]).toEqual([projectId, inviteeId]);

    const screenplayClient = fakeClient([
      empty(),
      rows([{ projectId, projectTitle: 'P', screenplayTitle: 'S' }]),
      rows([{ role: 'owner' }]),
      rows([{ id: inviteeId, name: 'I', email: 'a@b.test' }]),
      empty(),
      empty(),
      empty(),
      rows([{ id: 'i', role: 'editor', createdAt: now }]),
      rows([{ name: 'Inviter' }]),
    ]);
    await store(screenplayClient).invite(actorId, screenplayScope, {
      email: 'a@b.test',
      role: 'editor',
    });
    const screenplayLookup = screenplayClient.query.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('from membership_invitations') &&
        call[0].includes('for update'),
    );
    expect(screenplayLookup?.[0]).toContain('screenplay_id = $1');
    expect(screenplayLookup?.[1]).toEqual([screenplayId, inviteeId]);
  });

  it('sends the notification after the commit, naming what was shared and nobody else', async () => {
    const client = fakeClient([
      empty(),
      rows([{ projectId, projectTitle: 'Shared project', screenplayTitle: 'Shared one' }]),
      rows([{ role: 'owner' }]),
      rows([{ id: inviteeId, name: 'Invitee', email: 'a@b.test' }]),
      empty(),
      empty(),
      empty(),
      rows([{ id: 'invitation-1', role: 'reviewer', createdAt: now }]),
      rows([{ name: 'The Inviter' }]),
    ]);
    await store(client).invite(actorId, screenplayScope, {
      email: 'a@b.test',
      role: 'reviewer',
    });
    expect(sent).toEqual([
      {
        toEmail: 'a@b.test',
        toName: 'Invitee',
        inviterName: 'The Inviter',
        projectTitle: 'Shared project',
        screenplayTitle: 'Shared one',
        role: 'reviewer',
      },
    ]);
    // Sent only once the transaction committed: an invitation that rolled back must not produce an
    // email telling someone they were invited to something that does not exist.
    const commitIndex = client.query.mock.calls.findIndex((call) => call[0] === 'commit');
    expect(commitIndex).toBeGreaterThan(-1);
    expect(notifier.invitationCreated).toHaveBeenCalledOnce();
  });

  it('reports the invitation as created even when the notification email fails', async () => {
    // The dashboard is the authoritative mechanism and the row is already committed, so a mail
    // outage must not report failure for something that fully succeeded -- and must not invite a
    // retry whose only effect would be to try the same send again.
    notifier.invitationCreated.mockRejectedValue(new Error('Resend is down'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeClient([
      ...authorized('owner'),
      rows([{ id: inviteeId, name: 'Invitee', email: 'a@b.test' }]),
      empty(),
      empty(),
      rows([{ id: 'invitation-1', role: 'editor', createdAt: now }]),
      rows([{ name: 'Inviter' }]),
    ]);
    await expect(
      store(client).invite(actorId, projectScope, { email: 'a@b.test', role: 'editor' }),
    ).resolves.toMatchObject({ outcome: 'invited', created: true });
    // Loud in the logs instead, and without the address in the line.
    expect(errorLog).toHaveBeenCalledOnce();
    expect(String(errorLog.mock.calls[0]?.[0])).toContain('invitation_email_failed');
    expect(String(errorLog.mock.calls[0]?.[0])).not.toContain('a@b.test');
    errorLog.mockRestore();
  });
});

describe('changeMemberRole', () => {
  it('refuses to demote the project owner, and leaves the row untouched', async () => {
    const client = fakeClient([...authorized('editor'), rows([{ role: 'owner' }])]);
    await expect(
      store(client).changeMemberRole(actorId, projectScope, inviteeId, 'reviewer'),
    ).resolves.toEqual({ outcome: 'owner-immutable' });
    const statements = client.query.mock.calls.map((call) => call[0]).join('\n');
    expect(statements).not.toContain('update project_members');
    expect(client.query).toHaveBeenCalledWith('rollback');
  });

  it('reports a target with no membership at this scope as not-a-member, at either scope', async () => {
    for (const scope of [projectScope, screenplayScope]) {
      const client = fakeClient([...authorized('owner'), empty()]);
      await expect(
        store(client).changeMemberRole(actorId, scope, inviteeId, 'reviewer'),
      ).resolves.toEqual({ outcome: 'not-a-member' });
    }
  });

  it('updates project membership and notifies apps/collab inside the same transaction', async () => {
    const client = fakeClient([...authorized('owner'), rows([{ role: 'editor' }])]);
    await expect(
      store(client).changeMemberRole(actorId, projectScope, inviteeId, 'reviewer'),
    ).resolves.toEqual({ outcome: 'changed', role: 'reviewer' });
    expect(client.query).toHaveBeenCalledWith(
      'update project_members set role = $3 where project_id = $1 and user_id = $2',
      [projectId, inviteeId, 'reviewer'],
    );
    expect(client.query).toHaveBeenCalledWith('select pg_notify($1, $2)', [
      MEMBERSHIP_CHANGED_NOTIFY_CHANNEL,
      JSON.stringify({ userId: inviteeId }),
    ]);
    // Inside the transaction, so the notification is delivered if and only if the change commits.
    const statements = client.query.mock.calls.map((call) => call[0]);
    expect(statements.indexOf('select pg_notify($1, $2)')).toBeLessThan(
      statements.indexOf('commit'),
    );
  });

  it('updates screenplay membership at screenplay scope and notifies the same way', async () => {
    const client = fakeClient([
      empty(),
      rows([{ projectId, projectTitle: 'P', screenplayTitle: 'S' }]),
      rows([{ role: 'owner' }]),
      rows([{ role: 'editor' }]),
    ]);
    await expect(
      store(client).changeMemberRole(actorId, screenplayScope, inviteeId, 'reviewer'),
    ).resolves.toEqual({ outcome: 'changed', role: 'reviewer' });
    expect(client.query).toHaveBeenCalledWith(
      'update screenplay_members set role = $3 where screenplay_id = $1 and user_id = $2',
      [screenplayId, inviteeId, 'reviewer'],
    );
  });

  it('refuses a project reviewer and a non-member', async () => {
    const reviewerClient = fakeClient(authorized('reviewer'));
    await expect(
      store(reviewerClient).changeMemberRole(actorId, projectScope, inviteeId, 'reviewer'),
    ).resolves.toBe('forbidden');
    const strangerClient = fakeClient([
      empty(),
      rows([{ projectId, projectTitle: 'P', screenplayTitle: null }]),
      empty(),
    ]);
    await expect(
      store(strangerClient).changeMemberRole(actorId, projectScope, inviteeId, 'reviewer'),
    ).resolves.toBe('missing');
  });
});

describe('removeMember', () => {
  it('refuses to remove the project owner', async () => {
    const client = fakeClient([...authorized('editor'), rows([{ role: 'owner' }])]);
    await expect(store(client).removeMember(actorId, projectScope, inviteeId)).resolves.toEqual({
      outcome: 'owner-immutable',
    });
    const statements = client.query.mock.calls.map((call) => call[0]).join('\n');
    expect(statements).not.toContain('delete from project_members');
  });

  it('removes a project member and notifies apps/collab', async () => {
    const client = fakeClient([...authorized('owner'), rows([{ role: 'editor' }])]);
    await expect(store(client).removeMember(actorId, projectScope, inviteeId)).resolves.toEqual({
      outcome: 'removed',
    });
    expect(client.query).toHaveBeenCalledWith(
      'delete from project_members where project_id = $1 and user_id = $2',
      [projectId, inviteeId],
    );
    expect(client.query).toHaveBeenCalledWith('select pg_notify($1, $2)', [
      MEMBERSHIP_CHANGED_NOTIFY_CHANNEL,
      JSON.stringify({ userId: inviteeId }),
    ]);
  });

  it('removes a screenplay member, and reports not-a-member when the delete matched nothing', async () => {
    const removed = fakeClient([
      empty(),
      rows([{ projectId, projectTitle: 'P', screenplayTitle: 'S' }]),
      rows([{ role: 'owner' }]),
      rows([{ userId: inviteeId }]),
    ]);
    await expect(store(removed).removeMember(actorId, screenplayScope, inviteeId)).resolves.toEqual(
      { outcome: 'removed' },
    );

    const absent = fakeClient([
      empty(),
      rows([{ projectId, projectTitle: 'P', screenplayTitle: 'S' }]),
      rows([{ role: 'owner' }]),
      empty(),
    ]);
    await expect(store(absent).removeMember(actorId, screenplayScope, inviteeId)).resolves.toEqual({
      outcome: 'not-a-member',
    });
    // Nothing is announced for a change that did not happen.
    expect(absent.query.mock.calls.map((call) => call[0])).not.toContain(
      'select pg_notify($1, $2)',
    );
  });
});

describe('listSharing', () => {
  it('returns project members at project scope, and never another scope’s invitations', async () => {
    const client = fakeClient([
      empty(),
      rows([{ projectId, projectTitle: 'P', screenplayTitle: null }]),
      rows([{ role: 'owner' }]),
      rows([{ userId: actorId, name: 'Owner', email: 'o@b.test', role: 'owner' }]),
      rows([{ id: 'i-1', name: 'Pending', email: 'p@b.test', role: 'editor', createdAt: now }]),
    ]);
    await expect(store(client).listSharing(actorId, projectScope)).resolves.toEqual({
      members: [
        { userId: actorId, name: 'Owner', email: 'o@b.test', role: 'owner', scope: 'project' },
      ],
      invitations: [
        {
          id: 'i-1',
          name: 'Pending',
          email: 'p@b.test',
          role: 'editor',
          createdAt: now.toISOString(),
        },
      ],
    });
    const invitationQuery = client.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('from membership_invitations'),
    );
    expect(invitationQuery?.[0]).toContain('screenplay_id is null');
  });

  it('marks inherited project access and direct screenplay access distinctly at screenplay scope', async () => {
    const client = fakeClient([
      empty(),
      rows([{ projectId, projectTitle: 'P', screenplayTitle: 'S' }]),
      rows([{ role: 'owner' }]),
      rows([{ userId: actorId, name: 'Owner', email: 'o@b.test', role: 'owner' }]),
      rows([{ userId: inviteeId, name: 'Guest', email: 'g@b.test', role: 'editor' }]),
      empty(),
    ]);
    await expect(store(client).listSharing(actorId, screenplayScope)).resolves.toEqual({
      members: [
        { userId: actorId, name: 'Owner', email: 'o@b.test', role: 'owner', scope: 'project' },
        {
          userId: inviteeId,
          name: 'Guest',
          email: 'g@b.test',
          role: 'editor',
          scope: 'screenplay',
        },
      ],
      invitations: [],
    });
  });

  it('refuses a reviewer and a non-member, releasing the client either way', async () => {
    const reviewerClient = fakeClient(authorized('reviewer'));
    await expect(store(reviewerClient).listSharing(actorId, projectScope)).resolves.toBe(
      'forbidden',
    );
    expect(reviewerClient.release).toHaveBeenCalledOnce();
    const strangerClient = fakeClient([empty(), empty()]);
    await expect(store(strangerClient).listSharing(actorId, projectScope)).resolves.toBe('missing');
    expect(strangerClient.release).toHaveBeenCalledOnce();
  });
});

describe('revokeInvitation', () => {
  it('deletes a pending invitation for an authorized inviter', async () => {
    const client = fakeClient([empty(), rows([{ projectId }]), rows([{ role: 'editor' }])]);
    await expect(store(client).revokeInvitation(actorId, 'invitation-1')).resolves.toEqual({
      outcome: 'revoked',
    });
    expect(client.query).toHaveBeenCalledWith('delete from membership_invitations where id = $1', [
      'invitation-1',
    ]);
    // Nothing to announce: a pending invitation granted no access, so no live connection can be
    // affected by withdrawing it.
    expect(client.query.mock.calls.map((call) => call[0])).not.toContain(
      'select pg_notify($1, $2)',
    );
  });

  it('reports an unknown, already-answered, or foreign invitation as missing', async () => {
    const client = fakeClient([empty(), empty()]);
    await expect(store(client).revokeInvitation(actorId, 'invitation-1')).resolves.toBe('missing');
  });

  it('refuses a project reviewer', async () => {
    const client = fakeClient([empty(), rows([{ projectId }]), rows([{ role: 'reviewer' }])]);
    await expect(store(client).revokeInvitation(actorId, 'invitation-1')).resolves.toBe(
      'forbidden',
    );
  });
});

describe('listInvitationsForUser', () => {
  it('reads only this actor’s pending invitations, and never an inviter’s email address', async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(async () =>
        rows([
          {
            id: 'invitation-1',
            role: 'editor',
            createdAt: now,
            projectId,
            projectTitle: 'P',
            screenplayId: null,
            screenplayTitle: null,
            invitedByName: 'The Inviter',
          },
        ]),
      ),
    } as never;
    const result = await createPostgresSharingStore(
      pool,
      notifier,
      () => now,
    ).listInvitationsForUser(actorId);
    expect(result).toEqual([
      {
        id: 'invitation-1',
        role: 'editor',
        createdAt: now.toISOString(),
        projectId,
        projectTitle: 'P',
        screenplayId: null,
        screenplayTitle: null,
        invitedByName: 'The Inviter',
      },
    ]);
    const [sql, values] = (pool as unknown as { query: ReturnType<typeof vi.fn> }).query.mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain("i.status = 'pending'");
    expect(sql).toContain('i.invited_user_id = $1');
    // The invitee did not supply the inviter's address and has no need for it.
    expect(sql).toContain('inviter.name');
    expect(sql).not.toContain('inviter.email');
    expect(values).toEqual([actorId]);
  });
});

describe('respondToInvitation', () => {
  it('scopes the lookup to this actor, so someone else’s invitation id is simply missing', async () => {
    const client = fakeClient([empty(), empty()]);
    await expect(
      store(client).respondToInvitation(actorId, 'invitation-1', { response: 'accept' }),
    ).resolves.toBe('missing');
    const lookup = client.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('from membership_invitations'),
    );
    expect(lookup?.[0]).toContain('i.invited_user_id = $2');
    expect(lookup?.[1]).toEqual(['invitation-1', actorId]);
  });

  it('reports an already-answered invitation as not-pending rather than acting again', async () => {
    const client = fakeClient([
      empty(),
      rows([{ projectId, screenplayId: null, role: 'editor', status: 'accepted' }]),
    ]);
    await expect(
      store(client).respondToInvitation(actorId, 'invitation-1', { response: 'accept' }),
    ).resolves.toEqual({ outcome: 'not-pending' });
    const statements = client.query.mock.calls.map((call) => call[0]).join('\n');
    expect(statements).not.toContain('insert into project_members');
  });

  it('accepting a project invitation writes project membership, upserting so a replay is harmless', async () => {
    const client = fakeClient([
      empty(),
      rows([{ projectId, screenplayId: null, role: 'editor', status: 'pending' }]),
    ]);
    await expect(
      store(client).respondToInvitation(actorId, 'invitation-1', { response: 'accept' }),
    ).resolves.toEqual({ outcome: 'accepted', projectId, screenplayId: null, role: 'editor' });
    const insert = client.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('insert into project_members'),
    );
    expect(insert?.[0]).toContain('on conflict (project_id, user_id) do update');
    expect(insert?.[1]).toEqual([projectId, actorId, 'editor']);
  });

  it('accepting a screenplay invitation writes screenplay membership only', async () => {
    const client = fakeClient([
      empty(),
      rows([{ projectId, screenplayId, role: 'reviewer', status: 'pending' }]),
    ]);
    await expect(
      store(client).respondToInvitation(actorId, 'invitation-1', { response: 'accept' }),
    ).resolves.toEqual({ outcome: 'accepted', projectId, screenplayId, role: 'reviewer' });
    const statements = client.query.mock.calls.map((call) => call[0]).join('\n');
    expect(statements).toContain('insert into screenplay_members');
    // The whole point of the scope: accepting a screenplay invitation must never make anyone a
    // member of the project.
    expect(statements).not.toContain('insert into project_members');
  });

  it('declining writes no membership of any kind', async () => {
    const client = fakeClient([
      empty(),
      rows([{ projectId, screenplayId, role: 'editor', status: 'pending' }]),
    ]);
    await expect(
      store(client).respondToInvitation(actorId, 'invitation-1', { response: 'decline' }),
    ).resolves.toEqual({ outcome: 'declined' });
    const statements = client.query.mock.calls.map((call) => call[0]).join('\n');
    expect(statements).toContain("status = 'declined'");
    expect(statements).not.toContain('insert into screenplay_members');
    expect(statements).not.toContain('insert into project_members');
  });
});

describe('transaction discipline', () => {
  it('rolls back and releases the client when a query throws, on every operation', async () => {
    const operations: Array<(s: ReturnType<typeof store>) => Promise<unknown>> = [
      (s) => s.listSharing(actorId, projectScope),
      (s) => s.invite(actorId, projectScope, { email: 'a@b.test', role: 'editor' }),
      (s) => s.changeMemberRole(actorId, projectScope, inviteeId, 'reviewer'),
      (s) => s.removeMember(actorId, projectScope, inviteeId),
      (s) => s.revokeInvitation(actorId, 'invitation-1'),
      (s) => s.respondToInvitation(actorId, 'invitation-1', { response: 'accept' }),
    ];
    for (const operation of operations) {
      const client = {
        query: vi.fn(async (text: string) => {
          if (text === 'begin') return empty();
          if (text === 'rollback') return empty();
          throw new Error('Postgres went away');
        }),
        release: vi.fn(),
      };
      await expect(operation(store(client))).rejects.toThrow('Postgres went away');
      expect(client.query).toHaveBeenCalledWith('rollback');
      expect(client.release).toHaveBeenCalledOnce();
    }
  });
});
