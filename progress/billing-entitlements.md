# Server-side entitlement enforcement

Branch `feature/billing-entitlements`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/entitlements`, off `feature/billing-webhook`.

## Why this scope exists

`plan.md`'s "The free tier" and "What happens when a subscription lapses" (as given for this
slice -- see "A note on plan.md" below) define the rules: the free tier is one editable
screenplay; collaboration is not a paid feature and a shared screenplay occupies that same slot;
a lapsed account keeps reading, exporting, and one chosen editable screenplay, and must be asked
which one when it has several; export always works, on every tier and in every state; and
switching the editable slot is cooldown-limited, not quota-limited. Slice 1
(`progress/billing-webhook.md`) built the trust boundary up to a queryable `subscriptions`
projection. This slice builds the authorization layer on top of it: the policy itself, the schema
it needs, enforcement wired into every screenplay-content write, and the read/write API surface a
later UI needs. It deliberately does not build Checkout Sessions, the Customer Portal, pricing or
billing UI, or any React component -- slice 3's job.

### A note on plan.md

The task brief for this slice states `plan.md`'s "The free tier" and "What happens when a
subscription lapses" sections were rewritten on 2026-09-01 and are the current specification. I
checked: `git log -1 -- plan.md` shows the file's last change is `6f0b26c`, dated 2026-08-23, on
every branch I can see (`main`, `origin/main`, `origin/feature/billing-webhook`) -- there is no
2026-09-01 rewrite on disk anywhere I could find. The two sections as they actually read on disk
are shorter and looser than the rules stated in the task brief (they don't mention collaboration
occupying the slot, the "must ask, never guess" lapse rule, or the cooldown at all). I built this
slice against the detailed rules given directly in the task brief, since those are unambiguous and
internally consistent, and they are a strict superset of what's on disk -- nothing in the brief
contradicts the file. But the file itself was not updated as part of this work, and someone should
either commit the described rewrite or correct the instruction that it already happened.

## What shipped

**1. Schema** (`packages/database/src/schema.ts`,
`packages/database/drizzle/0005_whole_toxin.sql`, generated with `pnpm --filter
@finaler-draft/database db:generate` against a real database, not hand-written): one new table,
`editable_slots` -- `user_id` (primary key, `references user.id on delete cascade`),
`screenplay_id` (`references screenplays.id on delete cascade`), `updated_at`. One row per user,
naming the screenplay currently occupying that account's single editable slot and when that choice
was last made. Verified idempotent the same way slice 1's migration was: running `db:generate`
again reports "No schema changes, nothing to migrate."

**2. The policy** (`apps/api/src/entitlements.ts`) -- pure, no database handle, no clock read
inside it. `checkEntitlement(snapshot, action)` is the single function every entitlement decision
in this slice passes through; see "The policy function" below for why it's one function and its
exact shape.

**3. The entitlement store** (`apps/api/src/entitlementStore.ts`) -- Postgres-backed reads and
writes: `getSnapshot` (subscription status, the actor's owner/editor candidate screenplay ids, and
the slot row, if any), `claimEmptySlot` (unconditional, for establishing a first choice), and
`switchEditableScreenplay` (the cooldown-checked, candidate-validated, idempotent user-facing
action).

**4. Enforcement, wired into the authorization path** (`apps/api/src/entitlementProjectStore.ts`)
-- a decorator, `createEntitlementEnforcedProjectStore`, wrapping the existing `ProjectStore`.
Composed in `server.ts` around `createPostgresProjectStore(pool)` before it is ever handed to
`buildApp`, so every route that writes to a screenplay goes through it regardless of which routes
exist. See "How enforcement is wired in" below for why a decorator, not an edit to
`createPostgresProjectStore`'s own methods.

**5. The API surface** (`apps/api/src/app.ts`, `apps/api/src/server.ts`) -- `GET /api/entitlement`
(current tier, editable screenplay id if any, the candidate list a restricted account would need to
choose among, the slot's last-changed timestamp, and the cooldown deadline derived from it) and
`PUT /api/entitlement/editable-screenplay` (the user-facing "make this my editable screenplay"
action). Both sit behind the same authenticated-actor, same-origin `preValidation` hook the
existing project/screenplay routes already share.

## The policy function

```ts
export function checkEntitlement(
  snapshot: EntitlementSnapshot,
  action: EntitlementAction,
): EntitlementDecision;
```

`EntitlementSnapshot` is plain data: `subscriptionStatus` (`SubscriptionStatus | undefined` --
`undefined` is a missing row, i.e. free, not an error, matching slice 1's
`getSubscriptionForUser`), `candidateScreenplayIds` (every screenplay this actor holds an
owner/editor role on, live, non-deleted -- the exact universe the slot is drawn from; a reviewer
role is never a candidate, since a reviewer cannot write regardless of billing state), `slot` (the
explicit choice on record, or `null`), and `now`. `EntitlementAction` is a discriminated union of
the three things this slice needs a decision about: `'create-screenplay'`, `'edit-screenplay'`
(with a target id), and `'switch-slot'` (with a target id).

It is one function, not three, for two reasons stated directly in the task: entitlement must be
"evaluated in the same layer as project and screenplay authorization" -- one function is one place
that layer's rules live, rather than three call sites that could drift out of sync (a
`create-screenplay` check and an `edit-screenplay` check disagreeing about what counts as a
candidate would be a real bug class) -- and the switch-slot cooldown specifically needed to be
isolated to one function and one constant (`EDITABLE_SLOT_COOLDOWN_MS`, currently 24 hours) so that
changing the interval to 72 hours is a one-line edit, not a hunt across call sites.

A paid subscription (`active` or `trialing`) short-circuits every action to `{ allowed: true }`
before any slot logic runs. Otherwise: `create-screenplay` is allowed only when
`candidateScreenplayIds` is empty; `edit-screenplay` resolves the currently-editable screenplay
(explicit slot if it still names a live candidate, otherwise the sole candidate if there is
exactly one, otherwise `null`) and allows only a match; `switch-slot` allows unconditionally when
there is no prior slot (establishing a first choice is not a switch) and otherwise requires the
cooldown to have elapsed -- deliberately not validating that the target is a real candidate, since
that is a membership question every caller resolves before reaching this policy, the same way
every other authorization check in this codebase resolves membership ahead of the decision it
gates.

`resolveEditableScreenplayId` is exported alongside `checkEntitlement` because the read-side API
needs the identical resolution without asking about one specific screenplay id.

## How enforcement is wired in

`createEntitlementEnforcedProjectStore(base, entitlements, now)` wraps a `ProjectStore` and
overrides exactly two of its methods:

- **`createScreenplay`**: computes the actor's snapshot, asks `checkEntitlement` for
  `create-screenplay`, and throws a new `EntitlementLimitError` _before ever calling `base`_ if
  denied. On success, if the account is restricted, the newly created screenplay unconditionally
  claims the (necessarily empty) slot via `claimEmptySlot` -- an establishment, not a switch, so it
  does not touch the cooldown.
- **`updateScreenplay`**: only intervenes when the target is a live candidate for this actor. If it
  is and `checkEntitlement`'s `edit-screenplay` decision denies it, returns the store's own
  existing `'forbidden'` literal. If the target is _not_ a candidate at all -- not a member, or a
  reviewer -- the call passes straight through to `base` untouched, so a non-member's or a
  reviewer's request gets exactly the `'missing'`/`'forbidden'` response it always has. This guard
  is load-bearing, not decorative: see mutation 4 below.

Every other `ProjectStore` method (listing, renaming, deleting, restoring, reading) is spread
through unmodified -- both in behaviour and in the exact SQL `projects.test.ts`'s existing
query-sequence assertions check. This was a deliberate choice over editing
`createPostgresProjectStore`'s own methods directly: the task's rules restrict "creating new
screenplays beyond that one, and editing the others," not the library-management operations around
them, so a screenplay outside the slot can still be renamed, deleted, or restored by an
owner/editor; it just cannot be written to. A decorator composed at `server.ts`'s wiring point
satisfies "wired into the existing authorization path" without touching a single line, or a single
existing test, inside `projects.ts` itself -- confirmed: `apps/api/src/projects.ts` and
`apps/api/src/projects.test.ts` are unchanged in this diff, and all 13 of that file's tests, and
all 123 of the api package's pre-existing tests, pass unmodified throughout this work.

**A known, accepted race**: `createScreenplay`'s check-then-create-then-claim is not one atomic
transaction (the decorator calls `base.createScreenplay`, which opens its own connection). Two
concurrent creation requests from the same free account could both observe zero candidates and
both succeed, producing two screenplay rows before either `claimEmptySlot` call lands. This does
not defeat the entitlement: the slot table still ends up naming exactly one of the two (the last
upsert wins), so the other screenplay exists but is immediately unwritable via `updateScreenplay`
-- the actual protected resource (extra _editable_ capacity) is not gained, only an extra inert
row. I judged closing this fully (a per-user advisory lock spanning both the check and the base
store's own transaction) out of proportion for this slice; flagging it rather than silently
accepting it.

## Tests

**Unit** (`apps/api/src/entitlements.test.ts`, 25 tests): every state the task asked for --
free with none, free with one, free with a share beyond the slot, active subscription, lapsed with
one screenplay, lapsed with several and no choice made, lapsed after choosing, the cooldown inside
and outside its window (plus at the exact boundary, and confirming a newly shared screenplay gets
no exception) -- run directly against `checkEntitlement` and `resolveEditableScreenplayId` as plain
data, no fixtures.

**Unit** (`apps/api/src/entitlementProjectStore.test.ts`, 12 tests): the decorator against mocked
`ProjectStore`/`EntitlementStore` dependencies -- every mocked method throws unless a test
overrides it, so an unexercised call fails loudly rather than returning `undefined` silently.
Covers create-limit refusal without reaching the base store, edit refusal for out-of-slot and
no-choice-made states, the non-candidate passthrough (the information-hiding guard), and confirms
untouched methods never even call `getSnapshot`.

**Route unit** (`apps/api/src/app.test.ts`, 8 new tests in a new `entitlement API` describe block):
authentication is required; `GET /api/entitlement` reports each tier/state shape correctly
including the derived `cooldownEndsAt`; `PUT /api/entitlement/editable-screenplay` reports success,
404 for a non-candidate (not 403, so existence isn't leaked), and 409 for the cooldown.

**Integration** (`apps/api/src/entitlements.integration.test.ts`, 9 tests, real PostgreSQL,
following `persistence.integration.test.ts`'s and `stripeSubscriptions.integration.test.ts`'s
throwaway-database-per-run pattern, skips without `TEST_DATABASE_URL`): the schema shape; free-tier
first creation auto-claiming the slot; a second creation being refused and leaving no orphaned
screenplay in the target project; a shared screenplay staying readable but not writable beyond the
slot; a lapsed account with several screenplays and no choice being unable to edit or create
anything; choosing after a lapse; the cooldown blocking an immediate second switch and allowing one
24+ hours later; switching to a non-candidate being refused as not-found; and an active subscription
lifting every restriction. Added to `apps/api/package.json`'s `test:integration` script so it's not
a test that only ran once by hand.

**The negative tests are the point**, per the task's instruction, and they are what's listed above:
a second free-tier screenplay is proven refused (and proven to leave no row behind), a
beyond-the-slot screenplay is proven refused-but-readable, and a no-choice-made lapsed account is
proven unable to edit _any_ of its screenplays, not just asserted permitted where expected.

## Mutation testing

Every mutation below was applied, confirmed to fail the specific test(s) it should, then reverted
and reconfirmed green (`entitlementProjectStore.test.ts`, `entitlements.test.ts`, and, where noted,
`entitlements.integration.test.ts` against the real database). `grep -rn MUTATION
apps/api/src/*.ts` after the final revert returns nothing.

1. **The entitlement check removed entirely from the write path** (`entitlementProjectStore.ts`'s
   `createScreenplay` and `updateScreenplay` both reduced to a bare passthrough to `base`). **This
   is the one that matters most.** Failed 6 of 12 `entitlementProjectStore.test.ts` tests -- every
   test asserting a refusal, none asserting a success -- and, confirmed independently against a
   real database, 5 of 9 `entitlements.integration.test.ts` tests, including "a second screenplay
   cannot be created" and "a lapsed account with no choice made cannot edit anything." Restored;
   both suites green (12/12, 9/9).
2. **The free-tier creation limit disabled** (`checkEntitlement`'s `create-screenplay` branch
   hardcoded to `{ allowed: true }`). Failed exactly the 3 `entitlements.test.ts` tests asserting a
   `free-tier-limit` refusal (free-with-one, free-with-a-share, lapsed-with-several) plus the 2
   `entitlementProjectStore.test.ts` tests that depend on it; every other test in both files (32 of
   37 combined) stayed green. Restored; both green.
3. **The switch-slot cooldown disabled** (the time comparison removed, always `{ allowed: true }`).
   Failed exactly the 2 cooldown-window tests in `entitlements.test.ts` ("inside the cooldown
   window" and "a newly shared screenplay gets no exception"); the boundary test, the
   outside-the-window test, the establishing-a-first-choice test, and the paid-tier test all stayed
   green. Confirmed independently against the real database: `entitlements.integration.test.ts`'s
   "switching the slot is refused inside the cooldown window" failed with `expected 'applied' to be
'cooldown'`; the other 8 integration tests stayed green. Restored; both suites green.
4. **The information-hiding guard removed** (`updateScreenplay`'s `if
(snapshot.candidateScreenplayIds.includes(screenplayId))` check deleted, so entitlement is
   evaluated for every target regardless of whether the actor is even a candidate for it). Failed
   exactly "a non-candidate target is left entirely to the base store, never turned into a billing
   decision" (`expected 'forbidden' to be 'missing'`) -- the specific test that exists to catch a
   non-member's or reviewer's request being turned into a billing-shaped denial instead of the
   existing membership-shaped one, which would have been a real information leak (403 instead of
   404 tells an outsider the resource exists). Every other test stayed green. Restored; 12/12
   green.
5. **The switch-slot candidate check removed from the database layer**
   (`entitlementStore.ts`'s `switchEditableScreenplay` no longer rejecting a target outside
   `candidateScreenplayIds`). Confirmed against the real database: failed "switching to a
   screenplay outside the candidate set is refused" -- the mutation did not silently succeed
   (`'applied'`) in this specific test's arrangement because the actor already held a very recent
   slot from an earlier step in the same test, so the un-validated target fell through to the
   cooldown check instead and was refused for the wrong reason (`expected 'cooldown' to be
'not-a-candidate'`) -- still a specific, correct failure, and worth recording that the _general_
   risk this check exists to prevent is a full bypass (`'applied'` for an unauthorized target), not
   only the reason-code mismatch this particular test happened to surface. Restored; 9/9 green.
6. **The explicit-slot preference removed from `resolveEditableScreenplayId`** (always falling back
   to the single-candidate rule, ignoring a recorded `slot` even when it still names a live
   candidate). Failed exactly the 3 tests that depend on an explicit choice overriding the
   fallback: the two `edit-screenplay` "beyond the slot"/"lapsed after choosing" tests in
   `entitlements.test.ts`, and `resolveEditableScreenplayId`'s own "returns the explicit slot"
   test. Restored; 25/25 green in `entitlements.test.ts`.

After every mutation was reverted, `grep -rn MUTATION apps/api/src/*.ts` and `git diff --stat` were
checked to confirm the working tree matched the intended change set exactly.

## Every gate, verbatim

```
pnpm lint
```

Clean, no output, exit 0.

```
pnpm format:check
```

`All matched files use Prettier code style!`

```
pnpm typecheck
```

Clean across every package (including `database`, rebuilt with the new `editable_slots` table) and
both apps (`web`, `api`).

```
pnpm test
```

`apps/api`: 11 test files passed, 3 skipped (the three `*.integration.test.ts` files, expected
without `TEST_DATABASE_URL`) -- **168 tests passed**, 40 skipped (123 pre-existing + 45 new: 25 in
`entitlements.test.ts`, 12 in `entitlementProjectStore.test.ts`, 8 new in `app.test.ts`).
`apps/web`: 37 files, **562 tests passed**, matching the stated baseline exactly (this slice
touches no web code). Every other package unchanged and green (`config` 1, `server-config` 17,
`screenplay` 118, `database` 4, `xml-escape` 9, `fdx` 45, `docx` 58, `layout` 72, `pdf` 61).

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm --filter @finaler-draft/api test:integration
```

**40 tests passed** (20 pre-existing persistence + 11 pre-existing Stripe subscription + 9 new
entitlement), 0 failed.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm test:system:persistence
```

**18 passed**, matching the stated baseline exactly. The new `0005_whole_toxin.sql` migration
applied cleanly against the real database as part of this run.

## Credential audit

No credential appears anywhere in this diff -- this slice adds no Stripe API calls, no new
environment variables, and no secrets; every value handled is an application-level id (user,
project, screenplay) or a database connection sourced exactly the way the task specified,
`DATABASE_URL="$(grep ... | cut ...)" pnpm ...`, never printed and never appearing in a visible
command string. `.env` was never read into this conversation's output. No `git add`, `git commit`,
`git push`, or `gh pr create` was run.

## Known limitations / decisions for a later slice to pick up

- **The `create-screenplay`/claim-slot race described above** is accepted, not fully closed --
  see "How enforcement is wired in."
- **Rename, delete, and restore are not entitlement-gated**, by design (see "How enforcement is
  wired in" for the reasoning from the task's own wording), but this is an interpretation of scope
  worth the owner's explicit confirmation, since "every write to a screenplay" could be read more
  broadly than "every content edit."
- **plan.md itself was not updated** -- see "A note on plan.md" above. The rules this slice
  implements are the ones given directly in the task brief, which are more detailed than and a
  strict superset of what's currently on disk in `plan.md`, but the file and the brief now
  disagree about whether a rewrite already happened.
- **No UI consumes the new API surface** -- `GET /api/entitlement` and `PUT
/api/entitlement/editable-screenplay` exist and are tested at the route level, but nothing in
  `apps/web` calls them yet, matching this slice's explicit scope boundary.
