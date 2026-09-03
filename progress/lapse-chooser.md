# The lapse chooser and the read-only editor state

Branch `feature/lapse-chooser`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/lapse-chooser`,
off `61f455e` (current `main`).

## Why this scope exists

Slice 2 (`progress/billing-entitlements.md`) built the entitlement policy, the schema, server-side
enforcement wired into every screenplay-content write, and the read/write API surface
(`GET /api/entitlement`, `PUT /api/entitlement/editable-screenplay`). None of it was consumed by
`apps/web`. The gap that left: a lapsed writer with more than one screenplay could open one that
was not their account's editable screenplay, type into it, and only discover the save was refused
when it actually failed -- server-side enforcement holding, but the writer having already spent
real effort believing they were working. plan.md's whole lapse policy exists so a billing state
never costs someone their work; discovering the loss after writing is the same failure wearing a
different hat. This slice closes that gap: the editor becomes entitlement-aware and visibly
read-only when it should be, and the owner's chosen shape for the chooser -- a banner plus in-place
choosing, explicitly not a blocking modal -- is what asks a lapsed writer with several screenplays
which one stays editable. It touches no `apps/api` code at all; everything here is presentation on
top of the authority slice 2 already built.

## What shipped

**1. The read-only editor state** (`apps/web/src/App.tsx`, `apps/web/src/titlePageEditor.tsx`) --
`App` gained one new optional prop, `entitlementReadOnly?: EntitlementReadOnly` (`{ message: string;
onMakeEditable?: () => Promise<void> }`). It reuses the exact seam the editor already had for its
other read-only case (`initialContent !== undefined`, the schema-unsupported case) rather than
inventing a second one: `editingAllowed = initialContent !== undefined && entitlementReadOnly ===
undefined` is now the one flag that gates `useEditor`'s `editable` option, the title page's
`readOnly` prop, the element-type selector, Undo/Redo, and the "Document settings…" menu item. A
persistent banner (`.readonly-banner`, rendered above the toolbar so it survives panel toggles)
shows `entitlementReadOnly.message` and, when the route supplied `onMakeEditable`, a "Make this one
editable" button. See "How the editor became read-only" below for why this needed more than the
one `editable: false` flag Tiptap already offers.

**2. The screenplay route wired to entitlement**
(`apps/web/src/routes/projects/$projectId.screenplays.$screenplayId.tsx`) -- a second, live
`useQuery(['entitlement'], api.entitlement)` alongside the existing (deliberately-frozen,
`staleTime: Infinity`) screenplay query. `editable = tier === 'paid' || editableScreenplayId ===
screenplayId`; failing to resolve entitlement at all (a fetch error) is treated as **not** editable,
fail-safe rather than fail-open, matching plan.md's "a writer must never lose access to their own
work" the other way: not knowing the entitlement state is not a license to guess "editable". When
not editable, the route builds the banner's `message` (distinguishing "nothing chosen yet" from "a
different screenplay is already chosen," using `editableScreenplayId === null`) and, only when this
screenplay is actually a live candidate for the account (`candidateScreenplayIds.includes
(screenplayId)`), an `onMakeEditable` that calls `api.switchEditableScreenplay(screenplayId)` and
then invalidates the `['entitlement']` query so a successful click is reflected in place, with no
remount and no reload.

**3. The lapse-chooser banner** (`apps/web/src/routes/projects/index.tsx`) -- shown when
`tier === 'restricted' && editableScreenplayId === null && candidateScreenplayIds.length > 1`. Pure
explanation, no title list and no picker: plan.md is explicit that the system must never choose on
the writer's behalf or fall back to the oldest, newest, or largest, and the owner's own design
puts the actual choosing inside a screenplay (item 2 above), not in a list of titles a writer has
to recognise from this page. Reading and exporting are never blocked by this banner's presence or
absence -- it is advisory, so an entitlement fetch error here renders nothing rather than guessing
either way.

**4. The web API client** (`apps/web/src/api.ts`) -- `api.switchEditableScreenplay(screenplayId)`,
using `jsonWithServerMessage` (the same helper `createScreenplay` already uses for its 402) so a
404 ("not a candidate," the same information-hiding shape the server already uses for "does not
exist") or a 409 (the switch-slot cooldown) surfaces its exact server-written sentence in the
banner, not a bare "Request failed (409)".

## How the editor became read-only

The task brief pointed at the existing seam (`editable: initialContent !== undefined`,
`unavailableEditorContent`) and said to reuse it rather than invent a second mechanism. That is
what `editingAllowed` does -- but reusing the seam correctly turned out to require more than
flipping one boolean, because Tiptap's `editable: false` only stops the _ProseMirror_ document
from accepting DOM-level input (typing, paste, drag-drop). Three other surfaces in this editor can
mutate the canonical screenplay without ever touching the ProseMirror view, and each needed its own
guard:

- **The title page** (`titlePageEditor.tsx`) lives in separate React state and renders as bare
  `contentEditable` `div`s, never inside Tiptap at all. `TitlePageView`, `TitlePageField`, and
  `TitlePageLineList` all gained a `readOnly` prop: `contentEditable={!readOnly}` (not merely
  disconnecting the `onChange` handler -- dropping the attribute entirely is what actually stops a
  writer's keystrokes on this second, independent editable surface), and the add/remove line
  buttons are hidden outright, since they have no `contentEditable` layer at all standing between a
  click and a mutation.
- **The element-type selector and `changeElement`** call `convertActiveScreenplayBlock`, which
  dispatches a ProseMirror transaction directly and does not consult `editable`. The `<select>` is
  now `disabled={!editingAllowed}`, and `changeElement` itself gained an `!editingAllowed` early
  return -- proven load-bearing, not decorative, by a test that fires a raw `change` event
  (bypassing `disabled` the way `userEvent` would not) and confirms the block is untouched.
- **Undo/Redo and "Document settings…"** are similarly gated. Undo/Redo's own `!editor?.can().undo
()` check is not enough on its own: if this screenplay was editable, the writer made an edit
  (building real undo history), and entitlement then flips read-only mid-session -- the live
  `useQuery(['entitlement'])` in the route can do exactly this without remounting `App` --
  `editor.can().undo()` would still report `true` for that pre-existing history. `disabled={!
editingAllowed || !editor?.can().undo()}` is what actually closes that path, and is the one
  mutation in this slice that needed a purpose-built test (rendering editable, building undo
  history via the element selector, then re-rendering with `entitlementReadOnly` set) rather than
  being incidentally covered by an existing one.

The footer status text and the "Document settings…" `disabledReason` were also updated to describe
the entitlement case specifically, distinct from the pre-existing "Text editing is unavailable for
this screenplay" wording the schema-unsupported case uses.

## How the banner and the in-place action work together

Nothing is ever blocked. The lapse-chooser banner (projects page) is pure information: it explains
that the account is lapsed with several screenplays and none chosen, and says to open any
screenplay and use "Make this one editable" there -- it never lists screenplay titles and never
offers a picker of its own, on purpose, matching the owner's stated reason for doing the choosing
in-place at all ("rather than from a list of titles they must recognise"). The read-only editor
(screenplay page) is where the actual choice happens: its banner explains why _this_ screenplay is
read-only and offers "Make this one editable" when this screenplay is a live candidate. Both read
from and act on the same `GET /api/entitlement` / `PUT /api/entitlement/editable-screenplay`
surface slice 2 already built; neither adds a client-side notion of entitlement that could drift
from it. A successful "Make this one editable" click invalidates the `['entitlement']` query, which
naturally clears both the projects-page banner (fewer than two candidates now lack a choice, since
one now has one) and the screenplay-page banner (this screenplay's `editableScreenplayId` now
matches) on their next render, with no bespoke cross-page signalling.

## First choice is not cooldown-limited through this path -- confirmed

The one thing the task asked to specifically verify: `switchEditableScreenplay`
(`apps/api/src/entitlementStore.ts`) is the _general_ user-facing action -- used both for
establishing a first choice and for switching an existing one -- and its cooldown gate is exactly
`checkEntitlement`'s `switch-slot` branch (`apps/api/src/entitlements.ts`), which allows
unconditionally whenever `snapshot.slot` is `null`. This app's "Make this one editable" button calls
`api.switchEditableScreenplay`, which is `PUT /api/entitlement/editable-screenplay`, which is this
exact function -- there is no separate, cooldown-naive `claimEmptySlot` path exposed to the web
layer, and no client-side cooldown logic was added anywhere in this slice (deliberately: the route
never pre-emptively disables the button based on `cooldownEndsAt`; it always lets the click attempt
happen and lets the server's own 404/409 be the only gate, so nothing this slice adds could ever
impose a stricter rule than the server's). A restricted account choosing for the first time
therefore hits the `slot === null` branch and succeeds immediately, regardless of any prior
`cooldownEndsAt` a _different_ account's history might suggest. This was not re-derived from
scratch here -- it is exactly what slice 2's own mutation 3 and its integration test already prove
at the API layer (`entitlements.integration.test.ts`'s "establishing a first choice") -- and it
holds unmodified, since this slice added no `apps/api` code at all.

## Tests

**Web unit**, following existing conventions:

- `apps/web/src/App.test.tsx` (new `entitlement-driven read-only` describe block, 8 tests): a
  schema-supported screenplay rendered read-only by entitlement alone (content stays visible and
  legible, `contenteditable` is not `"true"`, the footer status and inspector reflect it); every
  other affordance disabled (undo/redo, element selector, Document settings); the undo-after-flip
  scenario described above; "Make this one editable" calling the provided action and surfacing a
  `MessageApiError`'s `serverMessage` inline on failure; a title page staying readable but not
  editable; the raw-`change`-event bypass proving `changeElement`'s own guard, not only `disabled`,
  stops a mutation.
- `apps/web/src/titlePageEditor.test.tsx` (new `readOnly` describe block, 3 tests): `contentEditable`
  dropped, `onInput` itself refusing to report a change even if fired, and the add/remove line
  controls hidden.
- `apps/web/src/routes/projects/$projectId.screenplays.$screenplayId.test.tsx` (new
  `entitlement-driven editability` describe block, 7 tests, plus one loading-state test): paid tier
  and the chosen screenplay both pass no `entitlementReadOnly` prop; no-choice-made and
  chosen-elsewhere both render read-only with the make-editable action; a non-candidate screenplay
  and an entitlement fetch error both render read-only _without_ the action; a successful click
  calls `api.switchEditableScreenplay` and invalidates `['entitlement']`.
- `apps/web/src/routes/projects/index.test.tsx` (new `the lapse-chooser banner` describe block, 5
  tests): silent for paid, for an already-chosen restricted account, for a restricted account with
  nothing to choose among (a single candidate), and on an entitlement fetch error; shown with the
  right copy, no title list, and no picker element when several candidates exist and none is
  chosen.
- `apps/web/src/api.test.ts`: `switchEditableScreenplay` folded into the existing "every supported
  operation" smoke test (now 21 calls, not 20), plus a new `switchEditableScreenplay error
reporting` describe block (2 tests) mirroring `createScreenplay`'s own 402 test for the 404/409
  cases.
- `apps/web/src/test/routeHarness.tsx`: `editorModuleMock`'s stub `App` now renders
  `entitlementReadOnly` (message plus a real, clickable "Make this one editable" button) so route
  tests can assert on it without the real, Tiptap-backed component; a new `entitlementSnapshot()`
  helper (mirroring `billing.subscription.test.tsx`'s pre-existing local `entitlement()` helper)
  gives every test file that now juggles two concurrent `useQuery` calls a shared, paid-by-default
  fixture.

Existing tests that needed updating because this slice changed what they were actually testing (not
weakened -- each still asserts what it always did, updated for the one new fact each page now
depends on):

- `apps/web/src/routes/projects/index.delete.test.tsx`: this page's real (unmocked) React Query
  instance now issues a genuine `/api/entitlement` GET on mount for the banner. Every
  `fetchMock.mockImplementation` in that file gained a branch answering it (paid, so none of these
  delete/undo-focused tests incidentally render the banner); the fetch-count assertion in "keeps
  the Undo affordance visible..." moved from 3 to 4; and "never fetches entitlement or billing
  state from the account menu itself" -- whose entire premise (this page fetches nothing
  billing-related) this slice necessarily changes -- was rewritten to prove the narrower, still-true
  claim: opening the account menu itself adds no _additional_ fetch beyond the page's own.
- `apps/web/src/routes/projects/$projectId.screenplays.$screenplayId.test.tsx`: the route now makes
  two concurrent `useQuery` calls, so the existing tests (which drove state through the shared
  single-slot `routeState.query`) needed `routeState.queries`-keyed overrides for both
  `['screenplay', id]` and `['entitlement']` -- the exact scenario `routeHarness.tsx`'s own `queries`
  field was already documented to anticipate.

## Mutation testing

Every mutation below was applied to the actual source (never a copy), confirmed to fail the
specific test(s) named, then reverted; `grep -rn MUTATION apps/web/src` after the final revert
returns nothing, and the full web suite (639 tests) was re-run clean after all reverts.

1. **The mutation that matters most: `editable: editingAllowed` reverted to `editable: initialContent
!== undefined`** (App.tsx), i.e. entitlement stops gating Tiptap's own editable flag -- the
   work-loss path this whole slice exists to close. Failed "renders visibly read-only when
   entitlement forbids editing, even though the schema is fully supported" (`contenteditable="true"`
   where the test demands it not be). This is the one the task brief named directly.
2. **The chooser picks a default: the screenplay route's `editable` computation extended to also
   treat `editableScreenplayId === null` as editable** -- i.e., "nothing chosen yet" silently
   defaults to "let them edit this one," exactly what plan.md forbids ("must never choose on the
   user's behalf ... must never fall back"). Failed all three tests in that file that depend on the
   no-choice-made state actually rendering read-only. This is the second one the task brief named
   directly.
3. `TitlePageField`'s `contentEditable={!readOnly}` reverted to always `true`. Failed both the
   dedicated `titlePageEditor.test.tsx` assertion and App.test.tsx's title-page read-only test.
4. `TitlePageLineList`'s `{!readOnly && <button>+ Add line</button>}` reverted to always render.
   Failed "hides the add/remove line controls."
5. The element selector's `disabled={!editingAllowed}` removed. Failed "disables every other
   affordance...".
6. `disabled={!editingAllowed || !editor?.can().undo()}` reduced to `disabled={!editor?.can().undo
()}` (dropping the entitlement half). The first, simpler test ("disables every other
   affordance...") did **not** catch this -- with no edits ever made, `can().undo()` is `false`
   regardless, so the mutation was invisible to it. This is exactly why the dedicated
   undo-after-flip test (item 6 above) was written, and it does catch it: `Undo local change` comes
   back `toBeEnabled()` where the test demands `toBeDisabled()`.
7. The "Document settings…" item's `disabled: !editingAllowed` reverted to `false`. Failed the
   same "disables every other affordance..." test, at its Document settings assertion.
8. `changeElement`'s `if (!editor || !editingAllowed)` reduced to `if (!editor)`. Not caught by
   `disabled` alone (that only stops `userEvent`, not a raw DOM event) -- caught specifically by the
   test built to bypass `disabled` with `fireEvent.change`, proving the internal guard is
   load-bearing rather than merely mirroring the DOM attribute.
9. The lapse-chooser banner's `candidateScreenplayIds.length > 1` loosened to `>= 0`. Failed "stays
   silent for a restricted account with nothing to choose among."
10. The screenplay route's `onMakeEditable` gate (`isCandidate && !entitlement.isError`) replaced
    with `true`, offering the action unconditionally. Failed both "renders read-only without
    offering the make-editable action for a screenplay that is not a candidate at all" and "fails
    safe ... when the entitlement fetch itself errors."
11. The screenplay route's loading gate `screenplay.isLoading || entitlement.isLoading` reduced to
    `screenplay.isLoading`. Failed "stays on the loading screen while entitlement is still
    resolving, even once the screenplay itself has loaded."
12. `api.switchEditableScreenplay` changed from `jsonWithServerMessage` to the plain `json` helper
    (losing the server's own message on a non-OK response). Failed both new
    `switchEditableScreenplay error reporting` tests, each with a bare `ApiError` where a
    `MessageApiError` carrying the server's sentence was expected.

## Every gate, verbatim

```
pnpm lint
```

Clean, no output, exit 0. (One `no-unused-vars` finding during development -- a leftover fixture
constant in a test file -- fixed before this run; the command as run here reports clean.)

```
pnpm format:check
```

`All matched files use Prettier code style!`, exit 0.

```
pnpm typecheck
```

Clean across every package and both apps (`config`, `server-config`, `screenplay`, `database`,
`layout`, `xml-escape`, `fdx`, `docx`, `pdf` builds; `web` and `api` typecheck), exit 0. (Running
`pnpm --filter @finaler-draft/web typecheck` in isolation, without the workspace packages built
first, produces a wall of `Cannot find module '@finaler-draft/screenplay'`-style errors -- that is
this monorepo's project-reference build order, not a defect in this slice; the root `pnpm
typecheck` script builds every package first and is the command that actually gates.)

```
pnpm test
```

`apps/api`: 215 passed, 40 skipped (unchanged -- this slice added no `apps/api` code). `apps/web`:
**639 passed** (614 baseline + 25 new). Every other package unchanged and green (`config` 1,
`server-config` 17, `screenplay` 118, `database` 4, `xml-escape` 9, `fdx` 45, `docx` 58, `layout`
72, `pdf` 61). Exit 0.

```
pnpm --filter @finaler-draft/web test:coverage
```

639 passed. Every new or touched file at or near 100% line coverage (`$projectId.screenplays.
$screenplayId.tsx` 100%, `routes/projects/index.tsx` 100%, `titlePageEditor.tsx` 100% lines/96.55%
branch -- the one uncovered branch is a pre-existing `?? ''` null-guard on `textContent`, not new
code this slice added). `App.tsx` 96.02% lines / 87.85% branch, consistent with its pre-existing
baseline for a file this large; no coverage threshold configured to fail on. Exit 0.

```
pnpm check:bundle-budget
```

`[bundle-budget] ok   Entry chunk        assets/index-BQMxMb1V.js      111.65 kB / 120.00 kB budget`
`[bundle-budget] ok   Lazy editor chunk  assets/App-CyDKyMaa.js        115.48 kB / 200.00 kB budget`
`[bundle-budget] ok   CSS                assets/index-CeuyErov.css       6.22 kB / 20.00 kB budget`
`All bundle artifacts are within budget.` Exit 0.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm --filter @finaler-draft/api test:integration
```

**40 passed** (20 persistence + 11 Stripe subscription + 9 entitlement), matching slice 2's baseline
exactly -- unchanged, since this slice touches no `apps/api` code. Exit 0.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm test:system:persistence
```

**18 passed**, matching the stated baseline exactly. Exit 0. See "A regression this slice risked
reintroducing, and what was done about it" below for why this result needed real scrutiny rather
than a glance at the pass count.

## A regression this slice risked reintroducing, and what was done about it

`progress/billing-checkout.md`'s "A regression, found and fixed" records that an earlier slice's
account menu fetched `/api/entitlement` unconditionally on every visit to the projects page, and
that measurably regressed this exact gate (`test:system:persistence`, `page-rendering-
persistence.spec.ts`'s "zoom modes" test) under Playwright's 3-worker contention against one real
Postgres instance and one real API process -- `getSnapshot` runs three parallel SQL queries, and
the projects page is the one page nearly every system-suite flow touches at least once. That fetch
was deferred behind the account menu's own open event, then removed from this page entirely once
`routes/billing.subscription.tsx` took over as the one place entitlement state was shown --
confirmed by this repo's own pre-existing test, `'never fetches entitlement or billing state from
the account menu itself'`.

This slice's lapse-chooser banner requires exactly the fetch that was removed: it must be visible
on page load, with no interaction to defer it behind the way the account menu could defer its own.
Rather than silently reintroduce a documented regression or silently drop a required feature, I:

1. Read `progress/billing-checkout.md` in full before writing the fetch, so the risk was known
   going in, not discovered after the fact.
2. Added `staleTime: 60_000` to this page's `['entitlement']` query specifically to blunt repeated
   refetching across a browsing session's several visits to this page (unlike the account-menu
   fetch this replaces, which fired on every single mount) -- entitlement state changing is not
   something a writer needs reflected within a minute of it happening on a page whose own action is
   "go read the details on another page."
3. Ran the actual gate, diagnostically, the same way `billing-checkout.md`'s own regression was
   found (not assumed): **18/18, matching baseline, on this run.**

This is reported honestly as "on this run," not as a closed question. The prior regression's own
writeup describes it as contention-shaped and machine-sensitive (a `--workers=1` run passed 18/18
even _with_ the original, unmitigated eager fetch; only the default 3-worker run reproduced it).
One clean run here is real evidence the `staleTime` mitigation is doing useful work, not proof the
risk is zero under different hardware or load. If this gate becomes flaky after this slice merges,
this section -- and `progress/billing-checkout.md`'s own diagnosis method (`git stash -u`, rerun,
compare) -- is where to start.

## Known limitations / decisions for a later slice to pick up

- **Role-based read-only (a reviewer's screenplay) is out of this slice's scope and was not
  touched.** `checkEntitlement`'s paid-tier short-circuit means a paying account's `editable`
  computation in the screenplay route resolves `true` for _any_ screenplay regardless of the
  account's actual project role; the underlying `ProjectStore.updateScreenplay`'s own
  membership/role check (unrelated to entitlement, `apps/api/src/projects.ts`) still refuses a
  reviewer's write server-side, so no work-loss risk exists, but the _web editor_ does not
  currently render read-only for that reason on its own account. This slice's brief was
  specifically "when a screenplay is not the account's editable one" (the entitlement/billing
  dimension); a reviewer-role read-only presentation, if wanted, is a separate, pre-existing gap
  worth its own scope.
- **The lapse-chooser banner and the read-only editor's banner are both silent on an entitlement
  fetch error**, by deliberate but asymmetric design: the projects-page banner is purely advisory
  (nothing it does gates editing, so staying silent until the next successful fetch costs nothing),
  while the editor fails _safe_ to read-only on the same error (never silently permits editing it
  could not confirm). Worth the owner's attention if a transient entitlement-fetch failure turning
  the editor read-only, rather than merely hiding a banner, is judged too aggressive in practice.
- **No default value or timer widens either banner's visibility window** -- both banners disappear
  the instant their triggering condition stops holding (a successful `invalidateQueries`), with no
  "dismiss and don't show again" affordance. Not asked for, and plan.md's "must never choose on the
  user's behalf" argues against anything that could be read as the system deciding the writer no
  longer needs to be told.

## Two bugs found by testing against a real lapsed subscription

The owner cancelled a real subscription via the Stripe CLI (the whole webhook chain ran) and
exercised this slice's UI directly, against the worktree above before either fix. Two defects
surfaced that no gate up to that point had caught.

### Bug 1: the read-only banner broke the application shell's layout

**Symptom:** opening a read-only screenplay rendered the shell broken -- the toolbar stretched to
fill the screen, the manuscript gone, the navigator and inspector crushed against the bottom edge.

**Cause:** `.application` (styles.css) lays the shell out as a CSS grid with a fixed five-row
`grid-template-rows: 38px 31px 47px minmax(0, 1fr) 30px`. `.readonly-banner` is an extra grid
child with no row budgeted for it, so every row after it shifted down one: the banner consumed the
toolbar's 47px row, the toolbar inherited the workspace's `minmax(0, 1fr)` row (hence "stretched to
fill the screen"), the workspace was squeezed into the status bar's 30px row, and the status bar
overflowed into an implicit, unstyled row past the end of the track list.

**Fix:** a modifier class, `.application.has-readonly-banner`, applied on `<main>` only when
`entitlementReadOnly` is set (`App.tsx`'s `applicationClassName`), inserting one extra `auto`-sized
row between the menubar and the toolbar in the CSS -- not a fixed pixel height, since the banner's
message length (and therefore its wrapped line count) varies with which entitlement state produced
it. `auto` also does the right thing at the narrow breakpoint, where the same banner text wraps to
more lines. Both copies of the rule (the base one at `styles.css:119` and the
`@media (max-width: 600px)` one, which overrides the toolbar row to 42px instead of 47px) gained
the identical extra row, keeping them in sync deliberately rather than by luck.

**Verified visually, not only by test.** A hand-built static fixture (real `styles.css`, real
class names) was screenshotted with Playwright's Chromium at 1280×800 (normal width) and 400×800
(inside the `max-width: 600px` breakpoint), both with and without the fix:

- Without `.has-readonly-banner`: the toolbar measured 639px tall at 1280×800 -- exactly the
  reported defect, confirmed with real numbers, not assumed from reading the CSS.
- With `.has-readonly-banner`: titlebar/menubar/banner/toolbar sized correctly, the workspace
  filled the remaining space, and the status bar sat at the bottom of the viewport, at both widths;
  the banner itself wrapped to two lines and the toolbar correctly used the narrow breakpoint's
  42px override at 400px wide.

That ad hoc fixture and its screenshots were scratch work, not committed. The permanent regression
coverage is two real tests, deliberately not a jsdom one:

- **jsdom is genuinely unable to catch this class of defect** -- it does not run layout at all, so
  no unit test can observe a stretched toolbar or a crushed workspace. What jsdom _can_ verify
  honestly is the mechanism the CSS fix depends on: `App.test.tsx` gained two tests asserting the
  rendered `<main>` carries `has-readonly-banner` exactly when `entitlementReadOnly` is set and
  never otherwise. This protects the App.tsx-side half of the fix (someone deleting the conditional
  class) but says nothing about whether the CSS itself is correct.
- **`apps/web/e2e/app-shell.spec.ts`** (real Chromium, the real built stylesheet, no database --
  this file already established the right pattern for shell-layout defects, including its own
  "not-saving dot" test's explicit reasoning for why jsdom can't see this class of bug) gained
  `'the read-only banner gets its own grid row instead of displacing the toolbar into the
workspace'`: injects the exact classes and DOM order `App.tsx` renders, with
  `.has-readonly-banner` applied, and asserts real `getBoundingClientRect()` geometry -- the
  toolbar stays near its 47px track, the banner sits above it, the workspace gets real room, and
  the status bar stays inside the viewport. Confirmed to actually fail without the fix (see
  "Mutations" below) before being finalized; this test file runs under `pnpm test:system` (the
  ordinary `playwright.config.ts`, no database), not `test:system:persistence`.

### Bug 2: a refused "Make this one editable" was invisible

**Symptom, in the owner's words:** "the user wouldn't know that. They would just know they clicked
a button that did nothing." Choosing screenplay A, then opening screenplay B and clicking "Make
this one editable" there returns a correct 409 (the second switch within 24h of the first is
cooldown-gated), but the UI showed nothing.

**What was already correct:** `App.tsx`'s `makeEditable` handler already caught a rejected
`onMakeEditable()` and displayed `MessageApiError.serverMessage` via `role="alert"` -- confirmed
working end-to-end by both the existing App-level test and a full route-level test written this
round. No swallowed-promise defect was found in the shipped code on review; the gap was in what the
UI told the writer, and when.

**What changed, and why (the two decisions the task asked me to make deliberately):**

1. **The button now says so up front when the account is already known to be inside its
   cooldown**, rather than only ever discovering it via a click. `GET /api/entitlement` already
   returns `cooldownEndsAt`, computed server-side from `EDITABLE_SLOT_COOLDOWN_MS` -- the route
   compares it to the current time (`cooldownActive = cooldownEndsAt !== null && cooldownEndsAt >
now`) and, when true, passes a new `EntitlementReadOnly.cooldownUntil` (a human-readable local
   time string) down to `App.tsx`. The button is `disabled` and an adjacent line states exactly
   when it will clear: _"You can switch to a different screenplay again at {time}."_ This is
   **reading the server's own value for display, not recomputing the interval or the policy**:
   `EDITABLE_SLOT_COOLDOWN_MS` is never referenced client-side, and a stale or wrong read here
   costs at most one avoidable click, never a false "you may edit" -- the server's own 409 remains
   the only actual gate, unchanged.
2. **A click that lands inside a cooldown this app didn't yet know about (a genuine race, not a
   bug) still gets a clear, dated answer.** The route's `onMakeEditable` now wraps
   `api.switchEditableScreenplay` in `try { ... } finally { invalidateQueries(['entitlement']) }`
   -- invalidating entitlement on _failure_ too, not only success. The failed click's own
   `MessageApiError.serverMessage` (the server's own wording, not invented parallel copy) still
   shows immediately via the existing `role="alert"` path; the refetch this triggers then carries a
   fresh `cooldownEndsAt` into the very next render, at which point the preemptive, dated notice
   from (1) takes over and the raw one-off error is suppressed (`App.tsx`'s error paragraph is now
   gated on `entitlementReadOnly.cooldownUntil === undefined`) -- so the two never appear stacked
   on top of each other saying overlapping things.

**The deliberate choice, stated plainly:** disabling-with-explanation is the _primary_ design for
the ordinary case (the entitlement snapshot already told this app the click cannot succeed, so
telling the writer up front is strictly better than a round trip that can only confirm what is
already known); letting a click through to a clear, server-worded error is kept as the _necessary
fallback_ for the race window where this app's last fetch predates a cooldown the server already
knows about. These are not two competing designs implemented halfway -- each covers a distinct,
real scenario the other cannot, and the second is what makes the first safe to rely on without a
client-side cooldown re-implementation. No cooldown duration or policy was added client-side
anywhere in this change.

## Mutations for both bugs (this round)

Every mutation below was applied to the actual source, confirmed to fail the named test(s), then
reverted; `grep -rn MUTATION apps/web/src apps/web/e2e` after the final revert returns nothing, and
the full web suite (645 tests) was re-run clean after all reverts.

**Bug 1 (the grid):**

13. **The base `.application.has-readonly-banner` CSS rule deleted outright.** Rebuilt the web
    bundle and ran `apps/web/e2e/app-shell.spec.ts`'s new test against the real build: failed with
    the toolbar measuring 639px tall (expected `< 80`) -- the exact reported defect, reproduced on
    demand. This is the one mutation in this whole slice verified against the actual compiled CSS
    and a real browser, not a source-level revert alone.

**Bug 2 (the cooldown affordance), all against jsdom source, each confirmed to fail before revert:**

14. The route's `onMakeEditable` reduced from `try { switchEditableScreenplay } finally {
invalidateQueries }` to two sequential awaits with no `finally` (invalidate only follows
    success). Failed "invalidates entitlement even when the switch itself fails...".
15. `cooldownActive`'s `cooldownEndsAt.getTime() > Date.now()` weakened to `cooldownEndsAt !==
null` (ignoring whether the deadline has already passed). Failed "passes no cooldownUntil...
    once a past cooldownEndsAt has already elapsed" -- the button came back disabled when a
    24-hour-old cooldown should long since have cleared.
16. The button's `disabled={... || entitlementReadOnly.cooldownUntil !== undefined}` reduced to
    drop the cooldown half. Failed both App.tsx cooldown tests: the button stayed clickable, and a
    direct `fireEvent.click` on it reached `onMakeEditable` (in the test built specifically to
    prove that path unreachable, per Bug 1's precedent of proving disabled controls actually block
    the action rather than only looking blocked).
17. The error paragraph's `entitlementReadOnly.cooldownUntil === undefined` suppression guard
    dropped, so the raw one-off 409 text and the up-front cooldown notice both remained on screen
    together after a refetch. Failed "yields to the up-front cooldown notice, not a redundant raw
    error...", which asserts the stale `role="alert"` is gone once the fresh notice arrives.

## Gates, re-run after both fixes

```
pnpm lint
```

Clean, no output, exit 0.

```
pnpm format:check
```

`prettier --write` was run on every file touched this round before this check (App.tsx and
App.test.tsx needed it; styles.css, both route files, routeHarness.tsx, and app-shell.spec.ts were
already clean). `All matched files use Prettier code style!`, exit 0.

```
pnpm typecheck
```

Clean across every package and both apps, exit 0.

```
pnpm test
```

`apps/api`: 215 passed, 40 skipped (unchanged -- no `apps/api` code touched by either fix).
`apps/web`: **645 passed** (639 from the first round + 6 new this round: 2 grid-class tests, 2
cooldown-affordance tests in `App.test.tsx`, 3 route-level tests in
`$projectId.screenplays.$screenplayId.test.tsx` -- net six after accounting for the test-count
arithmetic above). Every other package unchanged and green. Exit 0.

```
pnpm --filter @finaler-draft/web test:coverage
```

645 passed, exit 0.

```
pnpm check:bundle-budget
```

`[bundle-budget] ok` for entry, lazy editor, and CSS chunks -- the new CSS rules and the small
route/App changes did not move any artifact out of budget. Exit 0.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm --filter @finaler-draft/api test:integration
```

**40 passed**, unchanged. Exit 0.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm test:system:persistence
```

**18 passed**, matching baseline. Exit 0.

Additionally, since Bug 1's real regression test lives in `apps/web/e2e/app-shell.spec.ts` (not
part of `test:system:persistence`, which ignores that file): `pnpm build && npx playwright test
apps/web/e2e/app-shell.spec.ts` -- **6 passed** (the file's five pre-existing tests plus the new
one), exit 0.
