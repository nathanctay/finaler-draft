# Project ownership transfer

A project's owner has been permanent since `createProject` first wrote the single `project_members`
row with `role = 'owner'`. This slice adds the one deliberate second path to ownership: the current
owner may hand the project to an existing member, who becomes the owner while the previous owner is
demoted to `editor`, never removed. It is a prerequisite for account deletion (an owner needs
somewhere to hand a project before deleting themselves) but stands on its own and does not touch
deletion at all.

## Where this lives, and why

`apps/api/src/sharing.ts` is the module that governs every write to `project_members` apart from
`createProject`'s own first row, and its header comment is explicit that `'owner'` is absent from
the `shared_role` Postgres enum so sharing can never become a second path to ownership. That
invariant is about the _sharing_ surface (`invite`/`changeMemberRole`/`removeMember`), not about
`project_members` itself -- the table has always supported an `'owner'` row, just only ever written
once. `transferOwnership` lives in this same file, as a third function alongside `changeMemberRole`
and `removeMember`, with its own stricter bar, rather than as a weakening of either of theirs:

- `changeMemberRole`/`removeMember` refuse unconditionally the moment a _target_ row is `'owner'`
  (`MemberChangeOutcome`'s `'owner-immutable'`) -- that guard is untouched and still absolute.
- `transferOwnership` is the only function allowed to _write_ an `'owner'` role, and it is reached
  from nowhere `invite`/`changeMemberRole`/`removeMember` are reached from. An invitation still
  cannot grant ownership; a role change still cannot touch the owner row. The second path is this
  one function, not a loophole in the existing ones.

The module's own header comment was extended to say this explicitly, so a reader of `sharing.ts` a
year from now sees the exception named and justified at the place that would otherwise look
contradicted by it.

## Authorization: the current owner only

`transferOwnership(actorId, projectId, targetUserId)` requires `actorRole === 'owner'` -- stricter
than `canManageSharing` (owner-or-editor), which is the bar every other sharing operation sets. An
editor can already invite, change roles, and remove members on this project; they may not give the
project itself away. There is no site-admin override, because no such role exists in this codebase
(confirmed: `project_role` and `shared_role` are the only two role enums, and neither has a value for
"platform operator").

A non-member actor gets `'missing'`, not `'forbidden'` -- the same information-hiding convention
every other sharing operation uses: a stranger is told nothing differs from "this project does not
exist," while an editor (who demonstrably _can_ see the project) gets `'forbidden'`, which does admit
it exists. This is resolved by the same `lockScope`/`fetchProjectRole` helpers `invite`/
`changeMemberRole`/`removeMember`/`listSharing` already use, in the identical order (lock the project
row, then the actor's `project_members` row), so this function's authorization reads like the others
rather than inventing a parallel shape for the same two tables.

## Why the recipient must already be a member, and why there is no acceptance step

**Membership required, no invite-to-arbitrary-address.** Transferring to an address with no
existing relationship to the project would need an invitation-and-acceptance flow -- a materially
larger feature (a pending-invitation state machine for ownership itself, email, expiry, revocation)
that this slice deliberately does not build. Requiring existing membership also means the recipient
has already affirmatively chosen to collaborate on this project; ownership is being handed to someone
who opted in, not sent to a name typed into a box.

**No acceptance step; the transfer takes effect immediately.** Two independent reasons, both worth
stating because either alone would be a weaker argument:

1. The account-deletion flow this unblocks cannot wait on a recipient who may never respond. An
   owner who wants to delete their account and has handed off their project should not be stuck
   mid-deletion because the new owner hasn't opened an email.
2. Gaining ownership only _adds_ capability to someone who already has access -- any existing member
   can already read everything an owner can (owner/editor/reviewer differ in write and management
   capability, not in what they can see), so promotion to owner cannot be a privacy or read-access
   surprise to the recipient the way an invitation to a _stranger_ would be.

It is also reversible: the new owner can transfer back (and the integration test "moves ownership to
an existing member..." proves exactly that round trip against a real database, not just as an
assertion about the API's shape).

## The single-owner invariant, and the write order it demands

`project_single_owner_unique` (`packages/database/src/schema.ts`) is a **plain, non-deferrable**
partial unique index on `project_members.project_id where role = 'owner'`. Postgres checks a
non-deferrable unique index after each statement, not at commit, so a transaction can never have two
owner rows for the same project even transiently _within itself_ -- which is what makes the write
order load-bearing rather than cosmetic.

The two writes are **demote-then-promote**:

```sql
update project_members set role = 'editor' where project_id = $1 and user_id = $2;  -- actor
update project_members set role = 'owner'  where project_id = $1 and user_id = $2;  -- target
```

Promoting first (while the actor's row still says `'owner'`) would insert a second `'owner'` row for
the same project and fail the index on the transaction's own second statement -- confirmed, not just
reasoned about: reordering the two statements and running the integration test reproduces exactly
`duplicate key value violates unique constraint "project_single_owner_unique"` thrown from inside
`transferOwnership` itself (see the mutation table below). Demoting first means there is never an
instant, even inside this one transaction, where the index would see two owner rows.

Both writes are plain `UPDATE`s on rows that already exist (the actor's own row, confirmed `'owner'`;
the target's row, confirmed to exist by `fetchProjectRole`) -- there is no `INSERT`, so there is no
`project_id` foreign-key check to take a `KEY SHARE` lock on `projects` the way `document_revisions`'
insert does in the `restore.ts`/`revisions.ts` deadlock. That absence matters for the next section.

## The lock: `pg_advisory_xact_lock`, acquired first, and why

Two concurrent transfers of the same project must not be able to interleave into a project with zero
owners or two. A naive version -- read the current owner, then demote-then-promote -- is not safe
under concurrency even with the correct write order: two transactions could both read `actorId` as
the current owner before either writes anything, both demote it, and then race on which one's
promote lands last (the second would fail the unique index outright after having already, and
wrongly, demoted the real owner inside what should have been a refused request).

This codebase's convention for exactly this shape of problem is `pg_advisory_xact_lock`, used by
`packages/database/src/restore.ts` and `revisions.ts` (`REVISION_LOCK_NAMESPACE = -1`, keyed by
`hashtext(screenplayId)`) and by `apps/collab/src/updateLog.ts` (keyed by `hashtext(screenplayId)`
and the epoch). `transferOwnership` follows it: a new `PROJECT_OWNERSHIP_LOCK_NAMESPACE = -2`,
keyed by `hashtext(projectId)`, taken as the **first statement after `begin`**, before any row lock.

**The key.** `hashtext(projectId)` -- a project-scoped lock, because ownership is a project-level
concept (there is no screenplay-scoped owner; `shared_role` has no `'owner'` value). This is
deliberately a _different_ namespace from `REVISION_LOCK_NAMESPACE`, not a reuse of it, even though
reusing it would be harmless on paper: the two locks serialize completely different invariants over
completely different id spaces (a project id here, a screenplay id there), and a shared namespace
would only ever add an accidental extra wait if a project id and an unrelated screenplay id happened
to hash to the same 32-bit value -- a performance cost, never a correctness one, and not worth
inviting for no benefit. `-2` is simply the next unused negative integer; any value disjoint from
`updateLog.ts`'s non-negative epoch keys would do.

**Why first, before any row lock.** `progress/revision-lock-deadlock.md` documents a real production
deadlock between `restore.ts` and `revisions.ts`: one took a row lock (`FOR UPDATE` on `screenplays`)
then the advisory lock, the other took the advisory lock then needed a row lock (the `KEY SHARE` a
foreign-key check takes on insert) -- opposite orders, closing a cycle Postgres broke by killing one
side with `40P01`. The fix there was "every advisory-lock site takes advisory-then-row, no
exceptions." `transferOwnership` follows that same ordering from the start, even though -- checked
explicitly, not assumed -- nothing else in this codebase currently takes
`PROJECT_OWNERSHIP_LOCK_NAMESPACE`, so there is no _existing_ call site it could deadlock against
today. Two reasons to still take the lock first rather than treat this as a special case:

1. It is the convention a reader of any future advisory-lock site in this repo should be able to
   copy from any existing one without first checking whether _this particular_ site happens to be
   exempt.
2. The write order already established above (plain `UPDATE`, no `INSERT`) means this function
   itself takes no `KEY SHARE` lock on anything -- but a _future_ change to this function (say, an
   audit-log insert referencing `projects.id`) would introduce exactly that lock, and "advisory
   first" is what keeps such a change deadlock-safe automatically rather than depending on whoever
   makes it noticing.

Each advisory-lock call site in this codebase tags its own SQL with a distinguishing comment, because
a Postgres deadlock report prints the _waiting statement_, and before that convention existed an
ambiguous report cost real time pinning down which function was waiting (`revision-lock-deadlock.md`
again). `acquireOwnershipLock`'s statement carries `/* sharing.acquireOwnershipLock */` for the same
reason.

## Entitlements: verified, nothing to do

Checked rather than assumed: `packages/entitlements/src/index.ts` resolves entitlement **per actor**,
from that account's own subscription row -- `owner`/`editor` only decide which screenplays are
_candidates_ for that one account's single free-tier editable slot, never anyone else's. Transferring
ownership changes who holds the `'owner'` role on a `project_members` row; it does not touch either
account's subscription, nor the other account's own candidate set beyond the ordinary "your role on
this project changed" effect `changeMemberRole`/`removeMember` already produce and already notify
`apps/collab` about. No entitlement recalculation is triggered by this slice, and none is needed.

## Every distinct error case

| Case                                           | Outcome                        | Why distinguishable                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor is not the project's owner               | `'forbidden'`                  | Admits the project exists (the actor can see it), but refuses the specific act.                                                                                                               |
| Actor has no membership row at all (stranger)  | `'missing'`                    | Information-hiding convention: a stranger gets the same answer a nonexistent project would give.                                                                                              |
| Target has no `project_members` row            | `{ outcome: 'not-a-member' }`  | A 200 body, not a 4xx: a legitimate request from the actual owner, correctly evaluated as "that person is not here" -- same convention as `MemberChangeOutcome`'s `'not-a-member'`.           |
| Target is the actor (self-transfer)            | `{ outcome: 'already-owner' }` | Checked only after confirming the actor _is_ the owner, so it can never be used to probe who owns a project; a 200 body for the same "nothing failed" reason as `not-a-member`.               |
| Project does not exist, or `deleted_at` is set | `'missing'`                    | Resolved by the same `lockScope` every other sharing operation uses -- a soft-deleted project is treated identically to a nonexistent one everywhere else in this API, and this follows suit. |

The self-transfer check runs before the target lookup: once the actor is confirmed as the owner, a
self-transfer target trivially already holds the row just locked, so there is nothing to gain by
querying it again.

## The API route

`POST /api/projects/:id/transfer-ownership`, body `{ targetUserId: string }` (bounded `min(1).max(255)`,
matching `memberParams.userId`'s own bound for a Better Auth id -- deliberately not `.uuid()`).
Registered only under `options.auth && options.sharing`, matching every other sharing route. Unlike
every pair of routes above it in `app.ts`, there is exactly one route, not a project/screenplay pair:
there is no screenplay-scoped owner to transfer. `'missing'` maps to 404 ("Project not found"),
`'forbidden'` to 403 ("Project owner access required to transfer ownership" -- deliberately not the
"editor access" wording every other sharing refusal uses, since the bar here really is owner-only).
`'not-a-member'`/`'already-owner'`/`'transferred'` are all 200 bodies.

## The UI: built, in the sharing dialog

Built, not deferred. `apps/web/src/sharingDialog.tsx` already manages every other `project_members`
write (`invite`, `changeMemberRole`, `removeMember`) from one component shared by both scopes; adding
a "Make owner" control there was a small, contained change rather than a new surface:

- A new `viewerIsOwner?: boolean` prop (default `false`), set by the one caller that can set it
  meaningfully: `routes/projects/index.tsx`'s `ProjectRow`, as `project.role === 'owner'` -- the exact
  same field `canShare` already reads from the identical listing, so there is no second source of
  truth for "does this viewer own the project."
- The control (`canMakeOwner`) requires **both** `scope.kind === 'project'` and `viewerIsOwner`,
  checked again inside `SharingDialog` itself rather than trusted to the caller -- there is no
  screenplay-scoped owner to transfer, so a future screenplay-scope call site that got `viewerIsOwner`
  wrong gets no button at all instead of one whose own mutation throws when clicked.
- It piggybacks on exactly the rows `manageable` already covers (every non-owner row, never the
  read-only inherited-access row a screenplay's dialog shows), so it can never appear on the owner's
  own row.
- No confirmation dialog -- immediate action, like every other write in this same dialog (Remove,
  and like Delete on the project/screenplay row menus). The brief's own reasoning for skipping an
  acceptance step applies identically here: reversible, and only reachable by someone who already
  passes the server's bar.
- On success it reports the role flip to the viewer explicitly ("Ownership transferred. You are now
  an editor on this project.") rather than leaving them to infer it from the member list's own
  redraw.

Not built, and explicitly out of scope by the brief: anything on the editor's File menu or the
screenplay row's dialog, since both are screenplay-scoped and ownership is project-only.

## Mutations, and the test each one killed

Every mutation below was applied with a Python string-replace asserting an exact match count of 1,
run against the real file, confirmed to fail the expected test with the expected message, then
reverted with the same exact-match discipline and the suite re-run green. "Restored" means a
subsequent full run of the relevant test file(s) passed again.

| #   | Mutation                                                                                                | Expected failure                                                                                                            | Actual result                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Authorization widened from `actorRole !== 'owner'` to `!canManageSharing(actorRole)` (owner-or-editor)  | `transferOwnership > refuses an editor with forbidden...`                                                                   | Failed: `expected { outcome: 'not-a-member' } to be 'forbidden'` -- an editor now passed authorization and fell through to the target-membership check instead.                                                                                                                                                                                                                                                                                                            |
| 2   | Self-transfer check (`targetUserId === actorId`) removed                                                | `transferOwnership > answers already-owner for a self-transfer...`                                                          | Failed: `expected { outcome: 'not-a-member' } to deeply equal { outcome: 'already-owner' }` -- a self-transfer fell through to the (unqueued) target lookup.                                                                                                                                                                                                                                                                                                               |
| 3   | `not-a-member` guard removed (target role fetched but not checked)                                      | `transferOwnership > reports a target with no membership row as not-a-member`                                               | Failed: `expected { outcome: 'transferred', newOwnerId: 'actor-2' } to deeply equal { outcome: 'not-a-member' }` -- a non-member target was silently promoted.                                                                                                                                                                                                                                                                                                             |
| 4   | Write order reversed: promote target, then demote actor                                                 | `transferOwnership > demotes the actor to editor before promoting the target to owner...` (unit, statement-order assertion) | Failed: `expected 6 to be less than 5`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4b  | Same mutation, against a real database                                                                  | `sharing.integration.test.ts`'s "moves ownership to an existing member..."                                                  | Failed with a **real** `duplicate key value violates unique constraint "project_single_owner_unique"`, thrown from `transferOwnership`'s own promote statement -- confirming the write order is load-bearing against the actual index, not merely asserted in a comment.                                                                                                                                                                                                   |
| 5   | Advisory lock moved after `lockScope` (row lock first, advisory lock second)                            | `transferOwnership > takes the advisory lock before any row lock`                                                           | Failed: `expected 2 to be less than 1`. The concurrency integration test (#6) was checked too and **still passed** under this mutation -- expected and explained below, not a gap: that test's "blocker" never contends the project row, so reordering the two locks inside `transferOwnership` doesn't change when it blocks. The ordering property is exactly what the unit test checks; the integration test checks a different property (serialization exists at all). |
| 6   | `acquireOwnershipLock` call removed entirely                                                            | `sharing.integration.test.ts`'s "does not let two concurrent transfers..."                                                  | Failed: `expected false to be true` -- the real call never blocked on `pg_locks` at all, i.e. without the lock there is no serialization to prove.                                                                                                                                                                                                                                                                                                                         |
| 7   | Route handler passes `request.body.targetUserId` as the actor id instead of `request.actorId!`          | `sharingRoutes.test.ts`'s "always acts as the authenticated session's own actor..."                                         | Failed, naming the row explicitly: `ownership transfer: expected 'member-1' to be 'session-actor'`.                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | UI guard `canMakeOwner={scope.kind === 'project' && viewerIsOwner}` replaced with `canMakeOwner={true}` | `sharingDialog.test.tsx`'s "never offers Make owner at screenplay scope, even if a caller passed viewerIsOwner"             | Failed: the button rendered where it must not.                                                                                                                                                                                                                                                                                                                                                                                                                             |

Eight mutations, each killed by name, each restored and reverified. Mutations 1-3 and 7-8 are the
authorization-bearing guards the brief specifically asked to be exercised this way.

## Gate results

Isolated Postgres on port **55472** (not 5432, the owner's own development database), started with
`docker run -d --name transfer-test-pg -e POSTGRES_PASSWORD=postgres -p 55472:5432 postgres:16` and
removed afterward.

| Gate                                                              | Result                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                       | exit 0, no output                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm typecheck`                                                  | exit 0 -- every package, `apps/web`, `apps/api`, `apps/collab`, `apps/landing` (astro check: 0 errors)                                                                                                                                                                                                                                                                                    |
| `pnpm test` (no `TEST_DATABASE_URL`, CI-style)                    | exit 0 -- every package green; `apps/api` 356 passed / 115 skipped, `apps/web` 1212 passed, `apps/collab` 181 passed / 32 skipped                                                                                                                                                                                                                                                         |
| `pnpm test:integration` (`TEST_DATABASE_URL` set)                 | exit 0 -- `packages/database` 12/12, `apps/api` 115/115 (including `sharing.integration.test.ts` 27/27, 9 of them new), `apps/collab` 32/32                                                                                                                                                                                                                                               |
| `pnpm test:coverage` (no `TEST_DATABASE_URL`, CI-style)           | exit 0. `apps/api/src/sharing.ts`: 96.08% statements / 89.28% branch / 94.11% functions -- every uncovered line is pre-existing (none inside `transferOwnership`, checked by reading the exact line ranges). `apps/web/src/sharingDialog.tsx`: 97.86% statements / 87.91% branch / 90.9% functions. Both clear the 80% bar for the new functionality specifically, not only in aggregate. |
| `pnpm build`                                                      | exit 0 -- every package, including `apps/web`'s production bundle and `apps/landing`'s static build                                                                                                                                                                                                                                                                                       |
| `pnpm test:system` (`PLAYWRIGHT_CHANNEL=chrome`, default workers) | 108/109, 1 flake -- see below                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm format:check`                                               | run bare, last; see below                                                                                                                                                                                                                                                                                                                                                                 |

### `test:system`'s one failure is a pre-existing, unrelated flake

Two consecutive runs at the default worker count (5) each failed exactly one test, and it was a
**different** test each time (`header-contrast.spec.ts` on the landing page the first run,
`app-bar-logo.spec.ts` on the web app the second) -- neither anywhere near this slice's own files.
Both failures carried the identical signature:

```
Test timeout of 30000ms exceeded while setting up "context".
Error: browser.newContext: Test ended.
[pid=...][err] ...ERROR: Failed parsing extensions
<launching> /Applications/Google Chrome.app/...
```

That is a real, locally-installed Chrome failing to launch a new browser context under five
concurrent Playwright workers on this machine, not a test assertion failing. Confirmed two ways:

1. Each failing spec passes on its own when re-run in isolation (`header-contrast.spec.ts`: 4/4).
2. A full run at `--workers=2` instead of the default passes all **109/109** cleanly.

This matches the "Flaky browser suite" pattern already on record: environmental flakiness that
reproduces on `main` too and should be measured, not attributed to whichever branch happens to be
checked out. Nothing in this slice touches the landing page or the app shell/logo, and no sharing- or
ownership-related spec exists in the Playwright suite at all (the feature is covered by Vitest
component tests in `sharingDialog.test.tsx` instead, matching how `invite`/`changeMemberRole`/
`removeMember` are covered -- there is no existing Playwright coverage of the sharing dialog to
extend).

### `pnpm format:check`, bare and last

Run bare, not piped through anything -- the lead's own warning that `tail` has previously hidden a
nonzero exit here. The first run caught two real violations: `apps/api/src/sharing.test.ts` (this
slice's own new test) and this progress doc itself, both exit code **1**. Fixed with
`prettier --write` on exactly those two files, the affected test file re-run to confirm the
reformat changed no behaviour (47/47 still passing), and `format:check` run again, bare, as the
actual last command before this report was finished:

```
$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!
```

Exit code: **0**.

## What could not be verified

Nothing load-bearing. The one gap worth naming plainly: `pnpm test:system` was not run with real
persistence (`DATABASE_URL` pointed at a migrated database) end to end through a signed-in browser
session reaching the new route, because the plain `test:system` config (as opposed to
`test:system:persistence`) runs `apps/api` without `DATABASE_URL` set at all -- every non-persistence
spec in `apps/web/e2e` is deliberately static/offline (visual, geometry, contrast), and none of them
signs in or touches `/api/projects/*`. The server-side behavior is instead proven against a real,
migrated Postgres database by `sharing.integration.test.ts`, including the two-client forced-
interleaving concurrency test; the client-side behavior is proven by `sharingDialog.test.tsx` and
`routes/projects/index.sharing.test.tsx` against a mocked API. No Playwright spec for the sharing
dialog exists on `main` to extend, and adding one was outside this slice's scope (the brief asked for
"minimal UI," and the feature's own existing siblings -- invite, change role, remove -- have no
Playwright coverage either).

## Lead verification, run independently

| Check                                          | Result                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| `pnpm lint`                                    | exit 0                                             |
| `pnpm typecheck`                               | exit 0                                             |
| `pnpm test` (CI-style, no `TEST_DATABASE_URL`) | exit 0 -- `apps/api` 19 files, `apps/web` 78 files |
| `pnpm test:integration`                        | exit 0, against isolated Postgres on 55472         |
| `pnpm test:coverage`                           | exit 0 -- `sharing.ts` 96.08 / 89.28 / 94.11       |
| `pnpm build`                                   | exit 0                                             |
| `pnpm format:check`                            | exit 0, bare and last                              |

Two mutations re-run by the lead rather than taken on report:

| Mutation                                                       | Result                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Allow an `editor` to transfer ownership (privilege escalation) | failed "refuses an editor with forbidden, which does admit the project exists"   |
| Reverse the write order to promote-before-demote               | failed the integration test against the real `project_single_owner_unique` index |

The second is the one worth noting: it is caught by Postgres itself, not by a hand-written expectation
about ordering, so the test cannot drift from what the database actually enforces.

The concurrency test was checked for vacuity and is sound -- it forces the interleaving by polling
`pg_locks` for an **ungranted** advisory entry, rather than racing `Promise.all` and hoping, or
sleeping. That is the same technique `restore.integration.test.ts` uses, and it means the test either
reproduces the contention every run or never.

### The `test:system` failure is Chrome, not this change

The suite reported 108/109 at default worker count. Investigated rather than waved off as the known
contention flake, because the usual signature is _a different spec each run_:

```
Error: browserContext.newPage: Test timeout of 30000ms exceeded.
[err] ERROR:net/cert/internal/trust_store_mac.cc:764] Error parsing certificate:
```

That is Chrome failing to open a page at all, with a macOS keychain certificate-parsing stall during
browser startup -- not an application assertion. Measured: the spec fails **2 of 3 runs in
isolation** on this machine right now, while the full suite passes **109/109 at `--workers=2`**. So
it is not load contention in the usual sense either; it is Chrome startup being slow on this host,
and fewer concurrent contexts simply avoid it.

Worth recording for whoever reads this next: `app-bar-logo.spec.ts` measured 27/27 in isolation
earlier in this project's history, so this is an environmental change on the host rather than a
property of the spec. It is unrelated to ownership transfer, which touches `sharing.ts`, the API
route, the sharing dialog and the projects route -- none of which the brand-hover spec exercises.

### Still not verified, carried forward from the implementing agent's own report

No end-to-end browser coverage of the new route through a signed-in session. The plain `test:system`
config runs the API without a database at all, only `test:system:persistence` provisions one, and
sharing has no existing Playwright coverage to extend. So the route is covered by unit and
integration tests and by the dialog's own component tests, but never driven through a real browser
against a real database. Stated rather than glossed: that is a genuine gap, and the honest place to
close it is a persistence-suite spec for the whole sharing surface, which is larger than this slice.
