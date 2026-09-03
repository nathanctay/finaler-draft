# Stripe billing: the purchase path

Branch `feature/billing-checkout`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/billing-checkout`, off `e692520`.

## Why this scope exists

Slices 1 and 2 (`progress/billing-webhook.md`, `progress/billing-entitlements.md`) built the trust
boundary up through server-side enforcement: a `subscriptions` projection the webhook keeps
current, and `checkEntitlement` gating every screenplay write. Neither built any way for a writer
to actually become a paying customer, or to manage a subscription once they have one -- slice 1's
own known-limitations section says so explicitly, and flags the exact seam this slice closes:
`metadata.userId` on the Checkout Session is what lets the webhook resolve a Stripe customer back
to a Better Auth user in the first place. This slice builds Checkout Session creation, Customer
Portal session creation, the UI to reach both, and the prompt a free writer sees on hitting the
one-screenplay limit. It deliberately does not build the lapse "choose which screenplay stays
editable" chooser (`PUT /api/entitlement/editable-screenplay` already exists and is untouched) --
that is its own slice.

## What shipped

**1. `apps/api/src/stripeCheckout.ts`** (new) -- `buildCheckoutSessionParams` (pure parameter
construction) plus `createCheckoutSession` and `createPortalSession`, both taking a `BillingPort`
(`client` narrowed to `Pick<Stripe, 'checkout' | 'billingPortal'>`, mirroring `StripeWebhookPort`'s
own narrowing convention in app.ts; `store` narrowed to `Pick<SubscriptionStore,
'getSubscriptionForUser'>`; `priceIds`; `appOrigin`).

**2. Routes** (`apps/api/src/app.ts`): `POST /api/billing/checkout-session` (body `{ plan: 'monthly'
| 'annual' }`, `.strict()`) and `POST /api/billing/portal-session` (no body), both behind the same
authenticated-actor, same-origin `preValidation` hook `/api/entitlement` already shares, extended to
also match `/api/billing`. Both always act on `request.actorId!` -- the strict input schema admits
no field that could name a different actor, which is the entire answer to "a user cannot create a
billing session for another user."

**3. `EntitlementLimitError` now maps to 402, not 403** (`apps/api/src/app.ts`, the
`POST /api/projects/:id/screenplays` route). This is a deliberate change from slice 2's original
403, made because this slice adds the first client that needs to react specifically to "you must
pay to do this" -- 402 Payment Required is the status HTTP actually reserves for that, and
`ForbiddenError`'s plain membership 403 stays exactly what it was. The route's response schema
gained `402: errorResponseSchema` alongside the existing `403`.

**4. Server wiring** (`apps/api/src/server.ts`): one real `Stripe` client instance, constructed
once and shared between the webhook route's `stripe` option and the new `billing` option (both are
narrowed views of the same client -- no reason to hold two connections to the same API).
`appOrigin` resolves as `persistence.CLIENT_ORIGIN ?? persistence.BETTER_AUTH_URL`, the identical
fallback `auth.ts`'s `trustedOrigins` and `apps/web/src/api.ts`'s `appUrl` already use.

**5. Web API client** (`apps/web/src/api.ts`): `api.entitlement()`, `api.createCheckoutSession(plan)`,
`api.createPortalSession()`. `api.createScreenplay` now goes through a new `jsonWithServerMessage`
helper instead of the plain `json` helper every other call uses, throwing a new `MessageApiError`
(carries `serverMessage`) instead of the bare `ApiError` -- the one write that can hit the 402
free-tier limit needed to keep the server's actual explanation, not throw it away.

**6. UI** -- `apps/web/src/upgradeDialog.tsx` (new): a hand-built modal, following
documentSettingsDialog.tsx's own established pattern (jsdom has no
`HTMLDialogElement.showModal`), offering "Upgrade monthly" / "Upgrade annually", each starting a
Checkout Session and redirecting the tab via `externalRedirect.ts` (new -- the same
wrap-a-browser-side-effect-in-its-own-tiny-module pattern `docxDownload.ts`/`fdxDownload.ts` already
use, so tests intercept it instead of fighting jsdom's unimplemented navigation). Reached from two
places:

- The account menu (`routes/projects/index.tsx`): "Upgrade to Pro" for a restricted account,
  "Manage billing" for a paid one -- never both, never either until entitlement state is actually
  known.
- The free-tier limit prompt (`routes/projects/$projectId/index.tsx`): an inline
  `role="alert"` banner showing the server's own message (`EntitlementLimitError`'s text) plus an
  "Upgrade to Pro" button, replacing what was previously no error handling at all on that mutation.
  This is the thing the task asked for by name: "say what is happening and offer the upgrade, not
  present a bare error."

**7. Success and cancel pages** (`apps/web/src/routes/billing.success.tsx`,
`billing.canceled.tsx`, new) -- see "The rule that must not bend" below for what the success page
deliberately does and does not do.

**8. `components/OverflowMenu.tsx` gained an optional `onOpenChange` callback.** Not part of the
original plan; added mid-slice to fix a real regression -- see "A regression, found and fixed" below.

## `customer_update` / address handling: what I chose and why

Never set, in either direction. For an existing customer, the task's own guidance is that Checkout
uses the address already on file unless `customer_update: { address: 'auto' }` is set _and_
Checkout is made to collect a fresh one -- there is no product reason here to prefer a
freshly-typed address over the one already on record, so the simpler default (use what's saved) is
kept. For a brand-new customer, `billing_address_collection` is likewise left unset (Checkout's own
`auto` default) rather than forced to `'required'`, matching the explicit instruction not to add
friction: Checkout collects whatever address it needs for `automatic_tax` on its own.

## `metadata.userId`: how it reaches the webhook, and why it's on both objects

Set at two places in `buildCheckoutSessionParams`: the Checkout Session's own top-level `metadata`,
and `subscription_data.metadata` (copied onto the Subscription object Checkout creates). Both,
deliberately, not either:

- **`subscription_data.metadata` is the one that matters for correctness.** `progress/billing-webhook.md`
  records the exact seam: the webhook resolves a Stripe customer to a Better Auth user by reading
  `subscription.metadata.userId` -- the field on the _Subscription_, since `customer.subscription.*`
  events never carry the originating Checkout Session's own metadata. Without this, no real
  subscription event would resolve to a user on its first event, exactly as slice 1's known
  limitations warned.
- **Session-level `metadata` is independently useful, not redundant filler.** A Checkout Session and
  its own events are then also traceable to a user (support lookups, reconciliation) without
  needing the subscription to exist yet. It costs nothing to set.

`createCheckoutSession` also reuses an existing Stripe customer id from the `subscriptions`
projection (`store.getSubscriptionForUser`) when the account already has one -- a lapsed or
canceled account resubscribing -- rather than letting Stripe mint a duplicate customer on every
checkout, per the task's explicit instruction. A user with no subscription row at all gets no
`customer` param, so Stripe creates a fresh one and Checkout collects whatever it needs directly.

## The rule that must not bend

plan.md, quoted directly in the task: **"The Checkout success redirect is not proof of payment. A
user can navigate to the success URL directly ... Granting access on redirect is the single most
common way subscription integrations leak paid features."**

This is enforced architecturally, not by convention: `createCheckoutSession` never writes to
`store` or any other persistence -- the `BillingPort` it's given only exposes
`getSubscriptionForUser`, a read. There is no write method available to call even by accident.
Only `stripeWebhook.ts`'s `dispatchStripeEvent`, processing a signature-verified event, ever
writes the `subscriptions` table -- that code path is completely disjoint from anything this
slice's routes touch.

`routes/billing.success.tsx` obeys the same rule by construction: it makes exactly one network
call, a plain `GET /api/entitlement`, and shows a pending ("Thanks -- finishing up") or confirmed
("You're on Finaler Draft Pro") message depending on what that read reports, never asserting
success it cannot yet prove.

**Proof, not just the comment claiming it:**

- `apps/api/src/app.test.ts`'s `'creating a Checkout Session grants no entitlement by itself -- only
the webhook can'` creates a real Checkout Session against a mocked Stripe client, then immediately
  reads `GET /api/entitlement` with no webhook event ever delivered, and asserts the tier is still
  `'restricted'`.
- `apps/api/src/stripeCheckout.test.ts`'s `'never writes to the subscription store'` asserts
  `getSubscriptionForUser` was called exactly once (the customer-id lookup) and nothing else, on a
  store whose only exposed method is that read.
- `apps/web/src/routes/billing.success.test.tsx`'s `'makes no request that could grant anything'`
  asserts `fetchMock` was called exactly once, with `GET /api/entitlement`, and nothing else.

## A regression, found and fixed

Running the full gate list surfaced a real problem the unit and integration suites could not see:
`TEST_DATABASE_URL=... pnpm test:system:persistence` went from 18/18 (both prior slices' recorded
baseline) to 16/18, then, after a first fix, 17/18 -- always in
`page-rendering-persistence.spec.ts`, always failing to find the editor canvas or an expected
heading within Playwright's default 5-second assertion timeout.

**Diagnosed, not assumed:** `git stash -u` reverted this worktree to the exact base commit
(`e692520`), and the identical gate command passed 18/18 twice in a row on that clean tree, proving
the regression was real and caused by this slice, not environmental noise. Popping the stash and
re-running confirmed it reappeared.

**Root cause:** `routes/projects/index.tsx`'s account menu originally fired a real
`GET /api/entitlement` unconditionally on every mount (`entitlement.data?.tier` decides which
billing item to show). That endpoint's own handler, `getSnapshot`, runs three parallel SQL queries.
Every one of the system suite's many flows touches `/projects` at least once, so this added real,
non-trivial backend load to a hot path under the concurrency of Playwright's 3 workers sharing one
real Postgres instance and one real API process.

**The fix, in two parts:**

1. **`components/OverflowMenu.tsx` gained an optional `onOpenChange` callback**, fired on every
   open/close transition from every path that changes it (trigger click, ArrowDown, Escape,
   selecting an item, losing focus). `ProjectsPage` uses it to flip `accountMenuOpened` to `true`
   on first open, and the `['entitlement']` query is now `enabled: accountMenuOpened` -- it never
   fires until the account menu is actually opened once, since entitlement state is shown nowhere
   else on that page. Verified this alone did not fully account for the load: `--workers=1`
   (bypassing cross-worker contention entirely) passed 18/18 with `page-rendering-persistence.spec.ts`'s
   "zoom modes" test timing essentially identical to the original clean baseline (2.5s vs 2.6s), which is
   the decisive evidence that the _remaining_ default-run failure (below) is contention-shaped, not a
   further logic gap.
2. **`UpgradeDialog` is now lazy-loaded** (`React.lazy` + `Suspense`, wrapped exactly like
   `$projectId.screenplays.$screenplayId.tsx`'s own `EditorWorkspace`) from both call sites, rather
   than a static top-level import. A static import put it (and its own `useMutation`/api.ts
   dependency) in the eagerly-loaded chunk graph of two of this app's hottest routes; lazy-loading
   confirmed a genuinely separate chunk in the build output (`upgradeDialog-*.js`, 1.75 kB gzip
   0.85 kB) that most page visits never fetch.

**Result: 16/18 to 17/18, and the failure count and identity became deterministic** (always the
same single test, `page-rendering-persistence.spec.ts`'s "zoom modes" -- the file's last test,
sequentially the tail of that file's own worker after nine prior heavy real-editor tests) rather
than shifting between different tests run to run, as it did before the fix. `--workers=1` passes
18/18 cleanly and repeatably; the default (3-worker) run still fails this one test, reliably,
across every run performed. I judge the remaining gap a real but small residual cost (confirmed
negligible in isolation by the `--workers=1` timing) that compounds across `page-rendering-persistence.spec.ts`'s
long sequential chain specifically under this machine's 3-worker CPU contention, not a functional
defect in the shipped feature. Closing it further would mean either reducing unrelated existing
app payload (outside this slice's scope) or loosening this test file's own timeout margin, which is
shared test infrastructure I should not silently change. **Flagging this for the owner rather than
either hiding it or leaving the gate output unexplained.**

## Tests

**Unit** (`apps/api/src/stripeCheckout.test.ts`, 21 tests): `buildCheckoutSessionParams` --
mode, price selection for both plans, `metadata.userId` on both the session and
`subscription_data`, `automatic_tax: { enabled: true }`, the integration identifier carried
through, `customer` present/absent correctly, `success_url`/`cancel_url` passed through exactly --
and, explicitly asserting _absence_, not falsiness: no `payment_method_types`, no
`trial_period_days`, no `customer_update`, no forced `billing_address_collection`.
`CHECKOUT_INTEGRATION_IDENTIFIER` matches `finaler-draft-checkout-[a-z]{8}` and stays identical
across separate sessions (proving it's a stable per-process label, not per-session random).
`createCheckoutSession`/`createPortalSession` against a fake `BillingPort`: new vs. existing
customer, monthly vs. annual pricing, the never-writes-to-the-store proof, throwing when Stripe
returns no url, and the Portal's `'no-customer'` outcome never calling Stripe at all.

**Route** (`apps/api/src/app.test.ts`, new `'billing checkout API'` describe block, 7 tests):
unauthenticated 401 for both routes; a body naming another user (`userId`) rejected 400 by the
strict schema; a successful checkout session created for the authenticated actor only, url
returned; Portal 404 for a never-subscribed account, 200 with url for an existing customer; the
success-redirect-grants-nothing proof. Plus one addition to the existing `'persisted project API'`
describe block: `EntitlementLimitError` now maps to 402 with the exact server message, alongside
the pre-existing `'forbidden'` 403 test right next to it for contrast.

**Web unit**, following `App.test.tsx`'s Testing Library conventions: `upgradeDialog.test.tsx` (11
tests -- rendering with/without a reason, both plans starting checkout and redirecting, the error
state, Escape/Close/Tab-trap keyboard operation); `externalRedirect.test.ts` (1 test, the
`window.location` stand-in `App.test.tsx` itself already establishes); `routes/billing.success.test.tsx`
(4 tests, including the grants-nothing proof) and `billing.canceled.test.tsx` (2 tests);
`api.test.ts` additions (`entitlement`/`createCheckoutSession`/`createPortalSession` folded into
the existing exhaustive sequential test, plus a dedicated `'createScreenplay error reporting'`
block for `MessageApiError`); `components/OverflowMenu.test.tsx` additions (`onOpenChange` fires on
every transition, and is safely omittable); `routes/projects/index.test.tsx` additions (account
menu shows the right billing item for each tier, neither while unknown, Manage billing redirects to
the Portal url); `routes/projects/$projectId/index.test.tsx` addition (the full limit-prompt flow:
banner text, opening the dialog, starting checkout from it); `routes/projects/index.delete.test.tsx`
addition (the account-menu-open-gates-the-fetch regression itself, proven directly: no
`/api/entitlement` call until the menu opens, exactly one call after, no second call on
close-then-reopen).

## Mutation testing

Every mutation below was applied, confirmed to fail the specific test(s) it should, then reverted;
`git diff` against a pre-mutation backup confirmed byte-identical restoration after each one and
again at the end of the whole sequence.

1. **Added `payment_method_types: ['card']` to `buildCheckoutSessionParams`.** Failed exactly
   `'never sets payment_method_types -- hardcoding it silently disables every other method'`; the
   other 20 tests in `stripeCheckout.test.ts` stayed green. **This is the one that matters most**,
   per the task.
2. **Removed `metadata: { userId }` from the session** (kept `subscription_data.metadata`).
   Failed both `'stamps metadata.userId on both the session and the subscription it creates'` and
   `createCheckoutSession`'s `'creates a new customer'` test (which also reads `params.metadata`);
   19 of 21 stayed green. **The other mutation that matters most** -- this field is the only link
   between a payment and a user.
3. **`automatic_tax: { enabled: false }`.** Failed exactly `'enables automatic tax'`; 20/21 green.
4. **Added `trial_period_days: 14` to `subscription_data`.** Failed exactly `'never sets
trial_period_days'`; 20/21 green.
5. **`checkoutSessionInput` schema's `.strict()` removed.** Failed exactly `'rejects a body naming
another user'` in `app.test.ts` (a `userId` field is now silently accepted rather than rejected
   with 400); the six other billing-route tests stayed green.
6. **`EntitlementLimitError` mapped back to 403.** Failed exactly the new 402-mapping assertion in
   the `'persisted project API'` describe block; the paired `'forbidden'` 403 test right next to it,
   and the other 32 tests in that describe block, stayed green.
7. **`upgradeDialog.tsx`'s monthly button wired to `checkout.mutate('annual')`.** Failed exactly
   `'starts a monthly Checkout Session and redirects to the returned url'`; the paired annual-button
   test stayed green.
8. **`$projectId/index.tsx`'s limit-prompt status check changed from `402` to `403`.** Failed exactly
   the limit-prompt test (the banner never renders, since the mocked failure is 402); the sibling
   create/navigate test stayed green.
9. **`routes/projects/index.tsx`'s tier branching swapped** (`'restricted'` shows "Upgrade to Pro"
   and `'paid'` shows "Manage billing" -- backwards). Failed both the restricted-account and
   paid-account account-menu tests; the other seven tests in that file stayed green.
10. **`api.ts`'s `jsonWithServerMessage` stopped reading the response body**, always falling back
    to the generic `Request failed (${status})` message. Failed exactly `'keeps the
server-provided message from a 402 free-tier-limit response'`; the paired
    no-usable-body fallback test, and the rest of `api.test.ts`, stayed green.

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

Clean across every package (including the two new files' packages, `api` and `web`) and both apps.

```
pnpm test
```

`apps/api`: 12 test files passed, 3 skipped (the `*.integration.test.ts` files, expected without
`TEST_DATABASE_URL`) -- **196 tests passed**, 40 skipped (168 pre-existing + 28 new: 21 in
`stripeCheckout.test.ts`, 7 in the new `'billing checkout API'` block in `app.test.ts`; the 402
mapping test replaces no existing assertion, it's additive within an existing `it`).
`apps/web`: 41 files, **589 tests passed** (562 pre-existing baseline + 27 new: 11 `upgradeDialog.test.ts`

- 1 `externalRedirect.test.ts` + 4 `billing.success.test.tsx` + 2 `billing.canceled.test.tsx` + 2
  `api.test.ts` + 2 `OverflowMenu.test.tsx` + 3 `routes/projects/index.test.tsx` + 1
  `routes/projects/$projectId/index.test.tsx` + 1 `routes/projects/index.delete.test.tsx`). Every
  other package unchanged and green (`config` 1, `server-config` 17, `screenplay` 118, `database` 4,
  `xml-escape` 9, `fdx` 45, `docx` 58, `layout` 72, `pdf` 61).

```
pnpm --filter @finaler-draft/web test:coverage
```

589 tests passed. `upgradeDialog.tsx` -- the one file this slice added that needed dedicated
coverage attention -- sits at 95.29%/85.71%/100%/95.29% (stmt/branch/func/line) after adding
Tab-trap and initial-focus tests explicitly for it; every other file stays at or above the existing
80% per-file threshold. Exit 0.

```
pnpm check:bundle-budget
```

```
[bundle-budget] ok   Entry chunk        assets/index-BoYOUQWd.js      111.57 kB / 120.00 kB budget
[bundle-budget] ok   Lazy editor chunk  assets/App-gP26QUO1.js        115.16 kB / 200.00 kB budget
[bundle-budget] ok   CSS                assets/index-B4_2Yp4p.css       5.85 kB / 20.00 kB budget

All bundle artifacts are within budget.
```

Entry chunk grew 0.17 kB gzip over slice 2's recorded baseline (111.40 kB) despite adding the
entitlement/billing API surface to api.ts -- the lazy-loaded `UpgradeDialog` (its own 1.75 kB / gzip
0.85 kB chunk, `upgradeDialog-*.js`) and the two new billing route chunks (`billing.success-*.js`,
`billing.canceled-*.js`, both under 1 kB) stay out of the entry and editor chunks entirely.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm --filter @finaler-draft/api test:integration
```

**40 tests passed** (20 pre-existing persistence + 11 pre-existing Stripe subscription + 9
pre-existing entitlement), 0 failed -- matching slice 2's baseline exactly. This slice added no new
integration tests: `createCheckoutSession`/`createPortalSession` need only `getSubscriptionForUser`,
already exercised by slice 1's integration suite, and neither writes to the database at all (see
"The rule that must not bend").

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm test:system:persistence
```

**17 of 18 passed.** One failure, reproduced identically across every run at the default
(3-worker) setting: `page-rendering-persistence.spec.ts`'s "zoom modes: real editor, real DOM ..."
test, timing out at the same `getByRole('textbox', { name: 'Screenplay editing canvas' })` visibility
check inside its shared `createAndOpenScreenplay` helper. See "A regression, found and fixed" above
for the full diagnosis: this was 16/18 before a fix, is now 17/18, and `--workers=1` on the
identical code passes 18/18 with that same test's own timing essentially matching the original
clean baseline (2.5s vs. 2.6s) -- strong evidence the residual gap is a small, real cost that only
surfaces as a failure under this environment's specific 3-worker contention, not a functional
defect. **This is the one gate this slice does not close clean, and it is reported as such rather
than glossed over.**

## Credential audit

No credential appears anywhere in the diff. Grepped the full diff for `sk_live_`, `rk_live_`, and
`whsec_`/`price_`/`cus_`/`sub_`/`cs_`/`bps_` followed by opaque-looking characters: every match is an
explicitly-fake test fixture (`price_test_FAKE_monthly`, `cus_test_FAKE_existing`,
`cs_test_FAKE_1`, etc.), short and clearly labelled enough that none could be mistaken for a real
Stripe identifier. No `.env` file was read, created, or modified. No `git add`, `git commit`,
`git push`, or `gh pr create` was run -- `git status`/`git diff`/read-only inspection only, plus
`git stash -u` / `git stash pop` used solely to bisect the system-test regression against the clean
base commit (verified via `git diff` against pre-stash backups that the pop restored this
worktree's state exactly).

## Known limitations / decisions for a later slice to pick up

- **`test:system:persistence` is 17/18, not 18/18, at the gate's literal default settings** -- see
  above. Owner attention needed: either accept this as a known contention-sensitive margin on this
  specific test file (it was already the suite's heaviest, longest sequential chain before this
  slice), or decide whether `page-rendering-persistence.spec.ts`'s default assertion timeout should
  be loosened for its own heaviest tests -- a call on shared test infrastructure I did not make
  unilaterally.
- **No `customer_email` is passed to Checkout for a brand-new customer.** Correlation to a Better
  Auth user depends entirely on `metadata.userId`, never on email, so this doesn't affect
  correctness -- but Checkout will ask a signed-in writer to type an email it could have prefilled
  from their session. Left out as a deliberate scope-minimization, not an oversight; a later slice
  could thread the session's own email through if the friction turns out to matter.
- **The Portal's `return_url` is a fixed `/projects`.** Reasonable given Portal sessions are only
  ever started from the account menu on that page today, but if a future slice adds a
  billing-management entry point elsewhere, the return destination may want to become
  caller-supplied rather than hardcoded here.
- **No Stripe CLI / test-clock exercise of the actual Checkout flow against a live sandbox** --
  same limitation slice 1 recorded, for the same reason (no live Stripe sandbox access from this
  environment). Coverage here is unit + route + the architectural proof that success-redirect
  grants nothing; not an end-to-end run against Stripe's own test-mode infrastructure.

## Follow-up: a cancelled subscription no longer says "Renews on"

`routes/billing.subscription.tsx` already read `cancelAtPeriodEnd` for its status line
("Cancels on" vs. "Renews on"), but that was the only place the cancellation showed: the Pro
card's action area still collapsed to a bare "Current plan" badge with no button once
`proMatchesSelectedInterval` was true, exactly as it does for a normal renewing subscriber -- so a
cancelled-but-still-paid writer had no way to act on their own plan from this page (the account
menu's "Manage billing" still worked, but nothing on this page itself did). Data was already fully
plumbed end to end (`packages/database/src/schema.ts:161-162`,
`apps/api/src/stripeWebhook.ts:88-89`, `apps/api/src/app.ts:317-318`) -- this was presentation
only, no schema/webhook/route change.

**What changed**, all in `routes/billing.subscription.tsx` plus the matching CSS:

- A new `isCancelledCurrentPlan` derivation (`proMatchesSelectedInterval &&
current?.cancelAtPeriodEnd === true`) is the single switch between three Pro-card states: actively
  renewing (unchanged -- badge only), cancelled-but-current (badge _and_ a button), and not the
  selected plan at all (unchanged -- button only).
- **Wording**: "Cancels on \<date\>" became "Active until \<date\>", plus its own explicit line,
  "Cancelled -- won't renew after this date." "Active until" was chosen over keeping "Cancels on"
  because the date itself is the last day of _active_ access, not the moment anything stops --
  "Cancels on \<date\>" reads as if access ends abruptly _before_ that date; the cancellation fact
  itself now has its own sentence so it isn't inferred solely from the date's label.
- **CTA**: the cancelled-but-current state now shows the "Current plan" badge (it still is their
  plan) _and_ a "Resume subscription" button beneath it (new `.plan-card-current-actions`
  wrapper in `styles.css`, `display: flex; flex-direction: column; gap: 8px`), rather than the
  bare badge a renewing subscriber gets. The button calls the same `switchToPro` -> `portal.mutate()`
  path every other Portal button on this page already uses -- no new endpoint, no new mutation.
  This works because the owner's live Portal configuration has `subscription_cancel` enabled with
  `mode: 'at_period_end'`, which is exactly what offers to un-cancel a subscription already in this
  state; "Do not hand-build subscription management UI" (plan.md, quoted in the task) ruled out
  building a dedicated resume flow.
- The Portal's `subscription_update: { enabled: false }` (plan switching disabled at the Dashboard
  level, raised with the owner separately) was left exactly as documented above -- the
  interval-switch affordance is untouched, and nothing here works around or assumes anything about
  that account-level setting.

**Tests** (`routes/billing.subscription.test.tsx`): the existing single assertion for this state
was expanded into its own `describe` block (3 tests) covering the new wording, the CTA's presence
in place of the bare badge, and that the CTA opens the Portal (never a fresh Checkout Session).
Free tier and the plain-renewing/fully-lapsed states were already covered by existing tests in the
same file and needed no changes. File total: 14 -> 15 tests; suite total: 612 -> 614.

**Mutation testing**: reverted the "Active until"/cancellation-note branch back to always
rendering "Renews on" (the exact defect this change fixes) -- failed exactly the wording test, the
other 14 tests in the file stayed green. Separately reverted the CTA back to a bare "Current plan"
badge with no button in the cancelled state -- failed exactly the two CTA tests (presence and
Portal-opening), the wording test and the rest of the file stayed green. Both mutations reverted
and `git diff` confirmed a byte-identical restoration.

**Gates, this change only** (full app already verified clean by the prior pass; re-run after this
change):

```
pnpm lint            -- clean, exit 0
pnpm format:check     -- exit 0 (after `prettier --write` on the new test's own formatting)
pnpm typecheck        -- exit 0
pnpm test             -- apps/web: 43 files, 614 tests passed, exit 0
pnpm --filter @finaler-draft/web test:coverage
                       -- 614 tests passed; billing.subscription.tsx 98.33%/89.65%/100%/98.33%
                          stmt/branch/func/line -- the three uncovered lines (205, 235, 238) are
                          pre-existing branches this change didn't touch (the no-price-yet '—'
                          fallback and the two isPending in-flight labels), not new gaps; every
                          file stays at or above the 80% per-file threshold. Exit 0.
pnpm check:bundle-budget
                       -- all three budgets ok (entry 111.65 kB/120 kB, lazy editor 115.16 kB/200
                          kB, CSS 6.16 kB/20 kB). Exit 0.
```

`test:system:persistence` was not re-run for this change -- it touches no route, no query key, and
no network call this page's mount didn't already make; the 17/18 residual noted above is unrelated
and untouched.
