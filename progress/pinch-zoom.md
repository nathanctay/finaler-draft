# Pinch-to-zoom

Branch `feature/pinch-zoom`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/pinch-zoom`,
off `32152b8`.

## Scope

plan.md:662's remaining zoom-controls item: a trackpad pinch and a touch two-finger pinch both
change zoom continuously, anchored on the point under the gesture rather than the viewport centre.
A previous agent built and unit-tested the implementation (560 unit tests passing, `pnpm lint`/
`pnpm typecheck` clean) and then stopped mid-way through mutation testing, with no real-browser
test at all. This entry covers finishing that: a Prettier fix, the real-browser proof, a completed
mutation pass (redone from scratch, not resumed), and this file.

The real-browser proof found two genuine defects in the pointer-anchor formula -- one small and
bounded (vertical), one large and unbounded (horizontal) -- which were reported rather than fixed on
the first pass, per that pass's own scope. The owner reviewed both, confirmed the diagnosis
independently, and approved fixing them; both are fixed in a follow-up pass recorded in this same
entry (see "The vertical anchor: found, then fixed" and "The horizontal anchor: found, then fixed"
below), each with its own before/after measurements and a mutation that reverts the fix and confirms
the specific assertion that catches it.

## What was already built (read from the diff, not re-derived)

- **`apps/web/src/zoom.ts`**: `zoomRatioFromWheelDelta` (a wheel `deltaY` to a multiplicative zoom
  ratio, `Math.exp(-deltaY * PINCH_WHEEL_SENSITIVITY)`), `applyPinchWheelDelta` (applies that ratio
  and clamps to 50-150), `PointerZoomCapture`/`capturePointerAnchoredScroll`/
  `restorePointerAnchoredScroll` (the pointer-anchored scroll-restoration formula, both axes), and
  `PINCH_WHEEL_SENSITIVITY = 0.01`. As originally built, `capturePointerAnchoredScroll` measured the
  pointer's anchor offset against `.editor-region`'s own box; this entry's follow-up fix changed it
  to measure against `.pages` instead (see "The vertical anchor"/"The horizontal anchor" below) --
  described here in its current, fixed shape, not its original one.
- **`apps/web/src/App.tsx`**: two gesture paths, both wired to `.editor-region`. Trackpad pinch is a
  manually-registered `addEventListener('wheel', ..., { passive: false })` -- deliberately not
  React's `onWheel`, which Chrome always treats as passive, so `preventDefault()` inside it is
  silently ignored and the browser's own page zoom (or a plain scroll) would win underneath any
  handler logic. Touch pinch is Pointer Events (`pointerdown`/`pointermove`/`pointerup`/
  `pointercancel`/`pointerleave`), tracking every active touch pointer in a plain `Map` and computing
  the distance between exactly two of them. Both paths coalesce to at most one zoom update per
  animation frame (a `wheel` event, and a real two-finger drag, both fire far faster than the
  browser paints) and both call one shared `commitPinchZoom`, which captures the pointer-anchored
  scroll state and sets a **fixed** zoom mode -- "pinch sets a fixed percentage, leaving any fit
  mode" (plan.md:662) -- never `requestZoomMode`, since that populates the _centred_-scroll capture
  instead.
- **`apps/web/src/styles.css`**: `.editor-region { touch-action: pan-x pan-y; }` (omitting
  `pinch-zoom` from the allowed value list is what disables the browser's own native pinch-to-zoom
  on this element, while still leaving one-finger panning natively handled).
- **`apps/web/src/zoom.test.ts`** / **`apps/web/src/App.test.tsx`**: extensive jsdom unit coverage
  for both paths (50 and 80 tests respectively, after this entry's two additions across both passes
  -- see "Mutation testing" and "Mutation testing the two follow-up fixes" below), including the
  wheel/touch event wiring, clamping, coalescing, and an exact-formula proof of the pointer anchor,
  now against a stubbed `.pages` rather than `.editor-region` (see "The vertical anchor" below).

## Why the pointer anchor differs from the toolbar's centred zoom -- the owner's decision, not an inconsistency to fix

`restorePointerAnchoredScroll`'s own comment in `zoom.ts` states this plainly, and it is repeated
here because a future reader who only skims the diff should not "fix" it into one shared formula:
pinch anchors on **the point under the pointer**; the toolbar's stepper, its preset `<select>`, and
keyboard equivalents all keep the pre-existing **centred** anchor (`restoreCentredScroll`, unchanged
by this slice). This is deliberate, not an oversight: a control the writer _clicks_ has their hands
nowhere near the manuscript, so there is no point under a pointer worth preserving, whereas a pinch
gesture's whole point is that the content under the fingers stays there. Every other pinch-to-zoom
surface a writer has used (a map, a PDF viewer, the OS itself) already works this way. Do not unify
the two formulas later without checking with the owner first.

## The sensitivity constant

`PINCH_WHEEL_SENSITIVITY = 0.01` was tuned, not derived: a wheel event's `deltaY` for a trackpad
pinch is a raw, device- and browser-dependent pixel figure with no fixed relationship to how far the
writer's fingers actually moved (there is no OS-level pinch API a web page can read directly; the
browser synthesizes `ctrl`+`wheel` as the de facto standard for exposing the gesture at all), so
there is no first-principles quantity to derive a constant from. `Math.exp(-deltaY *
PINCH_WHEEL_SENSITIVITY)` (not a linear `1 - deltaY * sensitivity`) is what makes repeated small
deltas compose correctly regardless of the current zoom level -- a multiplicative response gives the
same _relative_ zoom step at 50% and at 150%, where a linear response would feel stronger at high
zoom, weaker at low zoom, and could in principle drive the ratio to zero or negative. At `0.01`, an
ordinary brisk pinch (accumulated `deltaY` on the order of 100-150, well within a real trackpad's
range for one full sweep) moves the ratio by roughly `e^1` to `e^1.5` -- very roughly doubling to
tripling the current percentage -- while a single incidental wheel tick (`deltaY` 1-5) stays under a
5% step (`exp(-5 * 0.01) ≈ 0.951`). Not re-tuned in this entry; the previous agent's choice was
plausible on inspection and nothing in this entry's testing gave a reason to second-guess it.

## The stored percentage stays fractional

`applyPinchWheelDelta` returns a fractional percentage, not rounded -- plan.md:662's "store the
percentage as a fractional value and round only for display." `App.tsx`'s `<output>` is the one
place `Math.round` is ever applied to it. A continuous gesture snapped to whole numbers at every
frame would feel steppy in a way the trackpad or finger movement producing it is not.

## Formatting

`pnpm format:check` failed on exactly one file, `apps/web/src/App.test.tsx`, left over from the
previous agent's session. Fixed with `pnpm exec prettier --write apps/web/src/App.test.tsx`; no
semantic change.

## The real-browser test

Added to `apps/web/e2e/page-rendering-persistence.spec.ts`, as further phases of the existing "zoom
modes: real editor, real DOM" test rather than a new one -- see "Why one test, not a new
`test.describe`" below for why that was not optional.

**Mechanism**: `page.mouse.wheel(deltaX, deltaY)` with `page.keyboard.down('Control')` held across
the call. Confirmed directly, with a disposable probe script run against a real page (deleted
before any of this work landed), that this combination reaches the page as a genuine `wheel`
DOMEvent with `ctrlKey: true` and `deltaMode: 0` (pixel deltas, exactly what
`zoomRatioFromWheelDelta` expects) -- not a Playwright-synthesized substitute. A `CDPSession`-level
`Input.dispatchMouseEvent({ type: 'mouseWheel', modifiers: 2 })` was tried as an alternative in the
same probe and produced an identical event; `mouse.wheel` was kept because it needs no separate CDP
session and is the same mechanism `page.mouse.move`/`page.keyboard.down` already use elsewhere in
this file.

**What it proves**:

1. **Ordinary scrolling still works.** A plain, unmodified `wheel` event over `.editor-region` moves
   `scrollTop` by a real, measured amount and leaves the zoom level at 100% throughout. The
   observable proof that nothing called `preventDefault()` is the native scroll itself actually
   happening -- a prevented wheel event produces no native scroll at all, so measuring real movement
   is the strongest and only externally-visible check available from outside the page.
2. **The character grid stays invariant across a pinch.** `measureGrid`, previously a closure local
   to the zoom-modes test, was hoisted to module scope (parameterised on `page`) so both tests share
   one definition rather than two copies drifting apart; the zoom-modes test's own call sites were
   updated to call it, with no change to what either test asserts. The same `gridAt100` baseline the
   zoom-modes test already captured (before any zoom-mode change touches the document) is reused for
   the pinch check too, since nothing edits the document in between.
3. **Both pointer-anchor axes hold, to within 1px, against real horizontal overflow.** Rather than
   re-deriving `restorePointerAnchoredScroll`'s own formula (already proved exactly against a
   stubbed DOM in `App.test.tsx`), this is a black-box, real-render-path property: the shortest
   manuscript block (by real rendered height, found by `getBoundingClientRect()`, not `offsetTop` --
   see the code comment for why `offsetTop`'s positioned-ancestor chain gave a wrong answer on the
   first attempt) is scrolled to the viewport's centre, the pointer is placed at its exact centre,
   and a real `ctrl`+`wheel` pinch (`deltaY: -20`) is fired there. The same block, re-measured after
   the gesture, is confirmed to still be under the pointer on **both** axes, to within 1px --
   including on the horizontal axis, which by this point in the gesture has real, substantial
   overflow (confirmed live: `scrollWidth` 1109px against `clientWidth` 810px, `scrollLeft` moving to
   a real, non-zero 96px, not staying pinned at 0). This did not hold on the first pass -- see "The
   vertical anchor: found, then fixed" and "The horizontal anchor: found, then fixed" below for the
   defects this same assertion originally found, with their own measured numbers, and the fix.

### Why one test, not a new `test.describe`

The vertical/grid checks above were first written as their own `test.describe`, each opening its own
signed-in session via `createAndOpenScreenplay`. That is what `progress/zoom-modes.md` already warns
against: "a second test here that repeated that setup pushed the full persistence suite over the
limit" (`DEFAULT_API_RATE_LIMIT_MAX`, `packages/server-config`, 300 requests). Confirmed directly,
not assumed from the warning alone: run as its own test, the nineteenth real account in this suite
reproduced the exact failure, `createAndOpenScreenplay` failing with "Projects could not be loaded."
Folded into the existing "zoom modes" test as further phases of the same session instead, per that
file's own precedent for its centred-scroll check.

### The vertical anchor: found, then fixed

**Found.** `restorePointerAnchoredScroll` assumed the anchored content's screen position scales by
exactly `ratio` from `.editor-region`'s own scroll origin. That is true of everything _inside_
`.pages` (CSS `zoom` scales it uniformly from its own top edge, per `progress/zoom-modes.md`'s
diagnosis), but `.editor-region`'s own 44px top padding sits _outside_ `.pages` and is never scaled
by anything -- only `.pages` carries `zoom`, and `.editor-region` is `align-items: flex-start` on the
cross (vertical) axis, so `.pages` sits at a fixed, unscaled offset below that padding. Working
through the formula (`documentY(z) = paddingTopPx + contentY * z`) showed the implementation's
scroll landing short of the visually-correct one by exactly `paddingTopPx * (ratio - 1)` -- derived
by hand, then confirmed against a live measurement: predicted 9.74px for the gesture the test uses
(`44 * (e^0.2 - 1)`), measured 9.4px, a difference well inside real-browser sub-pixel/rounding noise.
Reported to the lead rather than silently corrected on the first pass, per that pass's own scope.

**Fixed.** The owner independently verified the mechanism and approved a fix, with a specific steer:
measure the pointer's offset against `.pages`'s own box rather than `.editor-region`'s, so the
correction falls out of the formula naturally instead of being a `paddingTopPx` term bolted on.
`capturePointerAnchoredScroll` now takes a second element parameter, `pagesElement` (`.pages`
itself, via a new `pagesRef` in `App.tsx`), and computes `anchorOffsetX`/`anchorOffsetY` from
`pagesElement.getBoundingClientRect()`, not `region.getBoundingClientRect()`. Re-deriving the
formula from that basis: the pointer's offset from `.pages`'s own top-left is, by definition, a
painted distance that already reflects whatever the _current_ scale is, so dividing out and
re-multiplying by the new scale and subtracting the old capture point out algebraically collapses
`restorePointerAnchoredScroll`'s formula from `(oldScroll + anchorOffset) * ratio - anchorOffset` to
the simpler `oldScroll + anchorOffset * (ratio - 1)` -- with no `paddingTopPx`, no region padding, no
region centring rule appearing anywhere in it, because measuring against `.pages` already accounts
for whatever `.editor-region` does to position it, whatever that currently is. See zoom.ts's own
top-of-section comment on the pair for the full derivation.

**Verified.** The real-browser assertion (previously predicting and accepting a ~9-10px deviation)
now asserts the anchor holds directly, tolerance 1px: `expect(Math.abs(afterPointerY -
pointerY)).toBeLessThan(1)`. Passes reliably (run repeatedly while developing the fix); the residual
deviation measured during development was a small fraction of a pixel, consistent with ordinary
sub-pixel `scrollTop` writes and `getBoundingClientRect()`'s own fractional reporting, not a
remaining systematic effect.

### The horizontal anchor: found, then fixed

**Found.** `restorePointerAnchoredScroll`'s horizontal formula made the identical "scales linearly
from a fixed scroll origin" assumption the vertical case had -- but `.editor-region` is `display:
flex` with no `flex-direction` set (confirmed directly against `styles.css`, not inferred), so its
**main** axis -- the one `justify-content: center` governed -- was horizontal. Unlike the vertical
axis's `align-items: flex-start` (a fixed, unscaled origin), horizontal centring gave `.pages` a
**dynamic** origin that shifted with `.pages`'s own scaled width. Once `.pages` overflowed
`.editor-region` -- any real zoom-in, and even part of the time at 100% in this fixture's own
viewport, confirmed directly (`scrollWidth` already exceeded `clientWidth` before any pinch had
happened at all) -- that shift was not the small, bounded correction the vertical case had. This is
also a well-known CSS pitfall in its own right, independent of the pointer-anchor formula: once a
`justify-content: center` flex item is wider than its scrollable container, the overflow goes out
_both_ sides, but a `scrollLeft >= 0` clamp can never reach the left side, so part of the content
becomes permanently unreachable by scrolling.

Measured directly during diagnosis, in two different overflow/zoom combinations:

| Scenario                                                                         | Measured horizontal drift |
| -------------------------------------------------------------------------------- | ------------------------- |
| 100% -> ~122%, overflow only just beginning (pre-existing at baseline)           | 89.7px                    |
| 125% -> ~138% (pre-established overflow with slack on both sides, gentler pinch) | 42.8px                    |

Both were an order of magnitude larger than the vertical case, and neither scaled with the pinch size
the way a fixed, bounded offset would (the second, gentler gesture produced _less_ absolute drift
than the first, but nowhere near proportionally less) -- consistent with an origin that itself moves
by a different, content-width-dependent amount each time, not a fixed additive error. Reported to the
lead rather than silently corrected on the first pass, per that pass's own scope.

**Fixed -- shared layout, not pinch-local.** The owner independently verified the mechanism in the
CSS and confirmed the fix: `justify-content: center` removed from `.editor-region`; `.pages` now
centres itself with `margin-inline: auto` instead. This is the standard remedy for exactly this
pitfall, not a novel technique -- auto margins absorb positive free space exactly like
`justify-content: center` does, but per the flexbox spec resolve to exactly `0` (never negative) once
the item no longer fits, so the item's leading edge pins to the container's own scroll origin and
every pixel of overflow lands on the reachable, positive-`scrollLeft` side, and (for the
pointer-anchor formula specifically) that origin no longer moves with zoom. `align-items: flex-start`
on `.editor-region` was left untouched -- that is the unrelated cross-axis rule the existing comment
above it already documents. **This CSS rule is shared layout**: `.editor-region`/`.pages` govern how
the manuscript sits on screen at every zoom level, in every mode, for every writer action, not only
pinch -- the next person to touch `.editor-region`'s flex rules should read this entry and
zoom.ts's own comment on `capturePointerAnchoredScroll`/`restorePointerAnchoredScroll` first, since a
reintroduced `justify-content: center` (or an equivalent moving-origin centring rule) would silently
reopen this exact defect. `capturePointerAnchoredScroll`'s own fix (measuring against `.pages`
instead of `.editor-region`; see "The vertical anchor" above) is the other half of this -- the CSS
fix makes `.pages`'s edge behave predictably under overflow, and the capture-basis fix is what
actually reads that edge instead of `.editor-region`'s.

**Verified.** The full zoom-modes/pinch real-browser test (fit-width, fit-page, centred-scroll
toolbar anchoring, the title-page gap, and the pointer-anchor pinch phases, all in one test against
one real document) passes unchanged in shape, confirming this shared-layout change did not disturb
any of the other zoom paths that also depend on `.editor-region`'s centring. `page-geometry.spec.ts`
(14 tests, unrelated to `.editor-region` entirely -- confirmed by grep, it never references that
class) also passes, unaffected as expected. The horizontal pointer-anchor assertion, previously
omitted because it would have been a false claim, now asserts `expect(Math.abs(afterPointerX -
pointerX)).toBeLessThan(1)` and passes -- confirmed, while developing it, against a scenario with
real, substantial overflow (`scrollWidth` 1109px vs `clientWidth` 810px, `scrollLeft` moving to a
real 96px), not a vacuous one where `scrollLeft` never left `0`.

### The zoom-scroll-drift hazard, checked explicitly

`progress/zoom-scroll-drift.md` documents a bug fixed just before this slice: `@tiptap/react`'s
`useEditor` calling `editor.setOptions(...)` on every `<App>` re-render, letting
`maybeJumpScrollCaretIntoView` (`paginationExtension.ts`) write `.editor-region.scrollTop` behind the
app's own back. Pinch re-renders `<App>` at frame rate, making it about the heaviest realistic test
of that fix available. **Checked, not assumed**: the real, measured `scrollTop`/`scrollLeft` after
each gesture matched `restorePointerAnchoredScroll`'s own formula to within a fraction of a pixel in
every measurement taken during diagnosis and while developing both fixes -- both before the fix (the
9.74px-predicted/9.4px-measured agreement recorded under "The vertical anchor" above) and after (the
sub-1px residual the tightened real-browser assertion now holds to), which could not happen if a
second, independent write were also touching `scrollTop` between the effect's own write and this
test's read. Nothing in this slice's own testing, on either pass, found evidence of a second write;
the fix from `zoom-scroll-drift.md` appears to hold under pinch's frame-rate re-renders.

## Mutation testing

Redone from scratch per this scope's instruction ("do not assume any earlier result carried over"),
against `pnpm exec vitest run src/zoom.test.ts src/App.test.tsx` (~14s per run). Each mutation below
was applied, run to confirm the specific failure, then reverted and reconfirmed green.

| #   | File, behaviour mutated                                                                                                                                        | What broke                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `zoom.ts`: `zoomRatioFromWheelDelta` -- flipped the sign (`exp(deltaY * s)` instead of `exp(-deltaY * s)`)                                                     | Zoom-in/zoom-out direction reversed                                                                                                | **Killed.** 10 tests failed: `zoomRatioFromWheelDelta`'s own sign tests, `applyPinchWheelDelta`'s clamp tests (a reversed sign also breaks which end of the range a large gesture clamps to), and `App.test.tsx`'s "zooms in for a negative deltaY" / "a positive deltaY zooms out" tests.                                                                                                                                                                                   |
| 2   | `zoom.ts`: `applyPinchWheelDelta` -- removed the `clampZoomPercent(...)` wrapper                                                                               | No 50-150 clamp on the pinch path                                                                                                  | **Killed** by `zoom.test.ts`'s two ceiling/floor tests directly on the function. Not caught by `App.test.tsx`'s own end-to-end clamp test, because `resolveZoomPercent`'s `'fixed'` branch applies an independent, redundant `clampZoomPercent` downstream (the recompute effect that turns `zoomMode` into the rendered `zoomPercent`) -- real defense in depth, noted here so a future reader does not mistake the App-level pass for evidence this mutation was survived. |
| 3   | `zoom.ts`: `restorePointerAnchoredScroll` -- inverted the ratio (`oldPercent / newPercent` instead of `newPercent / oldPercent`)                               | Pinch would scroll the wrong way                                                                                                   | **Killed.** 8 tests failed across `zoom.test.ts`'s exact-formula suite for the function and `App.test.tsx`'s own exact-formula pointer-anchor test.                                                                                                                                                                                                                                                                                                                          |
| 4   | `zoom.ts`: `restorePointerAnchoredScroll` -- removed the `verticalExtent > 0`/`horizontalExtent > 0` degenerate-case guards, running the write unconditionally | (see next paragraph)                                                                                                               | **Not killed.** All 128 tests still passed.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | `App.tsx`: wheel handler -- removed `if (!event.ctrlKey) { return; }`                                                                                          | An ordinary, unmodified scroll would also zoom and be prevented                                                                    | **Killed** by "leaves an ordinary wheel scroll (no ctrlKey) completely alone" (`notPrevented` flipped to `false`).                                                                                                                                                                                                                                                                                                                                                           |
| 6   | `App.tsx`: wheel handler -- removed `event.preventDefault()`                                                                                                   | A real `ctrl`+wheel gesture would not intercept the browser's own native handling                                                  | **Killed** by "a ctrl+wheel pinch prevents default..." (`prevented` flipped to `true`).                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | `App.tsx`: wheel handler -- removed the `frame === undefined` rAF-coalescing guard, scheduling a fresh frame on every tick                                     | Every wheel event would separately schedule `requestAnimationFrame`, defeating the coalescing the handler's own comment describes  | **Killed** by "coalesces every ctrl+wheel event... into a single queued animation frame" (`rafSpy` called 3 times instead of 1).                                                                                                                                                                                                                                                                                                                                             |
| 8   | `App.tsx`: touch handler -- removed `previousDistance = undefined` from `clearPointer`                                                                         | A pair change (one of two original fingers lifts while a third is already down) reuses a stale baseline distance from the old pair | **Killed** by "one of the original two fingers lifting while a third is down leaves a fresh baseline for the new pair, not the stale one" (expected 110%, timed out waiting for it). This is the exact mutation the previous agent's session ended mid-verification of; redone here from a clean baseline rather than trusted from that earlier, incomplete run.                                                                                                             |
| 9   | `App.tsx`: touch handler -- removed the `pointers.size !== 2` guard in `handlePointerMove`                                                                     | A single touch pointer, or three-plus, would attempt the pairing/distance logic                                                    | **Killed.** 2 tests failed: "a single touch pointer never zooms..." and "lifting a finger clears its pointer, so a lone remaining finger goes back to native panning" (both flipped `notPrevented` to `false`).                                                                                                                                                                                                                                                              |
| 10  | `App.tsx`: touch handler -- removed `if (event.pointerType !== 'touch') { return; }` from **`handlePointerMove`** only                                         | (see next paragraph)                                                                                                               | **Not killed** by any existing test.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11  | `App.tsx`: touch handler -- removed the same guard from **`handlePointerDown`** only                                                                           | A non-touch pointer (pen, mouse) gets tracked in the `pointers` Map at all                                                         | **Not killed** by any existing test _before_ this entry added one -- see below.                                                                                                                                                                                                                                                                                                                                                                                              |

**Mutation 4, not killed, and correctly not fixed.** Tracing through why: in every test that reaches
this code with `extent <= 0` (content exactly fills the viewport, no scroll possible), the formula's
own clamp -- `Math.min(Math.max(target, 0), extent)` -- already forces the written value to `extent`
regardless of whether the surrounding `if` guard ran, and in the one existing test built for exactly
this case (`scrollHeight === clientHeight`, `scrollTop` already `0`), that forced value coincides
with the value already there. In a real browser, `scrollHeight` is never less than `clientHeight`
(it is defined as the larger of the two), so `extent` is never negative outside a hand-built test
double -- meaning this guard cannot be distinguished from its absence by any black-box test, real or
jsdom, that respects that invariant. This is the same shape of finding this codebase already has
one documented instance of (`App.tsx`'s own comment on `clearPointer`, describing an earlier,
similarly-dead reset in `handlePointerDown` that mutation testing found and a previous agent
removed) -- but per this scope's explicit constraint, the implementation is not to be redesigned or
simplified except where a test proves a genuine _defect_, and dead-but-harmless code is not that.
Left in place; reported here rather than silently touched.

**Mutations 10 and 11, and the real gap they found.** Mutation 10 (removing the guard from
`handlePointerMove` alone) turned out not to isolate anything: `handlePointerMove`'s own check is on
the _moving_ pointer's own `pointerType`, so a non-touch pointer's own move is still rejected by that
same function regardless of whether `handlePointerDown` tracked it. Reverted without further action;
recorded so a future reader does not repeat it expecting a different result. Mutation 11
(`handlePointerDown` alone) is where the real gap lives, and an initial test attempt -- two
simultaneous non-touch pointers (a pen and a mouse) spreading apart -- did not kill it either, for
the identical reason mutation 10 taught: both pointers' own _moves_ are independently rejected by
`handlePointerMove`'s check no matter what `handlePointerDown` did to the `pointers` Map. **A new
test was added** (`App.test.tsx`, `pinch-to-zoom: touch` describe block: "a stray non-touch pointer
(pen) paired with one real finger never zooms...") using a pointer pair that actually exercises the
gap: one pen pointer that only ever goes down, never moves, and one real _touch_ pointer that moves
twice exactly like this file's existing two-touch "zoom in" test. With `handlePointerDown`'s guard
removed, the pen pointer wrongly enters `pointers`, the touch pointer's own move passes its own
`pointerType === 'touch'` check, `pointers.size` reaches 2, and the pen/touch pair is measured as a
pinch -- zooming from one real finger moving near an incidental pen contact. Confirmed: this new test
failed against the mutation (`notPrevented` false, zoom moved to 150%) and passes against the
restored code. `firePointer`, the shared test helper for this describe block, gained an optional
`pointerType` parameter (default `'touch'`, so every pre-existing call site is unchanged) to make
this possible.

### Mutation testing the two follow-up fixes

Both approved fixes (see "The vertical anchor: found, then fixed" and "The horizontal anchor: found,
then fixed" above) were themselves mutation-tested: each reverted to reproduce the exact pre-fix
defect, run to confirm the specific assertion now catches it, then restored and reconfirmed green.

| #   | Fix, mutation                                                                                                                                                                          | Result                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `zoom.ts`: `restorePointerAnchoredScroll` -- reverted the simplified `oldScroll + anchorOffset * (ratio - 1)` back to the pre-fix `(oldScroll + anchorOffset) * ratio - anchorOffset`  | **Killed.** 5 unit tests failed in `zoom.test.ts` (the tests whose fixtures do not start at `scrollTop`/`scrollLeft` `0` and do not clamp -- see that describe block's own top-of-block comment on why the two formulas coincide in the other cases, deliberately, and are not useful mutation targets on their own). |
| B   | `zoom.ts`: `capturePointerAnchoredScroll` -- reverted to measure the anchor offset against `region.getBoundingClientRect()` instead of `pagesElement.getBoundingClientRect()`          | **Killed.** 2 tests failed: `zoom.test.ts`'s own capture test, and `App.test.tsx`'s exact-formula pointer-anchor test -- the latter via a deliberate trap built into that test (`.editor-region`'s stubbed rect is set to an obviously wrong box specifically so a regression to measuring against it fails loudly).  |
| C   | `styles.css`: `.editor-region`/`.pages` -- reverted `.editor-region` to `justify-content: center` and removed `.pages`'s `margin-inline: auto`, reproducing the exact pre-fix centring | **Killed.** The real-browser horizontal pointer-anchor assertion failed by 90.7px -- consistent with the original diagnosis (89.7px measured for a closely comparable scenario) -- confirming the mutation reproduces the original defect's actual magnitude, not merely _some_ failure.                              |

Mutation C required the full `pnpm test:system:persistence` gate (real browser, real layout; jsdom
never lays anything out, so this defect and its fix are both invisible to any unit test) -- the only
one of the three that could not be checked with the fast `vitest run` loop the other mutations used.

**A cannot be tested for X and Y independently by design.** Mutation A necessarily changes both axes
at once (the formula is one function, `ratio` shared), but the affected test set already spans both:
the killed tests include the dedicated vertical test, the dedicated horizontal test, and the
both-axes-together test.

## Gates

Run from `/Users/nathan/Documents/finaler-draft-worktrees/pinch-zoom`.

```
pnpm lint
```

Clean, `--max-warnings=0`, no output.

```
pnpm format:check
```

Clean: "All matched files use Prettier code style!" (after the one `App.test.tsx` fix above).

```
pnpm typecheck
```

Clean, full monorepo build chain. Note: `apps/web/tsconfig.json` only includes `src` and
`vite.config.ts` -- `apps/web/e2e/**` is not type-checked by this gate at all. A real duplicate
`const ratio` declaration introduced while drafting the e2e test (colliding with an unrelated,
pre-existing local of the same name in the same test function) was caught only by actually running
Playwright, not by this gate or by `eslint`. Worth knowing for the next slice that edits this file.

```
pnpm test
```

562/562 (560 pre-existing + 1 new from the first pass's mutation testing [the non-touch-pointer-pair
test] + 1 new `capturePointerAnchoredScroll` unit test from the fix's own mutation testing above,
`zoom.test.ts`/`App.test.tsx`).

```
pnpm --filter @finaler-draft/web test:coverage
```

Clean, exit 0. `zoom.ts` 100%/100%/100%/100%, unchanged by the fix. `App.tsx` 95.72% statements /
88.16% branches / 96.87% functions / 95.72% lines -- comfortably over the repo's 80%-per-file
threshold.

```
pnpm check:bundle-budget
```

Clean. Entry chunk 111.40 kB / 120.00 kB. Lazy editor chunk 115.16 kB / 200.00 kB. CSS 5.80 kB /
20.00 kB.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut -d= -f2-)" pnpm test:system:persistence
```

18/18, run six times across this session in total (three during the first pass, three more across
the follow-up fix -- once to confirm the tightened assertions pass, once to confirm mutation C's
failure, once to reconfirm green after reverting it) -- reliably green every time it was expected to
be, ~27-32s each run.

```
npx playwright test apps/web/e2e/page-geometry.spec.ts
```

14/14, run twice across this session (once per pass) -- unaffected by either fix, as expected: this
spec never references `.editor-region` at all (confirmed by grep), so the shared-layout CSS change
has nothing in it to disturb.

## Files touched

First pass:

- `apps/web/src/App.test.tsx` -- Prettier fix (no semantic change); `firePointer`'s new optional
  `pointerType` parameter; one new test (non-touch pointer pair, described above).
- `apps/web/e2e/page-rendering-persistence.spec.ts` -- `measureGrid` hoisted to module scope
  (parameterised on `page`), replacing a closure-local copy in the pre-existing "zoom modes" test
  with no change to what that test asserts; three new phases appended to that same test (ordinary
  scroll, pointer-anchor, grid-invariant-under-pinch), reusing its existing session rather than
  opening a new one, per the rate-limit finding above.

Follow-up pass (both approved fixes):

- `apps/web/src/zoom.ts` -- `capturePointerAnchoredScroll` gained a `pagesElement` parameter and now
  measures the anchor offset against it instead of `region`; `restorePointerAnchoredScroll`'s formula
  simplified from `(oldScroll + anchorOffset) * ratio - anchorOffset` to `oldScroll + anchorOffset *
(ratio - 1)`; both functions' top-of-section comment rewritten to derive and explain the new
  formula and why `.pages`, not `.editor-region`, is the right box.
- `apps/web/src/App.tsx` -- new `pagesRef` (`useRef<HTMLDivElement>`), attached to `.pages`'s own
  JSX element; `commitPinchZoom` passes `pagesRef.current` into `capturePointerAnchoredScroll`.
- `apps/web/src/styles.css` -- `.editor-region` lost `justify-content: center` (with a comment
  explaining why, and flagging this as shared layout); `.pages` gained `margin-inline: auto`.
- `apps/web/src/zoom.test.ts` -- `capturePointerAnchoredScroll`/`restorePointerAnchoredScroll`'s
  describe blocks rewritten for the new signature and formula: `regionWithScrollAndRect` replaced by
  `regionWithBothAxesScroll` (region no longer needs a stubbed rect) and a new `pagesElementWithRect`
  helper; one new test (`capturePointerAnchoredScroll` returns `undefined` for a null pages element);
  every pre-existing test's expected values and comments updated to the new formula, with a
  top-of-block comment explaining which cases do and do not distinguish the two formulas and why.
- `apps/web/e2e/page-rendering-persistence.spec.ts` -- the vertical assertion's "predict a known
  deviation and assert against the prediction" replaced with a direct `toBeLessThan(1)` on both axes
  (a real horizontal assertion added for the first time); the now-unused `paddingTopPx` measurement
  and `zoomRatioFromWheelDelta` import removed.
- `progress/pinch-zoom.md` -- this entry, updated in place per the coordinator's own instruction
  (move both items from "Left open" into what was fixed, keep the before-numbers as the record of
  why).

## Left open

1. **`restorePointerAnchoredScroll`'s `extent > 0` guards** (mutation 4, first pass) are provably
   unkillable by any black-box test given the real-browser invariant `scrollHeight >= clientHeight`
   -- not touched, per the coordinator's explicit instruction to leave them alone; they are not a
   defect, only dead-but-harmless code, and simplifying them was never in scope. Untouched by the
   follow-up fix either -- the formula change (see "The vertical anchor" above) is orthogonal to
   these guards, which still gate on `region.scrollHeight`/`clientHeight`/`scrollWidth`/`clientWidth`
   exactly as before.
2. Both pointer-anchor defects this entry originally reported are now fixed and verified -- see "The
   vertical anchor: found, then fixed" and "The horizontal anchor: found, then fixed" above. Nothing
   else surfaced during the follow-up fix's own testing that is not already recorded there.
