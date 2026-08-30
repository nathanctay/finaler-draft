# The caret at a mid-block page seam

Branch `feature/page-seam-caret`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/page-seam-caret`, off `5224da9`.

## The defect

`pagination.ts` anchors a mid-block page break INSIDE the block it splits
(`computePageBreaks`: `blockStart + 1 + last.endOffset`, when the last line on the outgoing page
does not end the block), so a long action beat or speech renders as two runs of text with the
break widget between them. A writer who clicked at the visual start of page 2 -- the incoming
sheet -- saw the caret appear at the end of page 1 instead. The defect is one-sided by
construction: the widget decoration's `side: 1` always renders the selection at the upstream DOM
anchor, whichever pixel the writer actually clicked.

## The spike, and what it measured

Before any code was written, a spike drove the real editor in a real browser and measured five
things (recorded in full in the module header of `apps/web/src/seamCaret.ts`):

1. The seam is ONE document position with two DOM realizations. `posAtDOM` from the text node
   before the widget and from the text node after it return the same integer under either bias --
   a widget decoration consumes no document range, so there is genuinely only one position. This
   is caret affinity, not two positions.
2. `posAtCoords` for a click at the top of page 2 returns that same position -- there is no
   downstream position for it to resolve to -- and ProseMirror then renders the selection at the
   upstream DOM anchor.
3. Setting the DOM selection to the downstream node holds for one frame and is rewritten back
   upstream by ProseMirror's own selection sync, with no dispatch involved. A click handler that
   moves the DOM selection is therefore not durable.
4. Flipping the break widget's decoration `side` from `1` to `-1` makes a downstream click stick,
   but only inverts the defect (the end of page 1 then renders downstream) and is a global choice
   that cannot express which side a particular writer meant.
5. Keyboard navigation across the seam is unaffected: Right and Down both walk it cleanly. Only
   pixel-coordinate clicks at the boundary are wrong.

**Finding 5 needs a caveat this document exists to record.** The owner test-drove the branch after
the spike and found the caret _moves_ correctly on Right/Down but _renders_ wrongly: arrowing right
at the seam lands the caret after the consumed wrap-space at the end of page 1 rather than at the
start of page 2, wasting a keystroke. He decided a further, per-motion affinity rule is needed
(horizontal motion draws downstream, vertical motion stays upstream, clicks decide by the incoming
sheet's paper edge as already built) -- but treated it explicitly as a second, separate slice: "the
click behaviour and the keyboard affinity are two fixes." **This slice is the click behaviour
only.** The keyboard-affinity half is not implemented here and is not this document's scope; see
"Known limitations" below.

## The two options, and why the owner chose the one that stands

**Rejected: flip the break widget's decoration `side` from `1` to `-1`.** This makes a click on the
incoming sheet resolve correctly -- but a click at the end of page 1 then renders on the incoming
sheet instead, which is the identical defect moved to the other side. `side` is one value shared by
every reader of the document; it cannot encode "the writer meant the downstream side of _this_
click" without also changing what every other reader sees. The owner's own words: "selection at the
edge of overflow should be the same whichever side of the overflow you are on" -- a global flip
trades one broken side for the other rather than fixing either.

**Chosen: leave ProseMirror's real selection alone; draw a second, cosmetic caret.** The real
selection stays exactly where finding 2 says it already renders -- upstream, untouched, one
document position. When a click says the writer meant the downstream side, the native caret is
suppressed for that one block (a `caret-color: transparent` node decoration, scoped to the block
hosting the seam) and a caret is drawn as an absolutely positioned `div` appended to
`.editor-region`, positioned from the browser's own collapsed-range rectangle for the downstream
DOM position. This is cosmetic _by construction_, not by hope: both sides of the seam are the same
document position (finding 1), so text typed at either renders identically in the canonical
screenplay, `canonical_hash`, a save, and an export. Nothing downstream of this module can observe
which side was drawn.

Three properties fall out of that choice and are asserted, not just claimed:

1. **Nothing enters the document.** Every transaction this module dispatches carries no steps, the
   same way `smartTypeGhost.ts`'s dismiss and `paginationExtension.ts`'s repagination do, so no
   save ever fires from drawing or clearing the caret.
2. **The drawn caret takes no part in layout.** `position: absolute` inside `.editor-region`
   (already `position: relative`, already the scrolling element) keeps it outside `.page`'s box
   tree entirely. This overlay-displaces-the-manuscript defect class has been fixed four times in
   this codebase; the e2e test measures it rather than asserting it.
3. **The suppression is exactly co-extensive with the drawing.** The `caret-color: transparent`
   class exists on the seam's block only while a caret is drawn for it, guaranteed by the
   invariant that a caret is only ever drawn while the real selection is an empty selection at
   exactly the position being drawn.

## What was already built when this agent picked up the slice

A previous agent had written the whole feature, uncommitted: `apps/web/src/seamCaret.ts` (the
plugin), the one-line mount in `App.tsx`, the two CSS rules in `styles.css`, and a large e2e test
in `page-rendering-persistence.spec.ts` covering all four owner-required behaviours. It had left
two `console.log('DIAG...')` statements in the plugin and a matching console forwarder in the spec,
and its last recorded words were "Now the geometry/behaviour test in a real browser" -- meaning the
test had not been run to green.

## What this agent did

**Established ground truth first.** Built the whole workspace, installed Playwright's Chromium
(twice -- see "Environment notes" below), and ran the new test before touching a line. It failed,
not on the `console.log` calls themselves but on the fourth and final assertion block: the second
click at the seam (behaviour 3, "drawn again, then cleared by focus leaving the manuscript") never
drew a caret at all.

**Root-caused it with the DIAG output already in place**, then went well past it once the DIAG
output turned out to be insufficient on its own (it never fired at all for the failing click,
which was itself the first real signal). The investigation, in the order it actually happened:

1. The very first run failed on an unrelated harness bug in the test-runner script this agent wrote
   to drive the persistence config outside its normal `pnpm test:system:persistence` wrapper: it
   inherited the real `RESEND_API_KEY`/`MAIL_FROM_ADDRESS` from `.env`, so the server selected the
   real Resend mail port instead of the system-test logging mailbox `verifyEmail` reads, and (worse)
   placed one real HTTP call against the production Resend API with a synthetic `@example.test`
   recipient before the fix. Fixed by explicitly unsetting both after building the admin connection
   string. Not a product defect; flagged here for the record since it involved a real credential.
2. With that fixed, the click that should draw the caret produced _no_ `DIAGCLICK` output at all --
   meaning `handleClick` itself was never invoked by ProseMirror for that click, even though the
   native `click` DOM event demonstrably fired (confirmed with a temporary capture-and-bubble-phase
   listener). Reading `prosemirror-view`'s own `handlers.mousedown`/`isNear` explained why:
   `page-rendering-persistence.spec.ts` clicks the _identical pixel_ twice in a row (once to draw
   the caret, once again after `ArrowLeft`), and prosemirror-view treats two clicks within 500ms of
   each other and 10px of each other as a double click -- routed to `handleDoubleClick`, which this
   feature does not implement, never reaching `handleClick` at all. A real writer's two clicks here
   are seconds apart, not milliseconds; the test's back-to-back scripted clicks are not.
3. Waiting past that 500ms window (`page.waitForTimeout(600)`) made `handleClick` fire, but the
   caret still did not draw: `state.selection.from` inside the plugin did not match the position
   `handleClick` had just computed. Measured directly against `window.getSelection()` (bypassing
   ProseMirror entirely): the browser's own native selection genuinely never moved for this click --
   confirmed reproducible, and confirmed fixable by two independent, unrelated changes tried in
   isolation: (a) manually placing a `Range` at the target coordinate via
   `document.caretRangeFromPoint` before the real click, and (b) giving the synthetic click a
   non-zero `mousedown`-to-`mouseup` duration (`{ delay: 80 }`) instead of Playwright's default,
   effectively instantaneous click. (b) is the one that matters: `page.mouse.click()` with no
   `delay` does not reproduce a real click's timing, and this specific position -- immediately
   downstream of a just-rebuilt, non-editable widget decoration -- is exactly where that gap in
   realism showed up. A real mouse click always has non-zero duration; this was never something a
   real writer's click could hit.
4. To be certain (rather than assuming) that the delay fix and not some product change was what
   fixed it, the plugin code was reverted to byte-identical with what the previous agent had left
   (minus the two `DIAG` lines) and the test re-run three times clean. **`seamCaret.ts`'s
   implementation needed no change.** The defect was entirely in how the test drove the browser.

**The fix, entirely in `page-rendering-persistence.spec.ts`:** `page.waitForTimeout(600)` before
each of the two repeat clicks at the seam (past prosemirror-view's 500ms same-pixel double-click
window), and `{ delay: 80 }` on those same two clicks (a realistic mousedown-to-mouseup duration).
Neither weakens an assertion; both make the simulated input closer to what a real mouse produces.
The two earlier clicks in the test (end of page 1, first click on the incoming sheet) were left
unchanged since they do not exhibit either issue -- verified by three consecutive clean runs before
touching them and after.

**Removed all debug scaffolding.** Both `console.log('DIAG...')` calls in `seamCaret.ts` and the
`page.on('console', ...)` forwarder in the spec. `grep -n DIAG` across both files now returns
nothing.

**Added `apps/web/src/seamCaret.test.ts`** (new -- this was the one layer module missing a unit-test
sibling). Follows `paginationExtension.test.ts`'s conventions closely: a real `Editor` built from
`screenplayExtensions` plus `PaginationExtension` plus `SeamCaretExtension`, a real mid-block seam
produced by the real pagination plugin (the same `speechSplitBlocks` fixture
`paginationExtension.test.ts` already uses, not a hand-picked position), and `setSeamCaretDownstream`
driving the plugin's state machine directly rather than simulating a click (jsdom has no font
metrics, so `SeamCaretView.sync`'s DOM measurement -- and therefore the drawn caret's actual
geometry -- is deliberately left to the e2e suite; these tests cover the state machine and the
decoration only). Eight tests: records the seam position and decorates its block; clears both on an
explicit `undefined`; the suppression decoration's node range is exactly the seam's own block and
no other; an edit clears it even when engineered so the selection lands exactly back where it
started (isolating `tr.docChanged` from the separate selection-based clearing rule); a selection
move with no document change clears it; losing focus clears it; a same-frame no-op transaction of
the exact shape `paginationExtension.ts` dispatches every frame does not clear it; and a no-op when
nothing was ever drawn.

## Mutation-testing report

Six mutations, each introduced into `seamCaret.ts`, confirmed to break the corresponding test(s),
and reverted. All six were caught; none survived.

| #   | Mutation                                                                                      | Result                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Dropped `tr.docChanged` from the clearing condition                                           | Killed -- "an edit clears it..." (only after a first attempt at this test was found to pass for the wrong reason -- see below)                                                    |
| M2  | Dropped `!selectionIsAtSeam(...)` from the clearing condition                                 | Killed -- "a selection move away from the seam clears it..."                                                                                                                      |
| M3  | Disabled the `blur` handler's clearing call                                                   | Killed -- "losing focus clears it"                                                                                                                                                |
| M4  | Removed the no-op-transaction preservation branch entirely (any non-meta transaction cleared) | Killed -- "a same-frame no-op transaction... does not clear it"                                                                                                                   |
| M5  | `suppressionDecorations` decorated the whole document instead of the seam's block             | Killed -- three tests: "records the seam position...", "lands the suppression decoration...", and the no-op-preservation test (whose own assertion checks the decorated block id) |
| M6  | The meta branch's explicit `downstream: undefined` no longer cleared state                    | Killed -- two tests: "clears the recorded position..." and "losing focus clears it" (which routes through the same code)                                                          |

**M1 initially survived, and the test was wrong, not the mutation.** The first version of "an edit
clears it" inserted a character _before_ the seam position. ProseMirror auto-maps the current
selection through a transaction's own steps, so that insertion moved the mapped selection away from
`downstream` too -- meaning the mutated code (missing the `docChanged` check) still cleared the
state, just via the _other_ half of the `||`, and the test could not tell the two clearing rules
apart. Rewritten to insert _after_ the seam (at the end of the document) instead, where mapping
leaves a position before the insertion point -- exactly where the selection already sits --
untouched. That isolates `tr.docChanged` as the only thing this specific transaction could be
clearing state on, and the mutation is now killed. This is exactly the class of vacuous test this
codebase has been bitten by before (see `progress/element-menu.md`'s M6/M12/M16); it was caught here
by mutation testing rather than by review, which is the entire reason to do it.

## Gate results (all from the worktree, repo root unless noted)

1. `pnpm lint` -- clean, exit 0.
2. `pnpm format:check` -- clean.
3. `pnpm typecheck` -- clean across every package and both apps.
4. `pnpm test` -- clean; `apps/web` 458 tests (450 + this file's 8), every other package unchanged.
5. `pnpm check:bundle-budget` -- unchanged from before this slice (this slice touches no production
   bundle code beyond what was already built).
6. `pnpm build && pnpm exec playwright test -c playwright.persistence.config.ts
apps/web/e2e/page-rendering-persistence.spec.ts` -- the seam-caret test: **5/5** across every run
   in this session, standalone and as part of the full file. The full file: 7/7 clean on two of
   three runs; the third run's one failure was `an open element menu moves no line and no page...`
   (a _different_ test, `elementMenu`'s own geometry assertion, line 1091), which passed both
   standalone and on the very next full-file run -- a flake unrelated to this slice, not touched.

Exact numbers and verbatim gate output are in the implementing agent's final report to the session
that dispatched this work, not duplicated here.

## Environment notes (worth recording, not project-specific)

Playwright's own Chromium/`chromium-headless-shell` installer hung mid-extraction twice in this
sandbox, each time after a fully-downloaded zip sat untouched for many minutes with no further
disk writes. Both times, killing the installer and extracting the already-complete temp zip with
`ditto -x -k` (plus a manually-written `INSTALLATION_COMPLETE` marker) produced a working browser in
under a second. Whatever the installer's own unzip step was doing, it was not simply slow.

## Known limitations / things not done

- **The keyboard-affinity half of the owner's decision is not implemented.** Per-motion caret
  affinity (horizontal motion draws downstream at the seam, vertical motion stays upstream) is a
  second, explicitly separate fix the owner named after test-driving this branch; this slice is the
  click behaviour only, exactly as scoped. Finding 5 in the module header ("Keyboard navigation
  across the seam is unaffected") is consequently known to be incomplete as a description of
  today's behaviour -- the caret _moves_ correctly on Right, but _renders_ at the wrong end of the
  seam -- and should not be read as settled.
- **The pre-existing flake this file's own header comment warns about** (`plan.md`: "reproduces
  roughly 2 runs in 3, same assertion each time," an "immediate read" assertion around this spec's
  own line 331/418) was not encountered in this session's runs and was not investigated further; it
  is a different, already-known issue and out of this scope regardless.
- **The `elementMenu` geometry flake** encountered once during this session (see gate 6 above) is
  newly observed, not previously documented, and was not investigated -- it did not reproduce
  standalone or on a repeat full-file run, and `elementMenu.tsx`/`elementMenu.test.ts` were not
  touched by this slice.
