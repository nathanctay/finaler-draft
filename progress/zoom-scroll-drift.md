# Scope: zoom-scroll-drift

Branch: `fix/zoom-scroll-drift`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/zoom-scroll-drift`
Base: `feature/zoom-modes` @ `b072ee7`
Owner: diagnosis dispatched directly (no separate lead brief); the mechanism was required to be
stated and reported before any fix was implemented -- see "Diagnosis, before any fix" below. The
fix that follows was authorized only after the coordinator independently verified the mechanism.

## The defect

`progress/zoom-modes.md`'s "A real-browser drift, found and worked around, root cause not fully
diagnosed": a `useLayoutEffect` in `App.tsx` restores centred scroll after a zoom change, writing
`.editor-region.scrollTop` synchronously and correctly -- confirmed by reading it back immediately,
in the same effect, matching the formula to the sub-pixel. Once, between that effect returning and
the browser's next animation frame, something moved it to a different, wrong value. Never recurred;
a second chained `requestAnimationFrame` always showed the same (wrong) value as the first.

The workaround in place before this branch: re-apply the identical, idempotent
`restoreCentredScroll` call a second time inside a `requestAnimationFrame` callback. Removing it
made the real-browser centred-scroll assertion fail by 61.5px against a <5px tolerance (measured
under the current CSS `zoom` mechanism; ~602.5px under the older `transform: scale()` mechanism).
Already ruled out, before this branch: CSS scroll anchoring, a path-specific race (one `<select>`
change vs. five stepper clicks converge on the same wrong value), focused-contenteditable-follows-
layout, and a plain `scrollTop =` script write (a property-descriptor override on the setter saw
nothing).

## Diagnosis, before any fix

### First experiment: instrument every scroll-moving API, not only the setter

The existing property-descriptor override only caught `el.scrollTop = x`, not
`Element.prototype.scrollTo`/`scrollBy`/`scrollIntoView`/`scrollIntoViewIfNeeded`, or
`window.scrollTo`. A real-browser probe (`page.addInitScript`, run via the repo's own
`test:system:persistence` gate against `page-rendering-persistence.spec.ts`'s "zooming keeps the
viewport centred" test) patched all of these plus a `scroll` event listener on `.editor-region`,
each logging a stack trace and `performance.now()`.

This immediately found a real, scripted write that the narrower earlier override had missed. Stack
trace, captured directly from the running app:

```
HTMLElement.set [as scrollTop]
  at Fc (App bundle)                     -- paginationExtension.ts's maybeJumpScrollCaretIntoView
  at Object.update                       -- the pagination plugin's own view().update() hook
  at updatePluginViews / updateStateInner / update / setProps   -- ProseMirror internals
  at Editor.setOptions                   -- @tiptap/core
  at [React's useEditor onRender effect] -- @tiptap/react
```

`editor.setOptions(...)` was firing on the zoom-triggered re-render, reconfiguring every
ProseMirror plugin and forcing every plugin's `update(view, previousState)` hook to run --
including `paginationExtension.ts`'s pagination plugin, whose hook unconditionally called
`maybeJumpScrollCaretIntoView(view)` (a caret-_visibility_ heuristic, "keep the caret five lines
above the bottom edge") for **any** update, not only a real edit or selection move.

### Why: `useEditor`'s own options were never reference-stable

`@tiptap/react@3.23.6/dist/index.js`'s `EditorInstanceManager.onRender` (a plain `useEffect`, not
`useLayoutEffect`, so it flushes on a macrotask after the commit -- explaining exactly the "between
this effect returning and the next animation frame" timing already pinned down) runs on every
render and calls `compareOptions(previous, current)`; if it returns `false`, it calls
`editor.setOptions(...)`. `compareOptions` checks `extensions` by per-element identity and every
other key (including `editorProps`) by `!==`. `App.tsx`'s `useEditor({...})` call built its
`extensions` array and `editorProps` object as fresh literals on every render, and
`PaginationExtension.configure({...})` in particular returns a brand-new extension instance on
every call (Tiptap's `.configure()` never memoizes) -- so `compareOptions` failed, and
`editor.setOptions(...)` fired, on **every single render of `<App>`**, not only a zoom change.

### Direct proof: fix in, mitigation out, break, fix again

Real-browser runs (repo's own `pnpm test:system:persistence -g "zooming keeps the viewport
centred"`), each a full build + Playwright run against a scratch database, changing exactly one
thing between runs:

| Extensions/`editorProps` memoized (layer 1) | `requestAnimationFrame` reapplication | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No (as found)                               | Present                               | Passes -- the mitigation wins the race, masking the bug                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Yes                                         | Removed                               | Passes, reliably across 5 consecutive runs; probe log shows the `setOptions`-triggered write is gone entirely (only the harmless one-time write at initial mount remains)                                                                                                                                                                                                                                                                                                                                     |
| No (reverted)                               | Removed                               | **Fails**: `after.scrollTop` off by exactly **61.5px** -- the same figure already recorded in `progress/zoom-modes.md`. Probe log shows two `setOptions`-triggered writes bracketing `restoreCentredScroll`'s own correct write (App re-renders twice per zoom change -- once for `zoomMode`, once for the derived `zoomPercent` -- each firing its own copy of the passive effect); the second lands _after_ the correct write and is what the test measures: `669 - 607.5 = 61.5`, matching to the decimal. |

The "from" value logged by the probe at the moment of `restoreCentredScroll`'s own write also
explained why the earlier setter override "saw nothing between the two frames" for the _symptom_
even though a scripted write is real: the spurious `maybeJumpScrollCaretIntoView` write lands
outside the range CSS `zoom` has already shrunk `.editor-region`'s `scrollHeight` to, and the
browser's own native, non-scripted scroll-position re-clamping (invisible to any property-setter
override) brings it back in range before the next read -- a second, non-scripted step layered on
top of the first, scripted one. Neither earlier investigation round was wrong about what it
checked; the setter override was checking a real thing and correctly found nothing extra on top of
what it _did_ see, it just wasn't watching the API that mattered.

### Hypotheses eliminated in this diagnosis, on top of the two rounds already recorded

- Not `scrollTo`/`scrollBy`/`scrollIntoView`/`scrollIntoViewIfNeeded` directly on `.editor-region`
  or `window` -- none fired during the zoom transition in the probe.
- Not a stale-`scrollHeight` clamp read by `restoreCentredScroll` itself -- its own write was
  always correct at the moment it ran; the corruption came from an independent write afterward.
- The magnitude difference between the two mechanisms (~602.5px under `transform`, ~61.5px under
  CSS `zoom`) is consistent with the same mechanism: `maybeJumpScrollCaretIntoView`'s own clamp
  bound tracks the _current_ `scrollHeight - clientHeight`, and CSS `zoom` (unlike `transform`)
  shrinks that bound synchronously with the zoom change, shrinking the scripted wrong write's own
  ceiling too. Not independently re-verified against the `transform` code path, which no longer
  exists on this branch; not required for this diagnosis.

## The fix

### Layer 1 (root cause): stabilize `useEditor`'s own options

`apps/web/src/App.tsx`:

- The static `editorProps` object (`aria-label`/`aria-multiline`/`role` on the canvas) hoisted to a
  module-level constant -- it has no per-render or per-screenplay data, so nothing was ever gained
  by rebuilding it every render.
- The `extensions` array wrapped in `useMemo(() => [...], [])`. Empty deps deliberately:
  `PaginationExtension.configure({ documentSettings: initial.screenplay.documentSettings })` only
  ever _seeds_ the plugin's own `init()` the one time the extension is constructed -- a runtime
  `documentSettings` change reaches the plugin entirely through
  `updatePaginationDocumentSettings`'s meta-carrying `dispatch`, never by reconfiguring this
  extension (verified against the code, not assumed: `paginationExtension.ts`'s `apply(tr,
paginationState)` reads `tr.getMeta(paginationPluginKey)`, and `documentSettings` otherwise lives
  in the plugin's own state, read fresh from `paginationPluginKey.getState(...)` on every
  repagination -- the extension's own construction-time `documentSettings` option is never
  consulted again after `init()`). Every other member of the array was already a module-level
  singleton, so nothing here loses the ability to change for a reason that matters.

### Layer 2 (defence in depth): guard the caret-visibility heuristic on an actual change

`apps/web/src/paginationExtension.ts`, the pagination plugin's `update(view, previousState)` hook:
`maybeJumpScrollCaretIntoView(view)` now only runs when `!view.state.doc.eq(previousState.doc) ||
!view.state.selection.eq(previousState.selection)` -- value equality (`Node.eq`/`Selection.eq`),
not `state !==`, since a state that is merely a _new object_ carrying the same doc and selection
(exactly what a plugin reconfigure via `editor.setOptions` produces) must still count as
unchanged. The existing behaviour the hook's own comment already described is unchanged: a plain
selection move with no document change (arrow-key navigation, a click) still triggers it, only a
view update that moved _neither_ is newly excluded. `compensateScrollForRepagination`'s own
suppression (`viewsCompensatingForRepagination`) is untouched and still takes priority.

**Layer 2 is not merely a hypothetical safeguard for some other future path -- it independently
suppresses this exact bug too**, verified directly: with layer 1 deliberately re-broken (`extensions`
memoized with `[Date.now()]` instead of `[]`, forcing a fresh identity every render) but layer 2
left in place, the real-browser "zooming keeps the viewport centred" test still passed. ProseMirror's
plugin reconfigure (`editor.setOptions`) evidently preserves `doc`/`selection` by value, so layer
2's `.eq()` check alone already blocks `maybeJumpScrollCaretIntoView` from running for it. Layer 1
is still the correct primary fix -- it stops the wasted, unnecessary plugin reconfigure itself,
which is not free and would otherwise still run on every unrelated `<App>` render -- but this
finding shaped how the regression tests below had to be designed (see "Tests").

## The workaround: removed, not kept out of caution

With both layers in place, the `requestAnimationFrame` reapplication in `App.tsx`'s centred-scroll
effect was removed entirely, and the long comment documenting the undiagnosed drift was replaced
with a short note pointing at this file. Verified before removing, not assumed: the real-browser
"zooming keeps the viewport centred" test was run **five consecutive times** with the reapplication
already removed and both layers in place -- reliably green every time (see the proof table above,
row 2). The full `test:system:persistence` (18 tests) and `page-geometry.spec.ts` (14 tests) suites
were also run clean afterward, with the reapplication gone for good.

## Tests

### Layer 1: `apps/web/src/App.test.tsx`, `describe('useEditor options stability (zoom-scroll-drift.md)')`

`editor.setOptions` (spied via `vi.spyOn(Editor.prototype, 'setOptions')`, which calls through --
the editor keeps working normally) must not be called again for an `<App>` re-render that changes
neither the document nor the selection. Deliberately exercised through a panel toggle ("Toggle
navigator"), not a zoom action -- zoom is the symptom this bug was found through, not its cause,
and the test should prove the general claim, not only the specific path that found it.

A plain "does `.editor-region.scrollTop` move" assertion, as first drafted, turned out **not** to
discriminate layer 1 in isolation once layer 2 also exists -- the "layer 2 alone already suppresses
this bug" finding above means a scrollTop-based test would still pass with layer 1 reverted, as
long as layer 2 is present, and would not actually catch a layer-1 regression. The `setOptions`
call count is what layer 1 specifically claims to prevent, so that is what this test asserts
instead. Reported here rather than silently switched, per the standing instruction to report
exactly what was measured rather than force an expected result.

Mutation-tested: `extensions`'s `useMemo` deps changed from `[]` to `[Date.now()]` (forcing a fresh
identity every render, simulating layer 1 reverted) -- killed (`setOptions` called twice: once at
construction, once for the panel-toggle re-render). Reverted; green again.

### Layer 2: `apps/web/src/paginationExtension.test.ts`, two new tests in `describe('jump scroll', ...)`

- `does not run the jump scroll for a view update that changes neither the document nor the
selection`: `editor.state.tr` (an empty transaction, no doc or selection change) dispatched with
  `coordsAtPos` stubbed past the trigger edge on every call -- `scrollTop` must stay put.
- `still runs the jump scroll for a real selection move that lands the caret at the bottom edge`:
  the same stubbed geometry, but a genuine selection move (`dispatchSelectionMove`, a new test
  helper that dispatches `tr.setSelection(TextSelection.create(doc, pos))`) -- `scrollTop` must
  still jump, by the same formula the pre-existing tests already assert.

Mutation-tested: the `docChanged || selectionChanged` guard reverted to the pre-fix unconditional
call -- killed (`does not run the jump scroll...` fails, `50` expected vs `134` received, i.e. it
jumped when it should not have). Reverted; green again.

### A pre-existing test gap this branch's own fix exposed

Seven of the pre-existing `jump scroll` tests in `paginationExtension.test.ts` dispatched a bare
`editor.state.tr` (no change at all) purely to trigger the plugin's `update()` hook at all, since it
does not run at construction -- the module's own comment already said as much ("modelling the first
keystroke or selection change"), but the dispatch itself was neither. Layer 2's new guard correctly
stopped treating that as a trigger, which broke three of those seven tests (the ones whose
assertion depended on the jump actually firing). Fixed by introducing `dispatchSelectionMove(editor,
pos)` and using it at all seven call sites, so each test now drives a real selection change --
matching what the module comment always said it was modelling, and no longer relying on the
soon-to-be-guarded no-op behaviour. All 26 pre-existing `jump scroll`/`paginationExtension.test.ts`
assertions are unchanged in what they prove; only how each test triggers the `update()` hook
changed.

## Scope note: this bug is not zoom-specific

`editor.setOptions` fired on **every** `<App>` re-render before layer 1, zoom or not -- a panel
toggle, a save-state change, an active-block update, anything that re-renders `<App>` at all. Zoom
is how this was found (its own synchronous, correct `scrollTop` write made the spurious overwrite
observable and measurable), not the only place it could bite: any of those other re-renders could
in principle have yanked `.editor-region.scrollTop` toward the caret's own position whenever the
caret happened to read as at or past the bottom edge, entirely independent of what the writer was
actually doing. Per the brief for this diagnosis, this was not chased further -- no other symptom
was gone looking for, and nothing outside this exact mechanism was touched or fixed.

**Why this matters for the next slice (pinch-to-zoom, continuous scale changes at frame rate,
per the diagnosis brief):** before this fix, every `<App>` re-render this spurious path touched
would have meant the pagination plugin's caret-visibility heuristic fighting whatever a continuous
zoom handler was doing to scroll on every frame that also re-rendered `<App>` -- the exact
"write fighting the browser every frame" risk the diagnosis brief named. Both layers remove that
interference at its source, independent of and prior to whatever pinch-zoom's own scroll-anchoring
design turns out to be.

## Gates

Run from `/Users/nathan/Documents/finaler-draft-worktrees/zoom-scroll-drift`.

```
pnpm lint
```

Clean, `--max-warnings=0`, no output.

```
pnpm format:check
```

Clean: "All matched files use Prettier code style!"

```
pnpm typecheck
```

Clean, full rebuild, no errors.

```
pnpm --filter @finaler-draft/web test
```

Clean: 37 files / 527 tests (524 + 3 new: 1 in `App.test.tsx`, 2 in `paginationExtension.test.ts`).

```
pnpm --filter @finaler-draft/web test:coverage
```

Clean, exit 0. `zoom.ts` unchanged at 100%. `App.tsx` 96.65% statements / 89.61% branches.
`paginationExtension.ts` 92.92% statements / 90.14% branches. Every file comfortably over the
repo's 80%-per-file threshold.

```
pnpm check:bundle-budget
```

Clean. Entry chunk 111.40 kB / 120.00 kB. Lazy editor chunk 114.41 kB / 200.00 kB. CSS 5.78 kB /
20.00 kB -- effectively unchanged from before this branch.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm test:system:persistence
```

All 18 tests pass, run via the official script against a fresh, randomly-named database, with the
`requestAnimationFrame` reapplication already removed for good.

```
npx playwright test apps/web/e2e/page-geometry.spec.ts
```

All 14 tests pass, unmodified.

## Files touched

- `apps/web/src/App.tsx` -- `editorProps` hoisted to a module-level constant; `extensions` wrapped
  in `useMemo(() => [...], [])`; the `requestAnimationFrame` reapplication removed from the
  centred-scroll effect, and its long undiagnosed-drift comment replaced with a short pointer to
  this file.
- `apps/web/src/paginationExtension.ts` -- the pagination plugin's `update(view, previousState)`
  hook now guards `maybeJumpScrollCaretIntoView(view)` on `docChanged || selectionChanged`
  (`Node.eq`/`Selection.eq`), not an unconditional call.
- `apps/web/src/App.test.tsx` -- new `describe('useEditor options stability (zoom-scroll-drift.md)')`
  (1 test), mutation-tested.
- `apps/web/src/paginationExtension.test.ts` -- `dispatchSelectionMove` test helper; 2 new tests in
  `describe('jump scroll', ...)`, mutation-tested; the 7 pre-existing bare-`editor.state.tr`
  dispatches in that same `describe` block switched to `dispatchSelectionMove` so they keep
  modelling a real selection change now that a no-op dispatch is correctly excluded.
- `progress/zoom-scroll-drift.md` -- this entry.

No changes to `progress/zoom-modes.md` itself -- its own "root cause not fully diagnosed" section
is superseded by this file, not edited in place, matching this repo's convention of layering a new
progress entry rather than rewriting a prior one's own record of what was known at the time.
