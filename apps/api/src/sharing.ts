import { MEMBERSHIP_CHANGED_NOTIFY_CHANNEL, type EffectiveRole } from '@finaler-draft/database';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

/**
 * The screenplay-invitations slice: becoming a member, and managing who is one.
 *
 * Until this module existed, the only write to `project_members` anywhere in the system was
 * `createProject`'s "make the creator the owner" (apps/api/src/projects.ts) -- so the `reviewer`
 * role that `resolveConnectionAuthorization` enforces read-only at the socket, and every read path
 * that joins membership, described a population of exactly one person per project. plan.md builds
 * the whole entitlement design on invitations ("A free account **invited** to a screenplay may edit
 * it by making it the one screenplay it holds editable"), and none of it was reachable.
 *
 * **Two scopes, one set of operations.** `SharingScope` is either a whole project or a single
 * screenplay, and every operation here takes one. Accepting a project-scoped invitation writes
 * `project_members`; accepting a screenplay-scoped one writes `screenplay_members`. See
 * `screenplayMembers`' own schema comment for why those are two tables rather than one table with a
 * nullable column, and `ProjectStore`'s interface comment for which read paths honour which.
 *
 * **Who may share: owner or editor on the *project*, both scopes.** Resolved from `project_members`
 * alone -- deliberately not through `screenplayRoleLateral`, so a screenplay-scoped editor cannot
 * invite anyone at all. That is the same `canEdit` bar every other project mutation already sets
 * (`renameProject`, `createScreenplay`, `deleteScreenplay`), and it is bounded in the one way that
 * matters: `sharedRole` has no `'owner'` value, so no invitation and no membership row this module
 * writes can grant more than the inviter already holds, and no path here can remove or demote the
 * project's owner.
 *
 * **An invitation grants nothing.** `membership_invitations` is never joined by an authorization
 * path; `respondToInvitation`'s `accept` is the only thing in this codebase that writes a
 * membership row on an invitee's behalf. A pending invitation is refused by every REST path and by
 * the collaboration socket for exactly the reason a stranger is -- there is no membership row --
 * which is a property of the schema rather than of a check that could be forgotten.
 *
 * **The project-ownership-transfer slice: `transferOwnership`, the one deliberate second path to
 * ownership.** Every operation above this comment is bounded by "no invitation or membership row
 * this module writes can grant more than the inviter already holds" -- `sharedRole` has no
 * `'owner'` value, and `changeMemberRole`/`removeMember` both refuse outright the moment the
 * target's role is `'owner'` (`MemberChangeOutcome`'s own `'owner-immutable'`). `transferOwnership`
 * is the one function in this file that is allowed to write an `'owner'` role, because moving
 * ownership -- as opposed to sharing access -- is the feature it exists to implement. It does not
 * weaken `owner-immutable`: that guard is unconditional in `changeMemberRole`/`removeMember`, which
 * still cannot touch an owner row by any role or target; `transferOwnership` is a third, narrower
 * function with its own stricter bar (the *current* owner only, never an editor), not a backdoor
 * through the existing ones. See its own doc comment for the authorization rule, the write order
 * `project_single_owner_unique` requires, and the advisory lock that makes two concurrent transfers
 * of the same project serialize rather than interleave.
 */

export type SharedRole = 'editor' | 'reviewer';
export type { EffectiveRole };

/** The role an invitation may grant. `'owner'` is absent here and absent from the `shared_role`
 * Postgres enum, so sharing can never become a second path to project ownership. */
export const sharedRoleSchema = z.enum(['editor', 'reviewer']);

/**
 * Lowercased before it is ever compared. Better Auth stores `user.email` lowercased (confirmed in
 * the installed 1.6.25 `api/routes/sign-up.mjs`: `const normalizedEmail = email.toLowerCase()`
 * ahead of both the duplicate check and the insert), so lowercasing here makes the lookup both
 * correct for a mixed-case address the inviter typed and able to use `user_email_unique` -- unlike a
 * `lower(email) = ...` comparison, which would correctly match and then scan.
 */
export const inviteInput = z
  .object({
    email: z
      .string()
      .trim()
      .min(3)
      .max(320)
      .email()
      .transform((value) => value.toLowerCase()),
    role: sharedRoleSchema,
  })
  .strict();
export type InviteInput = z.infer<typeof inviteInput>;

export const changeRoleInput = z.object({ role: sharedRoleSchema }).strict();
// Matches `memberParams`'s own `userId` bound in `apps/api/src/app.ts` exactly (Better Auth
// `user.id` is an opaque `text` column, not a UUID, so this is deliberately not `.uuid()`): the
// target travels in the body here rather than the URL, because unlike `changeRoleInput`/
// `respondToInvitationInput` this input names a *second* account rather than acting on the one
// the URL already identifies.
export const transferOwnershipInput = z
  .object({ targetUserId: z.string().min(1).max(255) })
  .strict();
export type TransferOwnershipInput = z.infer<typeof transferOwnershipInput>;
export const respondToInvitationInput = z
  .object({ response: z.enum(['accept', 'decline']) })
  .strict();
export type RespondToInvitationInput = z.infer<typeof respondToInvitationInput>;

export type SharingScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'screenplay'; screenplayId: string };

export interface SharingMember {
  userId: string;
  name: string;
  email: string;
  role: EffectiveRole;
  /**
   * `'project'` for a `project_members` row, `'screenplay'` for a `screenplay_members` row. At
   * screenplay scope both appear: a `'project'` entry is access inherited from the project, which
   * this dialog deliberately shows (so an inviter can see the invitation they are about to send is
   * redundant) but cannot edit or remove from here -- changing project-wide membership belongs to
   * the project's own sharing view, not to one screenplay inside it.
   */
  scope: 'project' | 'screenplay';
}

export interface SharingInvitation {
  id: string;
  name: string;
  email: string;
  role: SharedRole;
  createdAt: string;
}

export interface SharingView {
  members: SharingMember[];
  /** Pending only. An accepted invitation is represented by the membership it created, and a
   * declined one is not something to keep showing the inviter as outstanding. */
  invitations: SharingInvitation[];
}

export type InviteOutcome =
  | {
      outcome: 'invited';
      invitation: SharingInvitation;
      /** `false` when an existing invitation to this same scope and account was reused rather than
       * a second row written -- the re-invite idempotency the brief requires. See `invite` below
       * for exactly what a reused row does and does not change. */
      created: boolean;
    }
  /** This account already holds access at or above the requested role, so there is nothing for an
   * invitation to grant. Carries what they already have so the dialog can say so. */
  | { outcome: 'already-member'; role: EffectiveRole; scope: 'project' | 'screenplay' }
  /** No account exists for that address. Honest and distinguishable by the owner's explicit
   * decision -- see this module's `NO_ACCOUNT_MESSAGE` for the reasoning and the wording. */
  | { outcome: 'no-account' }
  | { outcome: 'self' }
  | 'missing'
  | 'forbidden';

export type MemberChangeOutcome =
  | { outcome: 'changed'; role: EffectiveRole }
  | { outcome: 'removed' }
  /** The target holds no membership row at this scope. Not distinguished from "no such account", the
   * same information-hiding convention the rest of this API uses for an id that resolves to
   * nothing the caller may see. */
  | { outcome: 'not-a-member' }
  /** The target is the project's owner. Ownership is established once, by `createProject`, and
   * `project_single_owner_unique` guarantees there is exactly one -- so neither demoting nor
   * removing it is an operation this module offers. Without this guard an editor could remove the
   * owner and leave a project nobody can delete, rename, or share. */
  | { outcome: 'owner-immutable' }
  | 'missing'
  | 'forbidden';

export type RevokeInvitationOutcome = { outcome: 'revoked' } | 'missing' | 'forbidden';

export type TransferOwnershipOutcome =
  | { outcome: 'transferred'; newOwnerId: string }
  /** The target holds no `project_members` row at all. Not "invite them first" -- the brief's
   * explicit decision is that ownership can only move to someone who has already chosen to
   * collaborate on this project, which an invitation-and-acceptance flow for an arbitrary address
   * would not guarantee. Not distinguished from "no such account" for the same information-hiding
   * reason `MemberChangeOutcome`'s `'not-a-member'` already isn't. */
  | { outcome: 'not-a-member' }
  /** The target *is* the actor, i.e. the current owner asked to transfer to themselves. Checked
   * after confirming the actor is the owner, so this can only ever be reported to someone who
   * actually held ownership to begin with -- never used to probe who owns a project. */
  | { outcome: 'already-owner' }
  | 'missing'
  | 'forbidden';

export interface IncomingInvitation {
  id: string;
  role: SharedRole;
  createdAt: string;
  projectId: string;
  projectTitle: string;
  /** `null` for a project-scoped invitation. */
  screenplayId: string | null;
  /** `null` for a project-scoped invitation. */
  screenplayTitle: string | null;
  /** The inviter's display name, or `null` if that account has since been deleted
   * (`invited_by_user_id` is `on delete set null`). Never their email address: the invitee did not
   * supply it and has no need for it, and this is the one page in the flow whose viewer is not the
   * person who typed an address. */
  invitedByName: string | null;
}

export type RespondOutcome =
  | { outcome: 'accepted'; projectId: string; screenplayId: string | null; role: SharedRole }
  | { outcome: 'declined' }
  /** The invitation is not pending any more -- already accepted, already declined, or revoked. A
   * replayed click, not an error worth alarming anyone about. */
  | { outcome: 'not-pending' }
  | 'missing';

/**
 * The message a dialog shows when the invited address has no account.
 *
 * **Why this is honest rather than concealed.** `apps/api/src/app.ts` documents an
 * anti-enumeration rule for membership and auth errors, and that rule is right where it came
 * from -- *unauthenticated* endpoints like password reset, which anyone can probe anonymously and
 * at will. This endpoint is not one: it sits behind the same `preValidation` hook as every other
 * project mutation (authenticated session, same-origin check) and additionally requires
 * owner-or-editor membership on the project, so probing it requires a real account, is attributable
 * to that account, and is bounded by the global per-client rate limit `@fastify/rate-limit` applies
 * to every `/api` route. A determined prober with an account defeats concealment anyway by reading
 * the pending list; what concealment actually costs is every honest inviter who typos an address
 * and is told nothing. The owner weighed that explicitly and chose the message.
 *
 * Phrased about the address, not the person: the product does not know who was meant, and
 * "this user does not exist" would imply it does.
 */
export const NO_ACCOUNT_MESSAGE =
  'No account found for that email address. They need a Finaler Draft account before they can be invited.';

export interface SharingStore {
  /** The inviter-side view: who has access at this scope, and which invitations are outstanding. */
  listSharing(actorId: string, scope: SharingScope): Promise<SharingView | 'missing' | 'forbidden'>;
  invite(actorId: string, scope: SharingScope, input: InviteInput): Promise<InviteOutcome>;
  changeMemberRole(
    actorId: string,
    scope: SharingScope,
    targetUserId: string,
    role: SharedRole,
  ): Promise<MemberChangeOutcome>;
  removeMember(
    actorId: string,
    scope: SharingScope,
    targetUserId: string,
  ): Promise<MemberChangeOutcome>;
  /** Withdraws an invitation that has not been answered. Scope comes from the invitation row
   * itself, so there is one route rather than one per scope. */
  revokeInvitation(actorId: string, invitationId: string): Promise<RevokeInvitationOutcome>;
  /**
   * Moves ownership of a project from `actorId` (who must be its current owner) to
   * `targetUserId` (who must already be a member of it). The previous owner is demoted to
   * `editor`, never removed -- see this file's module comment for the full argument and
   * `transferOwnership`'s own implementation comment for the write order and the lock. Project
   * scope only: there is no screenplay-scoped owner to transfer (`shared_role` has no `'owner'`
   * value), so this takes a bare `projectId` rather than a `SharingScope`.
   */
  transferOwnership(
    actorId: string,
    projectId: string,
    targetUserId: string,
  ): Promise<TransferOwnershipOutcome>;
  /** The invitee-side list the dashboard renders Accept/Decline against. */
  listInvitationsForUser(actorId: string): Promise<IncomingInvitation[]>;
  respondToInvitation(
    actorId: string,
    invitationId: string,
    input: RespondToInvitationInput,
  ): Promise<RespondOutcome>;
}

/**
 * What `invite` hands to the notification mail port, once the invitation has actually committed.
 * The dashboard is the authoritative accept/decline mechanism (it needs no token to leak or
 * expire, it is revocable, and it does not depend on mail delivery), so this email is *only* a
 * nudge toward it -- it carries no token and grants nothing.
 */
export interface InvitationNotification {
  toEmail: string;
  toName: string;
  inviterName: string;
  projectTitle: string;
  /** `null` for a project-scoped invitation. */
  screenplayTitle: string | null;
  role: SharedRole;
}

export interface SharingNotifier {
  invitationCreated(notification: InvitationNotification): Promise<void>;
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Resolves the scope to its project, locking the rows the operation is about to authorize against,
 * and refuses a scope whose project (or screenplay) is soft-deleted or absent. `'missing'` never
 * distinguishes "does not exist" from "you cannot see it".
 *
 * For a screenplay scope this locks the screenplay row *and* its project row -- the same pair
 * `projects.ts`'s `lockScreenplayRow` locks, for the same reason: a concurrent `deleteProject` or
 * `deleteScreenplay` must serialize against a membership change rather than interleave with it,
 * or an invitation could be written into a project that has just been deleted.
 */
async function lockScope(
  client: Queryable,
  scope: SharingScope,
): Promise<
  { projectId: string; projectTitle: string; screenplayTitle: string | null } | 'missing'
> {
  if (scope.kind === 'project') {
    const result = await client.query(
      `select p.id as "projectId", p.title as "projectTitle"
         from projects p
        where p.id = $1 and p.deleted_at is null
        for update`,
      [scope.projectId],
    );
    if (result.rowCount !== 1) return 'missing';
    const row = result.rows[0] as { projectId: string; projectTitle: string };
    return { ...row, screenplayTitle: null };
  }
  const result = await client.query(
    `select s.project_id as "projectId", p.title as "projectTitle", s.title as "screenplayTitle"
       from screenplays s
       join projects p on p.id = s.project_id
      where s.id = $1 and s.deleted_at is null and p.deleted_at is null
      for update of s, p`,
    [scope.screenplayId],
  );
  if (result.rowCount !== 1) return 'missing';
  return result.rows[0] as {
    projectId: string;
    projectTitle: string;
    screenplayTitle: string | null;
  };
}

/**
 * The actor's role on the *project*, from `project_members` alone. This is the sharing privilege
 * for both scopes -- see this module's own comment on why a screenplay-scoped editor must not be
 * able to invite anyone, and why `screenplayRoleLateral` is deliberately not used here.
 */
async function fetchProjectRole(
  client: Queryable,
  projectId: string,
  actorId: string,
): Promise<EffectiveRole | undefined> {
  const result = await client.query(
    'select role from project_members where project_id = $1 and user_id = $2 for update',
    [projectId, actorId],
  );
  return (result.rows[0] as { role?: EffectiveRole } | undefined)?.role;
}

function canManageSharing(role: EffectiveRole | undefined): boolean {
  return role === 'owner' || role === 'editor';
}

const ROLE_RANK: Record<EffectiveRole, number> = { owner: 0, editor: 1, reviewer: 2 };

/** True when `held` is at least as privileged as `wanted` -- the same `owner > editor > reviewer`
 * precedence `screenplayRoleLateral` applies, so "they already have this" here and "most privileged
 * wins" there can never disagree. */
function alreadyCovers(held: EffectiveRole, wanted: SharedRole): boolean {
  return ROLE_RANK[held] <= ROLE_RANK[wanted];
}

/**
 * The advisory-lock namespace `transferOwnership` takes, keyed by `hashtext(projectId)`.
 *
 * Deliberately a namespace of its own, not a reuse of `packages/database`'s
 * `REVISION_LOCK_NAMESPACE` (`-1`): that lock is keyed by *screenplay* id and serializes
 * `document_revisions` writers against each other, a completely different id space and a
 * completely different invariant. A shared namespace would be harmless on paper (`hashtext`
 * folding a project id and a screenplay id to the same 32-bit value is already an accepted,
 * merely-unlucky-performance cost elsewhere in this codebase -- see `updateLog.ts`'s own comment
 * on exactly that) but gives no benefit either, so this gets its own constant rather than
 * borrowing one that means something unrelated. `-2` is simply the next negative integer after
 * `-1`; any value works as long as it does not collide with `updateLog.ts`'s epoch-keyed second
 * argument, which is always a non-negative epoch number, so every negative constant is already
 * disjoint from it.
 */
const PROJECT_OWNERSHIP_LOCK_NAMESPACE = -2;

async function acquireOwnershipLock(client: Queryable, projectId: string): Promise<void> {
  // Tagged with a call-site comment for the identical reason every other `pg_advisory_xact_lock`
  // site in this codebase is (see `restore.ts`'s `acquireRevisionLock` and
  // `progress/revision-lock-deadlock.md`, the production incident that is why this convention
  // exists at all): Postgres's own deadlock report prints each blocked process's *current
  // statement*, and an untagged lock statement would say only "something is waiting for an
  // advisory lock," not which function. The next deadlock report involving this lock names this
  // function by itself.
  await client.query(
    'select pg_advisory_xact_lock(hashtext($1), $2) /* sharing.acquireOwnershipLock */',
    [projectId, PROJECT_OWNERSHIP_LOCK_NAMESPACE],
  );
}

/**
 * Announces a committed membership change to `apps/collab`, inside the caller's transaction, so the
 * notification is delivered if and only if the change commits. See
 * `MEMBERSHIP_CHANGED_NOTIFY_CHANNEL`'s own comment for why the payload names only the account and
 * what `apps/collab` does with it.
 *
 * Called by `changeMemberRole` and `removeMember` only. `respondToInvitation`'s `accept` does not
 * need it: accepting only ever *grants* access, and no open connection can be wrong because its
 * holder gained access somewhere. Neither does `revokeInvitation`, which withdraws something that
 * granted nothing.
 */
async function notifyMembershipChanged(client: Queryable, userId: string): Promise<void> {
  await client.query('select pg_notify($1, $2)', [
    MEMBERSHIP_CHANGED_NOTIFY_CHANNEL,
    JSON.stringify({ userId }),
  ]);
}

function toSharingInvitation(row: {
  id: string;
  name: string;
  email: string;
  role: SharedRole;
  createdAt: Date;
}): SharingInvitation {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

export function createPostgresSharingStore(
  pool: Pool,
  notifier: SharingNotifier,
  // Injectable purely for deterministic tests, matching `createPostgresRestoreStore`'s own
  // convention; defaults to the real clock everywhere else.
  now: () => Date = () => new Date(),
): SharingStore {
  return {
    async listSharing(actorId, scope) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const resolved = await lockScope(client, scope);
        if (resolved === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        const actorRole = await fetchProjectRole(client, resolved.projectId, actorId);
        if (actorRole === undefined) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canManageSharing(actorRole)) {
          await client.query('rollback');
          return 'forbidden';
        }
        // Project-scoped membership is listed at both scopes: at project scope it is the whole
        // answer, and at screenplay scope it is the inherited access an inviter needs to see
        // before sending a redundant invitation (`scope: 'project'` marks it unmanageable from
        // here).
        const projectMembers = await client.query(
          `select m.user_id as "userId", u.name, u.email, m.role::text as role
             from project_members m
             join "user" u on u.id = m.user_id
            where m.project_id = $1
            order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, u.email asc`,
          [resolved.projectId],
        );
        const screenplayMembers =
          scope.kind === 'screenplay'
            ? await client.query(
                `select sm.user_id as "userId", u.name, u.email, sm.role::text as role
                   from screenplay_members sm
                   join "user" u on u.id = sm.user_id
                  where sm.screenplay_id = $1
                  order by sm.role::text asc, u.email asc`,
                [scope.screenplayId],
              )
            : { rows: [] };
        // Invitations are filtered to this exact scope, not to the project: a project-scoped
        // sharing view must not list the pending invitations of individual screenplays inside it
        // (they are not its to revoke or re-send), and a screenplay-scoped view must not list the
        // project's.
        const invitations =
          scope.kind === 'project'
            ? await client.query(
                `select i.id, u.name, u.email, i.role::text as role, i.created_at as "createdAt"
                   from membership_invitations i
                   join "user" u on u.id = i.invited_user_id
                  where i.project_id = $1 and i.screenplay_id is null and i.status = 'pending'
                  order by i.created_at asc`,
                [resolved.projectId],
              )
            : await client.query(
                `select i.id, u.name, u.email, i.role::text as role, i.created_at as "createdAt"
                   from membership_invitations i
                   join "user" u on u.id = i.invited_user_id
                  where i.screenplay_id = $1 and i.status = 'pending'
                  order by i.created_at asc`,
                [scope.screenplayId],
              );
        await client.query('commit');
        return {
          members: [
            ...(projectMembers.rows as Array<Omit<SharingMember, 'scope'>>).map((row) => ({
              ...row,
              scope: 'project' as const,
            })),
            ...(screenplayMembers.rows as Array<Omit<SharingMember, 'scope'>>).map((row) => ({
              ...row,
              scope: 'screenplay' as const,
            })),
          ],
          invitations: (
            invitations.rows as Array<{
              id: string;
              name: string;
              email: string;
              role: SharedRole;
              createdAt: Date;
            }>
          ).map(toSharingInvitation),
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async invite(actorId, scope, input) {
      const client = await pool.connect();
      let notification: InvitationNotification | undefined;
      let result: InviteOutcome;
      try {
        await client.query('begin');
        const resolved = await lockScope(client, scope);
        if (resolved === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        const actorRole = await fetchProjectRole(client, resolved.projectId, actorId);
        if (actorRole === undefined) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canManageSharing(actorRole)) {
          await client.query('rollback');
          return 'forbidden';
        }
        // Invite-by-email resolves to an existing account only (the owner's decision for this
        // slice: no sign-up-on-invite). `user_email_unique` makes this a single index lookup on an
        // already-lowercased address -- see `inviteInput`.
        const invitee = await client.query('select id, name, email from "user" where email = $1', [
          input.email,
        ]);
        const inviteeRow = invitee.rows[0] as
          | { id: string; name: string; email: string }
          | undefined;
        if (!inviteeRow) {
          await client.query('rollback');
          return { outcome: 'no-account' };
        }
        if (inviteeRow.id === actorId) {
          await client.query('rollback');
          return { outcome: 'self' };
        }
        // "Already has this" is checked against *effective* access, not just a row at this exact
        // scope, so a project editor is not sent a screenplay-scoped `reviewer` invitation that
        // would change nothing when accepted (most-privileged wins -- `screenplayRoleLateral`).
        // The same check is what makes re-inviting an existing member a clear answer rather than a
        // pending invitation that can never do anything.
        const inheritedRole = (
          await client.query(
            'select role from project_members where project_id = $1 and user_id = $2',
            [resolved.projectId, inviteeRow.id],
          )
        ).rows[0] as { role?: EffectiveRole } | undefined;
        if (inheritedRole?.role && alreadyCovers(inheritedRole.role, input.role)) {
          await client.query('rollback');
          return { outcome: 'already-member', role: inheritedRole.role, scope: 'project' };
        }
        if (scope.kind === 'screenplay') {
          const existing = (
            await client.query(
              'select role from screenplay_members where screenplay_id = $1 and user_id = $2',
              [scope.screenplayId, inviteeRow.id],
            )
          ).rows[0] as { role?: EffectiveRole } | undefined;
          if (existing?.role && alreadyCovers(existing.role, input.role)) {
            await client.query('rollback');
            return { outcome: 'already-member', role: existing.role, scope: 'screenplay' };
          }
        }
        // One row per (scope, invited account), for every status -- enforced by the two partial
        // unique indexes on `membership_invitations` and serialized here by the scope row lock
        // `lockScope` already holds, so this select-then-write cannot race itself. Re-inviting
        // therefore *updates* the one existing row: it can raise or lower the offered role, and it
        // returns a declined or accepted row to `pending` so declining is not a permanent block.
        // What it never does is write a second row, and what it never touches is
        // `editable_slots.updated_at` -- the only cooldown in this system, which plan.md requires
        // re-sharing not to reset.
        const at = now();
        const existingInvitation = (
          await client.query(
            scope.kind === 'project'
              ? `select id, status::text as status from membership_invitations
                  where project_id = $1 and screenplay_id is null and invited_user_id = $2
                  for update`
              : `select id, status::text as status from membership_invitations
                  where screenplay_id = $1 and invited_user_id = $2
                  for update`,
            [scope.kind === 'project' ? resolved.projectId : scope.screenplayId, inviteeRow.id],
          )
        ).rows[0] as { id: string; status: string } | undefined;
        let invitationRow: {
          id: string;
          role: SharedRole;
          createdAt: Date;
        };
        let created: boolean;
        if (existingInvitation) {
          const updated = await client.query(
            `update membership_invitations
                set role = $2, status = 'pending', invited_by_user_id = $3, updated_at = $4
              where id = $1
              returning id, role::text as role, created_at as "createdAt"`,
            [existingInvitation.id, input.role, actorId, at],
          );
          invitationRow = updated.rows[0] as { id: string; role: SharedRole; createdAt: Date };
          created = false;
        } else {
          const inserted = await client.query(
            `insert into membership_invitations
                (project_id, screenplay_id, invited_user_id, invited_by_user_id, role, status,
                 created_at, updated_at)
              values ($1, $2, $3, $4, $5, 'pending', $6, $6)
              returning id, role::text as role, created_at as "createdAt"`,
            [
              resolved.projectId,
              scope.kind === 'screenplay' ? scope.screenplayId : null,
              inviteeRow.id,
              actorId,
              input.role,
              at,
            ],
          );
          invitationRow = inserted.rows[0] as { id: string; role: SharedRole; createdAt: Date };
          created = true;
        }
        const inviterName = (await client.query('select name from "user" where id = $1', [actorId]))
          .rows[0] as { name?: string } | undefined;
        await client.query('commit');
        notification = {
          toEmail: inviteeRow.email,
          toName: inviteeRow.name,
          inviterName: inviterName?.name ?? 'A Finaler Draft writer',
          projectTitle: resolved.projectTitle,
          screenplayTitle: resolved.screenplayTitle,
          role: input.role,
        };
        result = {
          outcome: 'invited',
          created,
          invitation: toSharingInvitation({
            ...invitationRow,
            name: inviteeRow.name,
            email: inviteeRow.email,
          }),
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      // Sent after the commit, and deliberately not allowed to fail the request. The dashboard is
      // the authoritative mechanism: the invitation is already committed and already visible to the
      // invitee, so turning a mail-provider outage into a 500 here would report failure for
      // something that fully succeeded -- and would invite a retry that, being idempotent, would
      // only try to send the same mail again. The failure is loud in the logs instead, the same
      // discipline `sendOrLogFailure` (packages/auth-server) applies to the reset/verification
      // sends for the same reason.
      await notifier.invitationCreated(notification).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: 'invitation_email_failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
      return result;
    },

    async changeMemberRole(actorId, scope, targetUserId, role) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const resolved = await lockScope(client, scope);
        if (resolved === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        const actorRole = await fetchProjectRole(client, resolved.projectId, actorId);
        if (actorRole === undefined) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canManageSharing(actorRole)) {
          await client.query('rollback');
          return 'forbidden';
        }
        if (scope.kind === 'project') {
          const target = await client.query(
            'select role from project_members where project_id = $1 and user_id = $2 for update',
            [resolved.projectId, targetUserId],
          );
          const targetRole = (target.rows[0] as { role?: EffectiveRole } | undefined)?.role;
          if (!targetRole) {
            await client.query('rollback');
            return { outcome: 'not-a-member' };
          }
          if (targetRole === 'owner') {
            await client.query('rollback');
            return { outcome: 'owner-immutable' };
          }
          await client.query(
            'update project_members set role = $3 where project_id = $1 and user_id = $2',
            [resolved.projectId, targetUserId, role],
          );
        } else {
          const target = await client.query(
            'select role from screenplay_members where screenplay_id = $1 and user_id = $2 for update',
            [scope.screenplayId, targetUserId],
          );
          if (!(target.rows[0] as { role?: SharedRole } | undefined)?.role) {
            await client.query('rollback');
            return { outcome: 'not-a-member' };
          }
          await client.query(
            'update screenplay_members set role = $3 where screenplay_id = $1 and user_id = $2',
            [scope.screenplayId, targetUserId, role],
          );
        }
        await notifyMembershipChanged(client, targetUserId);
        await client.query('commit');
        return { outcome: 'changed', role };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async removeMember(actorId, scope, targetUserId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const resolved = await lockScope(client, scope);
        if (resolved === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        const actorRole = await fetchProjectRole(client, resolved.projectId, actorId);
        if (actorRole === undefined) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canManageSharing(actorRole)) {
          await client.query('rollback');
          return 'forbidden';
        }
        if (scope.kind === 'project') {
          const target = await client.query(
            'select role from project_members where project_id = $1 and user_id = $2 for update',
            [resolved.projectId, targetUserId],
          );
          const targetRole = (target.rows[0] as { role?: EffectiveRole } | undefined)?.role;
          if (!targetRole) {
            await client.query('rollback');
            return { outcome: 'not-a-member' };
          }
          if (targetRole === 'owner') {
            await client.query('rollback');
            return { outcome: 'owner-immutable' };
          }
          await client.query('delete from project_members where project_id = $1 and user_id = $2', [
            resolved.projectId,
            targetUserId,
          ]);
        } else {
          const deleted = await client.query(
            'delete from screenplay_members where screenplay_id = $1 and user_id = $2 returning user_id',
            [scope.screenplayId, targetUserId],
          );
          if (!deleted.rowCount) {
            await client.query('rollback');
            return { outcome: 'not-a-member' };
          }
        }
        await notifyMembershipChanged(client, targetUserId);
        await client.query('commit');
        return { outcome: 'removed' };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async revokeInvitation(actorId, invitationId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // The invitation carries its own scope, so authorization is resolved from the row rather
        // than from the URL -- which is why there is one revoke route instead of two. A pending
        // invitation grants nothing, so deleting it needs no notification to `apps/collab`.
        const invitation = await client.query(
          `select i.project_id as "projectId"
             from membership_invitations i
             join projects p on p.id = i.project_id
            where i.id = $1 and i.status = 'pending' and p.deleted_at is null
            for update of i`,
          [invitationId],
        );
        if (invitation.rowCount !== 1) {
          await client.query('rollback');
          return 'missing';
        }
        const { projectId } = invitation.rows[0] as { projectId: string };
        const actorRole = await fetchProjectRole(client, projectId, actorId);
        if (actorRole === undefined) {
          await client.query('rollback');
          return 'missing';
        }
        if (!canManageSharing(actorRole)) {
          await client.query('rollback');
          return 'forbidden';
        }
        await client.query('delete from membership_invitations where id = $1', [invitationId]);
        await client.query('commit');
        return { outcome: 'revoked' };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * The transfer itself. In order:
     *
     *  1. The advisory lock (`acquireOwnershipLock`), taken as the very first statement after
     *     `begin` -- before any row lock, following `restore.ts`'s `acquireRevisionLock` ordering
     *     for the identical reason: `progress/revision-lock-deadlock.md` documents a real
     *     deadlock that came from two paths taking an advisory lock and a row lock in opposite
     *     orders, and the only way to be safe against that class of bug by construction is for
     *     every advisory-lock site to agree on "advisory first." Nothing else in this codebase
     *     currently takes `PROJECT_OWNERSHIP_LOCK_NAMESPACE`, so there is no other call site that
     *     could disagree -- but this still follows the convention rather than being a one-off
     *     exception to it, since the next thing that needs a project-scoped advisory lock should
     *     find one example to copy, not two.
     *
     *     This is also the serialization point for the operation's own correctness, independent
     *     of deadlock avoidance. Two concurrent transfers of the *same* project (actor transfers
     *     to B, and -- before that commits -- someone races a second transfer to C) would, without
     *     this lock, both be able to read `actorId` as the current owner, both demote it, and
     *     both attempt to promote their own target. `project_single_owner_unique` is a plain
     *     (non-deferred) unique index, so the second promote would fail outright rather than
     *     silently double-own the project -- but it would do so *after* having already demoted the
     *     real owner to `editor`, leaving a transaction to roll back out of a half-finished write
     *     rather than a clean refusal. Taking the lock first means the second transfer's `begin`
     *     returns immediately but this statement blocks until the first transfer's commit or
     *     rollback, so the second transfer always re-reads a project whose owner is already
     *     whichever account the first transfer actually landed on, and reports `'forbidden'`
     *     (actor is no longer the owner) through the ordinary authorization check below --
     *     never a unique-violation exception, and never a moment with zero or two owners.
     *
     *  2. `lockScope`/`fetchProjectRole`, the identical row-lock helpers every other operation in
     *     this file uses, in the identical order (project row, then the actor's `project_members`
     *     row) -- so this function's row-lock ordering agrees with `invite`/`changeMemberRole`/
     *     `removeMember`/`listSharing`, and a future deadlock between this and any of them (there
     *     is currently no cycle: none of those four take any advisory lock at all, so they cannot
     *     be the other half of an advisory/row ordering cycle with this function) would still have
     *     to come from a genuinely new interleaving, not from this function inventing its own
     *     order for the same two tables.
     *
     *  3. Authorization: `actorRole !== 'owner'` is `'forbidden'`, stricter than every other
     *     operation's `canManageSharing` (owner-or-editor) -- the brief's explicit decision that
     *     only the current owner, never an editor, may give the project away.
     *
     *  4. The self-transfer check, before the target lookup: if the actor is confirmed as the
     *     owner and the target id equals the actor id, the target is trivially already a member
     *     (they hold the very `project_members` row just locked), so there is nothing to gain by
     *     querying it again.
     *
     *  5. The target's own membership, `'not-a-member'` if absent.
     *
     *  6. The two writes, *demote-then-promote*. `project_single_owner_unique` is checked after
     *     each statement, not deferred to commit, so promoting the target first (while the
     *     actor's row still says `'owner'`) would violate the index on this transaction's own
     *     second statement -- a self-inflicted unique violation, not a race with anyone else.
     *     Demoting first means there is never an instant, even inside this one transaction, where
     *     the index would see two owner rows for this project.
     */
    async transferOwnership(actorId, projectId, targetUserId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await acquireOwnershipLock(client, projectId);

        const resolved = await lockScope(client, { kind: 'project', projectId });
        if (resolved === 'missing') {
          await client.query('rollback');
          return 'missing';
        }
        const actorRole = await fetchProjectRole(client, resolved.projectId, actorId);
        if (actorRole === undefined) {
          await client.query('rollback');
          return 'missing';
        }
        if (actorRole !== 'owner') {
          await client.query('rollback');
          return 'forbidden';
        }
        if (targetUserId === actorId) {
          await client.query('rollback');
          return { outcome: 'already-owner' };
        }
        const targetRole = await fetchProjectRole(client, resolved.projectId, targetUserId);
        if (targetRole === undefined) {
          await client.query('rollback');
          return { outcome: 'not-a-member' };
        }

        await client.query(
          "update project_members set role = 'editor' where project_id = $1 and user_id = $2",
          [resolved.projectId, actorId],
        );
        await client.query(
          "update project_members set role = 'owner' where project_id = $1 and user_id = $2",
          [resolved.projectId, targetUserId],
        );

        // Both accounts' effective roles just changed, so both get the identical live-socket
        // reconciliation `changeMemberRole` gives *any* role change -- see
        // `notifyMembershipChanged`'s own comment for why a reconnect is always safe to trigger
        // even when, as here, neither holder actually lost write access (owner and editor can
        // both write): the cost of over-inclusion is a brief, correct reconnect, and there is no
        // under-inclusion risk to weigh it against.
        await notifyMembershipChanged(client, actorId);
        await notifyMembershipChanged(client, targetUserId);

        await client.query('commit');
        return { outcome: 'transferred', newOwnerId: targetUserId };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listInvitationsForUser(actorId) {
      // Driven by `membership_invitations_invited_user_index` on (invited_user_id, status). Joins
      // the project and (for a screenplay-scoped invitation) the screenplay purely for their
      // titles -- the invitee has no access to either yet, and naming what they were invited to is
      // exactly plan.md's "Someone invited into a screenplay should see what they were invited
      // to." An invitation whose project or screenplay has since been soft-deleted is excluded:
      // accepting it could not produce anything reachable.
      const result = await pool.query(
        `select i.id, i.role::text as role, i.created_at as "createdAt",
                i.project_id as "projectId", p.title as "projectTitle",
                i.screenplay_id as "screenplayId", s.title as "screenplayTitle",
                inviter.name as "invitedByName"
           from membership_invitations i
           join projects p on p.id = i.project_id
           left join screenplays s on s.id = i.screenplay_id
           left join "user" inviter on inviter.id = i.invited_by_user_id
          where i.invited_user_id = $1
            and i.status = 'pending'
            and p.deleted_at is null
            and (i.screenplay_id is null or s.deleted_at is null)
          order by i.created_at asc`,
        [actorId],
      );
      return (
        result.rows as Array<{
          id: string;
          role: SharedRole;
          createdAt: Date;
          projectId: string;
          projectTitle: string;
          screenplayId: string | null;
          screenplayTitle: string | null;
          invitedByName: string | null;
        }>
      ).map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
    },

    async respondToInvitation(actorId, invitationId, input) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Scoped to `invited_user_id = $2`: an invitation id is never trusted to resolve on its
        // own, the same "id plus the identity that may act on it" discipline
        // `getRevisionById(screenplayId, revisionId)` already uses. Someone else's invitation id is
        // `'missing'`, never a forbidden -- it is not theirs to know about.
        const invitation = await client.query(
          `select i.id, i.project_id as "projectId", i.screenplay_id as "screenplayId",
                  i.role::text as role, i.status::text as status
             from membership_invitations i
             join projects p on p.id = i.project_id
             left join screenplays s on s.id = i.screenplay_id
            where i.id = $1 and i.invited_user_id = $2
              and p.deleted_at is null
              and (i.screenplay_id is null or s.deleted_at is null)
            for update of i`,
          [invitationId, actorId],
        );
        if (invitation.rowCount !== 1) {
          await client.query('rollback');
          return 'missing';
        }
        const row = invitation.rows[0] as {
          projectId: string;
          screenplayId: string | null;
          role: SharedRole;
          status: string;
        };
        if (row.status !== 'pending') {
          await client.query('rollback');
          return { outcome: 'not-pending' };
        }
        const at = now();
        if (input.response === 'decline') {
          await client.query(
            "update membership_invitations set status = 'declined', updated_at = $2 where id = $1",
            [invitationId, at],
          );
          await client.query('commit');
          return { outcome: 'declined' };
        }
        // Accepting is the *only* write of a membership row on an invitee's own behalf anywhere in
        // this codebase. `on conflict do update` rather than a plain insert so a replayed accept
        // (two clicks, or a retried request) lands on the same single row instead of a unique
        // violation.
        if (row.screenplayId === null) {
          await client.query(
            `insert into project_members (project_id, user_id, role)
              values ($1, $2, $3)
              on conflict (project_id, user_id) do update set role = excluded.role`,
            [row.projectId, actorId, row.role],
          );
        } else {
          await client.query(
            `insert into screenplay_members (screenplay_id, user_id, role)
              values ($1, $2, $3)
              on conflict (screenplay_id, user_id) do update set role = excluded.role`,
            [row.screenplayId, actorId, row.role],
          );
        }
        await client.query(
          "update membership_invitations set status = 'accepted', updated_at = $2 where id = $1",
          [invitationId, at],
        );
        await client.query('commit');
        return {
          outcome: 'accepted',
          projectId: row.projectId,
          screenplayId: row.screenplayId,
          role: row.role,
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
