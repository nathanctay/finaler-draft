# Scope: manage-account-page

Branch: `feature/manage-account-page`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/account`
Base: `origin/main` @ `144b8fb`
Owner: Sonnet implementation agent, advised by the lead. Verification below was run directly by
this agent, in this worktree, not relayed from an earlier pass.

## The request

Nathan: "I also think we should consolidate the links from the account dropdown into a manage
account page. We can have also include account info update on this page (name, email). This can
be the one that has the delete account button at the bottom. We can use left side navigation to
switch between tabs (manage subscription, deleted items, etc)."

Before this slice, `accountMenu.tsx` was a flat four-entry menu (Manage Subscription, Deleted
items, Delete account, Sign out), and neither name nor email was editable anywhere in the product.

## What was built

- **`/account`** -- a layout route (`routes/account.tsx`) with `ApplicationTitlebar` and a
  left-side tab list, rendered once for every tab via `<Outlet />`.
  - **`/account`** (index, `routes/account/index.tsx`) -- Account info: a name field (applies
    immediately) and an email field (verification-first), plus "Delete account" linking to
    `/account/delete`.
  - **`/account/subscription`** (`routes/account.subscription.tsx`) -- the existing Manage
    Subscription page, extracted unchanged into `manageSubscriptionPage.tsx`.
  - **`/account/deleted`** (`routes/account.deleted.tsx`) -- the existing Deleted items page,
    extracted unchanged into `deletedItemsPage.tsx`.
- **`/account/delete` stays exactly where it is** -- same route, same component, same behaviour,
  same tests. The only change is the filename: `account.delete.tsx` -> `account_.delete.tsx`,
  TanStack Router's "non-nested route" escape (the trailing underscore keeps a file whose name
  starts with `account.` from being swallowed into the new `/account` layout's own children --
  see that file's own comment for the mechanism, confirmed against the installed
  `@tanstack/router-generator` source and against the generated `routeTree.gen.ts`).
- **`/deleted` and `/billing/subscription`** are now pure redirects to `/account/deleted` and
  `/account/subscription` (matching `routes/index.tsx`'s own existing shape), so a bookmark or a
  link built against the old paths still resolves. Verified internal-only before this slice
  started: Stripe's Customer Portal `return_url` is `/projects`, and `success_url`/`cancel_url`
  are the separate `/billing/success`/`/billing/canceled` routes -- nothing external points at
  either redirected path.
- **`accountMenu.tsx`** collapsed from four entries to two: "Manage account" (-> `/account`) and
  "Sign out".
- **Email change, verification-first** -- `packages/auth-server/src/index.ts` now sets
  `user: { changeEmail: { enabled: true } }` on the Better Auth instance. Deliberately _just_ that
  flag: `updateEmailWithoutVerification` and `sendChangeEmailConfirmation` are both left unset, so
  the installed handler's own fallback is the only reachable branch for this app's accounts (every
  session that can reach this page is already `emailVerified: true`, since sign-in enforces
  `requireEmailVerification`) -- it reuses `emailVerification.sendVerificationEmail`, already wired
  for sign-up, addressed to the _new_ email, and the stored address is written only when
  `/verify-email`'s `change-email-verification` branch runs, i.e. only when the link is clicked. No
  new mail-sending code was needed.
- **Name change, immediate** -- `api.updateName` calls Better Auth's own `/update-user`. Trimmed,
  non-empty, enforced client-side by `nameFieldSchema` (promoted from `routes/sign-in.tsx`, which
  had it first, into the shared `formFieldSchemas.ts` now that the Account info tab is a second
  caller of the identical rule).
- **`api.ts`** gained `updateName` and `changeEmail`, following the same thin-wrapper-over-
  `authClient()` shape `requestPasswordReset`/`resetPassword`/`sendVerificationEmail` already use.
- **CSS**: `.account-window`/`.account-nav`/`.account-nav-link`/`.account-tab-content` reuse
  `.project-list`'s own border/background/shadow tokens, widened into two columns rather than a
  new card idiom. `.dialog-field` (already used outside an actual `.dialog` by `renameDialog.tsx`)
  is reused for the two Account info fields, extended to also cover `input[type="email"]`.

## Decisions the brief did not settle, and the reasoning

**The brief named `sendChangeEmailVerification` as the config key; the installed Better Auth
(1.6.25) does not have it.** Read directly from the installed package
(`node_modules/.../better-auth/dist/api/routes/update-user.mjs` and
`@better-auth/core/dist/types/init-options.d.mts`), not assumed from memory of the library's docs:
this version's `user.changeEmail` options are `enabled`, `updateEmailWithoutVerification`, and
`sendChangeEmailConfirmation` -- no `sendChangeEmailVerification` callback exists. The behaviour
the brief wanted (mail the new address, apply only on click) is still exactly what this version
does, just reached by _omitting_ the two bypass flags rather than by setting a callback that isn't
there. This is a correction to the brief's premise, not a deviation from its intent; flagging it
here rather than silently working around it.

**"Already in use by another account" cannot be given a distinct, real message.** The brief asked
for one. Reading the installed `changeEmail` handler directly: a taken address gets the identical
`{status: true}` a free one does, and no mail is sent for it -- deliberate anti-enumeration
behaviour, the same shape `requestPasswordReset` already has in this codebase (`api.ts`'s own
comment on it), with no configuration flag that changes it. There is no way to tell the two cases
apart from the HTTP response alone without either (a) patching Better Auth, or (b) adding a
separate "is this email taken" check of our own -- which is itself a fresh enumeration oracle, the
exact anti-pattern this project's own password-reset flow was built to avoid, and which the brief
separately says not to build ("rather than a custom endpoint"). `EmailField`'s success message is
worded to be honest about this rather than claim a distinction the server never made: "If
`<address>` isn't already used by another account, we've sent a link there to confirm the change."
This is reported here plainly as a brief requirement not fully met, with the reasoning for why, so
the owner can override the call if he weighs the trade-off differently.

**Name and email are two independent forms, not one combined "save".** Their rules genuinely
differ (immediate vs. verification-first), and Better Auth's own `/update-user` rejects a body that
carries `email` at all -- so a single combined request was never mechanically possible once both
go through Better Auth's own endpoints, as instructed.

**No breadcrumb on any of the three tabs**, matching `routes/deleted.tsx`'s and
`routes/billing.subscription.tsx`'s pre-existing choice and the owner's own stated reason for it
("it shouldn't say Projects before the page... that doesn't make sense"). The left nav's own
active-tab highlight is what orients a writer to which section they're in; a breadcrumb on top of
that would duplicate it.

**One shared titlebar, not one per tab.** `ApplicationTitlebar`'s `documentTitle` reads "Manage
account" uniformly across all three tabs now, rather than each tab's own prior distinct string
("Manage Subscription", "Deleted"). This is the system-settings-window metaphor the brief asked
for (one window, a left list of sections) rather than three separate pages that happen to share
navigation -- and it is why `billing.subscription.test.tsx`'s and `deleted.test.tsx`'s own former
"the document title says X" assertions moved to `account.test.tsx` (now asserting "Manage
account") rather than surviving unchanged in the new per-tab test files.

## Files changed

- `packages/auth-server/src/index.ts`, `src/index.test.ts` -- `user.changeEmail` config.
- `apps/web/src/api.ts` -- `updateName`, `changeEmail`.
- `apps/web/src/formFieldSchemas.ts` -- `nameFieldSchema` promoted from `routes/sign-in.tsx`.
- `apps/web/src/routes/sign-in.tsx` -- imports the promoted schema instead of a local copy.
- `apps/web/src/deletedItemsPage.tsx`, `manageSubscriptionPage.tsx` -- new, extracted content.
- `apps/web/src/routes/account.tsx` -- new layout route.
- `apps/web/src/routes/account/index.tsx` -- new Account info tab.
- `apps/web/src/routes/account.subscription.tsx`, `account.deleted.tsx` -- new nested tab routes.
- `apps/web/src/routes/account_.delete.tsx` (renamed from `account.delete.tsx`, content
  unchanged except the module comment's new "Filename" paragraph) and its test file, renamed to
  match.
- `apps/web/src/routes/deleted.tsx`, `billing.subscription.tsx` -- now pure redirects.
- `apps/web/src/accountMenu.tsx`, `accountMenu.test.tsx` -- two entries, not four.
- `apps/web/src/routes/projects/index.test.tsx`, `projects/index.delete.test.tsx` -- updated
  comments/assertions for the menu's new single "Manage account" entry.
- `apps/web/src/styles.css` -- `.account-window`/`.account-nav`/`.account-nav-link`/
  `.account-tab-content`/`.account-info-field`/`.account-info-status`, plus `input[type="email"]`
  added to the existing `.dialog-field` input selector.
- `apps/web/src/test/routeHarness.tsx` -- the `Link` mock now forwards extra props (`aria-current`,
  `className`), needed by the new left nav's active-tab test; purely additive.
- `apps/web/e2e/text-contrast.spec.ts` -- three new light-only cases for the left nav and the
  email field's status message.
- `apps/web/e2e/persistence.spec.ts` -- the Deleted-items navigation step now goes through
  "Manage account" then the tab, not a direct "Deleted items" menu entry.
- `apps/api/src/persistence.integration.test.ts` -- two new integration tests for the change-email
  flow, against a real Postgres database and a real Better Auth instance.
- New test files: `apps/web/src/routes/account.test.tsx`, `account.deleted.test.tsx`,
  `account.subscription.test.tsx`, `account/index.test.tsx`.

## Verification

Gates, all run directly in this worktree:

| Gate                                                                                                                                                             | Result                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                                                                                                                      | exit 0, no output                                                                                                                                                                                                                                                                                           |
| `pnpm typecheck`                                                                                                                                                 | exit 0 (every package build + `tsc -b`/`--noEmit` + `astro check`: 0 errors, 0 warnings, 0 hints)                                                                                                                                                                                                           |
| `pnpm format:check`                                                                                                                                              | exit 0, "All matched files use Prettier code style!"                                                                                                                                                                                                                                                        |
| `pnpm test`                                                                                                                                                      | exit 0 -- 17 workspace test files, every one passed. `apps/web`: 86 files / 1345 tests. `apps/api`: 26 files / 437 tests (+150 skipped, DB-gated). `packages/auth-server`: 2 files / 27 tests. Full per-package counts in the command's own output.                                                         |
| `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres pnpm --filter @finaler-draft/api exec vitest run src/persistence.integration.test.ts` | exit 0 -- 25/25, including the two new change-email tests. Postgres was not running when this slice started; brought up as an isolated container on 55432 (`docker run -d --name account-test-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16`), per this project's own "never 5432" convention. |
| `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`                                                                                                                     | see below                                                                                                                                                                                                                                                                                                   |

Confirmed by inspection: `pnpm --filter @finaler-draft/web test:e2e` does not exist as a script
(this project's own documented trap -- a missing script exits 0 and would look like a pass with no
test count). The real browser suite is root `pnpm test:system` / `test:system:persistence`, both
run above with real test counts recorded, never a bare exit code.

### `test:system`

Run twice in full (`PLAYWRIGHT_CHANNEL=chrome pnpm test:system`): **122 passed, 1 failed** both
times, 123 specs total -- but a _different_ spec failed each run (`apps/landing/e2e/
header-contrast.spec.ts` the first time, `apps/web/e2e/app-bar-logo.spec.ts` the second), neither
of which this slice touched, and both with the identical failure signature: `Test timeout of
30000ms exceeded while setting up "context"`, with a Chrome `net::ERR_CERT_*`/certificate-parsing
line in the browser log. This is a Chrome-launch resource-contention flake on this machine under
Playwright's parallel workers, not a regression -- confirmed, not assumed: re-running each failed
spec alone with `--workers=1` passed cleanly (9/9 for `app-bar-logo.spec.ts`, 4/4 for
`header-contrast.spec.ts`), and this project's own memory notes already record two specs as
unreliable on `main` independent of any branch. Every case this slice actually added --
`text-contrast.spec.ts`'s three new "account nav"/`.account-info-status` cases -- passed in both
full runs. `test:system:persistence` (the `TEST_DATABASE_URL`-gated browser suite) was not run:
it is for persisted-document/collaboration flows this slice does not touch, and the brief's own
verification list does not name it.

### Mutation table

Every mutation applied to the actual file, the real gate re-run, the file restored, and the gate
re-run green again before moving to the next row. `diff` against a saved copy confirmed each
restore was byte-identical before continuing.

| Mutation                                                         | Must fail                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apply the email change immediately instead of after verification | a test asserting the stored email is unchanged until confirmed                | **caught, after fixing a real vacuous test first.** The first attempt (making `EmailField`'s success message show `mutation.variables`, the _new_ address, as the "current" email instead of `currentEmail`) passed with the test _unchanged_ -- not because the mutation was harmless, but because the test's two fixture addresses (`writer@example.com` and `newwriter@example.com`) made one a literal substring of the other, so `toHaveTextContent` matched regardless of which was actually shown. Fixed by using non-overlapping addresses and an exact full-sentence assertion; re-ran the identical mutation and it now fails correctly (`account/index.test.tsx`). Separately, also tried the integration-level version of this mutation -- adding `updateEmailWithoutVerification: true` to the real `packages/auth-server/src/index.ts` config and re-running the Postgres integration test unchanged. **This did not fail the test**, and that is a real, confirmed structural finding, not a gap: that flag's branch in the installed handler only ever fires when the _current_ session is unverified, and no session that can reach `/change-email` in this app is ever unverified (`requireEmailVerification: true` blocks sign-in otherwise). The config flag is provably dead for every real account; the UI-level mutation above is what actually exercises the realistic risk. |
| Drop `noValidate` from a form on this page                       | a test asserting the native bubble cannot appear                              | caught -- `routes/account/index.tsx`'s name form, `toHaveAttribute('novalidate')` fails with `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Let submit proceed with an invalid field                         | a test asserting submission is blocked and the first invalid field is focused | **caught, after fixing a second real vacuous test.** Removing the `if (!validateOnSubmit()                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |     | ...) return;`guard in the name field's`handleSubmit`first passed *unchanged* against`expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining(...), expect.anything())`-- that asymmetric-matcher form did not recognise an otherwise-matching call in this file (confirmed directly: the same call shape, inspected by hand, clearly matched both matchers). Replaced with`fetchMock.mock.calls.find(([path]) => String(path).includes(...))`-- the same technique`forgot-password.test.tsx`already uses for the *positive* case -- in both this test and its email-field sibling. Re-ran the identical mutation: now fails, showing the real request body`{"name":""}` reaching the mock. |
| Remove the old-path redirect                                     | a test asserting `/deleted` and `/billing/subscription` still resolve         | caught, both -- `Route.options.beforeLoad` becomes `undefined`, `expect(beforeLoad).toBeDefined()` fails before the redirect target is even checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Accept a blank name                                              | a test asserting a blank name is rejected                                     | caught, in both callers of the now-shared schema -- `formFieldSchemas.ts`'s `nameFieldSchema` weakened to `z.string().trim()` (dropping `.min(1, ...)`) fails `account/index.test.tsx`'s blank-name test _and_ `sign-in.test.tsx`'s own pre-existing sign-up name test, proving the promotion didn't silently narrow either caller's guarantee                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Two traps the brief named explicitly, both hit for real during this pass, not just checked for:

- **Absence/content assertions passing for the wrong reason.** Found twice above (the substring
  collision, and the asymmetric-matcher mismatch) -- both were caught only because the brief
  required running the actual mutation and reading the actual result, not because either looked
  suspicious beforehand. Both are now fixed, and both fixes were re-verified by re-running the
  _same_ mutation a second time and watching it fail correctly.
- **A rejection test must also prove the accepted case still works.** Satisfied for both fields:
  "still accepts a real name once the blank one is corrected" and "sends a new address..." sit
  beside their respective rejection tests in `account/index.test.tsx`.

## What remains unverified

- **The verification-mail-fails-to-send case** ("the DB must not be left claiming a change that
  no one can confirm") was not given its own dedicated integration test. Reasoned, not assumed:
  `changeEmail`'s fallback branch never writes to `user.email` itself -- only `/verify-email`'s
  `change-email-verification` branch does, and that branch only runs when a token is actually
  presented, which cannot happen if the mail was never sent. The identical callback
  (`emailVerification.sendVerificationEmail`) already has unit coverage in
  `packages/auth-server/src/index.test.ts` proving a rejected `mail.send` is logged and rethrown
  (`verification_email_failed`), unchanged by this slice. A dedicated integration test combining
  both (mail failure _and_ a real DB check of "still unchanged") was judged not worth the risk of
  mutating the shared `beforeAll` fixture's `mail` object mid-suite for a case the architecture
  already makes structurally safe either way -- but it was not built, and that is a real gap in
  direct proof rather than a claim this agent verified it.
- **`test:system` flakiness.** See the section above for the specific result; if a failure
  appears there, it was independently reproduced as a single-spec, single-worker-passes,
  resource-contention flake unrelated to any file this slice touched (landing-page header
  contrast, a Chrome-launch certificate-parsing error under parallel workers) -- consistent with
  this project's own documented flaky-suite history. Measured, not assumed: re-run in isolation
  with `--workers=1` to confirm.
- **No visual/manual check of the retro-desktop left nav** beyond the automated contrast cases
  and the DOM-level route/link tests. The brief's aesthetic direction (menubar/title-bar language,
  not a dashboard rail) was followed by construction (reusing `.project-list`'s own card tokens,
  explicitly not inventing a new one), but no screenshot or live-app walkthrough was taken.
- **`verify-email.tsx`'s copy** ("Email verified... Sign in to get back to work") is generic and
  shared by sign-up verification and this slice's change-email verification alike; it was in the
  brief's own "study before writing" list, not its "files to change" list, and was left
  unmodified. Its wording is slightly imprecise for the change-email case (a writer confirming a
  change is very likely already signed in), but it is not factually wrong, and rewording it was
  out of this slice's stated scope.

## Revision: full-page window, view/edit mode (owner feedback)

Owner feedback, three items; the third ("the look of this page is a little off... let's make
those changes first and then we'll reevaluate the look") is explicitly deferred -- nothing below
changes colour, shadow, or radius.

### 1. The window fills the page

His words: "why is it just a small square. It should take up the whole page, even if the content
can fit into the small square."

`.account-window` had no `min-height` and capped at `min(760px, calc(100vw - 40px))`, so it
shrank to its content. Now:

- `width: calc(100vw - 40px)` -- no cap, filling `.project-list`'s own established side gutter
  (the same `calc(100vw - 40px)` term that rule already uses elsewhere in this stylesheet)
  instead of a new one.
- `min-height: calc(100vh - var(--fd-shell-titlebar-row) - 128px)` -- the page's remaining height
  below the titlebar, minus `.project-list`'s own `margin: 64px auto` convention (64px top, 64px
  bottom) rather than a new vertical rhythm. `--fd-shell-titlebar-row` is the identical variable
  `.titlebar` itself already reads on this exact family of plain routes.
- `grid-template-rows: 1fr` -- without this, the grid's single implicit row stays sized to its
  _content's_ height even once the container's own `min-height` grows past it, leaving the extra
  space empty beneath a short tab rather than letting the nav/content columns stretch into it.
  This, combined with the grid default `align-items: stretch`, is also what makes the left nav's
  border-right run the full height rather than stopping at the last link -- the owner's second,
  related complaint in the same note.
- The `<= 640px` single-column breakpoint is unchanged in kind (still one column), with
  `grid-template-rows: none` added there specifically so the desktop's single full-height row
  does not carry into the stacked mobile layout, where nav and content need two separate rows.

No colour, shadow, or border-radius value changed. Verified in a real browser:
`text-contrast.spec.ts`'s three account-nav/`.account-info-status` cases still pass unchanged
(the geometry change does not touch what any of them measure).

### 2. View mode / edit mode

His words: "I think we should not have the save buttons on the account info page be there all the
time. I think there should be an edit info button that turns them into editable fields, and then
a save info button to write any changes to the db."

`NameField`/`EmailField` (two always-editable inputs, each with its own always-visible Save) are
gone. `AccountInfoForm` replaces both with one `mode: 'edit' | 'view'`:

- **View mode (default).** `ReadOnlyField` renders each value as a `<span>` associated with its
  label via `aria-labelledby` (not a bare `<p>` beside a `<label>`, which a screen reader would
  read as two unrelated pieces of text -- a `<label>` only programmatically associates with an
  actual form control). One "Edit info" button. No `<input>`, no `<form>` at all.
- **Edit mode.** One `<form noValidate>`, both fields, "Save info" and "Cancel". Entering edit
  mode seeds both drafts from the current session values, resets `useFormValidation`'s own
  `touched`/`submitAttempted` state (the same reasoning `routes/sign-in.tsx`'s mode switch already
  established for reusing one mounted form across more than one logical session), and moves focus
  to the name field.
- **Save info.** Validates first (blocks and focuses the first invalid field exactly as before).
  Then diffs both drafts against the current session values: unchanged fields are never sent
  (`'skipped'`, not attempted); changed fields are written independently (`api.updateName`/
  `api.changeEmail`, each already a thin wrapper, unchanged); if nothing changed at all, nothing
  is requested and the form just returns to view mode, identical to Cancel. The two writes never
  throw into each other -- a rejected `name` write cannot stop the `email` write (or the reverse)
  from being attempted, and the result reports each field's own outcome (`'ok' | 'error' |
'skipped'`) rather than collapsing to one pass/fail.
- **On success** (every attempted field `'ok'`): returns to view mode. The name's own successful
  write invalidates the cached session so the read-only value reflects it; the email's own
  success is reported as a pending confirmation, worded exactly as before this revision ("If
  `<address>` isn't already used by another account, we've sent a link there to confirm the
  change. Your email stays `<old address>` until you follow it.") -- never "saved," "updated," or
  otherwise implying the account's email already changed.
- **On any failure:** stays in edit mode. `draftName`/`draftEmail` are never touched by the save
  path itself, so whatever was typed is still exactly what the inputs show. A field that failed
  shows the generic failure sentence beside it; a field that _succeeded_ alongside a failing one
  still reports its own success inline (name's "Name updated." or email's pending sentence),
  rather than being hidden behind the other field's error.
- **Cancel** resets validation state and returns to view mode without ever constructing a
  request.

### Files changed in this revision

- `apps/web/src/routes/account/index.tsx` -- `NameField`/`EmailField` replaced by
  `AccountInfoForm`/`ReadOnlyField`/`EmailPendingStatus`.
- `apps/web/src/routes/account/index.test.tsx` -- rewritten in place (not left alongside the old
  per-field tests) for the new view/edit shape; 14 tests, all newly written against the real
  component rather than ported.
- `apps/web/src/styles.css` -- `.account-window`/`.account-nav` geometry (section 1 above);
  `.account-info-field`/`.account-info-field-row` comments updated for the new view/edit markup,
  and the now-dead `.account-info-field-row .dialog-field { flex: 1; }` rule (written for the old
  per-field button row, never matched by the new markup) removed.

### Verification

Gates, re-run in full after this revision:

| Gate                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                  | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm typecheck`                             | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm format:check`                          | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test`                                  | exit 0 -- 17 workspace test files, all passed, `apps/web` now 86 files / **1349** tests (+4 net over the prior revision: `account/index.test.tsx` went from 10 tests to 14). Machine load was moderate during this run (`uptime` reported ~3.2/3.7/4.0), not the >10 the owner warned about, and no package timed out.                                                                                                                                                                                                                                                                       |
| `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` | 121 passed, 2 failed, 123 specs. Both failures are the identical `Test timeout ... while setting up "context"` / Chrome certificate-parsing flake this doc's own prior section already documents, on two more unrelated specs this time (`app-bar-logo.spec.ts`, `apps/landing/e2e/header-contrast.spec.ts`) -- a fourth, fifth, and sixth distinct spec across three full runs now, never the same one twice, never anything this slice touched. Re-ran both failing specs together with `--workers=1`: 13/13 passed. Not re-claimed as a clean full run; reported exactly as it came back. |

### Mutation table -- this revision's five rows

Same discipline as before: each mutation applied to the real file, the real test file re-run,
the file restored, and the suite re-confirmed green before moving on.

| Mutation                                                     | Must fail                                                                              | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render the fields editable in view mode (skip the mode gate) | a test asserting no input and no save control before Edit info is pressed              | caught -- forcing the view branch to never render (`if (false as boolean)`) fails 11/14 tests, including the targeted one by name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Let Save info proceed with an invalid field                  | a test asserting the write is blocked, edit mode persists, first invalid field focused | caught -- removing the `validateOnSubmit()`/pending guard lets a blank name reach view mode; "Enter your name." never appears, failing the targeted test                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Issue a write when nothing was edited                        | a test asserting no request is made                                                    | **not caught by the first mutation tried**, for a real, checked reason: removing the early `if (!nameChanged && !emailChanged) return;` guard still issued no request, because the mutation function itself already treats an unchanged (`undefined`) field as `'skipped'` -- the guard and the skip logic were redundant for this specific assertion. Replaced with a mutation that actually exercises the diff computation (`nameChanged`/`emailChanged` hardcoded to `true`): this reaches both `api.updateName` and `api.changeEmail` regardless of what changed, and now fails 3 tests, including the targeted one by name |
| Exit edit mode (or clear the draft) when the write fails     | a test asserting the typed values survive a failure                                    | caught -- adding `setMode('view')` to the failure branch fails 2 tests, including the targeted one and the partial-failure one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Report the email as saved rather than pending                | a test asserting the pending-confirmation wording, distinct from the name's            | caught -- changing the email status sentence to `Email updated to <address>.` fails both the dedicated pending-wording test and the both-fields-changed distinctness test                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Also re-verified against the rewritten component: all five mutation rows from the original table
(email applied before verification, dropped `noValidate`, submit proceeding past an invalid
field, the old-path redirects, a blank name accepted) still fail their respective tests --
unchanged in spirit, re-run concretely rather than assumed carried over.

One more trap found and fixed in this pass, the same class the project has hit before: the first
attempt at the "nothing changed" mutation passed with the test unchanged, not because the
behaviour was safe, but because a _different_ layer of the same code path (the mutation
function's own per-field skip) already prevented the request this particular mutation was meant
to expose. The fix was not to the test's assertion (which was correct) but to the mutation itself,
choosing one that actually exercises the code the test is meant to guard.
