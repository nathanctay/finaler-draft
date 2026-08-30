# Scope: repagination-scroll-anchor

Branch: `fix/repagination-scroll-anchor`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/repagination-scroll`
Base: `main` @ `c7332a1`
Owner: implementation agent, working from a defect already diagnosed and handed down directly (no
separate lead dispatch for this scope).

## The defect

`apps/web/e2e/page-rendering-persistence.spec.ts`'s `an open element menu moves no line and no
page, and only an explicit choice reaches the document` failed deterministically at
`expect(Math.max(gapBelow, gapAbove)).toBeLessThanOrEqual(4)` with `Received: 193`. Reproduced on a
clean worktree at the pre-existing commit `5224da9` too -- a latent bug the test only recently
became able to see, not something this branch introduced.

Measured at the failure: caret rect top 905, bottom 921, against a 720px `window.innerHeight`. The
caret was below the fold. The element menu's `placeAtCaret` clamped into the viewport (its
documented too-short-window branch) and landed 193px from a caret the writer couldn't see. The menu
was a symptom, not the defect -- `floatingPanel.ts`/`elementMenu.tsx` were not touched.

**The ordering race**, in `apps/web/src/paginationExtension.ts`:

1. An edit dispatches. ProseMirror scrolls the selection into view synchronously, against the DOM
   as it exists then -- with the _old_ page-break decorations.
2. `scheduleRepagination()` coalesces the recompute into a `requestAnimationFrame`.
3. That frame dispatches a transaction carrying the new `PaginationState` as meta -- no steps, no
   selection change.
4. Applying it materializes the page-break widget and its spacer
   (`spacerHeightIn = page.bottomMarginIn + PAGE_GAP_IN + MARGIN_TOP_IN`, `pagination.ts:216`).
   Everything below the break drops by that amount.
5. Because the transaction changed neither the document nor the selection, ProseMirror has no
   reason to scroll, and nothing corrects it. The caret ends up off-screen, and stays there --
   confirmed non-transient by the original diagnosis: the element-menu test's own 400ms settle
   window elapsed before the caret was ever measured, and it was still 193px off.

## The owner's chosen behaviour, and the alternative he rejected

**Repagination must not change whether the caret is visible, and must not appear to move the line
being typed.** If the caret was visible inside `.editor-region` before a repagination commits, it
must remain at the same screen position after it -- compensate `.editor-region`'s `scrollTop` by
exactly the shift the new decorations introduced, rather than reflowing the reader's screen.

The gate matters as much as the correction: **only compensate when the caret was visible
beforehand.** A writer who had deliberately scrolled away -- rereading page 1 while a
document-settings change repaginates the whole document -- must be left alone. The owner explicitly
rejected the simpler "scroll the caret back into view": it makes the manuscript jump by roughly two
inches every time a page break is created, and it would just as happily snap the reader back from
wherever they'd scrolled to read, which is a worse defect than the one being fixed.

## The fix

`apps/web/src/paginationExtension.ts` gained `compensateScrollForRepagination(view, dispatch)`, and
three small helpers it's built from:

- `readCaretRect(view)` -- the caret's viewport rectangle via `view.coordsAtPos(selection.head)`,
  guarded by `try`/`catch` (an invalid position throws) and by `view.isDestroyed`.
- `findScrollRegion(view)` -- `view.dom.closest('.editor-region')`, the scroll container
  `App.tsx` renders (`overflow: auto`, `styles.css`).
- `isRectVisibleInRegion(rect, region)` -- whether the caret rect falls inside the region's own
  visible box; a zero-height region counts as nothing being visible.

`compensateScrollForRepagination` measures the caret before `dispatch()`, gates on it having been
visible, measures again after, and adds the difference to `region.scrollTop` -- only when the shift
is non-zero, so a repagination that moves nothing near the caret never writes to `scrollTop` at all
(no accumulated rounding drift across repeated no-op frames).

It wraps both existing repagination dispatch sites: the frame-coalesced doc-change path inside
`scheduleRepagination`'s `requestAnimationFrame` callback (the site of the diagnosed race), and the
synchronous `updatePaginationDocumentSettings` (the document-settings-dialog path, which is also
where the owner's own "reading page 1" example lives).

### A correction made mid-implementation: not gated on focus

The first draft also gated `readCaretRect` on `view.hasFocus()`, reasoning that an unfocused editor
has no caret a writer is looking at. That was wrong, and caught before it shipped:
`documentSettingsDialog.tsx`'s dialog moves DOM focus onto its own first input the instant it opens
(`useEffect(() => dialogRef.current?.querySelector('input')?.focus(), [])`), so the editor is
unfocused for the _entire_ time a document-settings change can trigger this path -- exactly the
owner's own canonical scenario. Gating on focus would have silently disabled compensation for it.
`coordsAtPos` is a pure DOM geometry read and needs no focus to be accurate; visibility inside
`.editor-region` is the gate that matters, not focus. The unit test that had been written for "left
alone when unfocused" was replaced with one proving the opposite: compensation still applies while
unfocused, modelling the dialog scenario directly (`hasFocus()` unstubbed, defaulting to jsdom's
false).

### Decorations are synchronous -- verified, not assumed

Confirmed against `@tiptap/core`'s `Editor.dispatchTransaction` (the function `EditorView.dispatch`
is bound to): it calls `this.view.updateState(state)` synchronously, with no microtask or
animation-frame boundary before returning. The "after" measurement inside
`compensateScrollForRepagination` is taken immediately after `dispatch()` returns; no `setTimeout`
or second frame was needed, and none was added.

## An open issue found, not fixed: `parentheticalWidthIn` via the document-settings dialog

While building the end-to-end test, a document-settings-driven scenario (narrowing
`parentheticalWidthIn` to force a new page break) exposed a **second, distinct** ordering issue that
this fix's `updatePaginationDocumentSettings` wiring does not fully cover.

`App.tsx`'s `updateDocumentSettings` calls, in order: `updatePaginationDocumentSettings` (this
fix's compensation), then `applyPageGeometryCssVariables`. The latter writes the CSS custom
property that actually controls a parenthetical block's rendered width; the browser's _native_ text
wrap doesn't re-flow to the new width until that call runs. `parentheticalWidthIn` is unusual among
the document settings in that it changes wrap width, and both `wrap.ts`'s pagination model _and_
the browser's real word-wrap contribute to the same content's rendered height -- decorations move
first, the visual rewrap follows a moment later. Because `compensateScrollForRepagination` measures
its "after" state immediately following the decoration dispatch -- correctly, per the diagnosed
defect -- it captures the shift from the new page break alone, not the additional shift the
CSS-driven rewrap introduces right after. In one measured run: compensated shift 584px against a
true total of roughly 1160px, leaving the caret about 576px off after a `parentheticalWidthIn`
change specifically.

This is real, but out of this slice's scope: the diagnosis and the owner's fix location were both
specific to the doc-change race in `paginationExtension.ts`, and `App.tsx`'s `updateDocumentSettings`
ordering wasn't part of what was described. Fixing it would mean either reordering
`updateDocumentSettings`'s side effects or widening `compensateScrollForRepagination`'s wrapping to
span both the ProseMirror dispatch and the CSS write, which reaches outside `paginationExtension.ts`
into `App.tsx`. Flagged here rather than silently patched or silently ignored.

Every other document setting (`characterIndentIn`, `parentheticalIndentIn`, `pageNumberStyle`,
`sceneNumbersEnabled`, `autoMoreContinued`) is unaffected -- none of them change wrap width, so none
of them trigger a CSS-driven rewrap after the fact. This is why the shipped end-to-end test types
across a page boundary instead of exercising the settings dialog: it proves the fix without running
into this narrower, separate gap.

## Tests

### Unit, `apps/web/src/paginationExtension.test.ts`

New `buildEditorInRegion` helper (mount wrapped in a real `.editor-region` div with a stubbed
`getBoundingClientRect`, following `floatingPanel.test.ts:29-33`'s house precedent for stubbing
rects) and a `coordsAt(top)` stub builder, plus a new `describe('repagination scroll anchor', ...)`
block, four tests:

1. **Compensates a caret visible before repagination and pushed down by it, by exactly the shift**
   -- via the doc-change/`requestAnimationFrame` path (the diagnosed site), `coordsAtPos` stubbed
   to move from 300 to 493 (the real defect's own measured 193px, rounded for a clean fixture
   number). Asserts final `scrollTop` is exactly `50 + 193 = 243`.
2. **Leaves `scrollTop` alone when the caret was already out of view** -- via
   `updatePaginationDocumentSettings`, modelling the owner's own "reading page 1" scenario. Asserts
   `coordsAtPos` was called exactly once (no "after" measurement was ever attempted) and `scrollTop`
   is untouched.
3. **Still compensates a visible caret even when the view is unfocused** -- the document-settings
   dialog scenario, added after the mid-implementation correction above. `hasFocus()` left at
   jsdom's real default (false), asserting compensation still applies.
4. **Changes `scrollTop` by exactly zero when a repagination shifts nothing near the caret** -- an
   own-property override on `region.scrollTop` (getter/setter, not `vi.spyOn`, since jsdom's
   `scrollTop` accessor lives on the prototype) proves the setter is never invoked at all, not
   merely that the final value happens to match.

All 18 tests in the file pass (14 pre-existing + 4 new).

### End-to-end, `apps/web/e2e/page-rendering-persistence.spec.ts`

The already-failing element-menu test is unmodified and is the primary acceptance criterion -- see
Gates below.

New test: `typing across a page boundary leaves the caret at the same screen position an equivalent
same-page edit would have`. A single edit's own delta can't be asserted against a literal expected
value the way the document-settings path can (see paginationExtension.test.ts's coverage of that):
typing a line is _supposed_ to move the caret down by one line, and that ordinary advance can't be
told apart from the defect's spurious extra shift from a single before/after pair. So the test
compares two structurally identical edits -- each one hard-wrapped line of text, typed into the
same block the same way -- where only the second crosses a page boundary:

- Fixture: `fourPageMixedAnchorFixture`'s own block-0 recipe (a single action block, typed straight
  into the pre-seeded empty block). 55 lines of `linesOfLength(ACTION_BUDGET, _)` fill page 1
  exactly with no break; 56 lines cross to page 2 -- verified against the real `paginateScreenplay`
  in the test itself, not assumed.
- Types 54 lines (one line of room left), measures the caret (`window.getSelection()`, safe here
  since the canvas keeps focus throughout -- no dialog involved), types one more line (control:
  54→55, still page 1), measures again, types one more (test: 55→56, crosses), measures a third
  time.
- Asserts `|crossingDelta - controlDelta| <= 4` -- without the fix this is off by roughly
  `spacerHeightIn` (1.75-2.75in, hundreds of pixels), comfortably outside the tolerance.

## Mutation testing

### Unit-level (`paginationExtension.ts`, verified via `vitest run src/paginationExtension.test.ts`)

Every mutation: broke the implementation, ran the file, confirmed the predicted test(s) failed and
nothing else did, restored, confirmed all 18 green again.

1. **Dropped the `wasVisible` gate** (`if (!region || !before)`, omitting `!wasVisible`) -- caught
   by test 2 (`leaves scrollTop alone when out of view`): `coordsAtPos` called twice instead of
   once.
2. **Flipped the compensation's sign** (`scrollTop -= shift`) -- caught by tests 1 and 3
   (`compensates ... by exactly the shift`, `still compensates ... unfocused`): both expected final
   `scrollTop` values were wrong (e.g. `-143` instead of `243`).
3. **Dropped the `shift !== 0` guard**, writing `scrollTop += shift` unconditionally -- caught by
   test 4 (`changes scrollTop by exactly zero`): the setter spy recorded a call even though the
   written value would have been numerically identical to the untouched one, which is exactly why
   the setter-spy technique (not a value comparison) was used for that test.
4. **Gutted the visibility check** (`isRectVisibleInRegion` always returns `true`) -- caught by
   test 2: with visibility no longer gating anything, a second `coordsAtPos` call was attempted
   where none should have happened.
5. **Gutted `findScrollRegion`** (always returns `null`) -- caught by tests 1, 2, and 3
   simultaneously: no region means no compensation is even attempted, failing every assertion that
   depends on `coordsAtPos` having been called the expected number of times.
6. **Reintroduced `!view.hasFocus()`** into `readCaretRect`'s guard, as a check on the correction
   itself. Caught by tests 1, 2, _and_ 3 simultaneously: none of this file's editors ever call
   `.focus()`, so jsdom's real `hasFocus()` default (false) made every one of them fail the
   reintroduced guard, not only test 3 (the one written specifically to hold this line by testing
   the unfocused case on purpose rather than incidentally).

### End-to-end (verified via the full `pnpm test:system:persistence` gate, twice)

`compensateScrollForRepagination`'s body replaced with `dispatch(); return;` (compensation entirely
disabled, `findScrollRegion`/`readCaretRect`/`isRectVisibleInRegion` left unused but not deleted).
Ran the full 15-test persistence suite:

- The new typing test failed: `Received: 200` (comfortably over the `<= 4` tolerance) -- the
  crossing edit's delta exceeded the control edit's by roughly a spacer's height, exactly as
  predicted without the fix.
- **The previously-failing element-menu test failed again, at `Received: 193`** -- the identical
  value the original diagnosis measured, independently confirming both that the mutation correctly
  reproduces the original defect and that the real fix (restored immediately after) is what makes
  that number disappear.
- All 13 other tests in the suite stayed green, confirming the mutation's blast radius matched
  expectations exactly.

Restored immediately after; `diff` against a pre-mutation copy of `paginationExtension.ts` confirmed
byte-identical restoration before the final gate run.

## Gates

1. `pnpm lint` -- clean, `--max-warnings=0`, no output.
2. `pnpm format:check` -- clean, "All matched files use Prettier code style!"
3. `pnpm typecheck` -- clean, full `dist/` rebuild across every package plus both apps.
4. `pnpm test` -- clean, workspace-wide: `apps/web` 35 files / 446 tests (includes
   `paginationExtension.test.ts`'s 18), every other package unchanged and green.
5. `pnpm --filter @finaler-draft/web test:coverage` -- clean. `paginationExtension.ts`:
   92.15% statements / 87.23% branches / 100% functions / 92.15% lines, comfortably over the
   repo's 80%-per-file threshold (`apps/web/vite.config.ts`'s `thresholds: { perFile: true, ... }`).
   The uncovered branches are the defensive guards not exercised by any test written for this slice
   (`readCaretRect`'s `catch` for an invalid `coordsAtPos` position, and `view.isDestroyed`) -- see
   "Known limitations" below.
6. `TEST_DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm test:system:persistence`
   (env read from `/Users/nathan/Documents/finaler draft/.env`, never printed) -- **all 15 tests
   pass**, including the previously-failing element-menu test, run three times over the course of
   this work (once establishing the original failure was reproducible at the start, once after the
   fix and new test landed, once more as the final gate after the mutation-testing round-trip) with
   no flakes observed.

## Files touched

- `apps/web/src/paginationExtension.ts` -- `compensateScrollForRepagination` and its three helpers
  (`readCaretRect`, `findScrollRegion`, `isRectVisibleInRegion`); wired into both existing
  repagination dispatch sites.
- `apps/web/src/paginationExtension.test.ts` -- `buildEditorInRegion` helper, `coordsAt` stub
  builder, new `describe('repagination scroll anchor', ...)` block (4 tests).
- `apps/web/e2e/page-rendering-persistence.spec.ts` -- one new test proving the anchor directly
  through real typing across a page boundary. The already-failing element-menu test is unmodified.
- `progress/repagination-scroll-anchor.md` -- this entry.

## Known limitations / things left open

- The `parentheticalWidthIn`-via-document-settings-dialog gap described above is real and
  unfixed -- flagged for the owner's judgement on whether it's worth a follow-up slice.
- `readCaretRect`'s `catch` branch (an invalid `coordsAtPos` position) and its `view.isDestroyed`
  guard are implemented per the task's explicit "watch for" list but are not separately unit- or
  mutation-tested; both are defensive against states that don't arise in either normal typing or
  the document-settings path exercised by the tests above. Noted rather than silently claimed as
  covered.
- Nothing staged or committed. Handing off an uncommitted diff for review, per this project's
  standing git-ownership rule.

### 2026-08-30 -- implementation agent -- complete

Status: ready-for-review
