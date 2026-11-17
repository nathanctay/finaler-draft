# Deployment crash alerts

On 2026-11-16 the `account-purge` cron (`progress/account-purge-cron.md`) crashed on its first
scheduled run with `MODULE_NOT_FOUND`. The deploy had succeeded; only the 03:00 execution failed.
The grace-period purge had never once run, and nobody found out until a worktree cleanup turned it
up by chance. `quality.yml`'s `deploy-outcome` job already turns "production did not ship" into a
failed CI run a human sees. Nothing turned "a deployed service crashed at runtime" into anything
visible at all -- that account-purge-cron doc's own closing note even names the fix: "a Railway
webhook on deployment crash is the cheap version." This slice is that webhook.

## What was built

`POST /api/webhooks/railway` on `apps/api`, gated entirely on configuration, plus the config,
wiring, and tests around it.

- **`apps/api/src/railwayAlerts.ts`** (new) -- the pure logic: the webhook payload's zod schema,
  the constant-time shared-secret comparison, which `type` values are alertable and why, the
  retry-safe in-process dedupe cache, and the plain-text email rendering. No HTTP in this file at
  all, mirroring `stripeWebhook.ts`'s own split between "the event logic lives here" and "the
  route lives in app.ts."
- **`apps/api/src/app.ts`** -- `BuildAppOptions.railwayAlerts` (a new optional port, absent means
  the route does not exist) and the route registration itself, placed directly after the Stripe
  webhook block since both are unauthenticated, pre-`auth`-hook routes.
- **`apps/api/src/server.ts`** -- wires the route in `buildPersistentApp`, gated on **both**
  `RAILWAY_WEBHOOK_SECRET` and `ALERT_MAIL_TO` being present, reusing the same `mail` port
  `createAuth`, `sharing`, and `feedback` already share.
- **`packages/server-config/src/index.ts`** -- `RAILWAY_WEBHOOK_SECRET` and `ALERT_MAIL_TO`,
  following `FEEDBACK_MAIL_TO`'s exact precedent: optional for a health/static-only process or
  local development, both required in production via `requirePersistenceEnvironment` (fails at
  startup, not at the next silent crash).
- **`.railway/railway.ts`** -- both new variables declared under `app`'s `env` as `preserve()`,
  with a comment explaining why the webhook destination itself is not declared here (see below).
- **Tests** -- `railwayAlerts.test.ts` (pure-logic unit tests), `railwayAlertsRoutes.test.ts`
  (route-level, via `buildApp` + `app.inject`), `railwayAlertsSecretComparison.test.ts` (an
  isolated `vi.mock('node:crypto', ...)` file proving the comparison is actually constant-time, not
  just correct), and additions to `packages/server-config/src/index.test.ts` for the two new
  environment variables' production-required behavior.

## What was decided and why

**The shared secret, not a signature.** Verified directly against
`docs.railway.com/observability/webhooks` (via the Railway MCP's `search-docs`/`fetch-docs` and a
direct fetch, since the MCP tool could not resolve the page by URL): Railway's webhook delivery
carries no signature header and there is no `constructEvent`-equivalent to verify one against. The
documented mechanism is a custom header the receiver names; Railway's own form only refuses a name
starting with `X-Railway-` (reserved for itself) plus the handful of headers it always sets. This
route uses `x-finaler-draft-webhook-secret`, checked with a constant-time comparison
(`crypto.timingSafeEqual`, length-checked first since it throws on a length mismatch) -- there is
nothing resembling Stripe's HMAC verification here, and copying that shape would verify nothing.

**Alertability is keyed on `type`, not `details.status`.** Railway's own example payload in its
docs pairs `"type": "Deployment.failed"` with `"details": { "status": "SUCCESS" }` --
an inconsistency with no resolution available from the docs alone (placeholder sample data, or a
real case of `status` lagging the event). Trusting `type` is the one reading that survives that
inconsistency either way. The alertable set is `Deployment.failed`, `Deployment.crashed` and
`Deployment.oom_killed`.

**These are Railway's own published values, confirmed against its API's event-type enum during
review, not extrapolated from a naming convention.** The full published set is: `Deployment.crashed`,
`Deployment.oom_killed`, `Deployment.failed`, `Deployment.deployed`, `Deployment.redeployed`,
`Deployment.slept`, `Deployment.resumed`, `Deployment.restarted`, `Deployment.removed`,
`Deployment.building`, `Deployment.deploying`, `Deployment.waiting`, `Deployment.needs_approval`,
`Deployment.queued`, `VolumeAlert.triggered`, `VolumeAlert.resolved`, `Monitor.triggered`,
`Monitor.resolved`, `Monitor.deleted`.

The implementation originally shipped with only `failed` and `crashed`, inferred from the single
literal Railway's prose docs publish. The inference turned out correct for `crashed` -- but it
**missed `Deployment.oom_killed` entirely**, which is a distinct type and one of the exact three
Railway itself defaults a new webhook to. An OOM kill would have been acknowledged with a 2xx and no
email: the same silent failure this route exists to end, reintroduced inside the fix for it. Caught
in review by checking Railway's enumerated event types rather than accepting the inference.

Two of the original tests also asserted against **invented** event names (`Deployment.success`,
`Volume.usageAlert`), neither of which Railway ever sends. Such a test passes against any
implementation, because the input never occurs -- it proves nothing about real traffic. Every `type`
in the test file is now a real published value.

Every event that is _not_ a `Deployment.*` transition is treated as alertable unconditionally.
This single URL also receives volume usage alerts and CPU/RAM "resource" alerts
(`docs.railway.com/observability/webhooks#platform-events` groups all three under "Platform
events"), and Railway's docs never publish the literal `type` string either alert category uses.
Hardcoding a guessed literal would either alert on nothing (wrong guess) or silently stop alerting
the day Railway renames an internal string. Since the only three categories this URL ever receives
are deployment status changes and two alert categories, "not a `Deployment.*` transition" is
sufficient on its own.

**Dedupe marks "seen" only after a successful send, never before attempting one.** Railway retries
an undelivered webhook up to 3 times with exponential backoff if it does not see a 2xx/3xx response
within a 30-second-per-attempt timeout. The brief's own scenario is a retry _after_ a slow-but-
successful send; the failure mode this decision additionally avoids is marking a key "seen" on a
_failed_ attempt, which would let one transient mail-provider outage permanently suppress the exact
retry that was Railway's only mechanism for getting the alert out at all. Verified directly: see the
mutation table's "retries a genuinely new delivery after a failed send" case below. The cache is an
in-process `Map`, swept lazily on each call rather than on a timer; it does not survive a process
restart, which is stated in `railwayAlerts.ts`'s own comment rather than left implicit.

**`ALERT_MAIL_TO` is a separate variable from `FEEDBACK_MAIL_TO`, never a reuse.** Feedback may
later route to a shared inbox a wider team reads; an operational crash alert needs a human to act
within minutes and must not be forced to follow feedback there if that happens. The route is gated
on **both** `RAILWAY_WEBHOOK_SECRET` and `ALERT_MAIL_TO` being configured (`server.ts`'s
`railwayAlertsConfigured`), not the secret alone: a route that could authenticate a caller but had
nowhere to send the resulting alert would defeat the entire point of building it.

**Mail failure is a 5xx, never swallowed into 200.** Unlike `feedback.ts`, where the database row
is authoritative and the notification email is best-effort, the email _is_ the entire point of this
route. Returning 200 on a send failure would tell Railway's bounded retry the alert was delivered
when it was not -- reproducing the exact silent failure this route exists to close. 502 specifically,
matching the existing convention for "an upstream mail/billing dependency failed" elsewhere in
`app.ts` (the Checkout/Portal/billing-plans routes).

**The IaC SDK has no webhook primitive.** Checked by reading the installed `railway@3.11.0`
package's actual exported surface -- `node_modules/railway/dist/iac/index.d.ts` and the underlying
`index-C3uk0ruc.d.ts` -- rather than guessed: no `webhook()` function, and no `webhook`-shaped field
on `ProjectDefinition` or `ServiceConfig`. (A GraphQL schema string embedded in the package's
compiled source does mention "Test a webhook URL by sending a sample payload," confirming Railway's
underlying API has webhook mutations, but the `iac` module this repo's `.railway/railway.ts`
actually imports from does not expose them.) The two environment variables the route itself reads
are declared in `.railway/railway.ts` as `preserve()`, following `FEEDBACK_MAIL_TO`'s own
precedent and warning (an omitted variable is deleted on the next `railway config apply`, which
would arm a production crash-loop on an unrelated future infrastructure change). The webhook
registration itself -- the URL Railway posts to, and the custom header carrying the secret -- is
**not** declared here and must be configured by hand through the Railway dashboard's Webhooks tab,
or the Railway MCP's `create-webhook`/`update-webhook` tools, against a real project. Neither was
done as part of this slice; see "What remains unverified" below.

## Out of scope, deliberately

A heartbeat or dead-man's-switch for "the cron never fired at all" or "it ran and silently did
nothing." Both are real gaps this route does not close -- it only reports a deployment that reached
a documented failure/crash state, which is a different failure mode from a cron that simply never
triggers or that exits 0 having done nothing. Worth a later slice; not built here.

## Gates

Run from the worktree root, in order:

| Gate             | Command             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint             | `pnpm lint`         | exit 0, 0 problems                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Typecheck        | `pnpm typecheck`    | exit 0, 0 errors (builds all `packages/*` first, then `apps/web`, `apps/api`, `apps/collab`, `apps/landing`)                                                                                                                                                                                                                                                                                                                                                                                 |
| Format           | `pnpm format:check` | exit 0, "All matched files use Prettier code style!"                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Unit/integration | `pnpm test`         | exit 0 -- every workspace package green; `apps/api` reports 436 passed, 148 skipped (37 files, the skips are the Postgres-gated `*.integration.test.ts` suites, which this slice did not touch or need); `apps/web` 1330 passed; `apps/collab` 181 passed, 32 skipped                                                                                                                                                                                                                        |
| Browser suite    | `pnpm test:system`  | exit 0, 120 passed, 0 failed, no retries. This config runs the API with `FINALER_SYSTEM_TEST=true` and no `DATABASE_URL`, i.e. the health/static-only path -- this route is not exercised by the browser suite in this configuration (no persistence means `buildApp` is called directly, never `buildPersistentApp`, so `railwayAlerts` is never constructed here), the same situation every other persistence-gated route (Stripe webhook, feedback, billing) is already in for this tier. |

`pnpm --filter @finaler-draft/web test:e2e` was not used -- it does not exist in this repo and
exits 0 having run nothing, per this project's own standing caution. The command actually run was
root `pnpm test:system`, confirmed above to report a real test count (120), not a bare exit code.

## Mutation table

Each mutation was applied by hand with `Edit`, the relevant test command run, the result recorded,
and the code restored to its exact original text before moving to the next row. `git status`/`git
diff` were checked afterward to confirm no mutation left a residue.

| Mutation                                                                                                                         | Must fail                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove the shared-secret check (`app.ts`: `if (false && !secretsMatch(...))`)                                                    | a test asserting an unauthenticated request is rejected | **Failed as required.** Both `railwayAlertsRoutes.test.ts`'s "rejects a request with no shared-secret header at all" and "...with the wrong shared-secret header value" failed (`expected 200 to be 401`, both cases). The complementary "accepts a request with the correct shared-secret header" case was left untouched by this mutation and still passed, confirming the test suite does not pass by rejecting everything.                                                                                                                                                                                                                                                                |
| Make the secret comparison `===` instead of constant-time (`railwayAlerts.ts`'s `secretsMatch`: `return expected === received;`) | a test asserting constant-time comparison is used       | **Failed as required.** `railwayAlertsSecretComparison.test.ts`'s two `timingSafeEqual`-call-count assertions both failed (`expected "spy" to be called 1 times, but got 0 times`). No black-box test of `secretsMatch`'s return value could have caught this -- `===` returns the identical booleans for every functional test case in `railwayAlerts.test.ts`, which is why that mutation is isolated to its own spy-based file.                                                                                                                                                                                                                                                            |
| Register the route even when the secret is unset (`app.ts`: `if (true)` with a fallback `railwayAlerts` object)                  | a test asserting the route is absent when unconfigured  | **Failed as required.** `railwayAlertsRoutes.test.ts`'s "is not registered at all when no railwayAlerts port is supplied" failed (`expected 401 to be 404` -- the route existed and rejected the request for a bad secret, rather than 404ing outright).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Alert on a successful deployment too (`railwayAlerts.ts`'s `isAlertableRailwayEvent`: always `return true`)                      | a test asserting success does not email                 | **Failed as required, non-vacuously.** Three assertions failed: `railwayAlerts.test.ts`'s "does not alert on a successful deployment," "...in-progress deployment transition," and "...operator-initiated removal" unit tests, and `railwayAlertsRoutes.test.ts`'s route-level "acknowledges a successful deployment with 2xx and sends no email" -- which failed on an actual captured email (`expected [...] to deeply equal []`, with the real subject/body in the diff), not on a response-code mismatch. That route-level test also asserts `response.statusCode` is 200 ahead of the "no email" check specifically so a 404/400 can never make the assertion pass for the wrong reason. |
| Remove the dedupe (`app.ts`: `if (false && dedupe.hasSeen(dedupeKey))`)                                                          | a test asserting a retried delivery emails once         | **Failed as required.** `railwayAlertsRoutes.test.ts`'s "emails exactly once despite a retried delivery of the identical event" failed (`expected [...] to have a length of 1 but got 2`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Return 200 when the mail send throws (`app.ts`'s catch block: `return reply.code(200).send({ received: true });`)                | a test asserting a 5xx on send failure                  | **Failed as required.** Both "returns 5xx and sends no email when the mail port throws" and "retries a genuinely new delivery after a failed send, rather than permanently suppressing it" failed (`expected 200 to be greater than or equal to 500`).                                                                                                                                                                                                                                                                                                                                                                                                                                        |

After every mutation was reverted, the full gate list above was re-run in full (not just the
affected test files) and reported the identical green results shown in the Gates table.

## Files changed

- `apps/api/src/railwayAlerts.ts` (new, 279 lines)
- `apps/api/src/railwayAlerts.test.ts` (new, 26 tests)
- `apps/api/src/railwayAlertsRoutes.test.ts` (new, 10 tests)
- `apps/api/src/railwayAlertsSecretComparison.test.ts` (new, 3 tests)
- `apps/api/src/app.ts` (route registration, `BuildAppOptions.railwayAlerts`)
- `apps/api/src/server.ts` (`railwayAlertsConfigured` gate, wiring into `buildPersistentApp`)
- `packages/server-config/src/index.ts` (`RAILWAY_WEBHOOK_SECRET`, `ALERT_MAIL_TO`)
- `packages/server-config/src/index.test.ts` (coverage for both new variables' production-required
  behavior, and the two new fields added to every existing full-success fixture so those tests
  keep exercising a config that actually passes `requirePersistenceEnvironment` end to end)
- `.railway/railway.ts` (both variables declared under `app`'s `env`, with the no-IaC-primitive
  note)

## What remains unverified

- **No real Railway webhook has ever been configured or tested against this route.** Everything
  above is verified against Railway's published documentation and this repository's own test
  suite, not against a live delivery. In particular: the exact custom-header mechanics (whether a
  dashboard-configured header value truly arrives byte-identical, any header-name casing
  Railway's delivery might apply) and the real shape of a volume-usage or resource-alert payload
  (this route's schema and alertability logic for those two categories is written from the docs'
  prose description alone -- "Volume usage alerts," "CPU/RAM monitor alerts" -- never from an
  actual example payload, since Railway's docs do not publish one for either).
- ~~**The `Deployment.crashed` literal is inferred.**~~ **Resolved in review.** The literal was
  checked against Railway's own enumerated event types and is correct; `Deployment.oom_killed` was
  added at the same time, having been missed. The alertable set now rests on published values rather
  than a naming convention. The follow-up idea below is still worth doing, for a different reason
  than the one originally given.
- **No log line surfaces unrecognized `Deployment.*` types.** A type Railway adds later would be
  acknowledged with no email and no trace, because a non-alertable event is indistinguishable from a
  successful one in this route's own logs. Logging every unique `Deployment.*` type seen in
  production would make that discoverable rather than permanently invisible. Not built here.
- **The webhook itself is not created.** `.railway/railway.ts` declares the two environment
  variables the route reads; it does not and cannot declare the webhook registration (the IaC SDK
  has no primitive for it, confirmed above). Someone with dashboard access, or the Railway MCP's
  `create-webhook` tool against the real project, still needs to point a webhook at this route's
  URL with the custom header `x-finaler-draft-webhook-secret` set to the same value as
  `RAILWAY_WEBHOOK_SECRET`. Until that happens, this entire slice is inert in production even
  though every gate and every mutation above passes.
- **`RAILWAY_WEBHOOK_SECRET` and `ALERT_MAIL_TO` are not yet set in the real Railway project.**
  Declaring them in `.railway/railway.ts` as `preserve()` only protects an _existing_ value from
  being deleted by the next `railway config apply` -- it does not create one. Both need to be set
  through `railway config apply` (after filling in real values) or the dashboard before the
  production process will register this route at all; until then, `requirePersistenceEnvironment`
  will throw at the next production deploy's startup, which is the deliberately loud failure mode
  `server-config`'s own comment describes -- not a bug, but not yet exercised against a real
  deploy either.
- **No load-bearing exercise of Railway's actual retry/backoff timing.** The dedupe TTL
  (10 minutes) is sized against the documented worst case (3 retries, 30s timeout each, with
  backoff) but has never been measured against a real delivery sequence.
