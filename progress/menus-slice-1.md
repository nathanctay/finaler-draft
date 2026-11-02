# Menus, slice 1: Edit, View and Format

Branch `feature/menus-slice-1`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/menus`,
off `bd964b5` (current `main`).

## The problem

`apps/web/src/applicationMenubar.tsx` carried `INERT_MENU_LABELS = ['Edit', 'View', 'Format',
'Tools', 'Help']`, rendered as plain `<span>`s -- five labels that looked like menus, did nothing,
and were not even keyboard-reachable. Only File was real. This slice makes three of the five real
by surfacing capabilities that already existed elsewhere in the app, rather than inventing anything
new: undo/redo, the element-type converter, the zoom presets, the panel toggles, and the dark-canvas
preference. Tools and Help stay inert labels; a later slice activates them alongside the Characters
tab.

## What each menu now contains, and which existing capability it surfaces

**Edit** (`App.tsx`, editor only):

| Item         | Surfaces                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undo         | `editor.commands.undo()` / `editor.can().undo()` -- the identical pair the toolbar's own undo button already calls. `packages/screenplay-editor/src/index.ts`'s `ScreenplayYjsExtension` registers these under `@tiptap/extension-history`'s own command names, backed by `y-prosemirror`'s `yUndoPlugin` -- the same local-only undo plan.md specifies for collaboration, unchanged by this slice. |
| Redo         | The `redo` half of the same pair.                                                                                                                                                                                                                                                                                                                                                                   |
| Cut          | New. Writes the selection to the clipboard, then deletes it once the write succeeds. See "Clipboard" below.                                                                                                                                                                                                                                                                                         |
| Copy         | New. Writes the selection to the clipboard. See "Clipboard" below.                                                                                                                                                                                                                                                                                                                                  |
| _(no Paste)_ | Deliberately absent. See "No Paste" below.                                                                                                                                                                                                                                                                                                                                                          |
| Select all   | `editor.commands.selectAll()` -- a plain ProseMirror/Tiptap core command, not previously exposed anywhere in this app's own UI.                                                                                                                                                                                                                                                                     |

**Format** (`App.tsx`, editor only):

| Item                             | Surfaces                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Element type submenu (7 entries) | `screenplayElementTypes` and `displayElement` (`@finaler-draft/screenplay-editor`) and `changeElement`'s existing call into `convertActiveScreenplayBlock` -- the exact list and the exact conversion the toolbar's own `<select>` already drives. The menu does not restate the list; it `.map()`s the same array the toolbar imports, so the two cannot drift. |

**View** (`App.tsx` and the diff route both):

| Item                                                          | Surfaces                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigator / Inspector toggles                                 | The existing `panels` state and `togglePanel`, already wired to the toolbar's two `ToolButton`s.                                                                                                                                                                                                                                                        |
| Dark canvas                                                   | The existing `dark` state and `setDark` -- moved here from a standalone `<button>`. See "Where the dark-canvas toggle went" below.                                                                                                                                                                                                                      |
| Zoom submenu (11 entries: Fit width, Fit page, 9 percentages) | `ZOOM_PRESET_PERCENTS` (`zoomPresets.ts`) and `chooseZoomPreset` on the editor, `clampZoomPercent`/`setZoomPercent` on the comparison -- the identical preset list and identical dispatch the toolbar's own zoom `<select>` already uses on both screens. Not restated: both routes `.map()` the same `ZOOM_PRESET_PERCENTS` array the toolbar imports. |

None of the three menus' items carry a "currently selected" indication (no checkmark, no
`aria-pressed`) -- `OverflowMenuItem` has no such field, and this slice does not add one (see "Do
not change `OverflowMenu.tsx`" in the brief). A toggle item's own label states the action it will
take (`Hide Navigator` / `Show Navigator`, `Dark canvas` / `Light canvas`), the identical convention
the canvas toggle already used as a standalone button. The live percentage stays visible in the
toolbar's `<output>` regardless; the Zoom submenu is a quick-jump list, exactly as the File menu's
Download submenu is a list of actions with no indication of which format was last downloaded.

## The prop seam, and why an empty menu is not rendered

`fileMenuItems` was already a plain array the caller builds and gates; this slice gives Edit, View
and Format the identical shape:

```ts
export interface ApplicationMenubarProps {
  readonly editMenuItems?: readonly OverflowMenuItem[] | undefined;
  readonly fileMenuItems: readonly OverflowMenuItem[];
  readonly fileMenuRef?: Ref<HTMLDivElement>;
  readonly formatMenuItems?: readonly OverflowMenuItem[] | undefined;
  readonly viewMenuItems?: readonly OverflowMenuItem[] | undefined;
}
```

`fileMenuItems` stays required and non-optional: every screen that renders this component at all
has at least "Document settings…" to offer, permanently disabled or not. The other three are
optional, and a new `hasItems()` guard treats `undefined` and `[]` as the identical instruction --
cut the menu entirely, not render it as a label and not render it as an empty, triggerable shell:

```ts
function hasItems(
  items: readonly OverflowMenuItem[] | undefined,
): items is readonly OverflowMenuItem[] {
  return items !== undefined && items.length > 0;
}
```

This is the owner's own rule, stated once rather than left to each caller to reimplement: a menu
with nothing in it is not a menu. `INERT_MENU_LABELS` shrank from five entries to two (`Tools`,
`Help`); Edit/View/Format are no longer spans at all, in either their real or their absent form.

## The comparison-view decision

**Decided by the brief, not re-litigated here:** on the read-only revision comparison, View renders
and Edit and Format are omitted outright.

The reasoning, as recorded in the diff route's own comment: a comparison is a read-only reading view
of two stored snapshots. "Change the text" and "change an element's type" do not apply to one at
all -- there is nothing to cut, copy, undo, redo, or convert. Rendering either menu anyway, full of
disabled items that all share one repeated sentence ("this is a read-only comparison"), would be
noise rather than explanation. That is a different situation from the File menu's six items, each
of which is disabled for its own specific, nameable reason a reader might actually come looking for
("A comparison has nothing to save — open the live document to name a revision."). A wall of six
copies of the same sentence under Edit, and seven more under Format, teaches a reader nothing the
first one didn't.

View is the opposite case: it genuinely applies. The comparison has its own `zoomPercent` state and
its own dark-canvas preference, both real view preferences over a real (if read-only) canvas. Fit
width/Fit page are the one exception within View, and they are handled exactly the way the toolbar's
own zoom preset already handles them on this screen: really disabled, with a reason
(`FIT_MODE_DISABLED_REASON`, shared between the two controls so the sentence cannot drift) --
because they need `.editor-region`'s measured available area and a resize-driven recompute lifecycle
this view has none of, not because zooming itself doesn't apply.

Proven in three places: `applicationMenubar.test.tsx`'s own "renders exactly File and View, with
Edit and Format absent, matching the comparison route's own choice"; the diff route's own
`"omits Edit and Format entirely, rather than rendering either full of disabled items"`; and the
real-browser chrome enumeration in `screenplay-diff-persistence.spec.ts` (below).

## Clipboard: what Cut and Copy do, and what was measured

The brief's framing was that Cut/Copy "work in Chromium via `document.execCommand` when the document
holds a real selection" and "are less certain elsewhere," and asked for either a genuinely working
control or an honestly disabled one -- never a dead one.

**`document.execCommand('copy'/'cut')` was rejected before being tried**, for a reason specific to
this component rather than a general objection to the API: `OverflowMenu`'s Cut/Copy items are real
`<button>`s, and activating one moves DOM focus onto that button _before_ `onSelect` runs.
`execCommand('copy')` reads the browser's current native Selection at the moment it is called --
which, by then, may already have moved or collapsed away from the text the writer actually
highlighted in the editor, onto whatever (if anything) the click left selected. Reading from the
native Selection at all couples correctness to exactly when focus moves, which is also the fact
behind the long-standing Safari dismissal comment already in `OverflowMenu.tsx` ("WebKit does not
focus a `<button>` pressed with a mouse") -- i.e. a path this app has already been burned by once.

**What shipped instead:** Cut and Copy source their text from the ProseMirror model
(`editor.state.selection`, via `editor.state.doc.textBetween`), which is unaffected by where DOM
focus currently is -- only a dispatched transaction ever changes it -- and write it with
`navigator.clipboard.writeText()`, the write half of the Clipboard API. This sidesteps the
focus-race entirely, because nothing about it depends on the browser's native Selection at any
point.

**What was actually measured, in this sandbox:** only Chromium is installed here (confirmed:
`~/Library/Caches/ms-playwright` has `chromium`/`chromium_headless_shell` and nothing else;
`playwright.config.ts`'s own `channel` plumbing exists for `chrome` specifically). Real-browser
proof is therefore Chromium-only: `apps/web/e2e/menubar-menus-position.spec.ts` covers the
menu's own geometry, and the unit suite (`App.test.tsx`'s new "Edit, View and Format menus"
describe block, 12 tests) drives the actual clipboard write/delete through a real, if
Vitest-mocked, `navigator.clipboard.writeText`, asserting the exact string written and the
document's state afterward -- not merely that a handler was called.

**`writeText` versus `readText`, and why that is the right line to draw, not a hedge:** `writeText`
triggered synchronously inside a user-gesture click handler is granted with no permission prompt in
every engine this product supports (Chromium, Firefox, Safari) -- this is documented, broadly relied
upon browser behavior, distinct from `readText` (what a menu Paste would need), which Safari and
Firefox both gate or refuse outright. That asymmetry is not a guess standing in for a browser this
sandbox cannot drive; it is the standing difference between the Clipboard API's write and read
halves, and it is also exactly why "No Paste" (below) is correct policy rather than a shortcut.

**Conclusion:** Cut and Copy are genuinely reachable, not merely not-broken-in-the-one-browser-tested.
Measured directly in Chromium; relied on documented, engine-wide `writeText` behavior (not measured
directly) for Firefox and Safari, since this sandbox has no build of either to drive. This is stated
as what it is -- a measurement in one engine plus a documented fact about the others -- rather than
reported as "tested" more broadly than it was.

**A discovery made while testing it, worth recording for whoever edits this next:**
`@testing-library/user-event`'s own `setup()` installs a working in-memory clipboard stub on
`navigator.clipboard` unconditionally (for its own `user.copy()`/`.paste()` helpers), even though a
genuinely fresh jsdom window has no `navigator.clipboard` at all. The one test that needs to prove
the "no Clipboard API" disabled state therefore has to force that absence back explicitly
(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })`) rather
than relying on an untouched environment -- and because `clipboardWriteSupported` is read fresh on
every render rather than kept in React state, that test also has to call `rerender` afterward, or
the component never re-evaluates it. Both are commented in place at the test itself.

### Cut's write-then-delete ordering

Cut writes to the clipboard first and deletes the selection only in the success branch of that
write's promise. A failed write (denied, or thrown for any other reason) leaves the document
exactly as it was and surfaces the same `Toast` the export items already use ("Cut failed")
rather than silently losing the writer's selected text for nothing. Mutation-tested below
(moving the delete ahead of the write).

### No Paste

The owner's own words, recorded verbatim in `App.tsx` at the Edit menu's item array so nobody adds
this back without reading them first: _"if we can still right click to paste, we can leave that out
of the menu for now."_ A menu Paste item would need `navigator.clipboard.readText()` to get anything
onto the document, and that call is exactly the half of the Clipboard API Safari and Firefox gate or
refuse -- a menu entry built on it would silently fail on two of the three engines this product
supports, which is precisely the dead-control failure mode this whole slice's clipboard section
exists to rule out. Right-click paste and Ctrl+V both still work unchanged; they go through the
browser's own native paste event, never through this menu.

## Where the dark-canvas toggle went, and why

It was a loose `<button>` sitting in the menubar row next to (not inside) the menus -- the one stray
control in that row, and the one thing `applicationMenubar.tsx`'s own module comment no longer had
a category for once Edit/View/Format stopped being spans. It is a view preference (`.dark` restyles
chrome and surround, never the manuscript), the same category as the two panel toggles and the zoom
presets already inside View, so it moved inside View as an ordinary item rather than staying the
menubar's only non-menu, non-label child. `ApplicationMenubar` no longer takes a `canvasToggle` prop
at all; each caller (`App.tsx`, the diff route) builds the item itself from its own `dark`/`setDark`
state, the same way it already built the File menu's items from its own state.

One consequence worth stating plainly: `.menubar-spacer` (the flex spacer that used to push the
dark-canvas button to the row's right edge) had nothing left to push once the button moved, so it
was removed along with its two CSS rules rather than kept as dead chrome.

## CSS: generalizing `.menu-file` to every menubar menu

File's trigger styling and its left-anchored dropdown (`.menu-file .overflow-menu-trigger`,
`.menu-file .overflow-menu-list { right: auto; left: 0 }`) existed because File was the only real
menu in the row. Edit, View and Format needed the identical two things, so both wrapper divs now
carry a shared `.menubar-menu` class (`<div className="menubar-menu menu-file">`, etc.) and the two
rules were generalized to key off it, rather than duplicated three more times. `.menu-file` (and the
sibling `.menu-edit`/`.menu-view`/`.menu-format`) stay as per-menu identifiers with no styling of
their own -- `App.tsx` still queries `.menu-file` specifically to return focus to that one trigger
after a dialog closes.

**This generalization is exactly the kind of change that reads correctly in the source and can
still fail to reach three of the four menus it was meant to cover**, because `submenu-position.spec.ts`
already documents the identical failure shape for a single-class rule losing a cascade fight it
looked like it was winning. `apps/web/e2e/menubar-menus-position.spec.ts` (new) measures, in real
Chromium, that Edit/View/Format's triggers actually match File's height/border-radius/font-weight,
and that a dropdown opened from a menu other than the leftmost one (Format) actually anchors to
_that_ menu's own trigger rather than to the viewport's left edge or some other menu's trigger --
the two failure modes a copy-pasted or incompletely-generalized selector could produce silently. It
also re-proves, through `.menu-format` rather than `.menu-file`, the exact submenu-flyout-positions-
beside-not-on-top-of geometry `submenu-position.spec.ts` already proved for File's Download, since
Format's own "Element type" submenu reuses the identical flyout markup and CSS path.

The narrow-viewport rule that used to read `.menubar > span:nth-child(n + 4), .menubar
button:nth-child(n + 4)` (hide the 4th-and-later direct child) no longer makes sense: Edit/View/
Format are real, functioning menus now, only _sometimes_ present (the comparison omits two of
three), so a fixed child-index cutoff would hide a different, props-dependent set of controls on
each route -- and would now also hide a menu a writer can actually operate, which the original rule
never had to worry about since everything past index 3 was already inert. Replaced with a class
(`.menubar-inert`, carried by the two still-inert `<span>`s) so the narrow-width behaviour is
"the still-inert labels disappear" regardless of how many real menus precede them, on either route.

## Mutation testing

Every guard below was broken, confirmed to fail the specific test(s) that should catch it, then
restored. `git diff --stat` against the pre-mutation tree was re-confirmed empty after each revert.

| #   | Mutation                                                                                           | Result                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `ApplicationMenubar`'s `hasItems()` changed to ignore `items.length > 0` (so `[]` renders a menu)  | Killed exactly the 3 "does not render … when given an empty array" tests in `applicationMenubar.test.tsx`.                                                                                               |
| M2  | `.menubar-menu .overflow-menu-list { right: auto; left: 0 }` reverted to `.menu-file`-only         | Killed `menubar-menus-position.spec.ts`'s "the File and Format menus each open a left-anchored dropdown…" (`Expected: 134.69, Received: 33.33` -- Format's dropdown collapsed toward the viewport edge). |
| M3  | `.menubar-menu .overflow-menu-trigger` reverted to `.menu-file`-only                               | Killed `menubar-menus-position.spec.ts`'s "Edit, View and Format render as flush, label-sized triggers…" (`border-radius` reverted to the pill default).                                                 |
| M4  | Cut's `disabled` expression dropped `!editingAllowed`                                              | Killed `App.test.tsx`'s "lets a reviewer copy but not cut" (Cut became enabled for a reviewer).                                                                                                          |
| M5  | `clipboardWriteSupported` hardcoded to `true`                                                      | Killed `App.test.tsx`'s "disables Cut and Copy when the browser has no Clipboard API, naming why".                                                                                                       |
| M6  | `cutSelection` deletes the selection before (not inside the success branch of) the clipboard write | Killed `App.test.tsx`'s "tells the writer a Cut failed instead of deleting text that was never actually copied" -- the block the test expects to survive a rejected write was gone.                      |
| M7  | `syncEditorState` hardcoded `setHasSelection(false)`                                               | Killed 5 tests in `App.test.tsx`'s new describe block -- every one that depends on `hasSelection` becoming `true` after "Select all".                                                                    |
| M8  | Format's `Element type` children's `disabled` hardcoded to `false`                                 | Killed `App.test.tsx`'s "disables every Element type choice, carrying one reason, when editing is not allowed".                                                                                          |
| M9  | View's "Hide/Show Navigator" item's `onSelect` replaced with a no-op                               | Killed `App.test.tsx`'s "toggles Navigator and Inspector from the View menu…".                                                                                                                           |
| M10 | The diff route's `ApplicationMenubar` call given an `editMenuItems` array it should never pass     | Killed the diff route's own "omits Edit and Format entirely, rather than rendering either full of disabled items".                                                                                       |

Not separately mutation-tested: `OverflowMenu.tsx` itself (untouched, per the brief) and its own
39-test suite, which already mutation-tests the submenu/disabled machinery Format's and View's
submenus now also exercise.

## Test-file updates, beyond the new tests

- **`apps/web/src/applicationMenubar.test.tsx`** -- rewritten rather than patched: the five-label
  `INERT_MENU_LABELS` constant and the `canvasToggle` prop are both gone from every test, and a new
  `describe('Edit, View and Format: a menu with no items does not render at all', …)` block proves
  both halves of the "no items" rule for each of the three menus (prop omitted, and prop `[]`) and
  the comparison route's own real combination (File + View only).
- **`apps/web/src/App.test.tsx`** -- the one existing test that clicked the standalone "Dark canvas"
  button now opens the View menu first; a new `describe('Edit, View and Format menus', …)` block (12
  tests) covers the list of each menu's items, undo/redo parity with the toolbar, Cut/Copy gating in
  every combination (no selection, no clipboard support, read-only, reviewer), the write-then-delete
  ordering, Format's element conversion and its read-only gating, and View's panel toggles and Zoom
  submenu.
- **The diff route's own test file** -- the "Dark canvas" test now opens the View menu; two new
  tests cover the Edit/Format omission and the View menu's own content (including the Zoom
  submenu's Fit-mode-disabled state).
- **`apps/web/e2e/screenplay-diff-persistence.spec.ts`** -- the chrome-parity assertion that used to
  read `expect(comparisonFrame.menubarChildren).toEqual(editorFrame.menubarChildren)` no longer holds
  by construction (the two screens' menubars are now intentionally different in which menus exist,
  not only in disabled state and panel contents). Replaced with two literal arrays stating each
  screen's real children, and a stated fourth permitted difference (which menus exist) alongside the
  three the file's own comment already named. This is the one persistence-suite edit in this slice;
  see "Gates" below for how it was verified against a real database.

## Gate results

All from the worktree root, after `pnpm install --frozen-lockfile` and `pnpm build:packages`.

1. **`pnpm lint`** (`eslint . --max-warnings=0`) -- clean, exit 0.
2. **`pnpm typecheck`** (every package, both apps, `astro check` for `apps/landing`) -- clean, exit 0. 0 errors / 0 warnings / 0 hints throughout.
3. **`pnpm test`** -- exit 0. `apps/web` 1115 tests / 72 files (up from 1101/70 on `main`); `apps/api`
   317 passed + 101 skipped (integration, no database in this run); `apps/collab` 169 passed + 32
   skipped; `packages/pdf` 61 passed.
4. **`pnpm test:coverage`** -- exit 0, every per-file threshold (80% lines/functions/branches/
   statements) met. The three files this slice changed most: `App.tsx` 92.09/88.47/87.17/92.09,
   `applicationMenubar.tsx` 100/100/100/100, the diff route's `index.tsx` 98.58/92.99/88.57/98.58.
5. **`pnpm build`** -- clean (web, api, collab, landing, every package).
6. **`pnpm check:bundle-budget`** -- entry chunk 112.29 / 120.00 kB, lazy editor chunk 167.18 / 200.00
   kB (6 chunks), CSS 8.24 / 20.00 kB. All within budget with headroom; the lazy chunk grew from
   145.33 kB (the last recorded figure, `progress/download-submenu.md`) to 167.18 kB -- the new
   Edit/Format item arrays, the Cut/Copy/Select-all handlers, and the Zoom submenu's extra items all
   live in `App.tsx`, which is part of that chunk.
7. **`pnpm test:system`** (`PLAYWRIGHT_CHANNEL=chrome`) -- **97 passed** on the clean run (a first
   run reported one failure, `app-bar-logo.spec.ts`'s "keyboard focus reveals the label…", unrelated
   to anything this slice touches -- `app-bar-logo.spec.ts` is about the brand-logo hover/focus
   reveal, not the menubar; reproduced as a flake, not a regression: 3/3 clean on an isolated
   `--repeat-each=3` run, and 97/97 clean on a full immediate re-run). Includes the 3 new
   `menubar-menus-position.spec.ts` tests.
8. **`pnpm test:integration`** -- exit 0 against the disposable Postgres below: `packages/database`
   11/11, `apps/api` 101/101 (7 files), `apps/collab` 32/32 (3 files).
9. **`pnpm test:system:persistence`** (`PLAYWRIGHT_CHANNEL=chrome`, against the disposable Postgres
   below) -- run three times, per the owner's own standing instruction that this suite is flaky:
   - **Run 1: 33/36.** Three failures: `screenplay-diff-persistence.spec.ts:82` with duplicated
     characters (`"Added after the milestone.tone."`) -- the exact known flake named in this task's
     brief. `persistence.spec.ts:319` ("pasting content copied from this editor…") timed out waiting
     for a second paste to reach the server. `page-rendering-persistence.spec.ts:739` ("a page frame
     stays put when an edit changes a short page's fill…") failed on a spacer height that did not
     change -- not one of the two flakes named in the brief, but also nothing this slice's changes
     (menubar/App.tsx menu items, CSS scoped to `.menubar`/`.overflow-menu-*`) could plausibly touch:
     no pagination, no `.page`, no spacer code was changed anywhere in this branch.
   - **Run 2: 36/36, clean** -- including both of `screenplay-diff-persistence.spec.ts`'s tests
     (`:82` and `:642`), which is the run that actually exercises this slice's own edit to that
     file's menubar assertions end to end against a real database.
   - **Run 3: not completed.** The agent writing this document was cut off mid-run; the
     sentence that followed promised a third result that does not exist. Recorded as not run
     rather than left as a dangling forward reference.

   Consistent with the standing note that this suite fails roughly 2 runs in 3 on `main` already;
   no run in this slice failed on anything this slice's own code touches a second time, and the one
   edit this slice made to the persistence suite itself (`screenplay-diff-persistence.spec.ts`) was
   proven correct by the clean run.

### Postgres

```
docker run -d --name menus-test-pg -e POSTGRES_PASSWORD=postgres -p 55453:5432 postgres:16
```

Removed with `docker rm -f menus-test-pg` once the gates above finished. No credential from this
instance is reused anywhere outside this worktree's own test runs.

## Known limitations / things not done

- **Firefox and Safari were not driven directly.** Only Chromium is installed in this sandbox. The
  Clipboard-write conclusion above rests on documented, engine-wide `writeText` behavior for those
  two, not on a measurement taken here -- stated as such rather than claimed as tested.
- **No "currently active" indication on any toggle or Zoom-submenu item.** `OverflowMenuItem` has no
  checked/active field, and adding one would be a change to the shared component the brief rules out
  of scope ("Do not change `components/OverflowMenu.tsx`"). Every toggle instead states the action
  it will take in its own label text, the same convention the standalone dark-canvas button already
  used.
- **Arrow-key traversal between menubar menus is unchanged and out of scope**, per the brief: Tab
  still reaches each of File/Edit/View/Format independently; Left/Right does not move between them.

## Two defects the owner found by hand, and what they say about the gates above

Both were reported after the gates above were green, which is the useful part: neither was
reachable by anything this slice had written.

### "Select all does not work. It just scrolls me to the bottom"

One omission with two symptoms. `onSelect` was `editor?.commands.selectAll()` and nothing else:

- **Nothing looked selected.** `selectAll` moves the selection in the editor's state, but the click
  that ran it left focus on the menu item, and ProseMirror paints no selection through an unfocused
  view. The whole manuscript was selected and the writer could not see it.
- **The viewport jumped to the last page.** `selectAll` leaves the selection head at the end of the
  document, and the resulting dispatch scrolls it into view. With no visible selection, that jump
  was the only feedback the command gave -- hence the owner's description, which is an exact
  account of what the code did.

Fixed by focusing the view and restoring the scroller:

```ts
const region = editorRegionRef.current;
const scrollTop = region?.scrollTop;
editor.commands.selectAll();
editor.view.focus();
if (region && scrollTop !== undefined) region.scrollTop = scrollTop;
```

`view.focus()` rather than Tiptap's own `focus` command, and that is not cosmetic. The command
defers the real `view.focus()` into a `requestAnimationFrame`, so its callback can land after the
writer has already opened another menu -- and `OverflowMenu` closes when focus leaves it, so the
menu they had just opened would shut by itself a frame later. Four existing Cut/Copy tests, which
reopen the Edit menu after selecting, failed in exactly that way against the deferred version. The
synchronous call has no pending callback to misfire.

The zoom helpers (`captureCentredScroll`/`restoreCentredScroll`) were deliberately not reused: they
rescale `scrollTop` across a zoom change, and nothing about the zoom level changes here.

### The dark theme made every open menu unreadable, and it was never this slice's bug

In the dark shell an open menu was near-white text on a white panel -- measured in Chromium at
`rgb(220, 227, 230)` on `rgb(255, 255, 255)`, about 1.2:1.

The cause is a specificity leak that predates this slice entirely:

```css
.dark .menubar {
  color: var(--dark-text-03);
} /* near-white, correct for the dark bar */
.dark .menubar button {
  color: inherit;
} /* (0,2,1) */
.overflow-menu-list button {
  color: var(--text-17);
} /* (0,1,1) -- loses */
```

A dropdown list is a _descendant_ of `.menubar`, so `color: inherit` reaches inside it, while the
list itself is one of the surfaces that deliberately stays white in both themes. `.dark .menubar
button` is unchanged on `main` (line 3673 there); this slice only renamed the `.menu-file` selector
beside it to `.menubar-menu`. **The File menu has therefore been unreadable in the dark theme for as
long as it has existed** -- the slice did not cause this, it multiplied the exposure from one menu to
four.

Fixed by re-asserting the list's own colours immediately after the rule that leaks into it, where
they win the specificity tie by order. Deliberately not fixed by darkening the list: every other
floating menu in this product stays white in the dark theme, and a menubar dropdown that alone went
dark would be the inconsistent one.

### Why the gates missed both

`menubar-menus-position.spec.ts`, added by this slice, renders its markup **without the `.dark`
ancestor the editor shell actually carries**, so every colour it resolved was the light theme's. It
was written to prove geometry and it does; it could not have seen this. `menubar-menu-dark-contrast.spec.ts`
now covers the gap, and asserts the light-island property (an item inside a menu that did not go
dark reads in the colour the light theme gives it) rather than a hardcoded rgb, so a later palette
change does not make it lie.

### Mutation testing for both fixes

| Mutation                                  | Test it had to kill                                            | Result                                                            |
| ----------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Remove `.dark .overflow-menu-list button` | `menubar-menu-dark-contrast.spec.ts`                           | failed: expected `rgb(38, 48, 42)`, received `rgb(220, 227, 230)` |
| Remove `editor.view.focus()`              | `App.test.tsx` "returns focus to the canvas…"                  | failed on `toHaveFocus()`                                         |
| Remove the `region.scrollTop` restore     | `persistence.spec.ts` "Select all selects the whole document…" | failed: expected `0`, received `2238`                             |

Each mutation asserted an exact match count of 1 before applying, scoped to the Select all handler
where `App.tsx` contains seven `scrollIntoView: false` calls in total.

### One of these tests was vacuous first, and the mutation is the only reason that is known

The real-browser test originally read `document.scrollingElement.scrollTop`. It passed -- and it
**also passed with the fix mutated back out**, because the shell is a fixed-height grid and the
manuscript scrolls inside `.editor-region`, so the document element's `scrollTop` is always `0` and
could not change either way. The assertion could not fail. It now reads `.editor-region` and first
asserts that pane has somewhere to scroll to (`scrollHeight - clientHeight > 200`), so "it did not
scroll" is a claim about a scroller that genuinely could have.

This is the same failure mode as the four vacuous assertions already recorded against this project,
and the mutation step is what caught it. A test that passes is not evidence; a test that fails when
the behaviour is removed is.

## Gates after the two fixes

Re-run from the worktree root, by the lead rather than the implementing agent:

1. **`pnpm lint`** -- exit 0.
2. **`pnpm typecheck`** -- exit 0, 0 errors.
3. **`pnpm test`** -- exit 0. `apps/web` **1116 tests / 72 files** (the 72-file count matters as much
   as the test count: a file that errors at collection reports no failures and simply vanishes).
4. **`pnpm test:system`** (`PLAYWRIGHT_CHANNEL=chrome`) -- exit 0, **98 passed**, up from 97 with
   `menubar-menu-dark-contrast.spec.ts`. The `app-bar-logo.spec.ts` timeout seen on one earlier full
   run did not reproduce; measured 27/27 on an isolated `--repeat-each=3`, so it is contention under
   a full parallel run, not geometry.
5. **`pnpm format:check`** -- run bare and last. It had **never been run** by the implementing agent
   and failed on first invocation (`menubar-menus-position.spec.ts` and this document); both were
   reformatted. See the line below for the final result.
