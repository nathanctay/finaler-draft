# BIL-1 / BIL-2: Stripe is now the source of truth

Branch `fix/stripe-subscription-source-of-truth`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/billing`, off `144b8fb`.

## Why this scope exists

`audit/02-billing-and-entitlements.md`'s BIL-1 and BIL-2, both High severity, both traced to the
same root cause: `stripeSubscriptions.ts`/`stripeWebhook.ts` derived subscription state from the
webhook event's own payload, guarded by comparing `event.created` (one-second resolution) against
a stored `last_event_created_at`. Two events generated in the same second raced; whichever lost
was discarded _and_ marked processed, so Stripe's redelivery of it was a `duplicate` -- gone for
good (BIL-1). Separately, `invoice.paid`/`invoice.payment_failed` wrote a guessed `status`
(`active`/`past_due`) that never came from the subscription itself, so a customer paying an
overdue invoice on an already-canceled subscription (a real, common Stripe pattern -- open
invoices are not voided on cancellation) could buy a permanent paid tier for the price of one
invoice (BIL-2).

The audit's recommendation, and the brief's instruction, was not to patch the comparison but to
remove it: stop deriving state from the event payload at all. Treat every relevant event as a
signal that something changed, retrieve the subscription from Stripe inside the handler, and
upsert exactly what the API returns. That is what shipped.

## What was built

**`apps/api/src/stripeWebhook.ts`** -- `dispatchStripeEvent` now takes a third argument,
`client: Pick<Stripe, 'subscriptions'>`. For every event type that names a subscription
(`customer.subscription.created`/`.updated`/`.deleted` directly; `invoice.paid`/
`invoice.payment_failed` via `invoice.parent.subscription_details.subscription`), a shared private
helper, `projectSubscription`, reads only the subscription _id_ from the event payload, calls
`client.subscriptions.retrieve(id)`, and builds the `SubscriptionStore` write entirely from the
retrieved object -- status, price, billing period, `cancel_at_period_end`, `canceled_at`, and
`metadata.userId`. The event payload's own `status`/`metadata`/billing fields are never read.
Both event families now route through the identical write path, so an invoice event is no longer a
distinct, narrower write than a subscription event is.

**`apps/api/src/stripeSubscriptions.ts`** -- `recordSubscriptionEvent`'s upsert dropped the
`where subscriptions.last_event_created_at < excluded.last_event_created_at` guard entirely (no
replacement comparison, per the brief: there is no "older" to compare against once every write is
Stripe's own just-retrieved current state). `recordInvoiceEvent` and `InvoiceEventInput` are
deleted outright -- invoice events now produce a full `SubscriptionEventInput` like subscription
events do, so there is only one write method left. `ProcessOutcome` dropped `'stale'`, which is now
unreachable. `eventCreatedAt` is still threaded through and written to `last_event_created_at`
(which stays `not null` -- see "Database boundary" below) but is no longer read back for any
decision.

**`apps/api/src/app.ts`** -- `StripeWebhookPort.client` widened from `Pick<Stripe, 'webhooks'>` to
`Pick<Stripe, 'webhooks' | 'subscriptions'>`, kept as a narrow `Pick` rather than the full `Stripe`
class, matching the file's existing narrowing convention for `BillingPort`/`AccountDeletionStripePort`.
The webhook route's call site now passes `stripe.client` through to `dispatchStripeEvent`. No
change to `server.ts`'s wiring was needed: it already constructs one real `Stripe` instance and
passes it as `client` wholesale, so the widened `Pick` is satisfied automatically.

**`apps/api/src/accountDeletion.ts`, `apps/api/src/stripeCheckout.ts`** -- doc-comment-only edits,
updating two stale citations of `StripeWebhookPort.client`'s old (narrower) type so they stay
accurate.

## The retrieval-failure policy -- decided, and why

A retrieval can fail: network error, a transient Stripe 5xx, a Stripe outage. `projectSubscription`
does **not** wrap the `client.subscriptions.retrieve` call in try/catch. The thrown error propagates
out of `dispatchStripeEvent`, out of the webhook route's handler (which also does not catch it
around that call), into Fastify's existing global error handler, which falls through every named
branch (413, 429, `ZodError`, 4xx) to the generic `request.log.error(...); reply.code(500)` -- a
500, with only the error's name logged, matching this file's established never-log-the-raw-error
discipline.

That matters for one reason: **`SubscriptionStore.recordSubscriptionEvent` is never called when
retrieval throws**, and that store method is the only place that writes a row to
`stripe_processed_events`. So a failed retrieval leaves no ledger row at all. Stripe retries a
non-2xx response, and because nothing was marked processed, the retry is free to actually apply --
it is not misclassified as a `duplicate` of an event that was never really handled. This is the
direct fix for the audit's warning: "do not mark an event processed when it was not applied for an
ordering reason, so redelivery can retry it." A failed retrieval must look, from Stripe's side,
exactly like this endpoint was never reached.

I considered catching the error and calling `recordIgnoredEvent` (mark processed, swallow the
failure) so the webhook always returns 200. Rejected: that silently drops the event forever
(BIL-5's complaint -- "no reconciliation path" -- made permanent at exactly the place meant to fix
BIL-1/BIL-2) and reintroduces the discarded-event defect in a new shape. Letting Stripe's own
retry/backoff machinery handle a transient failure is the documented, boring, correct choice here.

**What this does not solve** (flagged, not fixed, since it's a different failure mode): if the
subscription id itself is permanently unreachable -- not a transient outage -- every retry fails
the same way, and Stripe stops retrying after about three days (BIL-5, Medium severity, out of
this slice's scope). I did not add special handling for "retrieval failed because the resource
is genuinely gone" versus "retrieval failed because the network blipped"; both propagate identically
today. That distinction, and any reconciliation sweep, is BIL-5's job.

## Database boundary

Per the brief's hard constraint, `packages/database/` was not touched and no migration was added.
`subscriptions.last_event_created_at` stays `not null` in the schema, so `recordSubscriptionEvent`
still writes a value to it on every insert/update (there is nothing else it could write without a
schema change) -- but nothing anywhere reads it back to make a decision anymore. This is a
deliberate, narrow exception to "stop using it": the column is populated because the `not null`
constraint requires _some_ value, not because its value means anything to this code now. Dropping
the column would be the natural follow-up but is a migration, correctly out of scope here.

I did not find any point where the schema actually needs to change for this fix -- the existing
columns are sufficient for a pure-upsert, no-ordering-guard design. `packages/database/src/schema.ts`
line 527's comment ("`recordSubscriptionEvent`/`recordInvoiceEvent` for the upsert that enforces
this") is now stale, since `recordInvoiceEvent` no longer exists -- flagged here rather than edited,
since that file is the other agent's territory.

## Gates, verbatim, with real exit codes

All run from `/Users/nathan/Documents/finaler-draft-worktrees/billing` after
`pnpm install --frozen-lockfile` and `pnpm build:packages` (required before `typecheck` can resolve
workspace package types at all -- confirmed this is a pre-existing requirement, not something this
slice introduced, by reading the root `package.json`'s own `typecheck` script).

```
pnpm --filter @finaler-draft/api typecheck
```

Exit code **0**. Clean, no output beyond the `tsc` invocation line.

```
pnpm lint
```

Exit code **0**. `eslint . --max-warnings=0`, clean, no output.

```
pnpm format:check
```

First run failed (exit 1) on `apps/api/src/stripeWebhook.test.ts` -- a real prettier formatting
issue in the new test file, not a false alarm. Fixed with `prettier --write` on that one file only.
Second run: exit **0**, `All matched files use Prettier code style!`.

```
pnpm --filter @finaler-draft/api test
```

Exit code **0**. **442 tests passed**, 145 skipped (the `*.integration.test.ts` files, expected
without `TEST_DATABASE_URL`). `stripeWebhook.test.ts` itself: 27/27 passed.

```
docker run -d --name bil-test-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/postgres" pnpm --filter @finaler-draft/api test
```

Exit code **0**. **587 tests passed**, 0 skipped -- every integration suite ran, not just this
slice's own. `stripeSubscriptions.integration.test.ts`: 8/8 passed.

```
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/postgres" pnpm test
```

Full monorepo, every package, exit code **0**: `config` 9, `collab-token` 9, `entitlements` 25,
`screenplay` 172, `server-config` 27, `database` 66, `xml-escape` 9, `landing` 31, `auth-server` 27,
`docx` 58, `layout` 72, `fdx` 127, `screenplay-editor` 143, `pdf` 61, `api` 587, `collab` 213,
`web` 1330. Nothing in this diff touches `apps/collab`, `apps/web`, or any package other than
`apps/api`; their green runs are the expected no-regression baseline, not evidence specific to
this fix.

```
docker rm -f bil-test-pg
```

Container removed; confirmed absent with a follow-up `docker ps -a --filter name=bil-test-pg`.

Per the brief's note about machine load: I ran package-scoped (`pnpm --filter @finaler-draft/api
...`) for every iteration while mutation testing, and only ran the full `pnpm test` twice (once
without, once with `TEST_DATABASE_URL`) -- both exit 0, no 5000ms-timeout-shaped failures observed
in either run.

## Mutation testing

Every row below was: mutated in the actual source file, the specific test run and its real
pass/fail recorded, then reverted to the exact prior text (never via `git checkout`, since nothing
in this worktree is committed -- that would have discarded the whole fix), then re-run to confirm
green again. All four rows are from the brief's table.

| #   | Mutation                                                                                                                                                                                                                                     | Must fail                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `projectSubscription` catches the retrieval error and calls `recordIgnoredEvent` (marks processed) instead of letting it propagate                                                                                                           | a test asserting the ledger has no row, so Stripe can retry                              | **Failed as required.** `dispatchStripeEvent > a failed retrieval rejects and never calls the store, so the event is not marked processed`: `AssertionError: promise resolved "'ignored'" instead of rejecting`. Also failed `POST /api/webhooks/stripe > returns 500 when the retrieval fails, and a subsequent retry with the same event.id still applies`: `expected 200 to be 500`. Reverted; `stripeWebhook.test.ts` 27/27 green again.                                                                                                                                                                                                       |
| 2   | `dispatchStripeEvent`'s invoice branch passes a `forcedStatus` (`'active'`/`'past_due'` by event type) into `projectSubscription`, which uses it instead of the retrieved subscription's own `status`                                        | a test asserting a paid invoice on a canceled subscription leaves the row canceled       | **Failed as required.** `dispatchStripeEvent > BIL-2: invoice.paid on a canceled subscription leaves the row canceled, not active`: expected `status: 'canceled'`, got `'active'`. Also failed the paired `invoice.payment_failed applies the retrieved status, not a hardcoded past_due` test (expected `'active'`, got `'past_due'`) -- proving the mutation broke both directions, not just the one the table names. Reverted (removed the `forcedStatus` parameter and its one call site); `stripeWebhook.test.ts` 27/27 green again.                                                                                                          |
| 3   | `recordSubscriptionEvent`'s upsert SQL has the `where subscriptions.last_event_created_at < excluded.last_event_created_at returning user_id` clause reinstated, with the outcome reading `result.rowCount === 1 ? 'applied' : 'unresolved'` | a test asserting two same-second events both apply                                       | **Failed as required**, against the real Postgres integration suite (the fake store in `stripeWebhook.test.ts` has no SQL to mutate, so this row can only be proven at the integration level -- confirmed by running it there). `stripeSubscriptions.integration.test.ts > applies two distinct events that share the exact same eventCreatedAt second, both writing their own state`: expected `'applied'`, got `'unresolved'`. Also failed `applies an event whose eventCreatedAt is earlier than the currently stored row, since there is no ordering guard` the same way. Reverted; `stripeSubscriptions.integration.test.ts` 8/8 green again. |
| 4   | `projectSubscription` skips `client.subscriptions.retrieve` entirely and casts `event.data.object` directly as the subscription                                                                                                              | a test asserting the stored status came from the retrieved subscription, not the payload | **Failed hard.** 18 of 27 tests in `stripeWebhook.test.ts` failed -- every test that depends on retrieval returning a well-formed `Subscription` (the payload builders in this file deliberately carry only an `id` plus bait fields, so casting the payload directly either reads `undefined.items` or produces a payload-sourced status/metadata mismatch), including the specific target test, `dispatchStripeEvent > projects customer.subscription.created from the retrieved subscription, not the payload`. Reverted; `stripeWebhook.test.ts` 27/27 green again.                                                                            |

After every revert, `grep -rn "MUTATION-UNDER-TEST" apps/api/src` returned no matches and
`git diff --stat` matched the intended change set exactly (the same 7 files listed above, nothing
else) -- confirming nothing was left half-reverted.

## What remains unverified

- **No real Stripe sandbox or `stripe listen` session was exercised.** Every retrieval test uses a
  fake `Pick<Stripe, 'subscriptions'>`, not a live Stripe test-mode account. I verified the
  _shape_ of `Stripe.Subscription`/`Stripe.Invoice` against this project's pinned API version
  (`2026-07-29.dahlia`) and the installed SDK's own `.d.ts` files (same fields `stripeWebhook.ts`'s
  pre-existing module comment already documents as relocated for this version), but I did not
  confirm end to end against Stripe's actual infrastructure that `subscriptions.retrieve` behaves
  as documented for every event type in production. This is the same limitation the predecessor
  billing-webhook slice recorded for the same reason (no live sandbox access from this
  environment).
- **The added outbound Stripe API call's latency/availability impact on webhook processing is not
  measured.** Before this fix, the webhook handler never left the process to do its work; now
  every relevant event makes one synchronous call to Stripe before it can be marked processed.
  I did not load-test this or check it against Stripe's own webhook response-time expectations
  (Stripe does have one, though I did not re-verify its exact threshold here), and no production
  call volume was exercised.
- **A duplicate delivery still triggers a wasted retrieval before the dedupe check runs**, since
  `markProcessed` lives inside `recordSubscriptionEvent`'s transaction, which is only reached after
  retrieval already succeeded. I deliberately did not add a cheap pre-check SELECT against
  `stripe_processed_events` ahead of the retrieval to avoid reintroducing the exact
  select-then-insert race `markProcessed`'s own comment warns against for a different reason. This
  costs one extra, otherwise-pointless Stripe API call per redelivered event -- correct, not free.
  Not benchmarked against Stripe's own redelivery volume.
- **BIL-5 (no reconciliation path) is unaddressed, by design** -- out of this slice's scope per the
  brief. A retrieval failure that is not transient (subscription genuinely unreachable) still
  exhausts Stripe's ~3-day retry window with no sweep to recover it afterward.
- **`packages/database/src/schema.ts`'s stale comment** (line 527, naming the now-deleted
  `recordInvoiceEvent`) was flagged above but not edited, per the hard boundary against touching
  that package.
- I did not attempt to reproduce a genuine two-API-call race against a live Stripe account (two
  real events landing in the same wall-clock second) -- the same-second scenario is proven at the
  code level (two calls with an identical `eventCreatedAt` both applying) rather than observed from
  real Stripe traffic, matching the audit's own "Evidence: Inferred" label for the Stripe-timing
  half of BIL-1.
