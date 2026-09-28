# Collaboration: connection tokens (inserted before slice 3)

Branch `feature/collab-connection-tokens`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/collab-tokens`, off `826f4f1`.

## Why this exists

The first real deployment proved the design `progress/collaboration-slice-1.md` shipped cannot
work once `app` and `collab` are two different Railway hosts. Every handshake was rejected with
`Authentication required` (`transient: false`): the origin guard passed, so this was not
`CLIENT_ORIGIN` or a missing variable. The cause is the Better Auth session cookie itself --
`httpOnly`, `sameSite: 'lax'`, `secure`, host-only (no `Domain`, no `crossSubDomainCookies`) -- which
is by design never sent to a different host. A `Domain` attribute cannot fix this (`up.railway.app`
is a public suffix browsers refuse to widen a cookie's scope to), and `SameSite=Lax` blocks it
independently of `Domain` anyway. It worked in every test and in local `pnpm dev` only because
`localhost:5173`/`localhost:4400` (or the two loopback ports the system-test harness uses) differ by
port, and cookie scope ignores ports -- so nothing before a real two-host deployment could have
caught this.

**Note on the brief's own pointer, and its resolution.** The brief that started this slice pointed
at a section of `progress/collaboration-plan.md` titled "Inserted slice -- connection tokens (placed
before slice 3)", and that section was genuinely absent from this worktree and from the whole of git
history -- correctly caught and reported rather than guessed around, with the work proceeding on the
brief's own (self-contained) contents.

The cause was on the dispatching side, and is recorded here so the discrepancy does not read as a
mystery later: that plan section had been written into the _main checkout's working tree_ and left
uncommitted, while this worktree was branched from `origin/main`. Uncommitted work in one working
tree is invisible to every other one. It resolves as soon as that plan edit is committed; nothing in
this branch touches `collaboration-plan.md`, so the two merge without conflict. The lesson worth
keeping: a brief may only cite committed, pushed state, or the reference it points at does not
exist for whoever receives it.

## What was built

### `packages/collab-token` -- the token itself

A new, minimal, dependency-light package (`jose` 6.2.8 only -- already resolved in the pnpm store as
a transitive dependency of `better-auth`, so no new network fetch was needed to add it as a direct
dependency here).

- **`mintConnectionToken(secret, actorId, now)`** -- signs an HS256 JWT: `sub` (the actor's user
  id), a fixed `purpose: 'collab-connect'` claim, `iat`/`exp` computed from the given `now` (not the
  real clock, so minting is deterministic and testable). `now` and `exp` are both passed as `Date`
  objects to `jose`'s `SignJWT`, which (confirmed by reading the installed source,
  `jwt_claims_set.js`) converts a `Date` to an absolute epoch-second claim via its own `getTime()`,
  never relative to real wall-clock time -- this is what makes minting an already-expired token in a
  test a matter of passing a past `Date`, not waiting on a real clock.
- **`verifyConnectionToken(secret, token, now)`** -- verifies signature and claims as of `now`
  (`jose`'s `jwtVerify`'s own `currentDate` option, confirmed to fully substitute for
  `Date.now()` by reading `validateClaimsSet`'s source), and returns one of exactly three outcomes:
  `{ outcome: 'valid', actorId }`, `{ outcome: 'expired' }`, or `{ outcome: 'invalid' }`. `'expired'`
  is split out deliberately -- see "Design decisions" below for why this is the single most
  important shape in this slice. Every other rejection (wrong secret, malformed, empty/absent
  string, right secret but the wrong `purpose`, no `sub`) collapses into `'invalid'`.

### Design decisions, each justified

**Token form: a signed JWT (HS256), not an opaque server-stored token.** An opaque token needs a
database table, a write on every mint, a read on every connect (on top of the role/entitlement
queries `resolveConnectionAuthorization` already runs), and a cleanup job for tokens that expire
unused. A self-contained signed token needs none of that -- verification is a pure, stateless
computation, and `apps/api`/`apps/collab` already have the exact relationship needed to agree on a
shared secret (`BETTER_AUTH_SECRET` already works this way between them). The one property an opaque
token buys -- revoking one specific token before it expires -- is not needed here: the token's own
five-minute lifetime already bounds a leak's value, and revoking a _session_ (sign-out) is Better
Auth's own database-backed mechanism, untouched by any of this.

**It is scoped to collaboration and cannot be used as a session credential.** Better Auth's session
lookup (`auth.api.getSession`) is entirely database-backed: it reads whatever value arrives as the
session cookie and looks it up against the `session` table. A connection token is a JWT that was
never written to that table under any value, so presenting it as a session cookie's value -- even
under the session cookie's own real name -- can never match a row. This is proven directly, not
just argued, by `apps/api/src/persistence.integration.test.ts`'s new test (below).

**Lifetime: five minutes (`CONNECTION_TOKEN_TTL_MS`).** Long enough that an ordinary mint-then-
connect round trip (one HTTP request to `apps/api`, then the WebSocket handshake to `apps/collab`,
both on Railway's internal network) never races its own expiry even under real latency or a moment
of clock skew between the two service containers. Short enough that a token captured from a
browser's network panel, a proxy access log, or a crash dump is worthless within minutes. It is
deliberately not sized around a whole editing session: `@hocuspocus/provider` 4.6.0's own
`getToken()`/`sendToken()` (confirmed by reading the installed source: `sendToken()` calls
`getToken()`, which awaits `configuration.token` when it is a function, and `sendToken()` itself
runs on every `onOpen`) means every reconnection fetches a fresh token automatically when `token` is
configured as an async function rather than a plain string -- which is exactly how `App.tsx` now
configures it. The token's lifetime only has to survive one handshake, never a whole session.

**What it asserts: identity only, never role or entitlement.** The signed payload carries `sub`
(the actor id) and `purpose`; nothing else. This is the property the brief calls the single most
important one in this slice, and it is enforced structurally, not just by convention: there is no
code path anywhere that reads a role or entitlement claim off a token, because no such claim is ever
minted. `apps/collab/src/authenticate.ts`'s `resolveConnectionAuthorization` is completely unchanged
in this slice -- it still resolves role (`fetchRole`) and, for an owner/editor, entitlement
(`checkEntitlement` via `fetchEntitlementSnapshot`) from Postgres, at connection time, exactly as it
did when the actor was identified from a session cookie instead of a token. Swapping the identity
mechanism underneath it changed nothing about how authorization is decided -- which is exactly the
seam this slice's design is built around: `authenticateConnection` composes "who is this" (now the
token) and "what may they do" (still the database) as two independent steps, and only the first one
changed.

**Where minting lives, and what authorizes it.** `POST /api/collab/connection-token`
(`apps/api/src/app.ts`), inside the same `preValidation` hook that already guards `/api/projects`,
`/api/entitlement`, and `/api/billing` -- so minting requires the identical authenticated-actor and
trusted-origin checks every other protected route already enforces. The browser's still-valid
Better Auth session cookie against `app`'s own origin (same-origin, so it is attached automatically)
is what authorizes minting; the route reads `request.actorId` (set by that hook after a real
`auth.api.getSession` lookup) and mints a token for exactly that actor, never a client-supplied id.
`apps/collab` is never involved in minting at all.

### The expired-token risk (#1 in the brief), and how it is closed

Slice 2's reconnection logic (`App.tsx`) already treats a `TRANSIENT_SYNC_AUTH_FAILURE_REASON`
`authenticationFailed` as "disconnect and retry with backoff" and everything else as a terminal
`'denied'` state with no retry. An expired token landing in the terminal bucket would mean a
reconnecting tab gives up forever the moment its token ages past five minutes.

The fix has two halves:

1. **Server-side classification.** `apps/collab/src/authenticate.ts` gained
   `ExpiredConnectionTokenError`, a class distinct from the pre-existing
   `TransientAuthenticationError` (which stays reserved for exactly what it always meant: an
   _unexpected_ failure, like a database blip, during token verification or the role/entitlement
   lookup -- never repurposed). `ExpiredConnectionTokenError` carries the identical
   `reason = TRANSIENT_SYNC_AUTH_FAILURE_REASON` client-visible property, so `App.tsx`'s existing
   retry logic -- unmodified -- already treats it as "retry," because that is the one thing it
   actually reads. `authenticateConnection` throws this specific class only when
   `verifyToken` resolves `{ outcome: 'expired' }`; every other invalid-token case (`'invalid'`,
   which covers a bad signature, a malformed token, and an absent one) still throws the plain
   `Error('Authentication required')`, preserving that message's existing meaning exactly.
2. **Client-side refresh.** `App.tsx`'s `HocuspocusProvider` is now constructed with
   `token: async () => (await api.connectionToken()).token` -- a function, not a string. Because
   `getToken()` re-invokes this function on every `sendToken()` call, and `sendToken()` runs on
   every `onOpen`, the existing disconnect-then-reconnect dance the transient-retry effect already
   performs on any `TRANSIENT_SYNC_AUTH_FAILURE_REASON` failure automatically fetches a brand-new
   token from `apps/api`'s real endpoint before the retried handshake completes. No new client-side
   code was needed for the refresh itself -- the mechanism `@hocuspocus/provider` already offers,
   combined with the reason tag `ExpiredConnectionTokenError` carries, was sufficient.

**The test that proves it**, over a real socket against a real database (not a stub):
`apps/collab/src/collaboration.integration.test.ts`'s new
`'reconnects and syncs once its token has expired, rather than terminating'`. It configures
`HocuspocusProvider`'s `token` as a stateful function returning an already-expired token (minted
with `now` set an hour in the past -- deterministic, not a timing race) on the first call, and a
real, currently-valid token on every call after; drives the existing transient-retry helper
(`waitForSyncedAfterTransientRetry`, unmodified since slice 2); and asserts both that the connection
ultimately reaches `synced` and that the token function was actually called at least twice (proving
the sync came from the refresh, not a lucky first attempt). Passes, verified against a real Postgres
database: see the Gates section.

### Role and entitlement stayed server-side -- verified, not just designed that way

Two separate, independent proofs, per the brief's own emphasis that this is the property that
matters most:

1. **Unit level** (`apps/api/src/app.test.ts`): the minted token is decoded directly (its base64url
   payload segment, parsed as JSON) and asserted to carry no `role`, `entitlement`, or `readOnly`
   property at all -- not merely that the _server_ ignores such a claim, but that no such claim ever
   exists to ignore.
2. **Integration level, over a real socket** (`apps/collab/src/collaboration.integration.test.ts`,
   new test `'a token minted for one actor cannot be used to reach a document only another actor
may see'`): actor A signs up for a real account and mints a real, honestly-signed, currently-valid
   token identifying A. Actor B (not A) owns a screenplay; A is never added as a project member. A's
   real token is used to try to connect to B's document. The connection never syncs, and the
   `authenticationFailed` reason is not the transient one -- proving the denial can only have come
   from `resolveConnectionAuthorization`'s own database-backed role lookup finding no row for A on
   this document, since A's _identity_ was never in question (the token verified as valid).

## Mutation testing -- the two properties named explicitly in the brief

Both run against a snapshot-backed copy of the real file, executed, observed to fail the intended
tests, then reverted and reconfirmed byte-identical to the pre-mutation file (`diff`, not assumed).

**Mutation 1 -- make `verifyConnectionToken` accept an expired token.** In
`packages/collab-token/src/index.ts`, the `catch` branch for `errors.JWTExpired` was changed to
return `{ outcome: 'valid', actorId: error.payload.sub }` instead of `{ outcome: 'expired' }` (jose's
own `JWTExpired` error carries the unverified claims set as `.payload`, confirmed by reading the
installed source, which is what makes this a realistic mutation rather than a contrived one).
Re-run against **the suite that actually proves this property**, `packages/collab-token`'s own
`index.test.ts`: 1 of 9 tests failed --
`'reports an expired token as its own distinct outcome, not folded into "invalid"'` -- with every
other test (including the "accepts a token right up to the instant before it expires" boundary case)
still green, exactly the targeted failure this mutation should produce. Reverted; `diff` confirmed
identical to the original; re-run confirmed 9/9 green again.

**Mutation 2 -- make `resolveConnectionAuthorization` trust a role without querying the database.**
In `apps/collab/src/authenticate.ts`, `const role = await fetchRole(queryable, documentName,
actorId);` was replaced with a hardcoded `const role: 'owner' | 'editor' | 'reviewer' | undefined =
'owner';`, bypassing the database query entirely -- the direct analogue of "trust a role claim
instead of resolving it from the database," since this token design carries no role claim at all;
the only way to simulate that attack is to stop checking the database. Re-run against **the suite
that proves this property** at two levels:

- `apps/collab/src/authenticate.test.ts` (the fast, direct proof): 3 of 16 tests failed --
  `'rejects a connection for an actor with no role on the document at all'` (now wrongly allowed),
  `'allows a reviewer to write nothing even on a paid account'` (now wrongly writable, since every
  actor resolves to `'owner'`), and `authenticateConnection`'s
  `'rejects a connection to a document this actor has no role on...'` (now wrongly resolved instead
  of rejecting) -- while the other 13, including every entitlement-branch test unrelated to role
  resolution itself, stayed green.
- `apps/collab/src/collaboration.integration.test.ts`, against the real, running server and a real
  Postgres database (stronger confirmation, not required but run anyway since the database was
  already available): 2 of 14 tests failed -- the pre-existing `'a genuine denial reaches a distinct
terminal state...'` test and this slice's own new `'a token minted for one actor cannot be used to
reach a document only another actor may see'` test, both for the identical reason (a connection
  that must never sync, synced).

Reverted; `diff` confirmed identical to the original; both suites re-run and reconfirmed fully green
(16/16 and 14/14 respectively).

## Local development

`pnpm dev` (`apps/api` + `apps/web` + `apps/collab` in parallel) continues to work exactly as before
for every part of this slice that does not need a new secret: `apps/collab`'s own
`requireCollabPersistenceEnvironment` already requires `DATABASE_URL`/`BETTER_AUTH_SECRET`/
`BETTER_AUTH_URL` unconditionally, in every environment, with no health/static-only fallback (that
process cannot run at all without persistence) -- `COLLAB_TOKEN_SECRET` was added to that same
unconditional list, for the identical reason: this process cannot authenticate a single connection
without it. **This means a developer's local `.env` now needs `COLLAB_TOKEN_SECRET` set (any string
of 32+ characters) for `apps/collab` to boot at all under `pnpm dev`, exactly as it already needs
`BETTER_AUTH_SECRET`.** `.env.example` documents the new variable (not `.env` itself, which this
task was constrained never to read or modify). This is a real, unavoidable consequence of the
design, not an oversight -- there is no way to authenticate a WebSocket handshake with a token whose
signature nothing can verify.

`apps/api`'s side is more permissive, by design, mirroring `RESEND_API_KEY`/`STRIPE_*`:
`COLLAB_TOKEN_SECRET` is optional in `parseServerEnvironment`, and `server.ts`'s
`collabTokenConfigured` gate means the minting route simply is not registered when it is absent --
a development or test process without it configured still starts. This does mean that if a
developer sets `COLLAB_TOKEN_SECRET` for `apps/collab` but forgets it for `apps/api` (or vice versa,
or sets two _different_ values), collaboration will fail cleanly with `'Authentication required'`
(an `'invalid'`-outcome verification, since the signature will not match) rather than a confusing
partial failure -- both processes need the exact same value, the same relationship
`BETTER_AUTH_SECRET` already has between them.

`scripts/test-system-persistence.mjs` was updated to generate and share a
`COLLAB_TOKEN_SECRET` across its `environment` object, the same way it already does for
`BETTER_AUTH_SECRET` -- both the `apps/api` and `apps/collab` `webServer` entries in
`playwright.persistence.config.ts` inherit it from that shared object with no config-file change
needed there. `pnpm test:system` (the non-persistence suite) is unaffected: it never starts
`apps/collab` and runs `apps/api` without persistence configured at all, so this option was never in
play for that suite either before or after this slice.

**No two auth paths were left alive.** `apps/collab/src/authenticate.ts` no longer has any code path
that reads a cookie or calls `auth.api.getSession` at all -- `getActorId` was deleted outright, not
kept as a fallback. The one path (token verification) is exercised everywhere: production, `pnpm
dev`, and every test in this slice, with no environment-gated branch choosing between "cookie" and
"token."

## Every gate, run and checked by `$?`, verbatim

```
$ pnpm lint
exit 0

$ pnpm format:check
exit 0 (after `pnpm format` fixed 5 files this slice touched: apps/api/src/app.ts,
apps/collab/src/authenticate.ts, apps/collab/src/authenticate.test.ts,
packages/collab-token/src/index.test.ts, and this progress file itself)

$ pnpm typecheck
exit 0 -- root script extended to build @finaler-draft/collab-token in dependency order
alongside the other workspace packages before typechecking web/api/collab/landing.

$ pnpm test
exit 0. Per package: config 2, collab-token 9 (new), database 30 (2 skipped), entitlements 25,
screenplay 118, server-config 20, xml-escape 9, landing 31, auth-server 24, fdx 45, docx 58,
layout 72, screenplay-editor 94, pdf 61, collab 71 unit (up from the 67 baseline; 14 more skipped
without TEST_DATABASE_URL), api 163 unit (up from 158; 40 more skipped), web 655 (unchanged).
Nothing dropped; every new number is new coverage for this slice.

$ pnpm test:coverage
exit 0. Every package's coverage thresholds met, including the newly-thresholded
packages/collab-token (90% lines/functions/branches/statements -- actual: 100/100/100/100) and
apps/collab's authenticate.ts (80% threshold -- actual: 100% lines/statements/functions, 97.22%
branches, one uncovered branch at line 280: `params.now ?? new Date()`'s `new Date()` fallback,
which every unit test in `authenticate.test.ts` deliberately never takes (each passes a fixed
`now` for determinism) but which the real integration suite and production both do take --
`collaboration.integration.test.ts`'s `startServer` never passes `now` either, matching
`server.ts`'s own real call site exactly).

$ TEST_DATABASE_URL="..." pnpm --filter @finaler-draft/api test:integration
exit 0, 40/40 (up from the 39 baseline: the new "rejects a minted connection token used as a
session cookie, even with the correct cookie name" test in persistence.integration.test.ts).

$ TEST_DATABASE_URL="..." pnpm --filter @finaler-draft/collab test:integration
exit 0, 14/14 (up from the 12 baseline: the new expired-token-reconnect test and the new
cross-actor-token-isolation test).

$ TEST_DATABASE_URL="..." pnpm test:system:persistence
exit 0, 25/25 -- unchanged from baseline, and this is the strongest possible confirmation
available: a real Chromium browser, a real signed-in session, a real call to
`POST /api/collab/connection-token`, and a real `apps/collab` verifying that token, end to end,
for every one of these 25 tests (including the presence and title-page-cursor specs, which
depend on a live collaborative connection exactly as much as the plain persistence specs do).

$ pnpm test:system
exit 0, 40/40 -- unchanged from baseline (this suite never starts apps/collab or configures
persistence for apps/api, so it was never a path this slice could affect).
```

## A flake observed during independent verification

`test:system:persistence` failed once during the lead's own re-run of the gates, at 24/25:
`titlepage-cursors-persistence.spec.ts`'s "context B sees context A's title-page caret ... and stays
correct under zoom" exceeded its placement tolerance (the `toBeLessThanOrEqual` at that spec's line
301). The immediately following run passed 25/25, as did every other run of the suite.

This is **not** attributable to this slice, and the reasoning matters more than the conclusion: the
failing assertion is a pixel-geometry delta, and nothing here touches caret measurement, layout, or
zoom. What this slice does add is one asynchronous mint request before the socket connects, which
shifts _when_ a remote caret first paints -- enough to lose a race in a test measuring geometry, not
enough to move a pixel once layout settles.

The underlying jitter is already documented by the cursors slice
(`progress/title-page-cursors.md`): Courier Prime is re-hinted independently at each rendered size,
which is why that assertion carries a 2px tolerance under zoom rather than the 1px used un-zoomed.
The flake says that tolerance, or the wait preceding the measurement, is not quite sufficient. It is
worth fixing as its own item -- a geometry test that fails one run in several teaches a reader to
ignore red, which is worse than the defect it was written to catch.

## New environment variable required

**`COLLAB_TOKEN_SECRET`** -- signs and verifies the connection token. Must be the _same_ value in
both the `app` and `collab` Railway services (HS256 is symmetric; a mismatch fails every handshake
with a clean `'Authentication required'`, not a crash). Generate a fresh, unique secret of at least
32 characters, distinct from `BETTER_AUTH_SECRET` -- do not reuse it. Required in `collab`
unconditionally (that service cannot start meaningfully without it, mirroring
`BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`); required in `app` only in production
(`requirePersistenceEnvironment`), optional in development and test, mirroring how
`RESEND_API_KEY`/`STRIPE_*` are already treated there.

**This was not set anywhere by this session** -- no `.railway/railway.ts` edit, no `railway
variables`/`set-variables` call, per the standing constraint. The owner needs to add
`COLLAB_TOKEN_SECRET: preserve()` to both the `app` and `collab` service `env` blocks in
`.railway/railway.ts` and set the identical real value in both services' Railway environments before
this change can work in production.

## Known limitations, honestly

- **A network failure while fetching a fresh token is not specially handled.** If
  `api.connectionToken()`'s own `fetch` throws (a network blip, or the mint endpoint returning a
  non-2xx for a reason other than an expired _connection_ token -- e.g. the browser's Better Auth
  session itself has separately expired), `@hocuspocus/provider`'s `sendToken()` catches that and
  emits `authenticationFailed` with a reason string built from the thrown error, not
  `TRANSIENT_SYNC_AUTH_FAILURE_REASON`. `App.tsx`'s existing classification therefore treats this as
  a terminal `'denied'` state, not something it retries. This is arguably correct when the underlying
  cause is a truly expired _session_ (the writer needs to sign in again regardless), but a bare
  network blip while minting would also land there today. The brief's own risk #1 is specifically
  about an _expired connection token_, which is fully solved (see above); this adjacent case was
  not in scope and is named here rather than silently left unproven.
- **`railway config plan`** was not run, per the standing constraint on mutating Railway commands
  and because no `.railway/railway.ts` edit was made in this slice at all (no new service, no new
  `env` entry added by this session -- see "New environment variable required" above for what the
  owner still needs to add there by hand).
