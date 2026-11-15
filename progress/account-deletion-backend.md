# Account deletion: the backend (slice B)

The grace-period deletion flow for a Finaler Draft account. Deletion marks the account deleted
**immediately** -- sign-in refused, every existing session gone, the Stripe subscription
cancelled -- and the row itself is purged later, after a fixed 30-day grace window, by a Railway
cron this slice does not build. An owner who has shared a project may either transfer it away
first or proceed anyway, deleting it for their collaborators too; a project nobody else is on
simply goes with the account.

Out of scope, deliberately, and not started here: the purge script (slice C) and the UI (slice
D) -- there is no Help-menu-shaped entry point for any of this yet, the same gap
`feedback.ts`'s own capture path shipped with before its menu item existed. The HTTP routes this
slice adds are backend, not UI, and were added anyway (see "Why a route after all," below) --
they simply have no caller in the product yet.

## The soft-delete shape, and the migration

`user.deleted_at`, nullable, `timestamp with time zone` -- the identical idiom `projects.deleted_at`
and `screenplays.deleted_at` already use. Generated with `drizzle-kit generate` against the
provided test database (port 55474), never hand-written:

```
packages/database/drizzle/0012_cooing_prism.sql
```

```sql
ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp with time zone;
CREATE INDEX "user_deleted_at_index" ON "user" USING btree ("deleted_at");
```

The index is for slice C: its purge query is `where deleted_at <= now() - interval '30 days'`, and
nothing else in this schema currently has any reason to filter `user` by this column, so it would
otherwise go unindexed until that slice remembered to add it.

Applied to the test database and re-generated to confirm a clean diff (`db:generate` followed by
`git diff --exit-code`, the exact check CI runs) -- the committed snapshot
(`packages/database/drizzle/meta/0012_snapshot.json`) and journal entry are generator output, not
edited by hand.

**`user_email_unique` stays a plain, non-partial index, deliberately.** A soft-deleted account's
email stays reserved for the rest of the grace window. Narrowing the index to
`where deleted_at is null` would not actually let someone sign up again with that address sooner:
Better Auth's own sign-up duplicate-email check (`internalAdapter.findUserByEmail`, confirmed by
reading the installed 1.6.25 `api/routes/sign-up.mjs`) has no `deleted_at` awareness at all and
would still find the soft-deleted row by a bare `email = ?` lookup and refuse the signup as
"already exists" -- so relaxing the index alone would trade one error for a more confusing one,
without the Better-Auth-adapter change this slice does not make. Recorded here as a known
limitation for whichever slice wants to let a grace-period account be reclaimed or recreated
before the purge runs, documented in the schema comment itself so a future reader does not
"simplify" the index without reading this first.

## Sessions: deleted outright, and rechecked anyway -- both, and why

Two independent mechanisms, not one, deliberately:

1. **`delete from session where user_id = $1`**, inside the one deletion transaction
   (`accountDeletion.ts`'s `deleteAccount`). Immediate, and sufficient on its own for every
   session that already exists at the moment this runs.
2. **`AuthPort.isAccountDeleted`**, a new optional capability on the interface `app.ts`'s
   authenticated-actor `preValidation` hook already calls through (`getActorId`). Checked
   immediately after `getActorId` resolves a non-null id, and answered the identical way an
   absent session already is -- a bare 401, `{ error: 'Authentication required' }` -- never a
   reason distinguishable from "not authenticated at all."

**Why both, stated plainly rather than left for a reader to reconstruct.** Deleting every
_existing_ `session` row cannot touch a session that does not exist yet at the moment the delete
runs. Two races share that shape and neither is hypothetical:

- A sign-in racing the deletion transaction itself: if a new `session` row is inserted (by a
  concurrent sign-in) _after_ this transaction's `delete from session` statement has already run
  but _before_ its commit, that row survives -- the delete already saw a snapshot that did not
  include it. The sign-in-time refusal (next section) closes most of this window by checking
  `deleted_at` before the session is created at all, but it checks the identical column at a
  moment that can itself race the same commit -- a sign-in that reads `deleted_at` as still null a
  moment before this transaction's `update "user" set deleted_at = now()` commits can still create
  a session.
- Anything that ever caches session validity outside the `session` table itself. Nothing in this
  stack does today (confirmed: `getActorId` is `auth.api.getSession`, which always queries the
  database; Better Auth's `session.cookieCache` feature, which would make this a real and
  immediate problem, is not configured in `packages/auth-server/src/index.ts`) -- but the
  recheck is why a future change that _does_ turn it on would not silently reopen this gap.

Both gaps close on the very next authenticated request after this hook runs, which is why "defense
in depth" here means a second, independent check of the same fact, not a second _mechanism_: there
is no session cache anywhere in this stack that would otherwise need its own invalidation path.

`AuthPort.isAccountDeleted` is optional, like every other capability `BuildAppOptions`/`AuthPort`
exposes (`StripeWebhookPort.ipAllowlist`, `BuildAppOptions.collab`, and so on) -- absent means the
recheck is not performed, not performed-and-denying. This is also what kept the change from
touching every one of the roughly fifteen call sites across six test files that already construct
a fake `AuthPort` for an unrelated reason; only the two that specifically exercise this capability
(`app.test.ts`'s new describe block, and `persistence.integration.test.ts`) needed to supply it.
`server.ts` always wires a real implementation in production.

## Sign-in refusal: `databaseHooks.session.create.before`, and why that mechanism

`packages/auth-server/src/index.ts`'s `refusePendingSessionForDeletedAccount`, wired as
`databaseHooks.session.create.before` on the `betterAuth(...)` call. It runs immediately before
Better Auth writes _any_ new `session` row -- password sign-in, social sign-in, anything a future
plugin adds -- and throws `APIError.from('FORBIDDEN', { message: 'This account has been deleted.',
code: 'ACCOUNT_DELETED' })` when the target account's `deleted_at` is set, which Better Auth's own
error-handling middleware turns into a 403 before any session is created.

**Why this mechanism, not a check bolted onto `/sign-in/email`.** The brief pointed at
`requireEmailVerification` as precedent for "a sign-in-time rule exists in this file already," but
that option is itself _built into_ Better Auth's own `signInEmail` route (confirmed in the
installed `api/routes/sign-in.mjs`) -- there is no equivalent built-in flag for "this account was
deleted," so a literal copy of that pattern was not available. A check written into a local
override of just the email/password route would also only ever cover that one route, leaving
social sign-in (and anything a later plugin adds) unguarded, each needing the same check pasted in
again. `databaseHooks.session.create.before` is Better Auth's own answer to exactly this kind of
problem -- it is the identical mechanism the shipped `admin` plugin uses for its own "banned
account" rule (`plugins/admin/admin.mjs`: the same hook checks `user.banned` and throws
`APIError.from('FORBIDDEN', ...)`), confirmed by reading that plugin's source rather than assumed
from its name. That is the real precedent this follows -- the same _kind_ of gate Better Auth
itself ships for an account-level block, not a second copy of the email-verification flag.

**What this does and does not reveal, stated plainly.** The hook only runs _after_ Better Auth's
own password verification has already succeeded (confirmed by reading `signInEmail`'s own source:
`databaseHooks` fire from inside `internalAdapter.createSession`, which that route only reaches
once the submitted password matched) -- so a `FORBIDDEN`/`ACCOUNT_DELETED` response is
distinguishable from `INVALID_EMAIL_OR_PASSWORD`, and confirms the credential pair was correct.
That is not a new information leak this slice introduces: it is the identical disclosure
`requireEmailVerification`'s own `EMAIL_NOT_VERIFIED` response already makes for an unverified
account, on the reasoning plan.md already accepted for that case. Stated here rather than left for
an auditor to find on their own.

**Why a raw `pool.query`, not Better Auth's own Drizzle adapter.** `internalAdapter.findUserById`
resolves fields through the adapter's configured schema, which only knows about fields Better Auth
was explicitly told to manage. Declaring `deletedAt` as a Better Auth `additionalFields` entry just
to make one internal lookup see it would expose it on every user-shaped API response the library
serializes -- not wanted. A plain parameterized query against the same `pool` `createAuth` already
holds is the one place this file already reaches around the adapter for an identical reason
(`sendOrLogFailure`'s neighbors need nothing from it either), and it is the same query shape
`accountDeletion.ts` and `app.ts`'s own `isAccountDeleted` use against the identical column.

Proven three ways: `index.test.ts` covers the function's own logic against a mocked `betterAuth`
(the hook throws/does not throw, the right error code, the right query); `persistence.integration
.test.ts`'s "refuses to sign in an account once its user row is soft-deleted..." drives a real
`/api/auth/sign-in/email` request through a real `betterAuth` instance against the real database,
proving Better Auth actually invokes this hook at the right moment, not just that the function
works in isolation; and the end-to-end deletion test (below) proves the whole chain starting from
a real deletion request.

## The Stripe-first ordering, and the retryable outcome

**Cancel at Stripe before touching the database; fail the whole request, with nothing written,
if cancellation fails.** The alternative -- write the soft-delete first, cancel after -- was
rejected because a failed cancellation in that order leaves Stripe **still billing a card for an
account that no longer has a `subscriptions` row to reconcile the eventual
`customer.subscription.deleted` webhook against**: the webhook's own projection logic
(`stripeWebhook.ts`, unchanged by this slice) resolves a Better Auth user id from
`subscription.metadata.userId` with a fallback to the existing `subscriptions` row for that
Stripe customer -- and if the account was already deleted and its projection row gone, there is
nothing left to reconcile against. Stripe-first means a cancellation failure costs nothing: the
account is untouched, and the caller retries. A 30-day grace window exists specifically so that
retry has room to happen.

`deleteAccount`'s actual sequence, in order:

1. **The owned-projects refusal gate, unlocked, before Stripe is ever touched.** If this account
   owns a project with other members and `deleteOwnedProjectsWithCollaborators` was not set, the
   whole request is refused -- no Stripe call, no write of any kind. This has to run _before_
   Stripe specifically because a refusal must have zero side effects: cancelling a subscription
   and then refusing the deletion it was meant to precede would be worse than either outcome
   alone.
2. **Stripe**, outside any Postgres transaction. Skipped entirely when there is no `subscriptions`
   row for this account, or when the row already shows `status === 'canceled'` -- most accounts
   (the free tier) never reach this step at all.
3. **The one local transaction** -- session delete, user soft-delete, and the owned-projects sweep
   -- opened only once Stripe has either succeeded or had nothing to do.

**The retryable outcome.** `cancelStripeSubscription` **retrieves the subscription before calling
cancel**, rather than calling `cancel` outright. This is what makes a _retried_ `deleteAccount`
call idempotent against Stripe itself: if a previous attempt's Stripe call already succeeded but
the local transaction that should have followed it failed for an unrelated reason (a dropped
connection, say) before committing, a second attempt calling `cancel` again on an already-cancelled
subscription is a Stripe API error ("This subscription has already been canceled"), not a no-op --
which would turn an already-successful cancellation into a spurious, permanently-stuck
`'stripe-cancellation-failed'`. Checking `status` first and treating `'canceled'` as already-done
avoids depending on parsing Stripe's own error shape to recognize that one case.

**What happens when Stripe is not configured in this environment at all.** The store's `stripe`
parameter is `AccountDeletionStripePort | undefined` -- `undefined` in any environment with no
Stripe keys, the same "absent means not configured" contract every other Stripe-touching option in
this codebase follows (`BuildAppOptions.stripe`/`.billing`). The ordinary case (no
`subscriptions` row, because nothing ever wrote one without Stripe) never reaches the Stripe call
at all. The one case this distinction earns its keep: a `subscriptions` row existing despite no
Stripe client being configured _now_ can only mean Stripe _was_ reachable when that row was
written and is a real misconfiguration today -- reported as the identical retryable
`'stripe-cancellation-failed'` a genuine Stripe rejection would produce, rather than silently
treated as "nothing to cancel."

## The owned-projects precheck

`findOwnedProjectsWithCollaborators(actorId)` -- one query, no lock, no flag:

```sql
select p.id, p.title
  from projects p
  join project_members m on m.project_id = p.id and m.role = 'owner'
 where m.user_id = $1
   and p.deleted_at is null
   and exists (
     select 1 from project_members other
      where other.project_id = p.id and other.user_id <> $1
   )
 order by p.title asc, p.id asc
```

Read-only and unconditional, matching the brief's explicit "must not require the deletion flag" --
a confirmation screen (slice D) calls this before the caller has decided anything, to show which of
their projects would be affected and let them transfer ownership away first (the existing
`transferOwnership`, a prerequisite slice this one depends on and does not modify) or proceed
anyway. `deleteAccount` re-runs the identical query itself, rather than trusting a result the
caller might be holding from an earlier call -- see "Each distinguishable outcome," below, for why
that staleness is accepted rather than closed with a second check deeper in the transaction.

## Each distinguishable outcome

```ts
type DeleteAccountOutcome =
  | { outcome: 'deleted' }
  | { outcome: 'owned-projects-have-collaborators'; projects: OwnedProjectWithCollaborators[] }
  | { outcome: 'stripe-cancellation-failed' };
```

| Outcome                             | When                                                                                                                        | Side effects                                                                                    | HTTP mapping                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `deleted`                           | Every owned project with collaborators was either absent or explicitly accepted by the flag                                 | Stripe cancelled (if applicable); sessions deleted; user and the selected projects soft-deleted | `200`, matching `transferOwnershipResponseSchema`'s own convention for a legitimate, successfully-evaluated request                         |
| `owned-projects-have-collaborators` | Owned projects with other members exist and the flag was not set                                                            | None -- refused before Stripe, before any write                                                 | `200` with the project list -- a successful evaluation, not a failure, the identical framing `'not-a-member'`/`'already-owner'` already get |
| `stripe-cancellation-failed`        | Stripe rejected, or could not be reached for, the cancellation (including "no client configured but a subscription exists") | None -- nothing was written                                                                     | `502`, the identical status every other Stripe-request failure in `app.ts` already uses (`logStripeRequestFailure`'s own call sites)        |

Also distinguishable, though not part of the public return type: calling `deleteAccount` again on
an account it already deleted returns `{ outcome: 'deleted' }` without writing anything further
(the user-row lock finds `deleted_at` already set and short-circuits) -- an idempotent replay of a
request that already succeeded, not an error. And `actorId` resolving to no `user` row at all
_throws_, rather than returning any outcome: that is not a reachable product state (`actorId`
always comes from an authenticated session's own resolved identity), so it is a programming error,
not a refusal a caller could mistake for a legitimate answer.

## Lock order

Touches `"user"`, `projects`, `project_members`, and `session`. Never touches
`membership_invitations` -- the soft-deleted project's own `deleted_at` is what every sharing path
already treats as "does not exist" (`lockScope`'s own filter), the identical behavior
`deleteProject` already relies on without touching that table either.

Order, inside the one transaction, and why:

1. **`"user"`**, locked first (`select ... for update`) -- the central resource of "delete this
   account," the same role the `projects` row plays as the first lock in
   `deleteProject`/`renameProject`. This is also the idempotency serialization point: a second
   concurrent `deleteAccount` call for the _same_ account blocks here until the first commits,
   then re-reads `deleted_at` already set.
2. **Owned, non-deleted `projects` rows**, locked next, in a fixed `order by id` -- deterministic,
   so that if this account ever owns enough projects for this transaction to lock more than one,
   nothing could deadlock against it by acquiring the same set in the opposite order.
3. **Every `project_members` row for those projects**, locked next, in a fixed order -- `projects`
   before `project_members`, the identical sub-order `deleteProject`,
   `lockScope`/`fetchProjectRole`, and `transferOwnership` already use for the same two tables.
4. **`session` rows**, deleted outright.
5. **`"user".deleted_at`** set.
6. **`projects.deleted_at`** set, for the selected subset.

**Why this agrees with the existing paths, checked rather than assumed.** Nothing else in this
codebase locks `"user"` or `session` at all (confirmed by grepping every store for
`from "user"`/`"user" set`/`from session`/`session set` outside this slice's own files), so there
is no existing cycle through either table this transaction could close. The one invariant that
does carry over is `projects` before `project_members`, and this transaction's agreement with it is
what rules out a deadlock against `transferOwnership` specifically: that function takes its own
advisory lock first and then the same two row locks in the same relative order this one does, so
the two can never hold opposite-order claims on the same pair of rows -- whichever reaches a
contested `projects` row first simply makes the other wait in a straight line, never a cycle.

**The one accepted, documented race.** Locking `project_members` rows with `for update` only locks
rows that _already exist_ at the moment of the `select` -- it does not block a concurrent
`respondToInvitation` from _inserting_ a brand-new membership row (that function never locks the
`projects` row at all, only the invitation row). So a collaborator accepted in the narrow window
between this transaction's membership read and its commit is not reflected in that read. This is
not a new gap this slice introduces: `deleteProject` already tolerates the identical race (its own
`for update` on the `projects` row does not block a concurrent accept either), and the consequence
here is bounded the same way -- if the flag is `false` and a project races from solo to
collaborator-owned mid-transaction, that one project is simply excluded from the sweep (left
untouched) rather than the whole request being aborted after Stripe has already succeeded. Proven
directly, not just argued: `accountDeletion.test.ts`'s "re-derives collaborator status fresh under
lock rather than trusting the early precheck" constructs exactly this race and asserts only the
genuinely-solo project is deleted.

The resulting state when this race actually fires -- a non-deleted project whose `'owner'`
`project_members` row now names a soft-deleted account that can never sign in, transfer, rename, or
delete it again -- is a real, if rare, consequence, named here plainly rather than glossed over.
It is one more path into a class of state the SEC-11 fix's own comment already names
(`project_single_owner_unique` enforces _at most_ one owner, never _at least_ one), not a new class
of problem this slice invents.

## What slice C (the purge) will need

A starting list, so that slice does not have to re-derive it:

- **The query**: `select id from "user" where deleted_at <= now() - interval '30 days'`, driven by
  `user_deleted_at_index` (added in this slice's migration).
- **What to actually delete.** This slice only ever sets `deleted_at`; nothing here hard-deletes a
  `user` row, so every `on delete cascade`/`on delete set null` foreign key already pointing at
  `user.id` describes exactly what a real deletion would ripple into (`session`, `account` cascade;
  `document_revisions.authored_by`, `membership_invitations.invited_by_user_id` set null; `feedback`
  cascades -- see that table's own schema comment for why). Slice C's job is largely "run the
  delete and let the existing foreign keys do the rest," not inventing new cleanup logic.
- **Membership this slice deliberately left untouched.** A deleted account's `project_members` rows
  on projects it does _not_ own (its collaborator access elsewhere) are never touched here --
  cascading from `user`'s own delete handles them for free once slice C actually removes the row.
  Pending invitations this account sent or received likewise are not touched (they already become
  inert once the project they name is soft-deleted, or once they can never be accepted by an
  account that can no longer sign in) and will cascade or null out the same way at hard-delete
  time.
- **Collaborator-owned projects left alone by the flag.** If an owner deleted their account without
  setting `deleteOwnedProjectsWithCollaborators` and the early refusal gate should have caught every
  such project, slice C should not expect to find any -- but the narrow race documented above means
  it is not impossible. Worth a defensive check in that slice, not assumed away.
- **Reclaiming the email address.** Not done by this slice (see `user_email_unique`'s own note,
  above) -- a real hard delete removes the row and the unique index entry with it, which is likely
  the moment this limitation actually resolves itself, but it is worth confirming explicitly when
  that slice is written rather than assumed.

## Why a route after all

The brief's own deliverable list did not name an HTTP route, and the first pass of this slice
deliberately did not add one, reasoning that "UI (slice D)" and "the route UI would call" were the
same boundary. Reconsidered before finishing: every other store this codebase has added under
`apps/api/src/sharing.ts`/`feedback.ts` got its route wired in the _same_ slice that introduced the
store method, with the UI (or, for feedback, even the lack of one) treated as a separate concern --
`transferOwnership`, `invite`, `changeMemberRole`, `removeMember`, `revokeInvitation`,
`respondToInvitation`, and `submitFeedback` all have a route in the commit that added them, several
with no caller in the product at the time. Leaving account deletion as a store with no route would
have been an inconsistency with that convention, not a smaller scope -- so two routes were added:

- `GET /api/account/owned-projects-with-collaborators` -- the precheck, unconditionally.
- `POST /api/account/delete`, body `{ deleteOwnedProjectsWithCollaborators: boolean }` -- the one
  entry point. `'deleted'`/`'owned-projects-have-collaborators'` are both `200` bodies (a
  discriminated union, `deleteAccountResponseSchema`); `'stripe-cancellation-failed'` is mapped to
  `502` instead of folded into that union, the identical status and the identical
  `logStripeRequestFailure`-shaped logging every other Stripe-request failure in `app.ts` already
  uses, rather than inventing a third case for a 200-shaped body to carry.

Both act on `request.actorId!` alone, like `/api/billing/checkout-session` and `/api/feedback` --
there is no field in either request capable of naming a different account, and
`deleteAccountInput` is `.strict()` for the same reason `checkoutSessionInput` is.

Not built: anything that calls either route from the product. That remains slice D's gap to close,
the identical shape `feedback.ts`'s own "no UI yet" note already recorded for its own capture path.
Also not built: proactively clearing the browser's session cookie in the `200` response. The
already-deleted `session` row (and, failing that, the `isAccountDeleted` choke-point recheck) is
what makes every subsequent request unauthenticated regardless of what the browser still holds; an
explicit `Set-Cookie` clear would be a usability nicety a UI slice can add, not a correctness
requirement this one needs.

## Every mutation, and the test it killed

Each mutation below was applied with a single, uniqueness-checked string edit (`grep -c` showing
exactly one match before editing), run against the real file, confirmed to fail the expected
test with the expected message, then reverted and the suite re-run green.

| #   | Mutation                                                                                                                                       | Expected failure                                                                                                                    | Actual result                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `accountDeletion.ts`: the Stripe-failure early return (`if (cancelled === 'failed') ...`) disabled                                             | `deleteAccount > reports a retryable failure and leaves every local row untouched when Stripe cancellation fails` (unit)            | Failed with a programming error further down the (now-reached) transaction path -- proceeding past a Stripe failure hit an unrelated guard first, confirming the ordering is load-bearing.                                                                                               |
| 2   | `accountDeletion.ts`: the flag check in the early refusal gate (`&& !options.deleteOwnedProjectsWithCollaborators`) removed                    | `deleteAccount > proceeds and deletes the collaborator-owned project too when the flag is set` (unit)                               | Failed: `expected { outcome: 'owned-projects-have-collaborators', ... } to deeply equal { outcome: 'deleted' }` -- a `true` flag was refused anyway.                                                                                                                                     |
| 3   | `accountDeletion.ts`: the final sweep's flag check (`options.deleteOwnedProjectsWithCollaborators \|\| !hasOtherMembers`) replaced with `true` | `deleteAccount > re-derives collaborator status fresh under lock... excluding only the project that gained a collaborator` (unit)   | Failed: the raced collaborator project was included in the `update projects` call when it should have been excluded.                                                                                                                                                                     |
| 4   | `accountDeletion.ts`: the idempotent-already-deleted guard (`if (userRow.rows[0]!.deletedAt)`) disabled                                        | `deleteAccount > is idempotent: replaying against an already-deleted account...` (unit)                                             | Failed: `expected "spy" to be called 3 times, but got 6 times` -- the replay proceeded into the full transaction instead of short-circuiting.                                                                                                                                            |
| 5   | `accountDeletion.ts`: the Stripe idempotent-cancel guard (`if (current.status !== 'canceled')`) replaced with `true`                           | `deleteAccount > treats an already-canceled subscription at Stripe as success without calling cancel again` (unit)                  | Failed: `cancel` was called once when the test asserts it must never be called.                                                                                                                                                                                                          |
| 6   | `packages/auth-server/src/index.ts`: the sign-in refusal guard (`if (result.rows[0]?.deletedAt)`) disabled                                     | `createAuth > databaseHooks.session.create.before > refuses to create a session for a soft-deleted account` (unit)                  | Failed: `promise resolved "undefined" instead of rejecting`. **Also re-run against the real stack**: `persistence.integration.test.ts`'s real sign-in test failed `expected 200 to be 403`, proving Better Auth really calls this hook, not merely that the function works in isolation. |
| 7   | `app.ts`: the `isAccountDeleted` defense-in-depth check disabled                                                                               | `app.test.ts`'s new `AuthPort.isAccountDeleted` describe block (unit)                                                               | Failed: `expected 200 to be 401`. **Also re-run against the real stack**: `persistence.integration.test.ts`'s choke-point test failed the identical way.                                                                                                                                 |
| 8   | `accountDeletion.ts`: `delete from session where user_id = $1` removed                                                                         | Three unit tests (positional call-index shift) and the integration test's `sessionCountFor(owner)` assertion                        | Unit: three tests failed on the shifted query positions. **Integration (real database)**: `expected 1 to be +0` -- a real `session` row survived.                                                                                                                                        |
| 9   | `app.ts`: the route's `if (result.outcome === 'stripe-cancellation-failed')` mapping disabled                                                  | `accountDeletionRoutes.test.ts`'s "returns 502 when the store reports the Stripe cancellation failed, never a 200"                  | Failed: `expected 500 to be 502` -- the unmapped outcome fell through to the response schema's serializer, which rejected it outright.                                                                                                                                                   |
| 10  | `accountDeletion.ts`: the "no Stripe client but a subscription exists" guard (`if (!stripe)`) disabled                                         | `deleteAccount > reports a retryable failure, logging it, when a subscription row exists but no Stripe client is configured` (unit) | Failed: `TypeError: Cannot read properties of undefined (reading 'client')` -- the exact crash the guard exists to prevent.                                                                                                                                                              |

Ten mutations, each killed by name, each restored and the full relevant suite re-verified green
afterward. Mutations 6, 7, and 8 were additionally re-run against the real database and the real
Better Auth stack (not just the mocked unit tests), specifically because the brief's own warning
-- that a prior slice's test passed with its guard removed -- was about exactly this kind of gap
between a mocked unit assertion and what the real system actually does.

## For every refusal, the allowed case in the same file

Per the brief's "if a test passes before you write the thing it tests, treat that as a bug in the
test" -- every refusal above has its paired "allowed" case living in the same file:

- `accountDeletion.test.ts`: "refuses... before touching Stripe" is paired with "proceeds and
  deletes the collaborator-owned project too when the flag is set."
- `accountDeletion.test.ts`: "deletes a solo-owned project regardless of the flag" is the allowed
  case for the collaborator refusal.
- `index.test.ts`: "refuses to create a session for a soft-deleted account" is paired with "allows
  a session to be created for an account that has not been deleted."
- `app.test.ts`: "refuses an authenticated request... once the account is reported deleted" is
  paired with "still allows the same request through when the account is reported not deleted" and
  a third case, "allows the request through when the capability is absent."
- `accountDeletionRoutes.test.ts`: the 502-on-Stripe-failure case is paired with the 200-on-success
  case in "acts as the authenticated session's own actor."
- `persistence.integration.test.ts`: the soft-deleted sign-in refusal and the choke-point refusal
  each have an "active account, same request, succeeds" assertion immediately before the account
  is deleted, in the same test.

## Gate results

Postgres: the provided isolated container, `del-pg`, on port **55474** -- used as given, never
started a second one.

| Gate                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                             | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm typecheck`                                        | exit 0 -- every package, `apps/web`, `apps/api`, `apps/collab`, `apps/landing` (astro check: 0 errors)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm test` (no `TEST_DATABASE_URL`, CI-style)          | exit 0 -- `apps/api` 384 passed / 127 skipped (21 files), `apps/web` 1263 passed, `apps/collab` 181 passed / 32 skipped, `packages/auth-server` 27 passed, every other package green                                                                                                                                                                                                                                                                                                                          |
| `pnpm test:integration` (`TEST_DATABASE_URL` set)       | exit 0 -- `packages/database` 12/12, `apps/api` 127/127 across 9 files (including `accountDeletion.integration.test.ts` 7/7 and `persistence.integration.test.ts` 23/23, 3 of them new), `apps/collab` 32/32                                                                                                                                                                                                                                                                                                  |
| `pnpm test:coverage` (no `TEST_DATABASE_URL`, CI-style) | exit 0. `apps/api/src/accountDeletion.ts`: 100% statements / 92.3% branch / 100% functions / 100% lines (added to `vitest.config.ts`'s coverage `include` list, which did not previously cover this file at all). `apps/api/src/app.ts`: 99.84% / 96.69% / 100% / 99.84%, the two uncovered lines pre-existing and unrelated (`app.test.ts`'s own `ForbiddenError` branch). `packages/auth-server/src/index.ts`: 100% / 100% / 100% / 100%. Every file clears the 80% bar comfortably, not just on aggregate. |
| `pnpm build`                                            | exit 0 -- every package, including `apps/web`'s production bundle and `apps/landing`'s static build                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm format:check`                                     | run bare, last; see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### `pnpm format:check`, bare and last

Run bare three times during this slice -- Prettier caught real violations each of the first two
times (new source and test files not yet formatted, and finally this progress doc itself), fixed
with `prettier --write` on exactly the flagged files each time, the affected test files re-run to
confirm the reformat changed no behaviour, and the full gate sequence re-run afterward. The actual
last command run before this report was finished:

```
$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!
```

Exit code: **0**.

## What could not be verified

- **No browser-driven (Playwright) coverage of either route.** The plain `test:system` config runs
  `apps/api` with no `DATABASE_URL` at all, and there is no UI (slice D) to drive through a real
  browser yet -- the identical gap `project-ownership-transfer.md` and `feedback-capture.md` both
  recorded for their own new surfaces before a UI existed. Everything here is proven at the unit
  level (fake pool, fake Stripe client), the integration level (a real migrated database), and
  once, end to end, through a real Fastify app with a real Better Auth instance and a real database
  (`persistence.integration.test.ts`'s "deletes a solo-owned account end to end..."). What is
  missing is a real browser making a real HTTP request through a rendered page, because that page
  does not exist yet.
- **The HTTP-route-plus-real-store-plus-real-database combination is proven once, not
  exhaustively.** `accountDeletion.integration.test.ts` exhaustively proves the store's own SQL
  (collaborator projects, the flag, Stripe outcomes, idempotency, the migration) against a real
  database, and `accountDeletionRoutes.test.ts` exhaustively proves the HTTP mapping against a fake
  store. The one real end-to-end test in `persistence.integration.test.ts` proves the wiring between
  them is genuine for the solo-owned success path specifically; it does not re-prove every
  combination the two narrower suites already cover independently, which seemed like the right
  amount of overlap rather than triplicating coverage for its own sake.
- **The narrow membership race documented under "Lock order"** (a collaborator accepted in the gap
  between this transaction's read and its commit) is proven to behave as described
  (`accountDeletion.test.ts`'s constructed-race test), but is not, and could not practically be,
  reproduced against a real concurrently-racing `respondToInvitation` call the way
  `sharing.integration.test.ts`'s `transferOwnership` concurrency test forces a real lock
  contention -- this race is about an absent lock, not a contended one, so there is nothing to poll
  `pg_locks` for. Accepted as argued, not independently reproduced under real concurrency.
- **Whether `deleteOwnedProjectsWithCollaborators` is the right name for the request body field**,
  versus the entry-point function's own parameter, is a judgment call following the brief's wording
  literally ("name it something unambiguous such as `deleteOwnedProjectsWithCollaborators`" read as
  naming the _parameter_, not the function). If the intent was instead to name the function itself
  `deleteOwnedProjectsWithCollaborators(actorId, flag)`, that is a one-line rename away from what
  is here (`deleteAccount(actorId, { deleteOwnedProjectsWithCollaborators })`) and worth confirming
  explicitly rather than assuming the reading above is the only one.

## Lead verification, run independently

| Check                                                   | Result                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| SEC-11 fix untouched                                    | guard 1 and guard 2 both present, and the invitation update is still ordered **before** the role writes |
| `db:generate` idempotency (CI's `git diff --exit-code`) | hashed the whole `drizzle/` tree, re-ran generate, **identical** -- CI passes                           |
| `pnpm lint`                                             | exit 0                                                                                                  |
| `pnpm typecheck`                                        | exit 0                                                                                                  |
| `pnpm test` (CI-style, no `TEST_DATABASE_URL`)          | exit 0 -- `apps/api` 21 files, `packages/auth-server` 2 files                                           |
| `pnpm test:integration`                                 | exit 0                                                                                                  |
| `pnpm test:coverage`                                    | exit 0                                                                                                  |
| `pnpm build`                                            | exit 0                                                                                                  |
| `pnpm format:check`                                     | exit 0, bare and last                                                                                   |

The `db:generate` check is worth describing, because the obvious version of it is useless: `git diff`
in this worktree shows the slice's own intentional `schema.ts` edit, so a non-empty diff proves
nothing. Hashing the generated tree before and after a re-run is what actually tests idempotency.

Two mutations re-run by the lead rather than taken on report, chosen as the two whose failure would
cost money or destroy a collaborator's work:

| Mutation                                                   | Result                                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Proceed with deletion even when Stripe cancellation fails  | 2 tests failed, including the integration test asserting the account stays active |
| Ignore the flag and delete collaborators' projects unasked | 2 tests failed, including the one asserting nothing is touched                    |

The Stripe ordering was also verified structurally, not only by mutation: the cancellation attempt
and its bail-out both sit **before** `client.query('begin')`, so a failed cancellation cannot leave
a partially written local state. That is the property that matters -- the alternative ordering leaves
Stripe billing a card for an account that no longer exists, with no local row left to reconcile the
webhook against.

The lock order was checked against the paths it could contradict rather than taken on assertion:
deletion touches **no** `membership_invitations` rows (zero references), so it cannot conflict with
`respondToInvitation`'s invitation-then-membership order, and its own `projects`-before-
`project_members` order matches `deleteProject`, `lockScope` and `transferOwnership`.

### On the flagged race

Accepted as documented, and the documentation is the right shape: both refusal mechanisms can race
the commit, and the honest net effect is that a session may be _created_ by a sign-in that read
`deleted_at` a moment too early, and is then useless on its very next request. Worth keeping the
note that `session.cookieCache` is not configured today -- `plan.md` plans it, and turning it on is
exactly the change that would convert this narrow race into a real window. That is a good reason for
the recheck to exist even though it is redundant today.
