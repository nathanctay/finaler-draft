# Transactional email

Branch `feature/transactional-email`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/transactional-email`.

## Why this scope exists

`plan.md`'s "Launch readiness": "Transactional email through Resend, with verified-email and
password-reset flows. **Until this exists there is no account recovery path at all.**" That sentence
is the whole justification. A writer who forgets their password today has no way back into their
account and no way for us to give them one.

The owner will supply a Resend API key. **You never see it and never ask for it.** Add the variable
names to `.env.example` with explanatory comments, following the file's existing style; the owner
puts real values in `.env`, which is git-ignored and must stay that way.

## Sequencing

`feature/auth-hardening` is in flight and also configures Better Auth in `apps/api/src/auth.ts`.
It merges first. Expect to merge `origin/main` into this branch before finishing and to reconcile
`auth.ts` -- the two touch different configuration keys, so this should be small, but check rather
than assume.

## What this must achieve

1. **A mail port, not a Resend-shaped hole through the codebase.** A narrow interface (send an
   email: to, subject, text, and html if used) with a Resend implementation behind it, wired in one
   place. Better Auth's callbacks should depend on the interface. The point is that the provider is
   replaceable and that tests do not need network access, not provider-agnosticism for its own sake.

2. **Password reset**, through Better Auth's `emailAndPassword.sendResetPassword`. This is the
   account-recovery path `plan.md` says does not currently exist, and it is the single most
   important thing in this slice.

3. **Email verification**, through `emailVerification.sendVerificationEmail`.

   **Ruling, so nobody is locked out:** new accounts require verification; **existing accounts are
   backfilled as verified** in the same migration that adds any column this needs. The owner's own
   account already exists, and shipping a requirement that locks him out of his own product would be
   a self-inflicted outage. Say plainly in the progress entry that this backfill happened and why.

4. **Configuration through `packages/server-config`**, following the established pattern exactly:
   optional in development, required in production via `requirePersistenceEnvironment`. At minimum a
   key and a from-address. A production process missing them must fail at startup, not at the first
   password reset a stranded user attempts.

5. **Behaviour when email is not configured must be loud.** In development without a key, log the
   message that would have been sent so the flow is testable offline -- but never silently succeed
   in a way that looks like delivery. A swallowed send is worse than a failed one: it tells the
   writer to check an inbox that will never receive anything.

6. **Tests that do not touch the network.** The mail port is what makes this possible: assert that
   requesting a reset sends exactly one message, to the right address, containing a working link,
   and that the flow fails loudly when sending fails.

## Dependency question, raise it at checkpoint 1

Resend publishes an SDK, and its send endpoint is also a single authenticated `POST` that `fetch`
can do without any dependency. This project has added three dependencies in its recent history, each
argued for individually. Make the case either way and wait for a reply -- do not add it unilaterally.

## Out of scope

Stripe and billing. Email templates beyond what these two flows need. Marketing or notification
email of any kind. Rate limiting -- `feature/auth-hardening` covers it, and Better Auth already
applies 3 requests per 60 seconds to `/request-password-reset` and `/send-verification-email`
specifically, which is worth confirming still holds once that branch lands.

## Verification

The full gate list, `pnpm format:check` after the progress entry, and the persistence gate three
times.

**No credential may appear in any file you write**, including the progress entry, test fixtures and
`.env.example`. `.env.example` carries variable names and comments only. Before handoff, grep your
own diff for anything that looks like a key.

For every behaviour that matters: break it, confirm the test fails, restore, report.

## Rules

Do not stage, commit, merge to `main`, force-push, reset, or create or delete branches or worktrees;
merging `origin/main` into this branch is expected and allowed. No TODO or placeholder comments, no
emojis, strict TypeScript, `.js` extensions on relative imports. Record _why_, citing `plan.md`.

## Checkpoints -- SendMessage to the lead

1. The mail port's shape, the Better Auth wiring, the migration and backfill plan, and your
   dependency recommendation. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

## 2026-08-23 -- implementation agent -- implemented and verified

Status: complete

### What shipped

**Mail port** (`apps/api/src/mail.ts`, new): `MailPort`/`MailMessage` interface, plus two
implementations behind it. `createResendMailPort` does the one authenticated `POST` Resend's send
API needs, with `fetch` injectable for tests -- no SDK added; the case against one (argued at
checkpoint 1 and approved) is recorded there and unchanged. `createLoggingMailPort` is what a
process without `RESEND_API_KEY` uses: it never throws and never silently succeeds either -- it
logs the full message under a structured `mail_delivery_skipped_no_provider_configured` event, so
grepping a log cannot mistake it for a real delivery, and the flow stays testable offline.

**Better Auth wiring** (`apps/api/src/auth.ts`): `createAuth`'s second parameter now carries
`mail: MailPort` alongside `feature/auth-hardening`'s `rateLimitEnabled` (the two landed as
separate options objects independently; reconciled into one `CreateAuthOptions` during the merge
below). `emailAndPassword.requireEmailVerification` is `true`. `sendResetPassword` and
`emailVerification.sendVerificationEmail` both route through a `sendOrLogFailure` wrapper that logs
a structured `password_reset_email_failed`/`verification_email_failed` line and rethrows on
failure. `emailVerification.sendOnSignIn: true` means a sign-in attempt against an unverified
account triggers a fresh verification email on the same rejected request -- the recovery path for
an expired link, since this slice deliberately does not build a separate "resend" UI.

**The `runInBackgroundOrAwait` finding**, praised at checkpoint 1 and recorded here so it survives:
reading the installed `better-auth` 1.6.25 source (`api/routes/password.mjs`, `sign-up.mjs`,
`context/create-context.mjs`) showed that both `/request-password-reset` and the sign-up-triggered
verification send go through `runInBackgroundOrAwait`, whose default implementation (no
`advanced.backgroundTasks.handler` configured) catches and only logs -- it never rethrows into the
route handler. That is deliberate on Better Auth's part: `/request-password-reset` always answers
with the same generic success so the response itself can never reveal whether an address is
registered, and letting a send failure flip that response to an error would leak exactly that.
`sendOrLogFailure`'s rethrow cannot and does not try to change that HTTP-level behaviour --
weakening anti-enumeration to make a failure "louder" would have been the wrong trade to make
unilaterally. What it guarantees is a structured, greppable log line, tested directly against the
callback function itself (`auth.test.ts`), independent of whatever Better Auth's own harness does
with it afterward. **Anyone tempted to "fix" the swallowed error by making
`/request-password-reset` return differently on a mail failure would be reopening an
account-enumeration hole**, not fixing a bug.

**Configuration** (`packages/server-config/src/index.ts`): `RESEND_API_KEY` and
`MAIL_FROM_ADDRESS`, optional in `serverEnvironment`, added to `requirePersistenceEnvironment`'s
production-only checks alongside the existing HTTPS one -- a production process without both
refuses to start, with a message naming exactly what's missing and why (`.env.example` carries the
same reasoning as comments, no real values).

**Migration and backfill** (`packages/database/drizzle/0003_backfill_email_verified.sql`, new):
data-only, no schema change -- `user.email_verified` already existed and Better Auth's sign-up
handler has always set it, just unenforced until this slice. The migration flips every existing
`false` row to `true`, scoped by `where email_verified = false` so a second run touches zero rows.
**This is the backfill the ruling in this file's scope section requires**: without it, flipping
`requireEmailVerification` to `true` would lock out every account that existed before this shipped,
including the owner's own. Verified directly against a scratch database (not just by reading the
SQL): seeded one legacy-unverified and one already-verified `user` row on top of migrations
0000-0002 only, applied 0003, and confirmed the unverified row flipped to `true` while the
already-verified row was untouched; re-running the same `UPDATE` twice more both times reported
`UPDATE 0`, confirming idempotence. `railway.toml`'s existing `preDeployCommand` runs `db:migrate`
before every deploy, so this applies automatically before the new enforcement goes live -- no
separate manual step for the owner.

**Frontend routes** (scope expansion, approved at checkpoint 1 -- see that reply's reasoning:
correct endpoints with no page to reach them would leave a stranded writer exactly as stranded):

- `apps/web/src/routes/forgot-password.tsx` -- requests a reset link. Renders the identical generic
  confirmation regardless of whether the address is registered, matching Better Auth's own
  anti-enumeration response; never branches on it.
- `apps/web/src/routes/reset-password.tsx` -- reads `token` from the URL query string (not
  `Route.useSearch()`/`useSearch()`: this component renders under the shared test harness without a
  `RouterProvider`, the same reason `useParams`/`useNavigate` are already shimmed there), submits a
  new password, shows an invalid-link state when no token is present.
- `apps/web/src/routes/verify-email.tsx` -- the landing page the verification link's `callbackURL`
  redirects to once Better Auth has already verified the token server-side. Branches only on
  `?error=...` (appended on an expired/invalid token, confirmed by reading
  `api/routes/email-verification.mjs`'s `redirectOnError`) to show a distinct message; otherwise
  reports success.
- `apps/web/src/routes/sign-in.tsx` -- a "Forgot password?" link in sign-in mode only, and a new
  branch on sign-up success: `requireEmailVerification` means Better Auth skips auto-sign-in for a
  fresh, unverified account, so `token` comes back `null` instead of a session ever being created.
  Navigating to `/projects` on that outcome (the old, unconditional behaviour) would have sent the
  visitor straight into the signed-out redirect that guards it. It now shows "Check your email."
  instead.
- `apps/web/src/authClient.ts` (new) -- wraps Better Auth's own client (`better-auth/client`),
  used only for `requestPasswordReset`/`resetPassword` (sign-in/sign-up/sign-out stay on the
  hand-rolled `request()`/`json()` helpers in api.ts, per the lead's explicit instruction to use
  the client for this narrow, security-sensitive surface rather than hand-rolling it). Constructs a
  fresh client per call rather than a module-level singleton, because `createAuthClient` binds
  `fetch` once at construction; a singleton built at import time would freeze in whatever `fetch`
  was global before a test ever stubs it.
- `apps/web/src/api.ts` -- `requestPasswordReset`/`resetPassword` (via `authClient()`), a
  `unwrapAuthClientResult` helper normalizing the client's `{data, error}` shape into the same
  `AuthApiError`/`ApiError` pair the hand-rolled path throws, `INVALID_TOKEN` and
  `EMAIL_NOT_VERIFIED` added to `authErrorMessages`, and `signUp`/`signIn` now typed against
  `{token: string | null}` instead of `z.unknown()` so `sign-in.tsx` can read `.token` without a
  runtime guard.

**System-test mailbox** (`apps/api/src/app.ts`, `server.ts`): a `GET /api/test/last-mail?to=`
route, registered only under `FINALER_SYSTEM_TEST`, returning the most recent message sent to an
address. This exists because a Playwright spec has no way to inject a fake `MailPort` the way a
Vitest test can -- without it, the only way for a browser-driven suite to get past
`requireEmailVerification` would have been writing `email_verified = true` straight into the
database, which would leave the production requirement itself unexercised by every system test.
`apps/web/e2e/testMail.ts` (new) fetches the real link this endpoint recorded and follows it with
`page.goto`, the same request a browser makes when a writer clicks the email -- a real code path,
not a shortcut. All three affected specs (`persistence.spec.ts` -- four separate sign-up flows
inside it, not just the shared `createAndOpenScreenplay` helper --, `page-rendering-persistence.spec.ts`,
`session-routing.spec.ts`) now verify and sign in for real between "Create account" and "Your
writing desk."

### Merging `feature/auth-hardening`

`feature/auth-hardening` landed on `origin/main` (`ac3d6ae`) partway through this work.
`git merge origin/main` fast-forwarded cleanly once the working tree was clean (`git stash push -u`
first, since this branch carries no commits of its own -- every change here is uncommitted, per
this project's agent protocol). `git stash pop` then produced real conflicts in exactly the six
files both slices touched: `auth.ts`, `auth.test.ts`, `app.ts`, `server.ts`,
`persistence.integration.test.ts`, and `packages/server-config/src/index.ts`. Every conflict was
the two slices adding different, non-overlapping keys to the same object literal or function
signature (`rateLimitEnabled` next to `mail`; `API_RATE_LIMIT_MAX`/`WINDOW_MS` next to
`RESEND_API_KEY`/`MAIL_FROM_ADDRESS`; `disableAuthRateLimit` and my `systemTestMode` naming the
same condition two different ways) -- resolved by keeping both additions, consolidating the two
differently-named "are we under system test" flags into the one `systemTestMode` already threaded
through `server.ts`, and folding `CreateAuthOptions`/`AuthDependencies` into a single options type.
One resolution was a small correctness fix, not just a merge: `app.ts`'s error handler carried a
comment saying `@fastify/rate-limit` was "registered below," but the plugin registration is
actually above the error handler in both branches' code (confirmed by inspection, not conflicted
by git) -- corrected to "registered above" during resolution rather than carried forward inaccurate.
Confirmed zero drift between what I'd read from the `auth-hardening` worktree at checkpoint time
and the actual committed content: every conflict hunk's "Updated upstream" side matched what I'd
already reconciled by hand before the merge. The full gate list (below) was re-run in full against
the merged state, including three more persistence-gate runs, after every conflict was resolved.

### Dependency: no Resend SDK

Argued at checkpoint 1, approved without change: raw `fetch`, no new dependency. Resend's send
call is one authenticated POST with a JSON body -- exactly what `fetch` does on Node 24 with zero
ceremony. The SDK's benefits (response typing, retries, multi-endpoint convenience) don't apply
when the port only ever calls one endpoint, and it would sit behind `MailPort` anyway, so nothing
about the port's shape would change if it were added later -- the cost would be paid now for a
benefit invisible at every call site today.

### Development-mode behaviour, so the owner isn't confused by it later

With no `RESEND_API_KEY` set (the default for local development), a password-reset or
verification-email "send" produces **only** a structured log line on the API process's stdout --
`{"event":"mail_delivery_skipped_no_provider_configured","to":...,"subject":...,"text":...}`,
`text` including the actual working link. There is no other record of it anywhere: no database
table, no admin UI, nothing the browser shows. **If the owner creates a local account before
`RESEND_API_KEY` is configured, the only way to find the verification or reset link is to read the
API process's terminal output at the moment the request was made.** This is deliberate (requirement
5: loud, not silently successful, but never claiming a delivery that didn't happen) but easy to
mistake for "email is broken" if you don't know to look there -- flagging it explicitly so that
doesn't happen.

### Mutation-testing report

Every behaviour load-bearing enough to matter was broken, confirmed to fail the right test with the
right message, then restored and reconfirmed green. All twelve below were carried out after the
`auth-hardening` merge, against the final state.

1. **`auth.ts` `sendOrLogFailure`'s rethrow** (commented out `throw error;`). Failed 3 tests in
   `auth.test.ts`: both "logs a structured failure and rethrows" tests (`sendResetPassword` and
   `sendVerificationEmail`) with "promise resolved undefined instead of rejecting," and the
   non-Error-rejection test the same way. Restored; green.
2. **`requireEmailVerification: true` -> `false`**. Failed `auth.test.ts`'s config-shape assertion
   (`requireEmailVerification: true` expected, `false` received) and, more importantly,
   `persistence.integration.test.ts`'s dedicated production-behaviour test: `signedUp.headers[
'set-cookie']` was defined when the test asserted it must be `undefined` (sign-up now creates a
   session for an unverified account, exactly the outage the ruling exists to prevent). Restored;
   both green, including a fresh `TEST_DATABASE_URL` run of just that test.
3. **`sendOnSignIn: true` -> `false`**. Failed `auth.test.ts`'s
   "configures verification to be sent on both sign-up and a sign-in attempt" test:
   `toMatchObject({sendOnSignUp: true, sendOnSignIn: true})` against actual `sendOnSignIn: false`.
   Restored; green.
4. **`mail.ts` `createResendMailPort`'s `if (!response.ok) throw`** (short-circuited to `if (false
&& !response.ok)`). Failed "throws with the response status and body when Resend rejects the
   request" -- promise resolved instead of rejecting. Restored; green.
5. **`mail.ts` `createLoggingMailPort`'s `console.log` call** (removed it, keeping only
   `onSend?.(message)`). Failed "resolves without throwing, and logs a structured line" --
   `expected "log" to be called 1 times, but got 0 times`. Restored; green.
6. **`server-config`'s production Resend gate** (`if (false && (!RESEND_API_KEY ||
!MAIL_FROM_ADDRESS))`). Failed both "refuses to start in production without a Resend API key"
   and "...with a Resend API key but no from address" -- `expected [Function] to throw an error`,
   got nothing. Restored; green.
7. **`app.ts`'s `if (options.testMail)` gate** (forced to `if (true)`). Failed "is not registered at
   all when no testMail option is supplied" -- a request to the unauthenticated address that should
   404 with no `testMail` configured instead 500'd (the route now exists, calls
   `options.testMail!.latestTo` against `undefined`, and crashes at runtime). Restored; green.
8. **`sign-in.tsx`'s `result.token === null` check** (changed the literal to a string that can never
   match). Failed "shows a check-your-email message instead of navigating when sign-up succeeds
   without creating a session" -- the "Check your email." heading never appeared within the wait
   window. Restored; green.
9. **`api.ts`'s `unwrapAuthClientResult`** (short-circuited to always `return result.data as T`,
   ignoring `result.error`). Failed all three error-path tests across
   `forgot-password.test.tsx`/`reset-password.test.tsx` -- `routeState.mutationErrorValue` never
   became defined, since the client-driven mutation silently "succeeded" on every response. Restored;
   green.
10. **`api.ts`'s `INVALID_TOKEN` map entry** (deleted the key). Failed
    "renders the invalid-or-expired message for an INVALID_TOKEN failure" -- rendered the generic
    fallback sentence instead of the specific one. Restored; green.
11. **`verify-email.tsx`'s `.has('error')` check** (changed to `.has('never-matches')`). Failed both
    error-branch tests -- the "invalid or expired" heading and alert never appeared for a
    `?error=...` URL. Restored; green.
12. **Migration backfill**, verified functionally rather than by source mutation (there is no clean
    way to mutate a one-shot SQL file and re-run it through the same test suite without a
    dedicated pre-migration fixture, which the integration suite's fresh-database-per-run design
    doesn't provide): built a disposable scratch database, applied only migrations 0000-0002,
    seeded one `email_verified = false` row and one `= true` row directly, then applied 0003 and
    confirmed the unverified row flipped while the verified one didn't move; ran the backfill
    `UPDATE` twice more directly and confirmed `UPDATE 0` both times. Scratch database dropped
    afterward; no artifact left behind.

Every mutation above reproduced the exact failure its corresponding test exists to catch, with a
message that names the actual behaviour, not a generic assertion failure -- and every one was
restored and reconfirmed green before moving to the next.

### Gate results (all commands run from the worktree, final state, after the `auth-hardening` merge)

1. `pnpm exec eslint . --max-warnings=0` -- clean, no output, exit 0.
2. `pnpm typecheck` -- clean across every package and both apps.
3. `TEST_DATABASE_URL=... pnpm test:coverage` -- exit 0. `apps/api`: 7 files, 104 tests passed;
   `app.ts` 99.54%/95.16% stmt/branch, `auth.ts` 100%/100%, `projects.ts` 94.78%/88.42% (pre-existing,
   untouched by this slice). `apps/web`: 30 files, 328 tests passed; every new file at or above the
   80% per-file threshold -- `api.ts` 100%/98.11%, `authClient.ts` 100%/100%, `forgot-password.tsx`
   100%/88.88%, `reset-password.tsx` 100%/86.66%, `sign-in.tsx` 99.55%/98.3%, `verify-email.tsx`
   100%/100%. Every other workspace package (`config`, `server-config`, `database`, `screenplay`,
   `xml-escape`, `docx`, `layout`, `fdx`, `pdf`) passed unchanged.
4. `TEST_DATABASE_URL=... pnpm test:integration` -- 20 tests passed (the persistence integration
   suite specifically, isolated from the rest of `apps/api`'s tests).
5. `pnpm build` -- succeeded for all packages and both apps.
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 23 passed. (This gate's server has no persistence
   configured at all, so it never reaches the auth code this slice touches; unaffected by design.)
7. `PLAYWRIGHT_CHANNEL=chrome TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/finaler_draft
pnpm test:system:persistence` -- run **three times** against the final merged state, 11/11 passed
   every time (session-routing, both persistence-project specs, both page-rendering-persistence
   full-suite runs). Also run three times earlier, before the `auth-hardening` merge, all 11/11 --
   six clean runs total across this slice.
8. `git diff --check` -- clean, no whitespace errors.
9. Credential grep across the full diff plus every new file, before and after the merge: no
   `re_...`-shaped key, no `api_key`/`secret`/`password`/`token` literal assignment other than
   test-fixture placeholders (`x.repeat(32)`, `test-key`, `integration-test-secret-...`,
   session-token fixtures), no 32+ character opaque blob other than `pnpm-lock.yaml`'s own public
   package integrity hashes. `.env` was never read or written; `.env.example` carries variable names
   and comments only.
10. `pnpm format:check` -- run after this entry was written (see below).

### Known limitations / things not done

- **No in-app "resend verification email" affordance.** Deliberately out of scope (see the scope
  section above and `auth.ts`'s comment on `sendOnSignIn`): the recovery path for an expired
  verification link is trying to sign in again, which Better Auth's own `sendOnSignIn` turns into a
  fresh email on the same rejected attempt. A dedicated resend button was not built.
- **No `autoSignInAfterVerification`.** Clicking a valid verification link verifies the account and
  lands on `verify-email.tsx`, but does not sign the visitor in automatically; they sign in normally
  afterward. Kept conservative deliberately -- enabling it would mean tracing exactly how Better
  Auth's cookie-setting interacts with its own redirect response, which felt like unnecessary risk
  for a slice that already had a lot of moving parts, and "keep it plain" was the explicit
  instruction for these screens.
- **The one-hour token expiry is Better Auth's own default**, not something this slice configured
  explicitly (`resetPasswordTokenExpiresIn`/`emailVerification.expiresIn` were left unset). Both
  the reset and verification emails' copy states "one hour" -- if that default ever changes upstream,
  the copy would need updating alongside it; nothing enforces they stay in sync.
- **`projects.ts`'s pre-existing coverage gaps** (94.78%/88.42%, lines around ~450, ~508, ~554) are
  untouched by this slice and were already present before it started; not fixed, since they're
  outside this scope.
- **Development-mode mail visibility** (see the section above): the only record of a "sent" email
  without `RESEND_API_KEY` configured is a structured stdout log line. No local-dev mail viewer was
  built.

### 2026-08-23 — the test-mail route's gate hardened (lead)

`/api/test/last-mail` returns the body of the most recent email sent to an address -- which is how a
Playwright spec follows a real verification link, and which means the response carries **live
password-reset and verification tokens**. It was gated on `options.testMail`, supplied only when
`FINALER_SYSTEM_TEST` is set.

That is one condition too few. `FINALER_SYSTEM_TEST` is not a production kill switch: `server.ts`
also uses it to _relax_ the "persistence configuration is required in production" check, so it is a
variable that can plausibly be set in a production-shaped environment. One misplaced environment
variable should not be sufficient to serve account-recovery tokens to anyone who asks.

The route now additionally refuses to register under `NODE_ENV=production`, regardless of what it
was passed. Two independent conditions, checked at the point of registration rather than in
`server.ts`, so the guard travels with the route and is reachable from a test.

**Tested and mutation-tested:** a new case builds an app with `testMail` supplied _and_
`NODE_ENV=production`, then asserts the response is a 404 that is not the route's own -- and that
the token planted in the fixture does not appear in the body, so a leak cannot pass as a pass.
Removing the `NODE_ENV` condition fails exactly that test by name. Restored and diffed identical.

This does not change the harness: the browser suites run without `NODE_ENV=production`, so the route
is present for them exactly as before.

### 2026-08-23 — an explicit resend, replacing the automatic one (lead, owner-requested)

The owner asked whether an unverified account would keep receiving verification emails. Reading the
installed `api/routes/sign-in.mjs` answers both halves of that:

- The verification check sits **after** the password comparison, so a resend only ever fired on a
  _correct_ password. It was never a way to post mail to an address you do not control.
- But with `sendOnSignIn: true`, every rejected attempt sent another email. A visitor who did not
  verify promptly, and kept trying to sign in, accumulated them.

Worse, the recovery path was undiscoverable: nothing told a visitor whose link had expired that
attempting sign-in again would quietly send a new one.

**`sendOnSignIn` is now off, and there is a real button instead.** `api.sendVerificationEmail` calls
Better Auth's `/send-verification-email`, which takes `{ email }` and requires **no session** --
confirmed against the installed `api/routes/email-verification.mjs`, and necessary, since an
unverified account cannot obtain a session to authenticate with. Better Auth applies its own
3-per-60-seconds limit to that path specifically, which is what keeps an unauthenticated send
endpoint from becoming a way to mail an arbitrary address.

The button renders in both places a visitor can be stuck without a session: the post-sign-up "Check
your email" panel, and a sign-in refused with `EMAIL_NOT_VERIFIED`.

**One piece of now-false copy was caught by this**: `EMAIL_NOT_VERIFIED`'s message read "We just sent
you a new link", which stopped being true the moment the automatic send was disabled. Corrected.

**An outdated test was updated rather than the behaviour reverted.** `auth.test.ts` asserted
`sendOnSignIn: true`, and failed correctly when this changed. That is the case where the test
encodes a superseded plan, so it now pins the new intent with the reasoning attached -- as distinct
from loosening a test to accommodate a weaker implementation, which this project does not do.

**Mutation-tested:** replacing the resend's `mutationFn` with a no-op fails the new test on the
assertion that a request actually left, carrying the right address.

## Known limitation

The new test does not assert the confirmation message the component renders on success. Better Auth's
client performs its own response parsing, and a `fetch` stub thin enough for the rest of that file
does not settle it into a success state -- asserting the message would have been asserting the stub
rather than the component. What is covered is the part that cannot be faked: the request leaves,
addressed to the right person. The success and failure copy is currently verified by reading, not by
test.

### 2026-08-24 — two defects found by running it (lead, owner-reported)

The owner ran the flow locally against a real Resend key. The email arrived; nothing after that
worked. Two separate defects, neither reachable by any test in this repository.

**1. The emailed link 404s in development.** `callbackURL` and `redirectTo` were relative paths, and
Better Auth resolves those against `BETTER_AUTH_URL` -- the API's own origin. In production the API
also serves the client, so a relative path happens to land correctly. In development it does not:
the API is on :3001 and Vite serves the app on :5173, so the verification link redirected to
`http://localhost:3001/verify-email`, where Fastify has no such route and answered 404.

Fixed with an `appUrl()` helper building an absolute URL on `window.location.origin` -- by
definition where the visitor's app is served from, in either environment. Better Auth validates
these against its own trusted-origin list, so an absolute URL is checked rather than blindly
followed.

**Why no test caught it:** the browser suites run against the production build, where the API and
the client share one origin and a relative path resolves correctly. The bug exists only in the
split-origin development setup, which nothing automated exercises. That is worth remembering as a
category -- "works in the suite, broken in `pnpm dev`" is invisible here by construction.

**2. Rate limiting could not identify a client, and silently shared one bucket.** The owner's logs
carried Better Auth's own warning. Confirmed in the installed `api/rate-limiter/index.mjs`: when no
IP resolves, every request collapses onto `NO_TRUSTED_IP_KEY`, a single shared bucket per path for
all clients combined. **That is worse than no rate limit** -- one abusive client exhausts it and
locks out every legitimate user.

`auth.ts` points Better Auth at `x-real-ip`, which Railway's proxy sends. Nothing sends it on a
direct connection, so the fallback applied in development, and would apply in any deployment where
that header ever stopped arriving.

Better Auth receives a web `Request` and cannot see the socket, but Fastify can. The auth route now
fills `x-real-ip` from `request.ip` **only when the header is absent**; behind Railway the real
value arrives and is passed through untouched.

**Known limitation, pre-existing and unchanged by this:** a client reaching the API directly can set
`x-real-ip` itself and rotate it to evade the limit. Closing that requires
`advanced.ipAddress.trustedProxies`, so the header is believed only from a known proxy -- a
deployment-topology decision rather than a code one, and worth taking before public launch.

**Mutation-tested:** removing the fallback fails the new test by name; the test also asserts a
header that did arrive is passed through unchanged, so the fix cannot regress into overwriting a
proxy's value with the proxy's own address.

### 2026-08-24 — duplicate sign-up, and two small fixes (lead, owner-reported)

**Signing up with an address that already has an account does not stop you. That is deliberate, and
it cannot be changed without giving up email verification.**

Better Auth's sign-up route has two paths for a duplicate address (installed
`api/routes/sign-up.mjs`): throw `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, or return a _synthetic_
success -- `{ token: null, user: <fabricated> }`, with the password still hashed to keep the timing
indistinguishable. Which one runs is not a setting of its own:

```
shouldReturnGenericDuplicateResponse =
  emailAndPassword.requireEmailVerification || emailAndPassword.autoSignIn === false
```

This slice sets `requireEmailVerification: true`, so the generic response is on, and there is no
independent switch to turn it off.

That is the right behaviour to keep. Rejecting the address would tell anyone who asks whether a
given person has an account here -- a stranger can test an address and learn something about them
that is not theirs to learn. The synthetic-user response, down to hashing a password it will never
store, exists precisely so that answer is unavailable.

What was genuinely wrong was the copy. "We sent a verification link to {email}" is a claim, and in
the duplicate case it is false: nothing was sent, and the visitor waits for an email that will never
arrive. It now reads "If {email} is not already registered, a verification link is on its way ... If
you already have an account, sign in instead", which is true in both cases, tells someone who
forgot they had an account what to do, and still reveals nothing.

**Two small fixes alongside it:**

- `.text-button` is now `display: block`. The entry screens render two in sequence -- "Resend
  verification email" and "I already have an account" -- and as inline elements they sat on one line
  and read as a single sentence.
- The client-IP question is recorded in `plan.md`'s "Launch readiness" as a gate, with the specific
  `curl` that settles it and an explicit warning not to guess the proxy range from the codebase.

### 2026-08-24 — the backfill had not run locally, and the expired-link path is now tested (lead)

**The owner's pre-verification account was refused sign-in.** Not a defect in the backfill: it had
simply never been applied to his local database. Confirmed by querying it directly -- three
migrations recorded, `0003_backfill_email_verified` absent, and `user` holding 26 rows with
`email_verified = false` against 2 true.

Migrations run automatically only on deploy (`railway.toml`'s `preDeployCommand`); locally
`pnpm --filter @finaler-draft/database db:migrate` is a manual step. Worth stating because the
symptom -- "an account that predates verification is locked out" -- looks exactly like the backfill
being wrong, and it is not.

**The expired-link question now has a test rather than an argument.** A visitor who signs up, does
not verify, closes the tab, and returns after the hour is up has a dead link in their inbox and no
post-sign-up panel to return to. The only thing they will naturally do is try to sign in, so that is
where the way back has to be -- and since `sendOnSignIn` is off, nothing arrives unless they ask.

`sign-in.tsx` renders the resend button beneath the `EMAIL_NOT_VERIFIED` error for exactly this
reason, and there is now a test proving it: a refused sign-in shows both the diagnosis and the
affordance. **Mutation-tested** -- forcing that branch to `false` fails the test by name, which is
what stops a future tidy-up from quietly turning the message back into a dead end.

Following the sibling error test's own pattern here was necessary rather than stylistic: this
suite's route mock surfaces a mutation error on the next mount, so the test unmounts and renders
again to observe it, and scopes to the first alert since the resend renders its own.
