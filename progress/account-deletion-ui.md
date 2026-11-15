# Account deletion: the UI (slice D)

The interface a writer uses to delete their own account -- the last of the four account-deletion
slices, built against the already-merged, already-tested backend
(`progress/account-deletion-backend.md`). That doc is the specification this one implements against;
read it first. The owner's own words are the product spec for the one genuinely novel interaction
here: "Prompt them which ones have other members and allow them to transfer them, but also put a
'Delete anyway' button with another confirmation dialog that says something along the lines of 'Are
you sure? this will delete these projects for all collaborators' if they haven't transferred to new
ownership." Everything below either implements that sentence or explains a decision it left open.

## Where this lives, and why

There is no account/settings page in this app -- `accountMenu.tsx`'s own module comment, before
this slice, named exactly three destinations: Manage Subscription, Deleted items, Sign out. This
slice adds a fourth menu item, **Delete account**, and a fourth flat route,
`apps/web/src/routes/account.delete.tsx` (`/account/delete`), following
`routes/billing.subscription.tsx`/`routes/deleted.tsx` precisely: the same `ApplicationTitlebar`
chrome, the same `guardSessionUser` guard every authenticated route uses, no breadcrumb and a plain
`brand={{ href: '/projects' }}` for the identical reason those two pages give (`routes/deleted.tsx`'s
own comment: "it shouldn't say Projects before the page in the header... this page is not inside a
project either"). Not nested under `/projects` -- reached only from the account menu on any screen,
exactly like its two siblings.

`accountMenu.tsx`'s new item is plain navigation (`onSelect: () => void navigate({ to:
'/account/delete' })`), not a dialog opened from the menu itself. The menu item's own comment says
why: the page runs a precheck and owns two separate confirmations, which is more than an `onSelect`
handler belongs holding.

## The two flows

The page runs `GET /api/account/owned-projects-with-collaborators` unconditionally on mount --
before the writer has decided anything, matching the backend doc's own framing of that route's
purpose. What it finds decides which of two shapes the page takes:

**No owned project has another member.** The page offers a single button, **"Delete account"**.
Clicking it opens `ConfirmDeleteDialog` -- a plain confirmation stating what deletion actually does:
immediate effect, subscription cancelled, data purged after 30 days. Confirming calls
`api.deleteAccount(false)`.

**At least one owned project has another member.** The page lists each one, with a **"Manage
sharing…"** link per row (see "Transferring," below), and the button becomes **"Delete anyway"**,
opening `DeleteAnywayDialog` directly. There is no intermediate generic dialog in this path: the
collaborator consequence is already known before the writer clicks anything, so showing the plain
dialog first and then a second one that only adds a sentence would be showing the same information
twice for no reason. `DeleteAnywayDialog` is self-sufficient -- it restates the generic consequences
underneath the collaborator-specific one -- so a writer who reaches it this way is not assumed to
have seen the other dialog's wording. Confirming calls `api.deleteAccount(true)`.

**Why the UI never trusts its own precheck as the gate.** `accountDeletion.ts`'s own comment is
explicit that `deleteAccount` re-runs the identical collaborator query itself, under lock, "rather
than trusting a result the caller might be holding from an earlier call" -- a collaborator can be
added in the gap between this page's `GET` and the writer's click. So the plain-dialog path still has
to handle `deleteAccount(false)` coming back `'owned-projects-have-collaborators'` instead of
`'deleted'`. `performDelete` (the one function both dialogs call through) treats that exactly like a
fresh refusal: it replaces whatever the precheck showed with the response's own freshly-locked list,
closes `ConfirmDeleteDialog`, and opens `DeleteAnywayDialog` on top of it -- **never auto-submitting
the override**. Reaching the override dialog by this path still requires the writer to see the named
list and click "Delete anyway" themselves, exactly as if the precheck had caught it to begin with.
Proven directly: `account.delete.test.tsx`'s "reports collaborators only once the server refuses,
even though the on-mount precheck came back empty, and still requires an explicit 'Delete anyway'
click" constructs this exact race (empty `GET`, refused first `POST`) and asserts the override
dialog appears with the server's own list and that nothing is auto-submitted.

If the precheck `GET` itself fails, the page does not block on it: it falls back to the plain
"Delete account" button with a `.muted` notice ("We could not check which of your projects have
other collaborators...") rather than refusing to render anything. `deleteAccount` is still the
authoritative check regardless of whether the precheck succeeded, so this is a lost UX convenience,
not a lost guarantee.

## The second confirmation's exact copy, and why it names collaborators

`DeleteAnywayDialog`'s body (`routes/account.delete.tsx`):

> Are you sure? These projects have other collaborators on them. Deleting your account now
> permanently deletes them for every collaborator too, not just you -- they will lose access
> entirely.

(singular-adjusted when there is exactly one project: "This project has... deletes it for every
collaborator too..."), followed by the plain list of project titles, followed by the generic
consequences repeated: "Your account also stops working immediately, any subscription is cancelled
right away, and your own data is permanently deleted after 30 days."

This is close to verbatim the owner's own sentence ("Are you sure? this will delete these projects
for all collaborators"), and deliberately names **collaborators** rather than "data" or "content" in
the abstract. `plan.md`'s own rule for this area -- modals "reserved for genuinely irreversible
actions, of which this area has none" -- is about screenplay soft-delete, which is reversible by
design; account deletion is not (a 30-day grace window, then a hard purge slice C has not built yet),
so a confirmation here is consistent with that rule rather than an exception to it, and this second,
collaborator-specific one is the owner's own explicit request, not an invented extra step.

Both dialogs follow `restoreRevisionDialog.tsx`'s established shape exactly -- `role="dialog"`,
`aria-modal="true"`, a Tab/Shift+Tab focus trap, Escape to close, local `idle`/`pending`/`error`
state, the confirming button labelled with the action rather than "OK" -- rather than inventing a
fourth dialog pattern. Both dialogs' buttons live in `.dialog-actions`, the existing idiom; no new
dialog shell exists. The one code-level difference from every other dialog in this codebase: both
confirmation dialogs here live in the same file, so the identical focus-trap keydown handler
(duplicated verbatim across every other dialog file, since each is the only dialog in its own
module) is factored into one local `buildDialogKeyDownHandler`, shared by both -- not promoted to a
new shared module, since nothing outside this file needs it.

## How each of the three API outcomes is surfaced

| Outcome                                                      | HTTP | Surfaced as                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ outcome: 'deleted' }`                                     | 200  | `performDelete` calls `onDeleted()`, which replaces the whole page with the terminal state (below).                                                                                                                                                                                                                                                                                                                                                   |
| `{ outcome: 'owned-projects-have-collaborators', projects }` | 200  | `performDelete` treats this as a refusal: replaces the displayed project list with this response's own, closes whichever dialog just submitted, opens `DeleteAnywayDialog`. Never auto-submits the override.                                                                                                                                                                                                                                          |
| `{ error: '...' }`                                           | 502  | `api.deleteAccount` uses `jsonWithServerMessage` (the same helper `createScreenplay`/`switchEditableScreenplay`/`restoreRevision`/`invite`/`transferOwnership`/`submitFeedback` already use for a server sentence worth showing verbatim), so this arrives as a `MessageApiError` whose `serverMessage` is exactly "Could not cancel the subscription. Try again shortly." Both dialogs show it as a `.field-error` **inside the still-open dialog**. |

The 502 is the one outcome this area has to get right about not reading as "your account is
half-deleted": the backend doc is explicit that nothing is written when this happens, and the UI's
job is to not contradict that by closing the dialog, clearing state, or navigating anywhere. Both
dialogs' `handleConfirm` only ever closes on success (which, as noted below, means "the page has
already replaced this component" -- the dialog itself never calls `onClose` on success); on a
rejection it stays open, shows the message, and leaves the same confirm button available to press
again with the identical flag. Proven: "shows the 502 Stripe-cancellation failure as retryable,
inside the still-open dialog, and does not show the terminal state," its sibling for the override
dialog ("surfaces the 502 as retryable inside the override dialog too, not just the plain one"), and
"a retry after the 502 can still succeed, with the same flag, and only one call per click" (a first
attempt rejects with 502, a second identical click succeeds, and the mock's own attempt counter
proves exactly two calls were made, not more).

A failure that is _not_ the server's own 502 sentence (a network failure, anything
`instanceof MessageApiError` is false for) gets a generic, honestly-worded fallback -- "Your account
could not be deleted. Nothing was changed -- try again." -- rather than fabricating a more specific
claim this page cannot actually verify. Proven by forcing `fetchMock` to throw a raw `TypeError`
rather than return an HTTP response at all.

## What happens on success, given that the session is already gone

The chosen resolution is **a terminal confirmation state on this same page**, not a redirect.
`DeleteAccountPage` holds one `deleted` boolean above everything else; becoming `true` swaps the
_entire_ subtree for `AccountDeletedPage`, unmounting `DeleteAccountForm` (and with it the precheck's
`useQuery`, both dialogs, and the mounted `AccountMenu`) in the same render. `AccountDeletedPage`
itself renders no `ApplicationTitlebar`, no `AccountMenu`, and issues no query of its own -- its only
content is the confirmation text and one plain `Link` to `/sign-in`.

This was a deliberate choice against a redirect, for two reasons:

1. **Nothing is left mounted that could refetch.** `main.tsx`'s `QueryClient` has no
   `refetchOnWindowFocus: false` override, so any query left subscribed when the browser tab
   regains focus will refetch -- against an account that now 401s on every request. Unmounting the
   whole subtree, rather than hiding it behind a conditional inside the same component, is what
   actually removes the subscription rather than merely hiding its rendered output.
2. **A redirect to `/sign-in` would work, but would say nothing.** `guardSessionUser` degrades
   gracefully on a failed session check (catches, returns `null`), so navigating away would not
   crash -- but it would silently drop the one piece of information this moment needs to convey:
   that the account really is gone, and when the data actually disappears. Rendering the message in
   place keeps that explanation on screen rather than trusting the writer to already know it.

The one link this screen offers (`/sign-in`) is a plain, un-auto-followed `Link` -- leaving is the
writer's own choice, never something that could read as a redirect loop. (Signing back in will
actually fail, since the account's `deleted_at` is still set during the grace window and
`refusePendingSessionForDeletedAccount` refuses the sign-in -- see "What could not be verified,"
below, for the one gap this leaves.)

The 30-day date shown there (`Date.now()` plus 30 days, formatted with `billingPresentation.ts`'s
existing `formatDate`) is computed client-side, not echoed by the server: the `'deleted'` response
carries no timestamp, and slice C's actual purge cron does not exist yet. The few seconds of skew
between this click and the server's own `now()` are immaterial against a 30-day window, but this is
a real limitation stated plainly: there is no shared constant between this file and the backend's
own prose "30 days," so a future change to that window requires updating this literal by hand.

Proven: "calls the delete endpoint with the override flag unset only after the dialog is confirmed,
and shows the terminal state on success" asserts the terminal heading renders _and_ that
`screen.queryByRole('button', { name: 'Account menu' })` is gone -- the chrome that could issue
another authenticated request (Sign out, Manage Subscription, Deleted items) is provably absent, not
merely unasserted.

## Transferring: reusing "Make owner," not duplicating it

Project-ownership transfer shipped in the previous slice as a **"Make owner"** control inside
`sharingDialog.tsx`'s project-scope "Share…" dialog, gated to `viewerIsOwner` -- and, read directly
from that slice's own code, that control is only ever offered from one call site:
`routes/projects/index.tsx`'s dashboard row menu. There is no screenplay-scoped equivalent (ownership
is project-only) and no second place in this app a writer can transfer a project away from.

Each project this page lists therefore links to **`/projects`**, the dashboard, labelled "Manage
sharing…" -- not to a project-specific deep link (none exists for opening that dialog directly by
URL, and TanStack Router's `Link` here is deliberately the same plain navigation every other menu
item in this app already uses, not a new query-param-driven auto-open mechanism invented for one
call site) and not to a second, purpose-built transfer control embedded in this page. The alternative
considered and rejected: building a "Make owner" affordance directly into this page's own project
list, which would duplicate a tested control for the sake of a one-click shortcut, and would need its
own authorization check, its own error handling, and its own test suite -- all of which the existing
Share dialog already has. Reusing the dashboard costs the writer one extra click (open the dashboard,
then Share…, then Make owner) in exchange for building nothing twice. No second ownership-transfer
mechanism was built.

## Both themes, verified with a real-browser measurement

The dark-theme rule this project has learned twice: "stays light in both themes" is a property of a
surface's own resolved background, never an ancestor's, and has to be proven by measuring the
element itself, not read off its CSS declaration.

`.destructive-button` ("Delete account" / "Delete anyway", both dialogs' confirm buttons) is
structurally identical to the existing `.primary-button` -- same border width, radius, font,
padding -- but filled with a new literal, `--fd-destructive-surface: #a02c22`, rather than
`--surface-14`. Neither `--fd-destructive-surface` nor its hover shade `--fd-destructive-surface-hover
(#8a241b)` is redefined anywhere inside the `.dark` block, so the button's own background is
identical in both themes by construction -- the same technique `.primary-button`'s own
`--surface-14`/`--surface-01` already use, and the same technique `--fd-diff-removed-surface`/
`--fd-find-match-surface` use for the manuscript sheet. `#a02c22` is not a new red invented for this
button: it is `--feedback-error`'s own light-theme value, reused rather than adding a second one this
codebase would have to keep in sync -- deliberately _not_ reusing the custom property itself, since
`.dark` _does_ redefine `--feedback-error` (to a light pink meant for text on a dark surface, which
would be close to unreadable as a button fill).

Measured with the project's own `contrastRatio` function, the same one `text-contrast.spec.ts` uses:

| State                 | Colours                                               | Ratio  | Floor                  |
| --------------------- | ----------------------------------------------------- | ------ | ---------------------- |
| Enabled, either theme | `#fff` on `#a02c22`                                   | 7.30:1 | 4.5:1 (real text)      |
| Disabled, light theme | `--text-04` (`#6f7d84`) on `--surface-11` (`#d8dde0`) | 3.10:1 | 3:1 (inactive control) |
| Disabled, dark theme  | `--text-04` (`#a3adb2`) on `--surface-11` (`#1f282f`) | 6.54:1 | 3:1 (inactive control) |

The disabled state deliberately reuses `.primary-button:disabled`'s exact token pair rather than
inventing a second "disabled filled button" treatment -- the two numbers above are not new
measurements of a new idea, they are `.primary-button:disabled`'s own already-proven numbers,
confirmed to apply identically here because the tokens are identical.

Four new cases added to `apps/web/e2e/text-contrast.spec.ts` (`.destructive-button`,
`.destructive-button:disabled`, each in both themes, `shell: true` so the fixture wraps the markup in
`<main class="application dark">` exactly like `.dialog-actions button`'s own case) -- run through a
real Chromium instance, not asserted from the CSS source, per this project's own rule that "jsdom
runs no layout and resolves no stylesheet." All four passed; see "Gate results," below, for the full
`test:system` run (117/117).

The collaborator-list notice box on the page itself (`.dialog-warning`, reused as-is, not a new
class) needed no new verification: it sets its own explicit `background: var(--surface-06)`, so its
contrast is identical wherever it is mounted, and it was already measured at that exact token pair
before this slice existed. It is also never actually reachable from inside the dark editor shell in
this app today (this route, like its siblings, is a plain `project-screen` page, confirmed by
`.muted on a project screen`'s own `LIGHT_ONLY` case in the same spec file) -- unlike the two
confirmation dialogs, which this slice treats as reusable chrome regardless of today's one call site,
following `.dialog-actions button`'s own precedent of testing `shell: true, themes: BOTH`
conservatively rather than only what currently renders.

## Every mutation, and the test it killed

Each mutation below was a single, uniqueness-checked edit (`grep -n` confirming one match), applied
to the real file, confirmed to fail the expected test with the expected message, then reverted and
the full file re-run green.

| #   | Mutation                                                                                                                                                                       | Expected failure                                                                                                                                                                  | Actual result                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Swapped `performDelete(false)`/`performDelete(true)` between `ConfirmDeleteDialog` and `DeleteAnywayDialog`'s `onConfirm` wiring                                               | "calls the delete endpoint with the override flag unset only after the dialog is confirmed..."; "...flag set only after the second confirmation"; the race test's final assertion | 3 tests failed, each naming the exact wrong boolean sent: `expected {"deleteOwnedProjectsWithCollaborators": true} to deeply equal {"deleteOwnedProjectsWithCollaborators": false}` and its mirror.                        |
| 2   | The top-level button's `onClick` changed from opening a dialog (`setConfirmOpen`/`setOverrideOpen`) to calling `performDelete` directly, bypassing both confirmations entirely | Nearly every test in the file -- this is the whole defect class the brief names by name                                                                                           | 12 of 16 tests failed. The destructive call fired on the very first click, with no confirmation ever shown -- exactly the bypassable-confirmation defect this area exists to prevent.                                      |
| 3   | `performDelete`'s `if (result.outcome === 'deleted')` replaced with `if (true)` -- treating every response, including a refusal, as success                                    | The race test: "reports collaborators only once the server refuses..."                                                                                                            | Failed: the override dialog ("Delete anyway?") never appeared; the test's `await screen.findByRole('heading', { name: 'Delete anyway?' })` timed out. A refusal would have been silently treated as a successful deletion. |
| 4   | `projects` (the list driving both the page's notice/list and the override dialog's content) hardcoded to `[]`                                                                  | 6 tests across the "at least one owned project" and race-condition groups                                                                                                         | 6 of 16 tests failed: the collaborator notice, the project list, the "Delete anyway" button, and the override dialog's own project name all disappeared, each assertion naming the specific missing text.                  |

Mutations 1 and 3 are the ones the brief specifically named ("the override flag and the second
confirmation"). Mutation 2 is the broadest: it is the literal defect class named in the brief's own
words, "a confirmation dialog that can be bypassed," applied to this page's own gate rather than
assumed safe by inspection.

**Not independently mutation-tested:** the duplicate `if (state === 'pending') return` guard inside
each dialog's own `handleConfirm`, copied verbatim from `restoreRevisionDialog.tsx`'s established
pattern. In practice this guard is backed up by the confirm button's own `disabled={state ===
'pending'}` attribute, which `@testing-library/user-event` already respects (a click on a disabled
button never dispatches), so a test driving this through the rendered UI exercises the `disabled`
attribute rather than the internal state check specifically. Stated here rather than silently
assumed covered.

## Every refusal, the allowed case in the same file

- "does not call the delete endpoint merely by opening the confirmation dialog" is paired with
  "calls the delete endpoint with the override flag unset only after the dialog is confirmed...".
- "does not call the delete endpoint merely by opening the override dialog" is paired with "calls
  the delete endpoint with the override flag set only after the second confirmation".
- "offers a single 'Delete account' button, never 'Delete anyway', once the precheck resolves
  empty" is paired with "lists the project, links to where its membership is managed, and offers
  'Delete anyway' rather than 'Delete account'".
- "shows the 502... as retryable..." (does not reach the terminal state) is paired with "a retry
  after the 502 can still succeed, with the same flag, and only one call per click" (the identical
  flow, succeeding).
- "cancelling the dialog never calls the delete endpoint" and "closes on Escape without calling the
  delete endpoint" are both paired against the dialog's own confirming click, which does call it.

## Changes, file by file

- `apps/web/src/routes/account.delete.tsx` (new) -- the route, `DeleteAccountPage`/
  `AccountDeletedPage`/`DeleteAccountForm`/`ConfirmDeleteDialog`/`DeleteAnywayDialog`.
- `apps/web/src/routes/account.delete.test.tsx` (new) -- 16 tests, described throughout this doc.
- `apps/web/src/accountMenu.tsx` -- the fourth menu item, "Delete account".
- `apps/web/src/accountMenu.test.tsx` -- one new test proving that item navigates to
  `/account/delete`.
- `apps/web/src/api.ts` -- `api.ownedProjectsWithCollaborators`, `api.deleteAccount`, and the
  `OwnedProjectWithCollaborators`/`DeleteAccountResult` exported types, mirroring
  `apps/api/src/app.ts`'s own schemas field for field.
- `apps/web/src/styles.css` -- `--fd-destructive-surface`/`--fd-destructive-surface-hover`,
  `.destructive-button`/`.destructive-button:disabled`, `.account-deletion-project-list` (a plain
  list reset; the rows themselves reuse `.restore-row`/`.restore-row-title` as-is).
- `apps/web/e2e/text-contrast.spec.ts` -- the four new `.destructive-button` cases.
- `apps/web/src/routeTree.gen.ts` -- regenerated by the TanStack Router Vite plugin on build; not
  hand-edited.

## Gate results

| Gate                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                      | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm typecheck`                                 | exit 0 -- every package, including `apps/landing`'s `astro check` (0 errors/warnings/hints)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test`                                      | exit 0 -- every package green; `apps/web` 81 files / 1280 tests, `apps/api` 21 files / 384 tests (9 integration files skipped, no `TEST_DATABASE_URL`), `apps/collab` 12 files / 181 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test:coverage`                             | exit 0, `perFile: true` at an 80% floor on every axis for every file. `apps/web/src/routes/account.delete.tsx`: 96.70% statements / 81.25% branch / 94.11% functions / 96.70% lines. `apps/web/src/accountMenu.tsx`: 100% across the board. `apps/web/src/api.ts`: 99.06% / 97.43% / 98.21% / 99.06% (pre-existing uncovered lines, unrelated to this slice's additions). The remaining uncovered branches in `account.delete.tsx` are the Tab/Shift+Tab focus-wrap geometry inside `buildDialogKeyDownHandler`, not exercised by any test here -- the identical gap every other hand-built dialog's own test file in this codebase leaves (Escape is tested; the wrap-around itself is not). |
| `pnpm build`                                     | exit 0 -- every package, including `apps/web`'s production bundle (`account.delete` gets its own 6.31 kB / 2.22 kB gzip chunk, loaded only on navigation to that route) and `apps/landing`'s static build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm check:bundle-budget`                       | exit 0 -- entry chunk 112.33 kB / 120 kB, lazy editor chunk 171.40 kB / 200 kB, CSS 8.72 kB / 20 kB. `account.delete`'s own chunk is not part of either budgeted group (it is neither the entry nor the lazy-loaded editor); it was not expected to move either number, and did not.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm test:system` (`PLAYWRIGHT_CHANNEL=chrome`) | 117/117 passed, including the four new `.destructive-button` contrast cases in both themes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm format:check`                              | run bare, last; see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### `pnpm format:check`, bare and last

Run bare three times during this slice -- Prettier caught real violations the first two times (new
source and test files not yet formatted), fixed with `prettier --write` on exactly the flagged files,
the affected test files re-run to confirm the reformat changed no behaviour, and the full gate
sequence re-run afterward. The actual last command run before this report was finished:

```
$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!
```

Exit code: **0**.

`pnpm test:integration` was not run. It needs a database, and this slice touches no backend code at
all (no new route, no schema change, no store method) -- the UI calls two routes the backend slice
already built and already integration-tested against a real database
(`accountDeletionRoutes.test.ts`, `accountDeletion.integration.test.ts`). Starting a container for
this slice specifically would have tested nothing this slice changed.

## What could not be verified

- **No browser-driven (Playwright) coverage of the actual deletion flow.** `test:system`'s plain
  config runs `apps/api` with no `DATABASE_URL` at all, so there is no real backend this route could
  hit through a real browser session -- the same gap `project-ownership-transfer.md` and
  `account-deletion-backend.md` both record for their own new surfaces. Everything here is proven at
  the component level, against a real DOM (`@testing-library/react`, real React Query, a mocked
  `fetch`) but a mocked server. The four new contrast cases _are_ real-browser (`test:system`), but
  they test the stylesheet, not the flow.
- **The sign-in refusal after deletion is not exercised end to end from this UI.** The terminal
  screen's "Return to the sign-in page" link is real, but nothing in this slice drives a browser
  through actually clicking it and attempting to sign back in. The backend doc's own note that
  `ACCOUNT_DELETED` is not one of `api.ts`'s recognised `AuthValidationErrorCode`s is a real, pre-
  existing gap this slice did not create and did not close: a writer who does try to sign back in
  during the 30-day grace window would see sign-in.tsx's generic fallback message ("We could not
  complete that request...") rather than a sentence that explains their account was deleted. Worth
  closing in a future slice, named here rather than silently left for the next reader to rediscover.
- **The duplicate-submit guard inside each dialog's `handleConfirm`** (`if (state === 'pending')
return`) is backed by the confirm button's own `disabled` attribute in every test that exercises
  it, so the internal check itself was never isolated and proven necessary on its own -- see the
  mutation table's own note.
- **Whether linking to `/projects` rather than a project-specific deep link is the right trade-off**
  is a judgment call, argued above rather than specified by the brief. The brief says "Reusing that
  surface... is cheaper and reuses a tested control" and leaves the exact mechanism open; a future
  slice could add a query-param-driven auto-open to the dashboard's own Share dialog if the extra
  click proves to be a real friction point, but that is new plumbing this slice did not build.
- **The 30-day date on the terminal screen** is a client-side computation with no shared constant
  tying it to the backend's own prose -- see "What happens on success," above.

## Lead verification, run independently

| Gate                       | Result                                         |
| -------------------------- | ---------------------------------------------- |
| `pnpm lint`                | exit 0                                         |
| `pnpm typecheck`           | exit 0                                         |
| `pnpm test`                | exit 0 -- `apps/web` **1281 tests / 81 files** |
| `pnpm build`               | exit 0                                         |
| `pnpm check:bundle-budget` | exit 0                                         |
| `pnpm test:system`         | exit 0, **117 passed**                         |
| `pnpm format:check`        | exit 0, bare and last                          |

The mutation that matters most was re-run rather than taken on report, because a bypassable
confirmation is the entire defect class of this slice: rewiring the page's own button to call
`performDelete(false)` directly, skipping both dialogs, **failed six tests by name** -- including one
asserting the endpoint is not called merely by _opening_ the dialog, which is the distinction a
weaker test set would miss.

Two structural properties were checked by reading rather than only by test, because a passing test
would not have proven either:

- **The success path cannot refetch against a dead session.** `if (deleted) return <AccountDeletedPage />;`
  is an early return _above_ the component that owns the `useQuery`, so the query-bearing subtree
  unmounts rather than staying mounted behind a conditional. Deletion removes the account's session
  rows server-side, so a mounted query would 401 and the writer's last experience of the product
  would be an error wall.
- **The failure copy does not imply partial deletion.** "Your account could not be deleted. Nothing
  was changed -- try again." The 502 case uses the server's own sentence. Both are honest that
  nothing happened, which is the one thing a writer could reasonably panic about here.

## One gap closed after the slice: sign-in after deletion

The implementing agent flagged, correctly, that signing in to a deleted account showed the generic
"check your details and try again". It characterised this as pre-existing. It is better described as
the last mile of this feature chain: `packages/auth-server/src/index.ts` already answers
`code: 'ACCOUNT_DELETED'` with `message: 'This account has been deleted.'` -- that was added by the
deletion backend slice -- and the web client simply had no entry for the code, so it fell through.

That fallthrough is actively misleading rather than merely unhelpful. The details _are_ correct and
retrying _cannot_ work, and during the 30-day grace window this is the single most likely reason a
real person is refused sign-in. Saying so is what lets them realise either that they deleted the
account, or that somebody holding their password did.

Added as one entry in `authErrorMessages`, with wording matching the server's own for the same code,
and a test. The test asserts its own non-vacuity -- that `GENERIC_AUTH_ERROR_MESSAGE` is a
_different_ string -- because otherwise it could pass with no mapping at all. Mutation: removing the
entry fails it with `expected Error: Request failed (401) ... to match object { code: 'ACCOUNT_DELETED' }`.

## Still not verified, carried forward

No end-to-end browser run of the real flow against a real backend. The plain `test:system` config
runs the API without a database, and only `test:system:persistence` provisions one. So this slice is
covered by component tests, the API client's own tests, and real-browser contrast measurement -- but
the sequence "press delete, confirm twice, land on the terminal page, fail to sign in afterwards" has
never been driven end to end. That is the same gap the two preceding slices recorded, and the honest
place to close it is one persistence-suite spec covering the whole deletion flow.

## Correction after the owner tested it: sharing opens in place

The first version linked each listed project to `/projects`, with a comment arguing that no
per-project deep link to the sharing dialog existed and that inventing one would be new plumbing for
one call site.

The owner tested it and rejected it: _"When I click manage sharing, I would love something to pop up
so I can manage it from there. I don't want to just be sent back to the home page."_

He is right, and the argument for the link does not survive contact with the component.
`SharingDialog` takes plain props -- `onClose`, `scope`, `title`, `viewerIsOwner` -- so mounting it
over this page costs three props and no plumbing at all. There was never a deep link to invent. And
the link made the page actively unhelpful at precisely its most important moment: a writer trying to
_keep_ a collaborator's project was sent away from the deletion flow to go and find the right row
themselves.

It is still not a second transfer mechanism, which was the real concern behind the original
decision: this mounts the same component `routes/projects/index.tsx` mounts, so "Make owner" remains
the one shipped control, gated the same way, and the server re-checks ownership on the transfer
itself.

`viewerIsOwner` is passed as a literal `true`, which is honest rather than lazy: this list is by
construction exactly the projects this account **owns** that have other members, since that is what
`GET /api/account/owned-projects-with-collaborators` returns.

### The list refetches when the dialog closes

Unconditionally, on close. A transfer means this account no longer owns that project, so it must
leave the list -- otherwise the page keeps insisting a project needs attention after the writer has
dealt with it, and the "Delete anyway" confirmation would name a project they no longer own, which
is the one piece of copy on this page that must be exactly true.

Unconditional rather than only on a detected transfer because the dialog also changes collaborator
roles and can remove the last collaborator, and either equally changes whether a project belongs in
a list of _owned projects that have other members_. One refetch on close is cheaper than inferring
which of the three happened.

### Tests

The old test asserted `href === '/projects'`, so it had to change. It was replaced by two, and the
second is the one that matters:

- the control is a **button, not a link** -- asserted in both directions, so it cannot pass if the
  element simply disappeared
- clicking it **opens a dialog naming that project, with the deletion flow still mounted underneath**
  -- and it first asserts no dialog is present _before_ the click, so the post-click assertion is
  not vacuous

Mutation: making the button a no-op fails the second test. Gates after the change: `lint` 0,
`typecheck` 0, `test` 0, `build` 0, `check:bundle-budget` 0, `test:system` 117 passed,
`format:check` 0 bare and last.
