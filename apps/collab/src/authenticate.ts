import { checkEntitlement, type EntitlementSnapshot } from '@finaler-draft/entitlements';
import type { ConnectionTokenVerification } from '@finaler-draft/collab-token';
import { TRANSIENT_SYNC_AUTH_FAILURE_REASON } from '@finaler-draft/config';
import { isTrustedConnectionOrigin } from './originGuard.js';

/**
 * The decision `onAuthenticate` (server.ts) needs for one connection: may it reach the document
 * at all, and if so, may it write to it. `allowed: false` closes the connection outright --
 * plan.md's "A collaboration server that trusts its clients is a data-integrity problem, not
 * merely a permissions gap." `readOnly` is the other half, and the one this slice's single most
 * important assertion is about: a reviewer, or a restricted-tier account editing a screenplay
 * outside its one editable slot, is `allowed: true` (plan.md: "They should not be second class
 * viewers just because they cannot edit") but `readOnly: true`.
 */
export type ConnectionAuthorization =
  | { allowed: false }
  | { allowed: true; actorId: string; readOnly: boolean };

/** Structurally compatible with both `Pool` and `PoolClient`, matching the rest of this codebase's
 * convention for a query surface that does not care which one it was handed. */
export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * The project role this actor holds on the screenplay named `documentName` (a screenplay id),
 * mirroring `apps/api/src/projects.ts`'s `getScreenplay` query exactly: joined through
 * `project_members`, and requiring both the screenplay and its parent project to be live
 * (`deleted_at is null`) -- a soft-deleted screenplay or project is unreachable here the same way
 * it is unreachable over REST. Returns `undefined` for "not a member, or the screenplay/project
 * does not exist" without distinguishing the two, the same information-hiding convention
 * `projects.ts` already uses.
 */
async function fetchRole(
  queryable: Queryable,
  screenplayId: string,
  actorId: string,
): Promise<'owner' | 'editor' | 'reviewer' | undefined> {
  const result = await queryable.query(
    `select m.role
       from screenplays s
       join projects p on p.id = s.project_id
       join project_members m on m.project_id = s.project_id
      where s.id = $1
        and m.user_id = $2
        and s.deleted_at is null
        and p.deleted_at is null`,
    [screenplayId, actorId],
  );
  return (result.rows[0] as { role?: string } | undefined)?.role as
    | 'owner'
    | 'editor'
    | 'reviewer'
    | undefined;
}

/**
 * The exact universe `entitlements.ts`'s `EntitlementSnapshot.candidateScreenplayIds` documents:
 * every screenplay where the actor holds `owner` or `editor` on a live screenplay under a live
 * project -- mirrors `apps/api/src/entitlementStore.ts`'s identically-named query. A `reviewer`
 * role is excluded by construction (the `in ('owner', 'editor')` clause), matching that file's own
 * comment: a reviewer cannot write regardless of billing state, so it can never occupy or contend
 * for the one editable slot.
 */
async function fetchCandidateScreenplayIds(
  queryable: Queryable,
  actorId: string,
): Promise<string[]> {
  const result = await queryable.query(
    `select s.id
       from screenplays s
       join project_members m on m.project_id = s.project_id
       join projects p on p.id = s.project_id
      where m.user_id = $1
        and m.role in ('owner', 'editor')
        and s.deleted_at is null
        and p.deleted_at is null`,
    [actorId],
  );
  return (result.rows as Array<{ id: string }>).map((row) => row.id);
}

async function fetchSlot(
  queryable: Queryable,
  actorId: string,
): Promise<{ screenplayId: string; updatedAt: Date } | null> {
  const result = await queryable.query(
    'select screenplay_id as "screenplayId", updated_at as "updatedAt" from editable_slots where user_id = $1',
    [actorId],
  );
  const row = result.rows[0] as { screenplayId: string; updatedAt: Date } | undefined;
  return row ? { screenplayId: row.screenplayId, updatedAt: new Date(row.updatedAt) } : null;
}

async function fetchSubscriptionStatus(
  queryable: Queryable,
  actorId: string,
): Promise<EntitlementSnapshot['subscriptionStatus']> {
  const result = await queryable.query('select status from subscriptions where user_id = $1', [
    actorId,
  ]);
  return (result.rows[0] as { status?: EntitlementSnapshot['subscriptionStatus'] } | undefined)
    ?.status;
}

/**
 * The entitlement snapshot resolution this module needs, built from the same three queries
 * `entitlementStore.ts`'s `getSnapshot` runs (candidate screenplays, the editable slot, and the
 * account's subscription status) -- deliberately not imported from that module, which lives in
 * `apps/api` and additionally depends on `stripeSubscriptions.ts`'s `SubscriptionStore`. Reusing
 * `checkEntitlement` itself (the actual policy: the free-tier rule, the slot resolution, the
 * cooldown) from `@finaler-draft/entitlements` is what the brief for this slice requires --
 * "Reuse `checkEntitlement`; do not reimplement it" -- and that requirement is met here in full.
 * What is duplicated is three short, direct `select`s with no policy content of their own; see
 * `progress/collaboration-slice-1.md` for why that duplication was accepted rather than also
 * extracting `entitlementStore.ts` into a shared package for this one caller.
 */
async function fetchEntitlementSnapshot(
  queryable: Queryable,
  actorId: string,
  now: Date,
): Promise<EntitlementSnapshot> {
  const [subscriptionStatus, candidateScreenplayIds, slot] = await Promise.all([
    fetchSubscriptionStatus(queryable, actorId),
    fetchCandidateScreenplayIds(queryable, actorId),
    fetchSlot(queryable, actorId),
  ]);
  return { subscriptionStatus, candidateScreenplayIds, slot, now };
}

/**
 * The single decision `onAuthenticate` (server.ts) delegates to. `documentName` is the
 * screenplay's own id -- the client connects with `name: screenplayId` (see
 * `packages/screenplay-editor`'s `SCREENPLAY_YJS_FRAGMENT` comment for the matching convention on
 * the fragment name within a document, a separate concern from the document name itself).
 *
 * Role resolution first, entitlement second, exactly mirroring `entitlementProjectStore.ts`'s own
 * layering (membership before billing): a `reviewer` is `readOnly` unconditionally and never
 * reaches the entitlement check at all -- billing state has no bearing on a role that cannot write
 * regardless (plan.md, and `entitlements.ts`'s own `candidateScreenplayIds` comment). An
 * `owner`/`editor` reaches `checkEntitlement`'s `edit-screenplay` action, which is `{allowed: true}`
 * unconditionally for a paid tier and otherwise depends on whether this screenplay currently
 * occupies the account's one editable slot -- the exact rule `entitlementProjectStore.ts` enforces
 * for the REST `PUT` this slice deletes, now enforced here instead, on the one write path that
 * remains.
 */
export async function resolveConnectionAuthorization(
  queryable: Queryable,
  documentName: string,
  actorId: string,
  now: Date,
): Promise<ConnectionAuthorization> {
  const role = await fetchRole(queryable, documentName, actorId);
  if (!role) return { allowed: false };
  if (role === 'reviewer') return { allowed: true, actorId, readOnly: true };

  const snapshot = await fetchEntitlementSnapshot(queryable, actorId, now);
  const decision = checkEntitlement(snapshot, {
    type: 'edit-screenplay',
    screenplayId: documentName,
  });
  return { allowed: true, actorId, readOnly: !decision.allowed };
}

/** What `authenticateConnection` needs from the wider process: a database handle, a function that
 * verifies the connection token the client sent (see `@finaler-draft/collab-token`'s
 * `verifyConnectionToken`, bound to this process's own `COLLAB_TOKEN_SECRET` at the call site in
 * `server.ts`), and the origin allowlist `createAuth` already builds. Bundled so `server.ts`'s
 * `onAuthenticate` hook is a thin wrapper reading fields off Hocuspocus's own payload, not a
 * second place this logic could drift from what this function actually does.
 *
 * `verifyToken` replaces this interface's former `getActorId(headers)` -- the Better Auth session
 * cookie this process used to read directly off the WebSocket handshake's own headers. That
 * cookie is host-only and never reaches this process once `app` and `collab` are on two different
 * hosts (progress/collaboration-plan.md's connection-tokens slice); a short-lived, collab-scoped
 * token sent over the socket's own `AuthenticationMessage` replaces it, verified here instead of
 * looked up in a session store. */
export interface AuthenticateConnectionDependencies {
  queryable: Queryable;
  verifyToken(token: string, now: Date): Promise<ConnectionTokenVerification>;
  trustedOrigins: readonly string[];
}

/**
 * Tags a thrown error as *transient* -- an unexpected failure while trying to answer the
 * authentication/authorization question (a Postgres blip, a dropped pool connection during
 * `verifyToken` or the role/entitlement queries), never a resolved decision. `authenticateConnection`
 * below is the only place this is constructed: it wraps exactly the two calls that can fail for a
 * reason that has nothing to do with whether this actor may see this document, leaving the three
 * deliberate denials (cross-origin, no session, not visible) as plain `Error`s, unchanged from
 * before this type existed.
 *
 * The `reason` property is not incidental plumbing -- `@hocuspocus/server`'s own `onAuthenticate`
 * contract already forwards a thrown error's `.reason` to the client verbatim (`error.reason ??
 * "permission-denied"`, confirmed by reading the installed 4.6.0 source), and `apps/web`'s
 * `App.tsx` reads this exact constant off the resulting `authenticationFailed` event to decide
 * whether to retry on its own or show a terminal "access denied" state. A plain `Error` -- every
 * deliberate denial below -- has no `.reason` and so falls through to Hocuspocus's own
 * `"permission-denied"` default, which is exactly the permanent case.
 */
export class TransientAuthenticationError extends Error {
  readonly reason = TRANSIENT_SYNC_AUTH_FAILURE_REASON;
  override readonly cause: unknown;
  /** Which of the two calls this wraps failed -- `server.ts`'s own rejection log reads this to
   * say precisely where a transient failure happened, not just that one did. */
  readonly stage: 'token-verification' | 'role-or-entitlement-lookup';

  constructor(cause: unknown, stage: 'token-verification' | 'role-or-entitlement-lookup') {
    super(
      'Transient failure while authenticating this connection (a thrown error, not a resolved denial)',
    );
    this.name = 'TransientAuthenticationError';
    this.cause = cause;
    this.stage = stage;
  }
}

/**
 * Risk #1 from the connection-tokens slice, named explicitly in the brief: "An expired token must
 * produce a refresh, not a permanent denial." A token expiring is not a database blip or any
 * other kind of unexpected failure -- `TransientAuthenticationError` above stays reserved for
 * exactly that -- it is an ordinary, expected event a reconnect resolves on its own, because
 * `@hocuspocus/provider` 4.6.0's `getToken()` (called from `sendToken()` on every `onOpen`, per
 * the installed source) re-fetches a fresh token from `apps/api`'s minting endpoint on every
 * reconnection when `HocuspocusProvider`'s own `token` option is an async function, which is
 * exactly how `apps/web/src/App.tsx` configures it.
 *
 * This class exists, distinct from `TransientAuthenticationError`, purely so `server.ts`'s own
 * rejection log can tell the two apart by name (an expired token is not a sign anything is
 * broken) while sharing the *one* property that actually matters to the client:
 * `.reason === TRANSIENT_SYNC_AUTH_FAILURE_REASON`. `apps/web/src/App.tsx`'s
 * `handleAuthenticationFailed` -- and this file's own `authenticate.integration.test.ts` --
 * dispatch on that reason alone, not on the error's class, so this is a drop-in member of the
 * exact same "retry, don't give up" bucket `TransientAuthenticationError` already established.
 */
export class ExpiredConnectionTokenError extends Error {
  readonly reason = TRANSIENT_SYNC_AUTH_FAILURE_REASON;

  constructor() {
    super(
      'Connection token expired; a reconnect fetches a fresh one rather than a permanent denial',
    );
    this.name = 'ExpiredConnectionTokenError';
  }
}

/**
 * The whole `onAuthenticate` decision, composed: reject a connection whose `Origin` is not on the
 * trusted allowlist (see `originGuard.ts`'s own comment for why this remains mandatory even though
 * a cookie is no longer what authenticates the connection -- a token sent by a page on an
 * untrusted origin is exactly the cross-site hijacking scenario this guard exists to close, token
 * or cookie makes no difference), reject one whose connection token does not verify, and otherwise
 * resolve the role/entitlement-driven read/write decision via `resolveConnectionAuthorization`.
 * Throws for every rejection -- Hocuspocus's own `onAuthenticate` contract treats a thrown error
 * (or a rejected promise) as "deny this connection," exactly the behaviour plan.md requires:
 * "reject connections to documents the actor cannot see."
 *
 * That contract has a real gap this function does not paper over on its own: Hocuspocus sends its
 * denial over the *same* still-open socket and never closes the transport (confirmed by reading
 * the installed source -- the permission-denied path is a `send`, never a `close`), so a
 * permanently-denied connection and a connection that merely hit a database hiccup during this
 * exact handshake look identical to a client with no other signal. `TransientAuthenticationError`
 * is the fix for that: `deps.verifyToken` and `resolveConnectionAuthorization` are the only two
 * calls here that can fail for a reason unrelated to the actor's actual access (a network error
 * talking to Postgres, not a decision about this actor and this document), so their failures alone
 * are wrapped and tagged transient. An *expired* token is a third, deliberately distinct case --
 * see `ExpiredConnectionTokenError`'s own comment -- routed into the identical client-visible
 * transient bucket by `.reason` alone, without being a `TransientAuthenticationError` itself.
 * Every other rejection here is a resolved, deliberate answer to "may this actor see this
 * document" and stays a plain `Error` -- retrying it would never change the outcome, so it is not
 * worth the client's time to retry, and `apps/web` shows it as a clear terminal state instead.
 */
export async function authenticateConnection(
  deps: AuthenticateConnectionDependencies,
  params: { documentName: string; requestHeaders: Headers; token: string; now?: Date },
): Promise<{ actorId: string; readOnly: boolean }> {
  if (!isTrustedConnectionOrigin(params.requestHeaders.get('origin'), deps.trustedOrigins)) {
    throw new Error('Cross-origin connection rejected');
  }
  const now = params.now ?? new Date();
  let verification: ConnectionTokenVerification;
  try {
    verification = await deps.verifyToken(params.token, now);
  } catch (cause) {
    throw new TransientAuthenticationError(cause, 'token-verification');
  }
  if (verification.outcome === 'expired') {
    throw new ExpiredConnectionTokenError();
  }
  if (verification.outcome === 'invalid') {
    throw new Error('Authentication required');
  }
  const actorId = verification.actorId;
  let authorization: ConnectionAuthorization;
  try {
    authorization = await resolveConnectionAuthorization(
      deps.queryable,
      params.documentName,
      actorId,
      now,
    );
  } catch (cause) {
    throw new TransientAuthenticationError(cause, 'role-or-entitlement-lookup');
  }
  if (!authorization.allowed) {
    throw new Error('This document is not visible to this account');
  }
  return { actorId, readOnly: authorization.readOnly };
}
