# Screenplay invitations and membership management

Branch `feature/screenplay-invitations`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/invites`, off `e089872` (current `main`).

## Why this scope exists

Five collaboration slices were built, tested and deployed — presence, cursors, connection tokens,
offline durability, revisions, restore-as-current — and **no second person could reach any of
them**. The only write to `project_members` in the whole system was `createProject`'s "make the
creator the owner" (`apps/api/src/projects.ts`), so the `reviewer` role that
`resolveConnectionAuthorization` enforces read-only at the socket described a role nobody could
hold, and the read paths that join membership described a population of exactly one person per
project.

`plan.md` builds the entitlement design on invitations throughout — "A free account **invited** to a
screenplay may edit it by making it the one screenplay it holds editable", "Someone **invited** into
a screenplay should see what they were invited to… the invitation itself is the moment the upgrade
is most legible" — and none of it was reachable. The single editable slot, the lapse chooser and the
24-hour cooldown all described a flow that did not exist.

## The modelling decision: a separate `screenplay_members` table

The owner wants both scopes: "the 3 dot menu on both the project or just the screenplay if thats all
they want to share." The options were a nullable `screenplay_id` on `project_members` (NULL meaning
the whole project), or a separate table.

**A separate table, because the two options have opposite failure modes.**

Every authorization path in this system joins `project_members` — `apps/api/src/projects.ts`,
`entitlementStore.ts`, `revisions.ts`, `restore.ts`, `apps/collab/src/authenticate.ts`. Adding a
nullable `screenplay_id` to that table would change what every one of those existing joins _means_
while leaving all of them syntactically valid. A query that did not also constrain the new column
would silently treat a member invited to one screenplay as a member of the whole project. The
failure mode of a forgotten query is a **privilege escalation**, discovered only if someone thought
to go looking.

A separate table inverts that. A screenplay-scoped member has no `project_members` row at all, so
every pre-existing join denies them by construction, and access has to be granted explicitly by a
query that names the new table. A path this slice failed to widen refuses a member who should have
been let in — a visible, reportable bug — rather than admitting one who should have been kept out.

It also sidesteps two concrete traps in the nullable-column design:

- `project_member_unique` would have to become a three-column index whose NULL member is `NULLS
DISTINCT` by default, so two project-wide rows for the same user would both insert on any Postgres
  before 15.
- `project_single_owner_unique`'s partial predicate (`where role = 'owner'`) would start matching
  screenplay-scoped rows.

**The cost, stated plainly:** every path that _should_ honour screenplay scope has to be widened
explicitly, and a path left un-widened is a permissive-direction gap (a screenplay-scoped member
refused where they should be allowed). That cost is paid once, in one shared SQL fragment, and the
"which paths were widened" question is answerable by grepping for one import.

### One definition of the resolution

`packages/database/src/membership.ts` exports `screenplayRoleLateral(actorPlaceholder, alias)` — a
`cross join lateral`-able subquery yielding at most one `role` column: the actor's effective role on
one screenplay, from either membership table, or no rows at all when they hold neither. "No rows"
eliminates the outer row, which is exactly the "not a member, and not told whether the screenplay
exists" denial every one of these paths already used.

It lives in `packages/database` rather than being copied into each app for the same reason
`revisions.ts`'s dedupe invariant does (see that module's comment): the security property this slice
is judged on is only as strong as the weakest copy of the rule, so there is one copy, shared across
both services.

**Precedence: most privileged wins.** `owner > editor > reviewer`, written out as
`ROLE_PRECEDENCE_SQL` rather than left to either Postgres enum's declaration order. An actor who is
a project reviewer _and_ a screenplay editor is an editor on that screenplay; a project editor who
also holds a screenplay-scoped `reviewer` row is still an editor on it. Both grants were made
deliberately by someone who could make them, and the narrower one is additive rather than a
revocation — there is no "deny" in this model, and inventing one here would mean a screenplay-scoped
reviewer row silently stripping write access an owner had granted project-wide, which no interface
in this product would explain. To narrow someone's access, remove the broader grant.

**Why SQL text rather than a query function.** Every caller embeds this inside a statement it is
already running — a `select … for update` that locks the screenplay row, a listing that filters and
orders, the socket's role-and-epoch lookup. A fragment keeps all of those at one round trip and
resolves the role inside the same snapshot (and, where it matters, the same row lock) as the row it
authorizes. A helper that ran its own query would resolve the role at a different instant from the
row it was authorizing. Only compile-time constants are interpolated — an alias this module chose
and a `$N` placeholder the caller chose; the actor's id always travels as a bound value.

## Schema (migration `0010_nappy_forgotten_one.sql`)

```
shared_role            enum ('editor', 'reviewer')      -- note: no 'owner'
invitation_status      enum ('pending', 'accepted', 'declined')

screenplay_members     screenplay_id, user_id, role, created_at
                       unique (screenplay_id, user_id)
                       index (user_id)

membership_invitations id, project_id, screenplay_id?, invited_user_id, invited_by_user_id?,
                       role, status, created_at, updated_at
                       unique (project_id, invited_user_id)    where screenplay_id is null
                       unique (screenplay_id, invited_user_id) where screenplay_id is not null
                       index (invited_user_id, status)
                       index (project_id)
```

**`shared_role` has no `'owner'` value.** That absence is the enforcement mechanism, not a
convention: a check constraint could be dropped by a later migration without the application
noticing, whereas an enum with no `'owner'` makes an owner-granting invitation fail at the database.
Project ownership is established exactly once, by `createProject`, and `project_single_owner_unique`
guarantees there is at most one; sharing must never become a second path to it. An integration test
asserts the enum's values directly, and another asserts the database itself rejects
`insert into screenplay_members … 'owner'`.

**`screenplay_id` null means the whole project.** `project_id` is always populated — derived from
the screenplay row for a screenplay-scoped invite, so the two can never disagree — which is what
lets the inviter-side list for a project find both scopes through one index.

**Idempotency is two partial unique indexes**, not one three-column index with a nullable member.
This avoids depending on `NULLS NOT DISTINCT` (Postgres 15+) for correctness, and the indexes cover
_every_ status rather than only `pending` — so re-inviting someone who has already accepted, or
already declined, is an update to the one existing row and can never become a second one.

**`invited_by_user_id` is nullable with `on delete set null`**, matching
`document_revisions.authored_by`'s convention: an invitation is a fact about the invitee's access, so
deleting the inviter's account must not delete a pending invitation out from under the person who was
invited. The dashboard renders "Someone invited you to…" in that case, which a test covers.

Purely additive — two enums, two tables, six foreign keys, six indexes. Safe against a database with
existing rows, which it will be the moment this merges.

## Every authorization path, and which tables it now consults

The methods split into two groups, and which group a method is in **is** its screenplay-scope story.

### Project-scoped — `project_members` only, deliberately unchanged

| Path                                                  | Why it must not honour screenplay scope                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listProjects`                                        | A screenplay-scoped member is not a member of the project. Their work reaches their dashboard through `listSharedScreenplays` instead, as a screenplay — see below. |
| `renameProject`, `deleteProject`, `restoreProject`    | Project-level operations; a screenplay-scoped editor must not rename or delete the project their one screenplay happens to live in.                                 |
| `createScreenplay`                                    | Creating a screenplay is a project-level act, and there is no screenplay for a screenplay-scoped role to be resolved against.                                       |
| `listDeleted().projects`                              | Owner-only, unchanged.                                                                                                                                              |
| `sharing.ts`'s own authorization (`fetchProjectRole`) | Sharing is a project-level privilege: a screenplay-scoped editor cannot invite anyone, at either scope.                                                             |

Each of these refuses a screenplay-scoped member with **no change to its SQL at all** — they have no
`project_members` row. That is the fail-closed half of the modelling choice.

### Screenplay-scoped — widened through `screenplayRoleLateral` (both tables)

| Path                                                                                              | What it gates                                                                              | Negative case proving it                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `projects.ts` `getScreenplay`                                                                     | REST read of the document                                                                  | `expectNoRestAccess` → `'missing'` on the sibling                                |
| `projects.ts` `listScreenplays`                                                                   | the project's screenplay list                                                              | sibling id absent from the listing                                               |
| `projects.ts` `lockScreenplayRow` → `renameScreenplay` / `deleteScreenplay` / `restoreScreenplay` | metadata writes                                                                            | all three `'missing'` on the sibling                                             |
| `projects.ts` `listDeleted().screenplays`                                                         | the Deleted page                                                                           | a deleted sibling never listed; the member's own deleted screenplay is           |
| `projects.ts` `listSharedScreenplays` (new)                                                       | the dashboard's "Shared with you"                                                          | sibling id absent                                                                |
| `revisions.ts` `resolveMembership`                                                                | `listRevisions`, `getRevision`, `getRevisionDiff`, `createRevision` (named **and** export) | all five `'missing'` on the sibling                                              |
| `restore.ts` `restoreRevision` (via `resolveMembership`)                                          | the epoch cutover — a **write** to the live document                                       | `'missing'` on the sibling                                                       |
| `entitlementStore.ts` `fetchCandidateScreenplayIds`                                               | which screenplay may occupy the one editable slot                                          | sibling absent from candidates; `switchEditableScreenplay` → `'not-a-candidate'` |
| `apps/collab` `authenticate.ts` `fetchRoleAndEpoch`                                               | **the collaboration socket**                                                               | connection to the sibling rejected, not admitted read-only                       |
| `apps/collab` `authenticate.ts` `fetchCandidateScreenplayIds`                                     | the socket's entitlement half                                                              | same `union` as the API's copy                                                   |

`resolveMembership` being one function is why widening it covers five routes at once — including
`restore`, which writes the live document, and the whole canonical screenplay text a revision
carries. The previous `join project_members m on m.project_id = s.project_id` was satisfied by _any_
membership anywhere in the project, so leaving it would have made the revision surface a complete
bypass of the screenplay scope on five routes.

**`fetchCandidateScreenplayIds` (both copies) is a `union` of two index-driven queries, not a
lateral.** Unlike every single-screenplay lookup here, that query has no screenplay id to start
from, so a lateral would have nothing to drive it but a full scan of every screenplay in the
installation. Each branch is driven by its own membership index. Its second branch is also what
makes plan.md's entitlement design work: "A free account **invited** to a screenplay may edit it by
making it the one screenplay it holds editable" — without it, an invited free account could accept
and then find the screenplay permanently read-only, because `checkEntitlement` can only put a
_candidate_ in the slot. An integration test does exactly that: accept, `switchEditableScreenplay`,
applied.

**`lockScreenplayRow` now resolves the role in the same statement that locks the row**, so
`renameScreenplay`/`deleteScreenplay`/`restoreScreenplay` no longer each run a second
`select role from project_members … for update`. Two things improve: the role is read from the same
snapshot as the row it authorizes, and there is one place screenplay-scoped membership has to be
honoured for all three operations instead of three. It uses `for update of s, p` rather than a bare
`for update` — a locking clause cannot be applied to the lateral's derived table, and naming the two
base tables keeps precisely the locks the bare form already took.

## Why `listProjects` was left alone, and what replaced it

A screenplay-scoped member could have been given a project row with a derived role. That was
rejected: the project page's every control — rename, "New screenplay", the project's own three-dot
menu — would answer 403 for them, which is the broken-control defect this codebase already names in
`listDeleted`'s own interface comment.

Instead, `GET /api/shared-screenplays` returns the screenplays an actor reaches **only** through
screenplay-scoped membership, and the dashboard renders them as a "Shared with you" section linking
straight into the editor. A screenplay-scoped member never lands on the project page at all. The
query excludes any screenplay whose project the actor is already a member of (that project is
already in `listProjects`, and listing its screenplays again would show one piece of work twice);
that `not exists` is de-duplication, not an authorization predicate — removing it widens nothing.

## Invitations are not memberships

Nothing joins `membership_invitations` from any authorization path. `respondToInvitation`'s `accept`
is the only thing in this codebase that writes a membership row on an invitee's own behalf. A pending
invitation therefore grants exactly nothing, and that is a property of the schema rather than of a
check that could be forgotten — there is no query that could accidentally read access out of that
table, because no authorization query mentions it.

Proven twice, at both enforcement layers:

- `sharing.integration.test.ts` — "a pending invitation grants no access at all": the full
  `expectNoRestAccess` set, plus the candidate list and `switchEditableScreenplay`.
- `collaboration.integration.test.ts` — "a pending invitation grants no collaboration access, at
  either scope": the socket rejects both a screenplay-scoped and a project-scoped pending invitee,
  and the invitations are still `pending` afterwards (so this is refusal, not a side effect having
  cleared them).

## Who may share

**Owner or editor on the _project_, for both scopes.** Resolved from `project_members` alone, so a
screenplay-scoped editor cannot invite anyone — they get `'missing'`, not even told the project
exists. That is the same `canEdit` bar `renameProject`, `createScreenplay` and `deleteScreenplay`
already set.

It is bounded in the one way that matters: `shared_role` has no `'owner'`, so nothing this module
writes can grant more than the inviter already holds, and neither `changeMemberRole` nor
`removeMember` will touch the project's owner (`'owner-immutable'`). Without that guard an editor
could remove the owner and leave a project nobody can delete, rename, or share.

A project **reviewer** gets `'forbidden'` rather than `'missing'` — they demonstrably can see the
project, so concealing its existence from them would be theatre. That is the distinction the rest of
this API already draws.

## Re-invite idempotency, and what it never resets

An invite to someone who already has a pending invitation at the same scope **updates that one
row**: it can raise or lower the offered role, and it returns a declined or accepted row to
`pending` so declining is not a permanent block. `created: false` in the response says so, and the
dialog reports "already had an invitation here — it has been updated to …" rather than claiming a
fresh one was sent. The invitation id is unchanged across repeated invites, which a test asserts
directly.

An invite to someone whose **effective** access already covers the requested role answers
`already-member` with what they already hold and at which scope — checked against effective access,
not merely a row at this exact scope, so a project editor is never sent a screenplay-scoped
`reviewer` invitation that would change nothing when accepted. The complementary case still works: a
project _reviewer_ invited as a screenplay _editor_ is a real upgrade and is invited normally.

**Nothing here touches `editable_slots.updated_at`**, which is the only cooldown this system has.
plan.md is explicit — "Do not add an exception for newly shared screenplays; re-sharing would reset
it" — and an integration test takes the slot, records the timestamp, re-invites twice, and asserts
it unchanged.

## The accept/decline flow, and where it lives

The owner offered two mechanisms and left the choice open. **The dashboard is the authoritative
one**, built as such: it needs no token that could leak or expire, it is revocable by the inviter at
any time, and it does not depend on mail delivery at all.

A pending invitation renders on `/projects` as a `.readonly-banner` with Accept and Decline
right-aligned in a `.readonly-banner-actions` pair — the existing class for exactly a two-action row
(`App.tsx`'s historical-revision banner), reused rather than a new one invented, and already covered
by its own tests. It sits **above** the project list and the lapse-chooser banner: an invitation is
the one thing on that page someone else is waiting on.

The email is **notification only**. It goes through the existing `MailPort`
(`packages/auth-server/src/mail.ts`) rather than a second mail path — so a system-test process still
cannot reach a live provider (`selectMailPort` forces the logging port under `FINALER_SYSTEM_TEST`
regardless of credentials), and there is one place a provider is ever swapped. It carries **no token
and no accept link**, only a link to the invitee's own dashboard; a test asserts the body contains
exactly one URL and no token-shaped anything. Because it grants nothing, a send failure cannot
invalidate an invitation that has already committed: `invite` sends after the commit, catches, logs
`invitation_email_failed` without the address, and still reports success. Failing the request would
report failure for something that fully succeeded, and would invite a retry whose only effect would
be to try the same send again.

## The unknown-address decision

`apps/api/src/app.ts` documents an anti-enumeration rule, and that rule is right where it came from:
_unauthenticated_ endpoints like password reset, which anyone can probe anonymously and at will.
This endpoint is not one, and three things make it not one — each asserted, not assumed:

1. It sits behind the same `preValidation` hook as every other project mutation — authenticated
   session plus same-origin check. `sharingRoutes.test.ts` builds an app with `sharing` as the
   **only** store and asserts 401 without a session and 403 from an untrusted origin, for all
   eleven routes.
2. It always acts as that session's own actor on a scope its URL names; the body has no field
   capable of naming a different actor or project (`.strict()` rejects one).
3. It requires owner-or-editor membership on the project (`sharing.ts`), so probing requires a real
   account with real access, and is attributable to it.
4. It is covered by the global `@fastify/rate-limit` registration — whose `allowList` exempts only
   paths that do **not** start with `/api` — at **300 requests per 60 000 ms** per client
   (`DEFAULT_API_RATE_LIMIT_MAX` / `DEFAULT_API_RATE_LIMIT_WINDOW_MS`, overridable by
   `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW_MS`), keyed on `x-real-ip` with `request.ip` as
   fallback. A dedicated test drives the invitations path past a low explicit cap to a 429, so the
   route's inclusion is asserted rather than inferred from the `allowList` expression.

A determined prober holding such an account defeats concealment anyway by reading the pending list.
What concealment actually costs is every honest inviter who typos an address and is told nothing.

**The message, in `NO_ACCOUNT_MESSAGE` (`apps/api/src/sharing.ts`) — one place, so it can be
reworded without touching the client:**

> No account found for that email address. They need a Finaler Draft account before they can be
> invited.

Phrased about the address, not the person: the product does not know who was meant, and "this user
does not exist" would imply it does. The dialog shows it verbatim, as a `role="status"` rather than
an error — nothing failed — and leaves the typed address in the field, since a typo is the likeliest
cause and retyping it is the one thing the message exists to spare.

## A latent authentication gap this slice found and closed

`buildApp`'s `preValidation` hook is registered only when one of a list of store options is present,
and `restore` and `sharing` were both absent from that list. With `sharing` as the only store, the
hook never registered and every sharing route ran with `request.actorId` undefined — not denied,
_unauthenticated_. `restore` had the identical latent gap, which never showed because `server.ts`
always supplies `projects` too, so the hook always registered in production.

Found by `sharingRoutes.test.ts`'s "requires an authenticated session", which deliberately builds an
app with `sharing` as the only store. Both options are now in the condition, and that test makes the
list's completeness an asserted property rather than a coincidence of how `server.ts` happens to
wire things.

## What happens to a live connection on demotion or removal

`resolveConnectionAuthorization` resolves role and entitlement **once**, at connection time. So a
demotion or removal performed in `apps/api` had no effect on an already-established connection, and
"takes effect on their next reconnect" is unbounded for a writer who leaves a tab open. A removed
member silently continuing to write is the one outcome this slice was not allowed to ship, so
reconnect-only was not an acceptable answer.

**The mechanism:** `changeMemberRole` and `removeMember` issue `pg_notify` on
`MEMBERSHIP_CHANGED_NOTIFY_CHANNEL` **inside** their transaction, so the notification is delivered
if and only if the change commits. `apps/collab` listens and **closes every socket that account
holds**. The reconnect then runs the real `onAuthenticate` against the database, so:

- a **removed** member is denied outright — `apps/web` shows its terminal "access could not be
  confirmed" banner and never retries;
- a member **demoted** from editor to reviewer comes back `readOnly`, with further keystrokes
  dropped by Hocuspocus's own low-level check and retained in `document_yjs_quarantined_updates`
  exactly as any other reviewer's are.

One mechanism covers both cases, and neither depends on `apps/collab` reasoning about roles — the
database stays the only authority. `NOTIFY` over service-to-service HTTP for the same reasons
`SCREENPLAY_RESTORED_NOTIFY_CHANNEL` already chose it: one shared database, no new credential, no
knowledge in `apps/api` of where `apps/collab` is deployed.

**The payload names only the account**, never the project or screenplay. That is deliberate
over-inclusion: `apps/collab` closes all of that account's sockets, each of which reconnects and
re-reads the database. A reconnect cannot grant anything, so the cost of over-inclusion is a brief,
correct reconnect on an unaffected document, while under-inclusion would be exactly the
removed-member-still-writing case. It also keeps the payload a fixed size — naming every affected
screenplay would put an unbounded list in an 8000-byte notification for a project-scoped change.

**Why close rather than force `readOnly`.** `supersedeRestoredDocuments` deliberately does _not_
close, because a superseded document's holders have legitimately retained read access. This is the
opposite situation: a removed member has lost read access too, so leaving the socket open and merely
read-only would keep streaming them a document they may no longer see.

`restoreNotifications.ts`'s listener was generalised into `startNotificationListener` (channel plus
payload handler) and the restore listener is now a thin binding of it. Everything subtle about it —
a dedicated connection because `LISTEN` is session state, abandoning rather than closing a client
that has already errored, a `dispose()` safe before the first connection exists, a `started` promise
a test can await — is identical for any channel, and a second copy would be a second chance to get
one of those wrong.

Both cases are proven over a real socket in `collaboration.integration.test.ts`. The removal test
asserts the member's **writes stop reaching the owner's document**, not merely that a socket closed:
a closed socket that silently reconnected with its old authorization would satisfy the weaker claim
and still be the bug. It also asserts the owner's own connection is untouched.

**Stated plainly as a known limitation:** a demoted editor's _editor UI_ does not become visibly
read-only until they reload. Their writes are refused and quarantined at the socket immediately,
exactly as any reviewer's are — but `App.tsx` computes its read-only presentation from the
entitlement endpoint and `syncState`, not from the connection's `readOnly` flag, so a reviewer can
type into a document whose keystrokes are being set aside. That is a **pre-existing** gap in the
reviewer experience, not introduced here, and deliberately not fixed in this slice: it is a
user-facing design question about how a reviewer's editor should present itself, and it touches the
editor's banner logic rather than anything this slice owns.

## Interface

One `SharingDialog` serves both scopes and all three entry points, because the only thing that
differs is the `scope` prop — exactly as on the server, where `sharing.ts` takes a `SharingScope`
rather than offering two sets of operations. It follows `NamedRevisionDialog`'s hand-built modal
shell (`role="dialog"`, `aria-modal`, Tab/Shift+Tab focus trap, Escape to close) rather than
introducing a third dialog pattern.

**Three entry points, as asked:**

| Entry point                                                            | Scope      | Gate                                                           |
| ---------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| Project row three-dot menu (`routes/projects/index.tsx`)               | project    | `role` is `owner` or `editor`; Delete stays owner-only         |
| Screenplay row three-dot menu (`routes/projects/$projectId/index.tsx`) | screenplay | `screenplay.role` is `owner` or `editor`                       |
| Editor File dropdown (`App.tsx`, via `onOpenSharing`)                  | screenplay | the live route supplies the callback only for `owner`/`editor` |

Each gate matches the server's own bar exactly, so "Share…" is never a control that answers 403 and
never withheld from someone who could have used it. In the File menu its _presence_ is the
authorization signal — the same shape `onOpenRevisionHistory` already uses — so `App.tsx` never
recomputes the rule, and the historical-revision preview route never supplies it at all. It is
deliberately **not** gated on `editingAllowed`: sharing is not an edit to the document, and a lapsed
subscription has nothing to say about whether an owner may invite a collaborator.

### The comparison view's File menu

The screenplay-diff slice established that the read-only comparison view wears the editor's whole
frame and **disables** what has no meaning there rather than omitting it — "the same control, in the
same place, under the same name" — and `screenplay-diff-persistence.spec.ts` asserts the two File
menus have the identical item set. Adding "Share…" to the editor's menu broke that invariant, and
that spec caught it (it was briefly mistaken for one of the known persistence flakes; the failure
text showed otherwise).

The comparison view therefore carries a **disabled** "Share…", with a reason, alongside its five
other unavailable items. That is correct on the comparison's own terms rather than only
expedient: sharing a stored comparison has no meaning for _any_ viewer, so unlike the editor's copy
it needs no role to decide — which matters, because the diff route fetches only the diff and has no
role to gate on without an extra round trip.

**One asymmetry this leaves, stated plainly:** a _reviewer_ sees no "Share…" on the live editor
(omitted, matching the project and screenplay three-dot menus, which also omit it for a reviewer)
but a disabled one on the comparison. It is cosmetic, it is the only role for which the two menus
differ, and closing it would mean either the comparison route duplicating the sharing role rule — a
second place that rule lives, which this slice deliberately avoids — or the editor showing a
reviewer a permanently disabled item that the other two entry points do not. Left as is, recorded
rather than hidden.

Two small wire additions carry the viewer's own effective role, which the widened lateral already
resolves for free: `role` on `GET /api/screenplays/:id` (for the File menu) and on each item of
`GET /api/projects/:id/screenplays` (for the per-row menu). `role` is deliberately **not** on
`PersistedScreenplay` — the historical-revision preview route constructs one of those from an
immutable revision and has no live role to report — so a separate `FetchedScreenplay` type carries
it and the live route reads it before handing `App` its props.

**Email addresses** appear on the inviter-side member and invitation lists and **not** on the
invitee-side list. The inviter-side viewer is an owner/editor managing a project they can already
share, and the address is the identity they themselves typed (and the only thing distinguishing two
collaborators with the same display name). The invitee has typed nothing and needs nothing: their
list carries the inviter's display name only, and `listInvitationsForUser` does not select
`inviter.email` at all — a test asserts that.

At screenplay scope the dialog shows inherited project members marked "via the project", visible so
an inviter can see an invitation would be redundant, but not editable from there: changing
project-wide membership from inside one screenplay's dialog would reach far outside what the writer
opened it from.

## Tests

- `packages/database/src/membership.test.ts` — 12. The fragment's shape: that it reads both tables,
  that screenplay membership is correlated on `sm.screenplay_id = s.id` and **never** on the
  project, that both branches filter by the actor placeholder and nothing else, and that precedence
  is the written-out expression rather than enum order.
- `apps/api/src/sharing.test.ts` — 39. Every store decision against a fake pool: which queries run
  in which order, every outcome mapping, the owner guard, that the notification fires inside the
  transaction and only for a change that happened, that a mail failure still reports success, and
  that every path rolls back and releases its client when a query throws.
- `apps/api/src/sharingRoutes.test.ts` — 27. All eleven routes plus `/api/shared-screenplays`, as a
  table: not registered without the store, 401 without a session, 403 from an untrusted origin,
  always the session's own actor on the URL's own scope, every status mapping, schema rejections,
  the rate limit, and `private, no-store`.
- `apps/api/src/invitationMail.test.ts` — 8. Including that the body contains exactly one URL (the
  dashboard), no token, and no address but the recipient's own.
- `apps/api/src/sharing.integration.test.ts` — 18, real database. Invite, accept, decline,
  re-invite idempotency (same row, changeable role, re-opened after a decline), already-member, the
  unknown address, inviting yourself, mixed-case resolution, role change, removal, the owner guard,
  revocation, a foreign invitation id, the cooldown non-reset, and the REST privilege negative.
- `apps/collab/src/membershipNotifications.test.ts` — 12. The exact boundary of which connections
  close, a connection with no identity, and listener reconnect/dispose.
- `apps/collab/src/collaboration.integration.test.ts` — 5 new, real socket, beside the existing
  reviewer and free-tier rejection tests: screenplay-scoped editor denied the sibling,
  screenplay-scoped reviewer denied (not merely read-only) on the sibling, pending invitation
  granting nothing at either scope, live removal, live demotion.
- `apps/web/src/sharingDialog.test.tsx` — 20. Both scopes' wording and URLs, every invite outcome,
  role change, removal, revocation, inherited access shown but unmanageable, loading and error.
- `apps/web/src/routes/projects/index.sharing.test.tsx` — 18. Invitation rows, the right-aligned
  action pair, accept/decline, the deleted-inviter case, "Shared with you", and the project menu's
  gate.
- `apps/web/src/routes/projects/$projectId/index.sharing.test.tsx` — 5.
- `apps/web/e2e/invitations-persistence.spec.ts` — 3, two real browser contexts and two real
  accounts: invite from the screenplay menu and accept; invite the whole project and decline; the
  unknown address.

### The REST privilege negative, as one reusable assertion

`expectNoRestAccess(actor, screenplayId, projectId)` covers **every** `apps/api` path that resolves
membership by id — read, both listings, three metadata writes, three project-level writes, the four
revision reads/writes including the membership-only export, and both entitlement paths. It is reused
by the sibling-screenplay case, the pending-invitation case and the post-removal case, so all three
prove the identical complete set rather than whichever subset each remembered. The revision paths
share one helper today, and are each asserted anyway: "they share a helper" is a fact about the
current code, not a property a test should assume on a future refactor's behalf.

One assertion in it is "does not contain this screenplay" rather than "is empty", and deliberately:
a screenplay-scoped member legitimately _does_ see their own screenplay in `listScreenplays`, so
asserting emptiness would assert the wrong property and fail on the very case the helper exists to
check. Where the listing really should be empty, the calling test covers every screenplay in the
project, so "contains none of them" is exactly emptiness.

### Mutation testing

Each mutation was applied to the real source, rebuilt across the package boundary
(`packages/database` is consumed through its compiled `dist/`), run against **the suite that owns
the property**, then reverted and reconfirmed byte-identical with `diff`.

**1. A screenplay-scoped member reaches a sibling screenplay.** `screenplayRoleLateral`'s second
branch correlated on the project instead of the screenplay — the plausible way this bug gets
written, and exactly the gap the separate table exists to prevent.

- `apps/api/src/sharing.integration.test.ts`: **2 failed** of 18 — "invites to one screenplay, and
  accepting grants exactly that screenplay — never a sibling" and "a screenplay-scoped member sees
  only their own screenplay in the deleted list".
- `apps/collab/src/collaboration.integration.test.ts`: **2 failed** — both sibling-denial tests,
  with `promise resolved "undefined" instead of rejecting` (the connection was admitted).
- `packages/database/src/membership.test.ts`: **2 failed** — the two correlation tests.

**2. A pending invitation grants access.** `invite` wrote the membership row at invite time, leaving
the invitation row as bookkeeping.

- `apps/api/src/sharing.integration.test.ts`: **4 failed** of 18, led by "a pending invitation grants
  no access at all"; also the decline test and both re-invite idempotency tests.
- `apps/collab/src/collaboration.integration.test.ts`: **passed** — and this is worth stating rather
  than glossing. That suite's fixture inserts the invitation row directly, so it cannot see a bug
  located in `invite()`. The two tests own different halves of the same property: the REST suite owns
  "accepting is the only thing that grants" (it drives the real `invite`), and the socket test owns
  "the socket's authorization never reads `membership_invitations`".

**2b. The socket's own half.** To prove the socket test is not vacuous, a third mutation made
`screenplayRoleLateral` itself resolve a role from a pending invitation — the way "an invitation is a
membership" would actually be written by someone who thought that table was the grant.

- `apps/collab/src/collaboration.integration.test.ts`: **1 failed** — "a pending invitation grants no
  collaboration access, at either scope".
- `apps/api/src/sharing.integration.test.ts`: **1 failed** — "a pending invitation grants no access
  at all".

## Existing tests that changed, and why none was weakened

- `projects.test.ts` (3) — one fewer queued fake result, because `lockScreenplayRow` now resolves
  the role in the statement that locks the row. The authorization asserted is identical (reviewer
  refused, editor succeeds) and is additionally proven against a real database for both kinds of
  membership.
- `revisions.test.ts`, `restore.test.ts` — their `vi.mock('@finaler-draft/database')` now spreads
  the real module instead of replacing it wholesale, so the pure membership helpers stay real.
  Stubbing them would not isolate anything; it would stop the resolution under test from working.
  Spreading also means a pure helper added later cannot silently become `undefined`.
- `index.test.tsx`'s "shows Delete only for a project the viewer owns" — it asserted the _menu's
  presence_ as a proxy, exact while Delete was an owner's only item. An editor now has a menu with
  "Share…" in it, so the test asserts the **Delete item** directly: strictly stronger, since it
  would also catch Delete appearing in a menu that was correctly shown.
- `index.delete.test.tsx` — the keyboard path now ArrowDowns past "Share…" to reach Delete (which
  additionally exercises `OverflowMenu`'s arrow-key handling), and the request count moves 4 → 6 for
  the dashboard's two new queries. The property that count pins down — that invalidating
  `['projects']` does not refetch the others — is unchanged.
- `routeHarness.tsx` — `useMutation`'s mock now calls `onError`, as React Query does (additive; no
  existing caller passes one), and `resetRouteHarness` defaults the two new dashboard query keys to
  empty, in the same spirit as `fetchMock`'s existing per-endpoint defaults.
- Fixtures gained the fields their schemas now require (`role` on screenplay reads,
  `listSharedScreenplays` on `ProjectStore` fakes).

## Deliberately out of scope

Shareable links, sign-up-on-invite, and consolidating the File menu's three download items into a
hover submenu (the owner's next request — the download items are untouched so the two slices do not
collide).

## Lead verification

**The two security properties were mutation-tested independently**, by making the membership lateral
resolve screenplay membership across the whole project -- the sibling leak in its most realistic
form:

| suite                     | result                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/api` integration    | 2 failed: "accepting grants exactly that screenplay -- never a sibling", and the deleted-list sibling case       |
| `apps/collab` integration | 2 failed: the scoped member denied the sibling, **and** the reviewer variant denied rather than merely read-only |

Both layers catch it, and the socket pair matters most: that is the path where a leak would mean a
stranger writing into someone else's screenplay rather than merely reading it.

**The latent authentication gap is real and the fix is right.** Before this slice,
`buildApp`'s `preValidation` hook registered only if one of an enumerated list of stores was present,
and `restore` and `sharing` were both missing from that list -- so an app built with either as its
only store ran those routes unauthenticated rather than denying them. Never exposed in production,
because `server.ts` always supplies `projects`, but real. Worth noting the shape of the mistake as
well as the fix: the gate is a hand-maintained list, this is the second and third store to be
forgotten in it, and a fourth will be. Inverting it -- register unless there are no protected stores
-- would remove the class rather than this instance.

**Migration `0010` is purely additive** (two enums, two tables, FKs, indexes; no `ALTER` on anything
existing), so it is safe against the owner's production rows. `shared_role` correctly excludes
`owner`. Re-invite idempotency is enforced by two partial unique indexes rather than by a check,
which is the right place for it.

**Gates re-run by the lead:** lint 0, format:check 0, typecheck 0, `pnpm test` 0 (web 919, api 317,
collab 139, database 52), integration 11 + 76 + 32.

## The browser-suite regression: investigated, and it was the test

`apps/web/e2e/screenplay-diff-persistence.spec.ts:79` fails **on both consecutive runs** of
`test:system:persistence` on this branch, and the same suite passes **33/33 on `origin/main`**. The
assertion is a typed string coming back garbled:

```
Expected: "Added after the milestone."
Received: "Added after the milestone.tone."
```

The last five characters are duplicated, which is the signature of typing proceeding, something
rolling the document back a few characters, and those characters being typed again.

This is not the known flake pattern. That test failed once on an earlier branch and passed on re-run;
here it fails every time while main passes. This slice did not touch the spec beyond adding
`'Share…'` to a File-menu item list, did not change the editor route's query configuration, and
added no query or effect to `App.tsx`.

**Best hypothesis, unconfirmed:** `GET /api/screenplays/:id` now carries the viewer's effective
`role`, which means it runs the membership lateral join. A slower initial fetch shifts when
`y-indexeddb`'s load and the collaboration provider's first sync complete relative to the test's
`page.keyboard.type(...)`, exposing a race the test always had.

**Why that hypothesis is not good enough to merge on.** If the race is in the test, the fix is a wait
before typing and nothing user-facing is wrong. If it is in the editor -- `y-indexeddb` merging a
stored state over characters already typed -- then **writers can lose or duplicate keystrokes under
timing pressure**, which is the most serious class of defect this product can have. The symptom is
identical from the outside, and nothing measured so far distinguishes them.

Recommended next step: instrument the real editor rather than the test -- log the Yjs document's
content at each of `IndexeddbPersistence`'s `synced`, the provider's first `sync`, and each
keystroke, then type under an artificially delayed screenplay fetch. If the duplication appears with
no test harness involved, it is a product bug and takes priority over everything else outstanding.

### Resolved

Measured rather than reasoned about, after the hypothesis above turned out to be only half right.

**The first hypothesis was wrong.** "The test types before the editor has synced" cannot be it: the
typing happens _after_ a complete File-menu interaction -- open the menu, click "Save named
revision...", fill the label, click Save, wait for the dialog to close -- so the editor is
demonstrably interactive and synced well before the first character.

**What the duplication actually was.** "Added after the milestone." came back as "Added after the
milestone.tone.", and the shape of that is exact: `miles` + `tone.` + `tone.`, the last five
characters applied twice. So input was being delivered faster than each keystroke's work -- the
ProseMirror transaction, the pagination pass, the Yjs update -- could settle.

**The threshold, by experiment:**

| typing delay                              | result                         |
| ----------------------------------------- | ------------------------------ |
| none (`page.keyboard.type` default)       | fails every run on this branch |
| 60 ms/char                                | 36/36                          |
| 25 ms/char -- faster than key auto-repeat | 36/36                          |

25 ms is faster than the ~30 ms a held key repeats at, and far faster than the 100-200 ms a person
types at. So the failing rate is not one any input device produces: it is Playwright dispatching key
events back-to-back within a single event-loop turn. **This is a test artifact, not a defect a writer
can reach**, and the honest fix is to type at a real rate rather than to chase a race that only
synthetic input creates.

Fixed by typing with `delay: 80`, matching `page-rendering-persistence.spec.ts`'s existing typing
delay rather than inventing a second number. Two consecutive full runs afterwards: **36/36 and
36/36**.

**Why it surfaced on this branch and not on `main`, which is the part worth remembering.** This slice
added the viewer's effective role to `GET /api/screenplays/:id`, so that request now runs the
membership lateral join. One extra join moved this assertion from passing to failing _every_ run.
That is not a statement about sharing; it is a statement about the test, which was sitting so close
to its own edge that a single join pushed it over. The same is true of the other known offenders in
this suite, and it is the argument for the harness pass recorded in
`progress/paste-split-block-identity.md` rather than another one-at-a-time fix.

**Not claimed:** that no input path can outrun the editor. Auto-repeat at 25 ms is clear, but an IME
commit or a very large paste delivers differently and was not tested here. What is established is
that the rate this test used is unreachable, and that nothing in the sharing work slowed the editor's
own input handling -- only one read query.

**Gates after the fix:** `test:system:persistence` 36/36 twice, `test:system` 40/40,
`test:coverage` 0, `check:bundle-budget` 0 (lazy editor 144.79 kB), lint / format:check 0.

## One list, not a "Shared with you" section

Changed on the owner's instruction after reviewing the branch: "I don't want a separate 'shared with
you' section. Thats why we put 'owner' on the projects initially, so ones shared with you could say
'shared with you' there instead."

The dashboard now renders one list. Project-scoped shares were always in it -- `listProjects` joins
`project_members`, so a project-scoped member has always seen the project as a row -- and the
screenplay-scoped rows that had their own section now sit among them.

**The row's role label is what distinguishes them**, via one `roleLabel` helper so the decision lives
in a single place: `owner` is stated plainly, and every other role is prefixed, reading
"shared with you · editor" or "shared with you · reviewer". The role is kept rather than replaced by
the phrase -- whether a writer may edit the thing is the next question after whose it is.

**Screenplay-scoped shares stay screenplay rows rather than surfacing their parent project**, which
is the one design question this raised. Granting access to one screenplay inside someone else's
project does not grant the project, so a project row would name a container the viewer cannot open --
and that is exactly what the existing test "links straight into the editor, never to the project page
the invitee cannot use" was written to prevent. It is also what Drive and Notion do: the thing
shared appears, not its container.

**Tightened on the way:** `projectSchema.role` was `z.string()`. Once the dashboard decides what a
row _says_ from that value, a loose string lets an unexpected role pass validation and then fall
through every branch that switches on it. It is now the same `effectiveRoleSchema` enum the other
membership responses use, which required hoisting that enum above the first schema needing it.

**Tests updated to the new contract rather than relaxed.** The "section is absent" test asserted a
heading that no longer exists, so it would have passed whatever the list did; it now asserts the
_row_ is absent. The role-text test asserts the new string. And one assertion was **added** for the
property the heading used to make trivially true and which nothing else checked -- that there is
exactly one list, with both an owned project and a shared screenplay in it.

Mutation-tested: restoring the separate section fails exactly that new test and nothing else.

**Gates after the change:** lint 0, format:check 0, typecheck 0, `pnpm test` 0 (web 920, api 317),
`test:system:persistence` 36/36, `test:system` 40/40.
