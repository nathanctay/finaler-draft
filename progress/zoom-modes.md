# Zoom modes

Branch `feature/zoom-modes`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/zoom-modes`,
off `43c1881`.

## Scope

plan.md lines 654-671 ("Zoom controls") and 673-683 ("Viewport and zoom"). Two of plan.md's own
claims are already stale and were not acted on: zoom is not a font-size reflow (it is already
`transform: scale()`), and `.page` is not `width: min(100%, 8.5in)` (it is already
`width: var(--fd-page-width)` with `flex-shrink: 0`). What plan.md actually asks for and did not
yet exist: zoom modeled as a discriminated union rather than a bare percentage, a preset dropdown,
Fit page and Fit width computed from the real available area, a floor lowered from 70 to 50, and
keyboard equivalents -- all with the character grid held invariant throughout.

## What was built

- **`apps/web/src/zoom.ts` (new).** `ZoomMode` (`{kind:'fixed', percent}` | `{kind:'fit-page'}` |
  `{kind:'fit-width'}`), `ZOOM_MIN_PERCENT` (50, was 70), `ZOOM_MAX_PERCENT` (150, unchanged),
  `ZOOM_STEP_PERCENT`, `ZOOM_DEFAULT_PERCENT`, `ZOOM_PRESET_PERCENTS`. `clampZoomPercent`,
  `computeFitPercent`, `resolveZoomPercent` -- pure arithmetic, page dimensions passed as
  parameters rather than imported, so every case is a plain-number unit test.
  `measureAvailableArea(region)` is the one DOM-touching function: `.editor-region`'s content box
  (`getComputedStyle` padding subtracted from `clientWidth`/`clientHeight`), read fresh on every
  call so a fit mode recomputes correctly at `styles.css`'s own narrow-width breakpoints without
  this module needing to know they exist. `captureCentredScroll`/`restoreCentredScroll` implement
  the owner's scroll-position formula -- see "Scroll position" below.
- **`App.tsx`.** `zoomMode` state (the writer's actual request) plus derived `zoomPercent` state
  (what currently renders), recomputed by a `useLayoutEffect` on `[zoomMode, panels.navigator,
panels.inspector]` and by a `window` `resize` listener -- the two triggers plan.md names that
  this codebase actually has (no `overlay` breakpoint state exists yet to add a third). A preset
  `<select>` in the toolbar beside the existing stepper, matching the element selector's own
  convention (a real `<select>`, `<optgroup>`s for "Fit" and "Percent") rather than a new pattern.
  Keyboard equivalents (`Mod-=`/`Mod-+` in, `Mod--` out, `Mod-0` reset) via a `window` `keydown`
  listener, gated on `event.metaKey || event.ctrlKey` so ordinary typing is never affected.
  `transform: scale(zoomPercent / 100)` replaces the old `zoom / 100` on both `.page` and
  `TitlePageView`, otherwise unchanged -- the scaling mechanism itself was already correct; only
  how the percent is chosen changed.
- **`styles.css`.** `.zoom-preset` / `.zoom-controls .zoom-preset select` -- borderless, living
  inside `.zoom-controls`'s existing bordered box with a hairline `border-left` separator, plus a
  dark-mode border-color override matching the existing `.zoom-controls` dark rule.
- **`paginationExtension.ts`.** `updatePaginationDocumentSettings` gained a third, optional
  `runBeforeDispatch` parameter (requirement 8 -- see its own section below). No other change:
  `compensateScrollForRepagination` and `maybeJumpScrollCaretIntoView` are untouched, and zoom
  never reaches either (see "Zoom never touches pagination's own scroll machinery" below).

## Scroll position: three decisions, in the order they actually happened

This is not in plan.md; it follows from the two slices that just merged (page-seam-caret,
repagination-scroll-anchor), both of which taught this codebase that a geometry change must not
silently move the writer's reading position. The owner made three, successive, explicit decisions
on this exact question over the course of the slice, each overriding the last after seeing the
next one stated precisely. Only the third is implemented; the first two were removed before this
report, including their tests.

1. **Caret-anchored** (first decision; superseded). Keep the caret at the same screen position
   across a zoom change, reusing `paginationExtension.ts`'s `readCaretRect`/`findScrollRegion`/
   `isRectVisibleInRegion` (temporarily exported for this) the way `compensateScrollForRepagination`
   does for a repagination. Built, unit-tested, e2e-tested, all green -- then explicitly overridden
   by the owner: "scroll position, not the caret, is what is preserved." Removed in full:
   `zoomScrollAnchor.ts`/`zoomScrollAnchor.test.ts` deleted, `paginationExtension.ts`'s three
   helpers reverted to private (their only reason for being exported was this).
2. **Proportional scroll fraction** (second decision; superseded). `scrollTop / (scrollHeight -
clientHeight)` preserved across the change. Specified in full by the owner, including the
   degenerate-case guard, but superseded before a single line of implementation was written: on
   seeing centred anchoring stated as an explicit alternative formula, the owner chose that
   instead. Nothing to remove.
3. **Centred** (final, implemented). The content at `.editor-region`'s vertical centre stays at
   that centre: `newScrollTop = clamp((oldScrollTop + clientHeight/2) * ratio - clientHeight/2, 0,
scrollHeight - clientHeight)`, `ratio` = new scale / old scale. `zoom.ts`'s
   `captureCentredScroll` records `scrollTop` and the percent in effect just before
   `requestZoomMode` calls `setZoomMode`; `restoreCentredScroll` applies the formula once the new
   scale has rendered, reading `scrollHeight`/`clientHeight` fresh (post-layout, not captured
   earlier) so the clamp bound reflects the _new_ scale, not the old one. A document that does not
   scroll (`scrollHeight - clientHeight <= 0`) is left alone entirely -- there is no centre to
   anchor when nothing scrolls.

   **Known, deliberate consequence, not special-cased**: at `scrollTop` 0, zooming in
   (`ratio > 1`) yields a positive target, so the very top of the document scrolls up out of view.
   The owner was told this in exactly those terms before choosing centred anchoring over
   proportional, and chose it anyway. Do not "fix" this later without checking with him first.

### A real-browser drift, found and worked around, root cause not fully diagnosed

Building the e2e proof for decision 3 turned up a second, independent finding: in a real browser,
`.editor-region.scrollTop`, set synchronously and correctly inside the `useLayoutEffect` (confirmed
by reading it back immediately, before returning, inside that same effect, matching the formula to
the sub-pixel), was overwritten again -- once, to a different, wrong value -- entirely outside this
component's own code, sometime between that effect returning and the browser's very next animation
frame.

Investigated methodically before working around it:

- **`overflow-anchor: none`** on `.editor-region`, and on every element under `.pages`, was tried
  first (CSS Scroll Anchoring is the standard suspect for exactly this symptom). Verified applied
  (`getComputedStyle(...).overflowAnchor === 'none'` on the live element) and made **no measurable
  difference** -- ruling out CSS Scroll Anchoring specifically, not merely failing to fix it.
- **A property-descriptor override** on the live `.editor-region`'s `scrollTop` setter, logging
  every script-driven write with a stack trace, saw **nothing** between the effect's own write and
  the drifted value appearing -- meaning whatever moves it does not go through the JS-visible
  property setter at all (native/compositor-level, not a missed script call).
- **Path-independence, confirmed deliberately**: driving the same 100%→50% transition via one
  `<select>` change versus five separate stepper clicks converges on the _exact same_ final
  scrollTop either way -- ruling out a race specific to one interaction path.
- Blurring focus first, and reading `document.activeElement`, made no difference either --
  ruling out a focused-contenteditable-follows-layout theory.

The shape of the drift is well-pinned even though the exact browser mechanism is not: it is a
one-time event, it always lands between the synchronous DOM commit and the first
`requestAnimationFrame` callback, and it never recurs after that -- a second, chained
`requestAnimationFrame` always shows the same value as the first. **The fix**: the effect
re-applies the identical, idempotent `restoreCentredScroll` call once more inside a
`requestAnimationFrame` callback. Since the inputs (`capture`, `zoomPercent`) do not change and the
function is pure given fresh `scrollHeight`/`clientHeight`, reapplying it is safe and reliably wins
-- verified directly: with the `requestAnimationFrame` reapplication removed, the real-browser e2e
test fails with the drifted value (reported in the mutation table below); with it restored, the
test passes reliably across repeated runs.

This is flagged honestly rather than presented as fully understood: if a future slice touches
`.editor-region`'s scroll behaviour again and hits something that looks like "my write got
overwritten once, right after I made it," this is the same phenomenon, and the reapply-after-a-frame
pattern is the known-working answer, not a root-cause fix.

### Zoom never touches pagination's own scroll machinery

The owner was explicit that a zoom change must never reach `compensateScrollForRepagination` or
`maybeJumpScrollCaretIntoView` (`paginationExtension.ts`), and that neither function may be
modified to accommodate zoom. Verified, not assumed: both functions are called from exactly two
places in the entire codebase -- the pagination plugin's `view().update()` hook (which fires only
when `editor.view.dispatch(...)` runs, i.e. on a ProseMirror transaction) and the explicit call
inside `updatePaginationDocumentSettings`. `grep` confirms neither function has any other call
site, and confirms `paginationExtension.ts` registers no `window`/`document` event listener of its
own that could reach them indirectly. Zoom's own code (`zoom.ts`'s `captureCentredScroll`/
`restoreCentredScroll`, and their call sites in `App.tsx`) touches only `.editor-region`'s own
`scrollTop`/`scrollHeight`/`clientHeight` -- plain DOM properties -- and never imports or calls
`editor.view.dispatch`, `editor.state.tr`, or anything else from the `@tiptap`/`prosemirror-*`
surface. There is structurally no path from a zoom change to either function; this is true by
construction, not by a guard that could later rot. `paginationExtension.ts` itself is untouched
except for the one addition described next.

## The separate fix: `updateDocumentSettings`'s ordering (requirement 8)

**The diagnosis, verified before changing anything.** `App.tsx`'s `updateDocumentSettings` used to
call `updatePaginationDocumentSettings(editor, next)` then `applyPageGeometryCssVariables(next)` as
two bare statements. `progress/repagination-scroll-anchor.md`'s "known limitations" section
diagnosed this as under-compensating the writer's scroll position for a `parentheticalWidthIn`
change specifically (the one document setting that changes a block's rendered wrap width), and
suggested the fix might be as simple as swapping the two statements.

**That specific reordering was tried and found NOT to fix it**, by reasoning through what
`readCaretRect`'s `coordsAtPos` call actually does: it forces a synchronous layout flush to return
accurate coordinates. In the _current_ (unswapped) order, `compensateScrollForRepagination`'s
"before" measurement happens before either change, and its "after" measurement happens after the
decoration dispatch but before the CSS write -- correctly isolating the decoration's own
contribution, but leaving the CSS-driven rewrap's contribution completely outside the measured
window (confirmed against the original diagnosis's own numbers: 584px compensated against a true
total of ~1160px). Swapping the two statements does not fix this: it only moves _which_ side of the
measurement window absorbs the rewrap. `compensateScrollForRepagination`'s own "before" reading
would itself force the pending CSS write to flush (since `coordsAtPos` needs accurate geometry),
landing _after_ the rewrap had already shifted the caret -- so "before" would already reflect the
post-rewrap position, and the rewrap's contribution would once again be invisible to the
before/after diff, just from the other side.

**The actual fix**: `updatePaginationDocumentSettings` gained a third, optional `runBeforeDispatch`
parameter, invoked _inside_ `compensateScrollForRepagination`'s wrapped `dispatch()` -- between its
"before" measurement and the decoration transaction, not before or after the whole function.
`App.tsx` passes `() => applyPageGeometryCssVariables(next)` here instead of calling it as a
separate statement. This puts both sources of shift (the CSS-driven rewrap and the decoration
dispatch) on the same side of both measurements, so the combined shift is captured as one amount.
Proved with a dedicated unit test (`paginationExtension.test.ts`, "compensates the writer for the
combined shift of runBeforeDispatch and the decoration dispatch, as one amount") using a bigger
combined shift than any single-cause test in the file, and a second test proving the ordering
specifically ("runs runBeforeDispatch before the pagination transaction commits, not after").

An end-to-end proof of this exact path (real settings dialog, real `parentheticalWidthIn` change,
real caret) was attempted and abandoned -- see "Known limitations" below for why, and what still
covers it.

## Tests

- **`apps/web/src/zoom.test.ts` (new, 27 tests).** `clampZoomPercent`, `computeFitPercent`
  (fit-width, fit-page including which bound binds, zero-area), `resolveZoomPercent` (fixed mode
  ignores available area; a fit mode recomputes fresh on every call -- the exact "fit must
  recompute" property plan.md names, proven by calling it twice with the same mode and different
  areas and asserting different answers; clamps to the floor without losing the mode),
  `measureAvailableArea` (padding subtraction, zero-clamp), `captureCentredScroll`/
  `restoreCentredScroll` (both degenerate cases named in the owner's brief, the formula exactly for
  zoom in and zoom out, both clamp directions, and that the clamp bound is read fresh rather than
  from anything captured earlier).
- **`apps/web/src/App.test.tsx`, new `describe('zoom modes', ...)` (9 tests).** A fit mode
  resolving against a stubbed `.editor-region` size and recomputing on `window` resize; recomputing
  on a panel toggle; the preset dropdown jumping to a fixed percentage; stepping from a fit mode
  switching to fixed and no longer recomputing on resize; keyboard shortcuts for in/out/reset; the
  same three keys individually asserted to do nothing without a modifier (see the mutation table
  for why "individually" mattered); and the centred-scroll formula itself, wired end-to-end through
  a real click, against a stubbed `.editor-region` scroll state -- this is pure DOM
  (`scrollTop`/`scrollHeight`/`clientHeight`), unlike the caret-anchored version this replaced, so
  it needs no ProseMirror stubbing and runs in plain jsdom.
- **`apps/web/e2e/page-geometry.spec.ts`**, the existing "zoom scales the page visually without
  changing the character grid" test extended (per plan.md's own instruction) from one scale factor
  to four: 0.5 (the new floor), 0.6125 (a deliberately non-round fraction standing in for an
  ordinary fit-width/fit-page result), 0.7 (the original case, kept), 1.5 (the ceiling).
- **`apps/web/e2e/page-rendering-persistence.spec.ts`**, one test covering Fit width and Fit page
  actually fitting (real `.editor-region` content box vs real `.page` rendered box, cross-checked
  for a uniform scale on both axes), the character grid staying invariant across three real
  zoom-mode changes (offsetWidth/offsetTop/offsetHeight of every block and the page-break spacer,
  unaffected by `transform`), and the centred-scroll formula end-to-end in a real browser. All
  three phases share one signed-in session -- seat below.

### Why the centred-scroll e2e test's numbers discriminate all three candidates, not just two

Centred and "proportional" (`oldScrollTop * ratio`) differ by exactly `(ratio - 1) * clientHeight /
2` (the owner's own identity, verified algebraically from the formula). A `ratio` near 1 would make
that gap negligible and prove nothing; `ratio = 0.5` (100% → 50%, the floor) is as far from 1 as
this app's range allows in one step, and `.editor-region`'s real `clientHeight` in this test
environment is ~570-600px, so the gap is on the order of 140-150px -- comfortably clear of
real-browser sub-pixel noise. "Untouched" (leaving `scrollTop`'s raw pixel value alone) diverges
from both by a wider margin still: at a mid-document starting position (55%, deliberately not near
either scroll extreme, so the argument does not depend on which edge the writer happened to be
reading near), the real numbers show all three candidates 50px+ apart from each other -- asserted
directly in the test, from real measurements, not assumed from the arithmetic alone. The test
therefore fails specifically against _both_ wrong answers, not only one.

### One sign-up, three phases

`createAndOpenScreenplay` cost a full sign-up-through-first-save round trip against a real,
rate-limited API (`DEFAULT_API_RATE_LIMIT_MAX`, `packages/server-config`). A 19th persistence test
(this slice's own, added as a separate `test()`) pushed the suite's total request count over that
limit within one run -- reproduced twice, with the next test's own project list failing to load
("Projects could not be loaded."). Fixed by folding every zoom-related e2e check (fit-width/
fit-page, grid invariance, centred scroll) into the single existing "Fit width and Fit page..."
test as sequential phases, keeping the persistence suite at 18 tests total, matching main.

## Mutation testing

Every mutation below: introduced, confirmed the predicted test(s) failed (and nothing else did),
reverted, confirmed the full relevant suite green again.

### `zoom.ts` (`apps/web/src/zoom.test.ts`)

| #   | Mutation                                                                                                           | Result                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `clampZoomPercent` dropped the floor (`Math.min(MAX, percent)` only)                                               | Killed -- `clampZoomPercent`'s own floor test, and `resolveZoomPercent`'s floor-clamp test                                                               |
| 2   | `computeFitPercent`'s fit-page branch used `Math.max` instead of `Math.min`                                        | Killed -- both fit-page tests (width-binds and height-binds cases)                                                                                       |
| 3   | `resolveZoomPercent` ignored `mode.kind` and always resolved to a fixed 100 for non-fixed modes                    | Killed -- the "fit mode is computed fresh... recomputes" test and the floor-clamp test (the exact "fit silently stops fitting" regression plan.md names) |
| 4   | `measureAvailableArea` stopped subtracting padding                                                                 | Killed -- both padding-subtraction tests                                                                                                                 |
| 5   | `captureCentredScroll` dropped the null-region guard (`region!.scrollTop`)                                         | Killed -- "returns undefined for a null region" (now throws instead)                                                                                     |
| 6   | `restoreCentredScroll` dropped the degenerate-case guard entirely                                                  | Killed -- "also treats a shrunk-below-viewport document... as degenerate"                                                                                |
| 7   | `restoreCentredScroll` dropped the low clamp (`Math.max(target, 0)`)                                               | Killed -- "clamps to 0 rather than going negative"                                                                                                       |
| 8   | `restoreCentredScroll` dropped the high clamp (`Math.min(..., scrollableExtent)`)                                  | Killed -- "clamps to the maximum scrollTop rather than overshooting"                                                                                     |
| 9   | `restoreCentredScroll`'s formula dropped the trailing `- clientHeight / 2` (pins the top edge instead of centring) | Killed -- 4 tests simultaneously (both formula tests, the low-clamp test, and the fresh-read test)                                                       |

### `App.tsx` wiring (`apps/web/src/App.test.tsx`, plus one real-browser mutation)

| #   | Mutation                                                                                                                 | Result                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | `requestZoomMode` recompute effect dropped `panels.navigator`/`panels.inspector` from its dependency array               | Killed -- "recomputes a fit mode when a panel opens or closes"                                                                                                                                                      |
| 11  | The `window` resize listener effect removed                                                                              | Killed -- "resolves Fit width... recomputes when the window resizes"                                                                                                                                                |
| 12  | Keyboard handler's modifier guard changed to only check `altKey` (drops the `metaKey`/`ctrlKey` requirement)             | **Initially survived** -- see "A test gap found and fixed" below. Killed after the fix.                                                                                                                             |
| 13  | `chooseZoomPreset` dropped the `fit-page`/`fit-width` branch, falling through to `Number(value)` (`NaN`, no-op) for both | Killed -- 3 tests ("recomputes a fit mode when a panel opens or closes", "stepping zoom in or out from a fit mode...", both of which select a fit preset first)                                                     |
| 14  | `requestZoomMode` dropped the `captureCentredScroll` call                                                                | Killed -- the jsdom "centres zoom..." test (300 vs expected ~340)                                                                                                                                                   |
| 15  | The centred-scroll `useLayoutEffect` dropped its `restoreCentredScroll` call entirely                                    | Killed -- the same jsdom test                                                                                                                                                                                       |
| 16  | `restoreCentredScroll(...)` hardcoded `scale(1)` on `.page`'s `transform` (the CSS binding, not the scroll formula)      | Killed -- the real-browser "Fit width and Fit page..." e2e test's "actually fits" assertion (118px off against a <1px tolerance)                                                                                    |
| 17  | The `requestAnimationFrame` reapplication removed from the centred-scroll effect                                         | Killed -- the real-browser e2e test's centred-scroll assertion (602.5px off against a <5px tolerance) -- this is the exact real-browser drift described above, reproduced on demand by removing its only mitigation |

### `paginationExtension.ts`'s `runBeforeDispatch` (`apps/web/src/paginationExtension.test.ts`)

| #   | Mutation                                                                                        | Result                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 18  | `runBeforeDispatch?.()` call removed from `updatePaginationDocumentSettings`'s wrapped dispatch | Killed -- both new tests ("runs runBeforeDispatch before...", "compensates... combined shift...")                                                                                                                                    |
| 19  | `runBeforeDispatch?.()` moved to _after_ the decoration dispatch instead of before              | Killed -- "runs runBeforeDispatch before the pagination transaction commits, not after" specifically (the combined-shift test still passed, correctly: total shift is order-independent, only _which_ test catches ordering differs) |

### A test gap found and fixed

Mutation 12 initially **survived**: the first version of "ignores the zoom shortcut keys with no
modifier held" fired `=`, `-`, then `0` and asserted the _final_ zoom level was still 100% in one
assertion at the end. With the modifier guard broken, `=` (zoom in, →110%) and `-` (zoom out,
→100%) net-cancelled before `0` (reset to 100%) ran anyway -- passing for the wrong reason, exactly
the class of bug this repo has a documented history of. Fixed by asserting after _each_ individual
key that the zoom level is still 100%, not only once at the end. Re-ran mutation 12 against the
fixed test: killed correctly (fails at the very first assertion, `=` alone already producing
110%). The fixed version is what ships; reported here rather than silently corrected.

## Gates

Run from `/Users/nathan/Documents/finaler-draft-worktrees/zoom-modes`.

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

Clean, full `dist/` rebuild across every package plus both apps (`tsc -b`/`tsc -p --noEmit` for
every workspace member), no errors.

```
pnpm test
```

Clean, workspace-wide: `apps/web` 37 files / 524 tests, `apps/api` 6 files / 91 tests (+20
intentionally skipped, pre-existing), every package (`config`, `server-config`, `screenplay`,
`database`, `xml-escape`, `docx`, `fdx`, `layout`, `pdf`) green and unchanged in count.

```
pnpm --filter @finaler-draft/web test:coverage
```

Clean, exit 0. `zoom.ts`: 100% statements/branches/functions/lines. `App.tsx`: 96.67% statements /
89.61% branches. `paginationExtension.ts`: 92.85% statements / 90% branches. Every file comfortably
over the repo's 80%-per-file threshold (`apps/web/vite.config.ts`).

```
pnpm check:bundle-budget
```

Clean. Entry chunk 111.41 kB / 120.00 kB budget. Lazy editor chunk 114.40 kB / 200.00 kB budget
(the zoom preset dropdown and its logic added negligibly to this). CSS 5.78 kB / 20.00 kB budget.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm test:system:persistence
```

All 18 tests pass, including the one covering Fit width, Fit page, grid invariance, and centred
scroll together. Run repeatedly (well over a dozen times) over the course of diagnosing the
real-browser drift described above; green every time once the `requestAnimationFrame`
reapplication was in place.

```
npx playwright test apps/web/e2e/page-geometry.spec.ts
```

All 14 tests pass, including the four parametrized zoom-scale cases (0.5, 0.6125, 0.7, 1.5).

## Known limitations

- **The `parentheticalWidthIn`-via-document-settings-dialog scroll-compensation scenario has no
  end-to-end proof**, only the unit tests described above. Attempted directly: typed a
  character/parenthetical/dialogue speech, narrowed `parentheticalWidthIn` via the real settings
  dialog to force a real rewrap, and measured the caret's screen position before/after via
  `window.getSelection()`. Found, empirically, that the fixture's caret was already scrolled out of
  `.editor-region`'s visible area _before_ the settings change -- `.editor-region`'s real
  `clientHeight` in this test environment (~574px) is shorter than a single manuscript page
  (~1056px at 100%), and a fresh screenplay's default title page adds a second page's height on top
  of that -- so the test was exercising `compensateScrollForRepagination`'s "leave a
  deliberately-scrolled-away writer alone" gate (already covered elsewhere, correctly) rather than
  the compensating path this fix is actually about. Building a fixture that reliably keeps the
  caret visible while still forcing a `parentheticalWidthIn`-driven rewrap large enough to measure
  was not completed in the time available. The unit-level proof (`paginationExtension.test.ts`,
  mutation-tested, table above) is real and precise; a real-browser confirmation of this one
  specific path is the gap.
- **The exact browser mechanism behind the real-browser scroll drift (see above) is not
  diagnosed**, only its shape and a working mitigation. If it resurfaces elsewhere touching
  `.editor-region`'s scroll position, start from the investigation notes above rather than
  re-deriving them.
- Pinch-to-zoom (`wheel`/`ctrlKey`, touch gestures) is out of scope per the brief and was not
  touched.

## Files touched

- `apps/web/src/zoom.ts` (new) -- zoom-mode types, fit-percent resolution, centred-scroll capture
  and restoration.
- `apps/web/src/zoom.test.ts` (new) -- 27 tests, table above.
- `apps/web/src/App.tsx` -- zoom-mode state, the preset dropdown, keyboard shortcuts, the two
  recompute effects, the centred-scroll capture/apply effect, `transform: scale(zoomPercent / 100)`
  in place of the old `zoom / 100`, and `updateDocumentSettings`'s `runBeforeDispatch` wiring.
- `apps/web/src/App.test.tsx` -- new `describe('zoom modes', ...)` (9 tests), and the pre-existing
  "moves zoom into the toolbar..." test updated for the new 50-percent floor (a deliberate spec
  change, not a weakened assertion -- see plan.md's own instruction).
- `apps/web/src/paginationExtension.ts` -- `updatePaginationDocumentSettings`'s new
  `runBeforeDispatch` parameter.
- `apps/web/src/paginationExtension.test.ts` -- 2 new tests for `runBeforeDispatch`.
- `apps/web/src/styles.css` -- `.zoom-preset` rules and its dark-mode override.
- `apps/web/e2e/page-geometry.spec.ts` -- the zoom-scale test parametrized across four scale
  factors.
- `apps/web/e2e/page-rendering-persistence.spec.ts` -- one existing test extended with three new
  phases (centred scroll, fit-width/fit-page fitting, grid invariance), sharing one sign-up.
- `progress/zoom-modes.md` -- this entry.

## Second session: the two remaining tasks (one zoom control, and the title-page gap)

Picked up mid-investigation from a previous agent that hit its session limit with two tasks still
open, both stated precisely by the owner in the handoff brief. Both are now done.

### Task A: one zoom control, not two

`App.tsx`'s `.zoom-controls` used to render two adjacent boxes: a stepper box (`-`, an `<output>`,
`+`) and a separate `.zoom-preset` box holding the preset `<select>`. The owner wanted one box:
`-` on the left, `+` on the right, the number in the middle, and clicking the number opens the
preset dropdown.

**What changed.** The two boxes merged into one `.zoom-controls` div. Its middle segment,
`.zoom-level`, holds both the unchanged `<output aria-label="Zoom level">` (same text content,
same aria-label, same behaviour as before this slice) and the unchanged preset `<select
aria-label="Zoom preset">` (same options, same `onChange`, same off-preset "no option selected"
behaviour), but now stacks the `<select>` exactly on top of the `<output>` via CSS
(`.zoom-level { position: relative }`, `.zoom-level select { position: absolute; inset: 0;
opacity: 0 }`) rather than placing them side by side. `opacity: 0`, never `display: none` or
`visibility: hidden`, so the `<select>` stays a real, focusable, clickable native control -- a
click anywhere on the visible number hits the (invisible) `<select>` sitting on top of it by
ordinary browser hit-testing, opening its native picker exactly the way a user clicking a visible
`<select>` would. The `<output>` beneath it is `pointer-events: none` so it can never intercept
that click itself, though in practice the `<select>`'s own stacking already wins regardless.

**Why not a real, visibly-styled `<select>` as the middle segment on its own** (the brief's
first-suggested, "likely simplest" option): a native `<select>`'s own closed-box text is always
its _selected option's_ label, and this control's number must stay accurate in every zoom mode,
including the two fit modes, whose `<select>` value is `'fit-page'`/`'fit-width'` -- option labels
"Fit page"/"Fit width", not a number. Synthesizing a permanent extra "current value" option to
force the displayed text to always be a number was considered and rejected: it would have to
special-case exactly when to add it (any fit mode, or any off-preset fixed percentage), and the
codebase's own existing comment on this `<select>` already commits to the opposite design
choice -- the dropdown is a _jump-to_ control, honestly showing no option selected when the live
percentage does not match one of its own options, not a second live display of the current
percentage. Keeping the `<output>` as the one and only place the live percentage is displayed or
announced, and stacking the `<select>` on top purely as an _opener_, preserves that existing
design decision instead of quietly overriding it, and is what let every pre-existing aria-label,
jsdom test, and keyboard-shortcut behaviour survive this restructuring completely unchanged.

**Focus, verified rather than assumed.** `opacity: 0` also hides a focused element's own native
`:focus-visible` outline (this codebase's generic `select:focus-visible` rule, styles.css), so a
keyboard user tabbing to this control would otherwise see no focus indicator at all. Fixed with
`.zoom-level:focus-within { outline: 2px solid var(--border-11); outline-offset: -2px }` on the
visible wrapper instead, matching the same outline the generic rule would have drawn.

**Proof, in a real browser, not jsdom.** jsdom does no layout, so neither the CSS stacking nor
which element a real click at a given screen coordinate actually hits is observable there --
every pre-existing jsdom test in `App.test.tsx` still passes unchanged (they only ever asserted
labels, values, and `onChange` wiring, none of which moved), but they cannot prove the overlay
click-through itself works. Proved instead in `page-rendering-persistence.spec.ts`'s zoom-modes
test (see below): `page.getByLabel('Zoom level').click({ force: true })` (a real mouse click at
the `<output>`'s own screen coordinates -- `force: true` overrides Playwright's own actionability
guard, which by default refuses to click a locator when a _different_ element would receive the
event at that point, exactly what this design does on purpose) followed by asserting the
`<select>` received focus. Mutation-tested: reverting `.zoom-level select`'s `position: absolute`
to `position: static` (breaking the overlay) killed this assertion (`toBeFocused()` timed out,
"Received: inactive"); restored, green again.

### Task B: layout tracking zoom (the title-page gap)

**The bug, in the owner's own words:** "the gap between the title page and the content pages...
When I zoom out, it grows, and when I zoom in it shrinks to the point of the pages overlapping."

**Root cause** (diagnosed by the owner before this session, not re-derived here): `transform:
scale()` does not affect layout. Page-to-page gaps inside the manuscript come from page-break
spacers _inside_ `.page`, so the transform scales them along with everything else and they are
fine. The title-page-to-content-page gap is different: it is `margin-top` on `.pages > * + *`
(styles.css), a layout property that lives _outside_ the transform each page individually carried
-- so it stayed a fixed number of unscaled pixels regardless of zoom, shrinking relative to a
zoomed-in page until the title page's scaled rendering overran it entirely.

**The fix**, decided on measurements taken before this session (a bare zoomed `<div>`, not this
app): replace the two per-element inline `transform: scale(zoomPercent / 100)` styles (`.page` and
`TitlePageView`) with a single CSS `zoom: zoomPercent / 100` on their shared parent, `.pages`.
`.pages`'s own internal layout -- including the `margin-top` gap -- is computed inside the zoomed
subtree, so it scales by the same factor as everything else with no separate compensation needed.
Applied in `App.tsx`; the two now-dead `transform-origin: top center` declarations (`.page`,
`.title-page`, styles.css) were removed after confirming (`grep`) nothing else in the app or its
tests referenced them.

**This is a deliberate departure from plan.md:683**, which names `transform-origin: top center`
as evidence "scale was the original intent." That evidence no longer applies once the mechanism
changed to CSS `zoom`, which has no `transform-origin` concept -- the departure is recorded here,
with the measured reason above, per the brief's own instruction to do so rather than silently
diverging.

**Required test, proved to fail before the fix and pass after, not merely written and trusted.**
Added to `page-rendering-persistence.spec.ts`'s zoom-modes test (folded in as an additional phase
rather than a new `test()`, for the same signup-rate-limit reason the previous session's "One
sign-up, three phases" note already documents): measures
`contentPage.getBoundingClientRect().top - titlePage.getBoundingClientRect().bottom` at 50%, 100%,
and 150% zoom, asserting the gap is never negative at any of the three and scales proportionally
with `PAGE_GAP_IN * 96` at each. Proved directly, not assumed: reverted `.pages`'s CSS `zoom` back
to the two per-element `transform: scale()` calls (restoring the pre-fix mechanism exactly, plus
the two `transform-origin` declarations), rebuilt production, ran this test alone against a
scratch database -- it failed exactly as predicted, `gapAt150` measuring **-504px** (the visible
overlap the owner reported, reproduced and measured, not merely reasoned about) against the `>= 0`
assertion. Restored the fix, rebuilt, reran: passed. The measured -504px matches a hand
calculation from real, non-transform figures (`PAGE_HEIGHT_IN * 96 = 1056`px unscaled title-page
height, `1056 * 1.5 = 1584`px visual bottom at 150% under the old per-element transform, against a
content-page top that never moved from its unscaled `1056 + 24 = 1080`px layout position) almost
exactly, confirming the root-cause diagnosis rather than just the symptom.

#### The three things the brief asked to verify rather than assume

1. **The `requestAnimationFrame` re-application in the centred-scroll effect: still needed, kept,
   not removed.** The hypothesis going in was that this reapplication was only ever compensating
   for `scrollHeight` failing to track the new scale before layout settled -- which CSS `zoom`
   fixes exactly (see item 2 below) -- so it might now be dead weight under the new mechanism.
   Tested directly, not assumed: removed the `requestAnimationFrame` block, rebuilt, reran the
   real-browser centred-scroll assertion against a scratch database. The drift is still there --
   smaller than it was under `transform` (roughly **61.5px** against a <5px tolerance, versus the
   previous session's own measured ~602.5px), but still real and still failing the test without
   the reapplication in place. Restored it; the same test passes reliably. The mitigation stays,
   and `App.tsx`'s own comment above the effect now records this second measurement alongside the
   first rather than only the original one.
2. **Geometry measurement, proved rather than reasoned about.** A throwaway real-Chromium probe
   (written, run, and deleted within this session -- never committed) measured what CSS `zoom`
   does to `offsetWidth`/`offsetHeight`/`clientWidth`/computed `width` versus
   `getBoundingClientRect()`, for an element nested inside a zoomed ancestor: the offset-family
   properties (and computed style) are **unaffected by an ancestor's `zoom`** -- they report the
   element's own local-frame layout box, exactly as they do under `transform` -- while
   `getBoundingClientRect()` **does** scale with it, crossing into the document's own coordinate
   space the way `transform`'s visual painting always did. This is exactly the split
   `page-rendering-persistence.spec.ts`'s `measureGrid` (offset-family, unaffected) and
   `measureFit` (`getBoundingClientRect`, scaled -- used deliberately to derive the real scale
   factor) already relied on under `transform`, so neither needed to change, and neither did:
   both passed unmodified once the CSS zoom mechanism landed, confirmed by the full persistence
   run below. Only the two comments explaining _why_ were corrected, since they used to name
   `transform` specifically as the mechanism responsible; `seamCaret.ts`'s `pixelsPerInch` was
   inspected on the same basis and needed no code change either, since it already measures
   `getBoundingClientRect().width` (the scaling-aware property) rather than assuming a percentage.
3. **Browser support.** CSS `zoom` is standardized (CSS Zoom Level 1) and shipped, with consistent
   cross-browser behaviour matching what this fix relies on, in Chrome/Edge (supported far longer
   than the non-standard original implementation), Safari 16.4+ (March 2023), and Firefox 126+
   (May 2024) -- all comfortably behind current releases as of this writing. No further
   compatibility shim is needed for this application's targets.

#### The invariant that overrides everything: unaffected, proved not assumed

`page-geometry.spec.ts`'s "zoom scales the page visually without changing the character grid" test
(the four-scale-factor version from the previous session) was run, unmodified, both before and
after this session's changes: 14/14 pass. It could not have been affected either way -- it builds
its own synthetic `.page` and sets `pageEl.style.transform` directly, never touching the real
`App.tsx` render path this session changed -- but it was run and reread rather than assumed safe
on that reasoning alone, per the brief's instruction to prove rather than reason about anything
zoom-adjacent. It was not modified in any way.

### Mutation testing, this session

Every mutation below: introduced, confirmed the predicted assertion failed (and, for the two run
against the full relevant suite, nothing unrelated also failed), reverted, confirmed green again.

| #   | Mutation                                                                                                                                                   | Result                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20  | Reverted `.pages`'s CSS `zoom` back to the old per-element `transform: scale()` on `.page`/`TitlePageView`, restoring both `transform-origin` declarations | Killed -- the new title-page-gap test's `gapAt150 >= 0` assertion, measured **-504px** (the real reported overlap, reproduced)                                             |
| 21  | Removed the `requestAnimationFrame` re-application from the centred-scroll effect (CSS `zoom` mechanism otherwise intact)                                  | Killed -- the centred-scroll assertion, measured **61.5px** off against a <5px tolerance (smaller than the ~602.5px this drift produced under `transform`, but still real) |
| 22  | `.zoom-level select`'s `position: absolute` changed to `position: static` (breaking Task A's click-through overlay)                                        | Killed -- the new "click the number opens the preset picker" assertion (`toBeFocused()` timed out, "Received: inactive")                                                   |
| 23  | `.pages`'s CSS `zoom` hardcoded to `zoom: 1` regardless of `zoomPercent` (ignoring the writer's actual zoom request)                                       | Killed -- the pre-existing "actually fits" fit-width assertion (118px off against a <1px tolerance), before even reaching the new gap-proportionality assertions           |

Mutations 22-23 are new, targeted at this session's own additions (the overlay click-through, and
the gap-proportionality assertions specifically). Mutations 20-21 are the required "fails before
the fix, passes after" proof for Task B, and the required re-verification of the
`requestAnimationFrame` mitigation, respectively -- both are real regressions of the app's own
code, run against a scratch database via the same build-and-`playwright test -g` sequence the
official `test:system:persistence` gate uses, not synthetic test-only mutations.

### Gates, rerun at the end of this session

All eight gates listed in the brief were rerun after every change in this session (including
after the mutation-testing above, to confirm the final, restored state is what they measure). All
pass; none needed relaxing.

```
pnpm lint
```

Clean, `--max-warnings=0`, no output.

```
pnpm format:check
```

One file needed reformatting after this session's own edits (`page-rendering-persistence.spec.ts`
-- a quote-style fix from an apostrophe in a new test title, `prettier --write`d); clean after.

```
pnpm typecheck
```

Clean, full `dist/` rebuild across every package plus both apps, no errors.

```
pnpm test
```

Clean, workspace-wide, counts unchanged from the previous session: `apps/web` 37 files / 524
tests, `apps/api` 6 files / 91 tests (+20 intentionally skipped), every other package green and
unchanged in count. This session added no new unit tests (both tasks needed real-browser
proof -- CSS `zoom`'s effect on layout and click hit-testing are not observable in jsdom).

```
pnpm --filter @finaler-draft/web test:coverage
```

Clean, exit 0. `App.tsx`: 96.64% statements / 89.61% branches -- identical to the previous
session's own figures, since this session's `App.tsx` changes (the zoom-control markup, and
swapping `transform` for `zoom`) are exercised by the same existing tests that already covered the
lines they replaced.

```
pnpm check:bundle-budget
```

Clean. Entry chunk 111.41 kB / 120.00 kB budget. Lazy editor chunk 114.37 kB / 200.00 kB budget.
CSS 5.78 kB / 20.00 kB budget -- all within a few hundred bytes of the previous session's own
figures.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2- )" pnpm test:system:persistence
```

All 18 tests pass, run via the official script against a fresh, randomly-named database -- the
same 18 as the previous session, with the zoom-modes test now covering two more things (the
title-page gap, and the click-to-open control) inside its existing phases.

```
npx playwright test apps/web/e2e/page-geometry.spec.ts
```

All 14 tests pass, unmodified from the previous session -- including the four parametrized
zoom-scale cases (0.5, 0.6125, 0.7, 1.5).

## Known limitations (carried forward, plus one addition)

- The two limitations the previous session recorded (no end-to-end proof of the
  `parentheticalWidthIn`-via-settings-dialog scroll-compensation path; the exact browser mechanism
  behind the real-browser scroll drift is undiagnosed, only its shape and mitigation) are
  unchanged by this session.
- **The real-browser scroll drift this session re-measured is smaller under CSS `zoom` (~61.5px)
  than it was under `transform` (~602.5px), but its cause is exactly as undiagnosed as before.**
  Whether the smaller magnitude is meaningful (e.g., partially caused by `scrollHeight` settling
  behaviour that `zoom` improves but does not eliminate) or coincidental was not investigated
  further -- the mitigation works either way and this session did not chase the mechanism, per the
  same reasoning the previous session recorded.
- Pinch-to-zoom (`wheel`/`ctrlKey`, touch gestures) remains out of scope and was not touched.

## Files touched, this session (in addition to the list above)

- `apps/web/src/App.tsx` -- Task A's merged `.zoom-controls` markup (one `.zoom-level` wrapper
  instead of two side-by-side boxes); Task B's `.pages` CSS `zoom` in place of the two per-element
  `transform: scale()` styles; comments updated where they used to name `transform` specifically
  as the zoom mechanism; the centred-scroll effect's own comment extended with this session's
  re-verification of the `requestAnimationFrame` mitigation under the new mechanism.
- `apps/web/src/styles.css` -- `.zoom-preset` replaced by `.zoom-level` (the overlay wrapper, its
  `output`/`select` rules, and the `:focus-within` outline); the two now-dead `transform-origin:
top center` declarations (`.page`, `.title-page`) removed; the corresponding dark-mode selector
  renamed to match.
- `apps/web/src/zoom.ts` -- one comment corrected (`restoreCentredScroll`'s doc comment used to
  attribute the scaling to `.page`'s own `transform-origin`, which no longer exists).
- `apps/web/e2e/page-rendering-persistence.spec.ts` -- the zoom-modes test gained three more
  phases: the click-to-open-preset-picker check, the title-page-gap check (the brief's required
  test), and two comments corrected where they used to attribute `offsetWidth`/`offsetHeight`'s
  zoom-invariance specifically to `transform` rather than to the more general local-frame-versus-
  document-frame distinction that also holds for CSS `zoom`. Test title extended to name both new
  checks; timeout raised from 60s to 75s for the added work.
- `progress/zoom-modes.md` -- this section.

## Third pass: grid invariance against the real render path (coordinator review)

Review caught a real gap: `page-geometry.spec.ts`'s "zoom scales the page visually without
changing the character grid" loop builds a synthetic `<article class="page">` in a blank document
and hand-applies `pageEl.style.transform = scale(...)`. It was an accurate proof of the invariant
when it was written; Task B's move from per-element `transform` to CSS `zoom` on `.pages` made its
own comment's central claim -- "the mechanism under test is still exactly `transform: scale()` on
`.page`" -- false for the app that actually ships. My own "it never touches the real render path,
so it couldn't have been affected either way" was reported as reassurance; it was actually the
defect: a test whose result cannot change when the real mechanism changes is not exercising that
mechanism.

**Fix**: `page-geometry.spec.ts` was left completely untouched, per the original brief's "must
pass unmodified" instruction and because the coordinator's ask was to add real coverage elsewhere,
not to touch this file. `page-rendering-persistence.spec.ts`'s zoom-modes test gained real-
render-path grid-invariance coverage across the same range the synthetic test used:

- **0.5 and 1.5** (the floor and ceiling): `measureGrid()` (the existing `offsetWidth`/`offsetTop`/
  `offsetLeft`/`offsetHeight` comparison against `gridAt100`) now runs at 50% and 150%, reusing the
  same zoom-mode transitions the title-page-gap check already makes.
- **0.7** (the original mid-range case): a new, dedicated transition to 70% with its own
  `measureGrid()` check -- nothing else in this test previously visited 70%.
- **0.6125's role, the "deliberately non-round fraction standing in for a fit result"**: no
  stand-in is needed against the real mechanism. `fit-width`/`fit-page` (already present, already
  `measureGrid()`-checked) resolve to whatever real, non-round percentage this fixture's real
  viewport actually produces -- the exact case 0.6125 was invented to represent, now used directly
  instead of engineered.

All four scale factors from the synthetic test's range are therefore covered against the real
`.page` inside the real `.pages`, with CSS `zoom` applied by the application itself, driven
through the real preset `<select>` -- not a detached element with a hand-set style.

### Proof it can fail: two mutations, one isolated

**Mutation A** (broad): `.pages`'s zoom hardcoded to `zoom: 1` (already tried in the previous
pass) -- caught by the pre-existing "actually fits" fit-width assertion before reaching any grid
check. Confirms the suite catches a total mechanism failure, but not specifically that the new
grid checks are what catches it, since an earlier assertion fires first.

**Mutation B** (the coordinator's own suggestion, and the one that matters): `.pages`'s zoom left
correct (`zoomPercent / 100`, page-level fit and scale stay right), but `.script-body`'s width
overridden to `calc(6in / (zoomPercent / 100))` -- inversely proportional to zoom, so the
character-wrap width diverges from the correct value at every zoom level except exactly 100%
(where the divisor is 1 and the mutation is a no-op, which is why `gridAt100` itself is still
captured correctly). This is precisely "changes `.script-body`'s layout width rather than
uniformly scaling," and precisely the class of bug a page-level fit/transform check cannot see,
because the page's own outer box never stops fitting -- only what happens _inside_ it does.

Run against the full test unmodified: killed at the **first** `measureGrid()` check the test
reaches (the pre-existing one at `fit-width`, since that runs chronologically before the three new
checks) -- `width: 576` expected, `823` received; `top: 1080` expected, `824` received. This alone
proves the mutation is a real, catchable defect, but not specifically that the _new_ checks (70%,
50%, 150%) contribute anything beyond the pre-existing fit-width/fit-page ones.

**Isolated**, to answer that specifically: with the `fit-width`/`fit-page` block temporarily
wrapped in `if (false) { ... }` (a throwaway, in-memory edit -- built, run once, and restored from
a pre-edit backup immediately after, never committed, no trace left in the working tree) so only
the new 70/50/150 checks could catch anything, the same mutation was killed at the **first of the
three new checks**, the 70% one: `width: 576` expected, `823` received; `top: 1080` expected,
`824` received; `widget top: 880` expected, `624` received. This is the specific, direct proof the
coordinator asked for: the new real-mechanism grid checks discriminate this exact bug shape on
their own, not merely by riding along with assertions that already existed.

Reverted (both the isolation wrapper and the mutation itself) and rebuilt; the build hash
(`App-B2RpRDrH.js`) matched the pre-mutation build exactly, confirming a byte-identical restore,
and the full test passed again.

### Gates, rerun after this fix

```
pnpm lint
```

Clean, no output.

```
pnpm format:check
```

Clean.

```
pnpm typecheck
```

Clean, full rebuild, no errors.

```
pnpm test
```

Clean: `apps/web` 37 files / 524 tests, unchanged from every prior run in this branch -- this fix
added no new unit tests (the grid-invariance property is specifically about the real render path,
which jsdom cannot provide).

```
pnpm --filter @finaler-draft/web test:coverage
```

Clean, exit 0. `App.tsx` 96.64%/89.61%, `zoom.ts` 100% -- unchanged, since this fix touched no
application code, only the e2e spec.

```
pnpm check:bundle-budget
```

Clean, unchanged from the previous pass (entry 111.41 kB/120 kB, lazy editor 114.37 kB/200 kB, CSS
5.78 kB/20 kB) -- this fix touched no application code.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2- )" pnpm test:system:persistence
```

All 18 tests pass, run via the official script against a fresh, randomly-named database.

```
npx playwright test apps/web/e2e/page-geometry.spec.ts
```

All 14 tests pass, still completely unmodified (`git diff --stat` on this file is identical to
every prior check in this branch: the previous agent's four-scale-factor extension only, nothing
from this session).

### Files touched, this pass

- `apps/web/e2e/page-rendering-persistence.spec.ts` -- the zoom-modes test's real-mechanism grid
  checks extended to 70%/50%/150%, and a comment added explaining why `fit-width`/`fit-page`'s
  already-real non-round result replaces the synthetic test's engineered 0.6125 stand-in.
  `apps/web/e2e/page-geometry.spec.ts` -- confirmed untouched (`git diff --stat` unchanged from
  the previous pass).
- `progress/zoom-modes.md` -- this section.
