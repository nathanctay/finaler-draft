# Auth hardening

Branch `feature/auth-hardening`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/auth-hardening`.

## Why this scope exists

`plan.md`'s "Launch readiness" is explicit that none of it is optional and none of it should be
discovered late. This slice takes the part of it that needs nothing from outside the codebase.

Verified against the code before writing this: **there is no rate limiting anywhere** -- not Better
Auth's own, not a Fastify plugin, nothing on authentication and no global request cap. `auth.ts`
configures no cookie attributes at all, so session cookie security rests entirely on library
defaults that nobody has checked.

## Explicitly out of scope, because it is blocked on the owner

Transactional email through Resend, and therefore verified-email and password-reset flows, need an
account and an API key only the owner can provide. `plan.md`: "Until this exists there is no account
recovery path at all." That remains the sharpest launch gap and is a separate slice.

Also out: Stripe, tax registration, legal copy, backup rehearsal, dependency licence review.

## What this must achieve

1. **Rate limiting on authentication.** Sign-in, sign-up, and any other credential-accepting
   endpoint. Better Auth has a built-in `rateLimit` option -- establish what it actually covers and
   what it stores state in before relying on it, and say so rather than assuming.

2. **A global request cap**, so a single client cannot exhaust the API regardless of endpoint.

3. **Explicit session cookie attributes**, not inherited defaults: `httpOnly`, `secure`, and an
   appropriate `sameSite`. Read what Better Auth defaults to in this configuration and state it in
   the progress entry -- if a default is already correct, say so and set it explicitly anyway,
   because a default that is right by luck is not a decision and will not survive an upgrade.

4. **Require an `Origin` header on state-changing requests.** `isTrustedOrigin` currently returns
   `true` when the header is absent, which is correct for a same-origin GET (browsers omit it) but
   means a POST, PUT or DELETE arriving without one is allowed through. No browser will do that
   cross-origin, so this is hardening rather than an open hole -- but the honest rule is that safe
   methods may omit `Origin` and unsafe ones may not. The owner found this by running the app on an
   unfamiliar port; the resulting 403 on sign-out was the guard working correctly.

5. **Every one of the above proven by a test that fails when the protection is removed.** A rate
   limit with no test is a configuration value nobody will notice going missing.

## Dependencies

A rate-limit plugin (`@fastify/rate-limit`) may be the right tool, and may not be -- Better Auth's
built-in may already cover the auth endpoints, leaving only the global cap. **Do not add a
dependency without raising it at checkpoint 1 with the reasoning.** This project has added exactly
two dependencies in its recent history (`fflate`, `pdf-lib`), both argued for specifically.

Note for the state question: rate-limit state held in process memory is per-instance, and `plan.md`
anticipates a second app instance behind Redis later. In-memory is acceptable now if that limitation
is recorded, not discovered later.

## Verification

The full gate list, `pnpm format:check` after the progress entry, and the persistence gate three
times. `main` is green.

The integration suite (`apps/api`) runs against a real database and is the right home for rate-limit
and origin tests. For every protection: remove it, confirm the test fails, restore, report.

No credential may appear in any file you write. Configuration values belong in environment
variables via `packages/server-config`, following what is already there.

## Rules

Do not stage, commit, merge, rebase, force-push, reset, or create or delete branches or worktrees.
No TODO or placeholder comments, no emojis, strict TypeScript, `.js` extensions on relative imports.
Record _why_, citing `plan.md`.

## Checkpoints -- SendMessage to the lead

1. What Better Auth's `rateLimit` actually covers and stores, what the current cookie defaults
   actually are, and whether you are asking for a new dependency. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

### 2026-08-23 — the protections collided with the test suites (lead)

The implementation agent reached a session limit while waiting on a persistence run, having
correctly predicted that the now-always-on auth limiter might throttle Playwright's parallel
workers. It does. Measured directly: **4 of 11 persistence tests failed, repeatably**, and chasing
that turned up three separate problems -- all consequences of the new protections working, not test
noise.

**1. Better Auth's limiter throttles the browser suite against itself.** Its built-in cap (3
requests per 10 seconds on `/sign-up` and `/sign-in`, hardcoded in 1.6.25) is keyed by IP, and every
Playwright worker signs up a fresh writer from the same loopback address. `buildPersistentApp` now
passes `rateLimitEnabled: !systemTestMode`, disabled only under `FINALER_SYSTEM_TEST` and named at
the call site rather than buried in a config default.

The production behaviour keeps its coverage: `persistence.integration.test.ts`'s "rate-limits
repeated sign-in attempts" builds a dedicated instance with the override omitted, so what a
deployment actually runs is still exercised. That separation was the agent's own design and it is
what made this safe to do.

**2. `page.request` is not a browser.** Playwright's API client sends no `Origin` header, so the
newly tightened guard refused a seeding `PUT` in `page-rendering-persistence.spec.ts`. Fixed by
setting the header to the page's own origin -- making the test client behave like the application it
stands in for, rather than relaxing the rule to accommodate a non-browser caller.

**3. The global cap counted static assets, and that is a product defect rather than a test
problem.** `@fastify/rate-limit` was registered across every route, so the bundle, the stylesheet and
every font file consumed the same 300-requests-per-minute budget as the API. A writer reloading a few
times could exhaust a cap whose purpose is to bound work reaching the application and the database --
neither of which static file serving touches.

It is now scoped with `allowList: (request) => !request.url.startsWith('/api')`. Note this is
deliberately **not** the origin guard's boundary: that guard covers `/api/projects`,
`/api/screenplays` and `/api/deleted`, while the cap must also cover `/api/auth/*`, which is the
endpoint that most needs it.

This also explains why the failure was so confusing to read: the budget ran out partway through a
run, so whichever test happened to be last failed, with a timeout pointing nowhere near the cause.

**Mutation-tested by the lead, both restored and re-verified:**

- `isTrustedOrigin` reverted to allowing a missing `Origin` on any method -- fails "rejects a
  state-changing request with a real session but no Origin header", by name.
- The global cap's `allowList` set to allow everything -- fails both "refuses further requests once
  a single client exceeds the configured cap" and "applies the real production default from
  server-config".

**Gates:** lint, typecheck clean. `test:coverage` green (api 67 passed / 19 skipped, web 314, and
every package unchanged). `test:integration` with a real database: 19/19, including the new
rate-limit and origin tests. Persistence gate **11/11 three consecutive times**, back to 13 seconds
per run from 42.

The 19 skipped api tests are the integration file, which skips without `TEST_DATABASE_URL` -- the
existing pattern, and they are run in CI by `pnpm test:integration`.
