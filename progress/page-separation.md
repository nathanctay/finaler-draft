# Page separation

Branch `feature/page-separation`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/page-separation`.

## The defect

`plan.md`'s "Page presentation" opens with "**Discrete separated pages are the default.** A writer
sees individual 8.5 by 11 inch pages with visible boundaries between them, in the manner of
Microsoft Word." That is not what the product renders, and the gap is recorded in that same section
under "Not yet true: discrete pages do not currently look separated."

The owner's description, which is the acceptance criterion: there _is_ grey between pages, but
"because of the shadow on the edges it is clearly part of the white pages above and below it. It
does not look like the gap between the title page and page 1."

**The title page gap is the target.** `.title-page` and `.page` are separate elements, each with its
own `box-shadow`, separated by the flex gap on `.editor-region` -- so that boundary already reads as
two sheets. Body page boundaries must look the same.

## Why it looks wrong, and the constraint that caused it

Every body page is drawn by a **single** `.page` element carrying a repeating gradient (white for
one page height, then `--surface-11` for the gap, repeating) with **one** `box-shadow` around the
whole stack. The shadow therefore wraps the outside of the entire run of pages, and the grey band is
an interior stripe rather than a gap between two shadowed sheets.

The single element is deliberate and must be preserved: **the manuscript is one contiguous flow**,
because selection, cursor movement and undo have to work across a page boundary. Splitting into a
DOM element per page would break all three.

**The owner has explicitly approved visual tricks here**: it does not need to actually be separated
as long as it convincingly appears to be.

## The mechanism, already worked out

Each break already renders a widget (`apps/web/src/pagination.ts`, `buildPageBreakWidget`) containing
a spacer of height `spacerHeightIn`, and that spacer already anchors the incoming page number
absolutely. `spacerHeightIn = page.bottomMarginIn + PAGE_GAP_IN + MARGIN_TOP_IN`, so within the
spacer:

- `0` to `bottomMarginIn` -- the rest of the outgoing page (white)
- `bottomMarginIn` to `+ PAGE_GAP_IN` -- **the gap**
- the remaining `MARGIN_TOP_IN` -- the incoming page's top margin (white)

So the gap begins at `spacerHeightIn - PAGE_GAP_IN - MARGIN_TOP_IN` from the spacer's top and is
exactly `PAGE_GAP_IN` tall, derivable from values the widget already computes.

Two things this implies:

1. The seam element must be **full page width**, and the spacer lives inside `.script-body`, within
   `.page`'s padding box. Break out with negative offsets against `--fd-page-margin-left` /
   `--fd-page-margin-right`, the way `.page-break-number` already positions itself against
   `--fd-page-number-right`.
2. **The widget decoration key must encode everything the widget draws.** This is a trap this
   codebase has already been bitten by: ProseMirror reuses the DOM for an unchanged key, and a
   stale spacer once left page frames a line off. The key already includes `spacerHeightIn`; if the
   seam introduces any other rendered value, it goes in the key too.

## What this must achieve

- A body page boundary reads as the bottom edge of one sheet and the top edge of the next, with the
  gap reading as the canvas behind them -- comparable to the title-page boundary.
- **Nothing about layout moves.** No line position, no page count, no break position, no margin
  changes. This is paint only. `page-rendering-persistence.spec.ts` already asserts a page frame
  never moves when content reflows; it must stay green untouched.
- Works in both light and dark mode, using existing tokens rather than new hardcoded colours.
- Continuous-scroll mode still removes the drawn page edges, per `plan.md`: that toggle is
  presentation only and must not gain or lose anything else.
- The last page and the first page keep their own outer edges looking correct.

## Out of scope

Splitting the manuscript into per-page DOM elements. Any change to `packages/layout` or to break
positions. Zoom behaviour beyond not breaking it. The `(MORE)`/`CONT'D` weight inconsistency the
owner also reported -- that belongs to the writing-flow slice.

## Verification

The full gate list, `pnpm format:check` after the progress entry, and the persistence gate three
times.

This is a visual change, so **look at it**: render it in a real browser and capture a screenshot of
a boundary, at both light and dark mode, and confirm against the title-page boundary rather than
against your own description of what you drew.

`apps/web` serves a **built** bundle, so rebuild before any browser check or browser-level mutation
test -- a CSS edit that has not been rebuilt will look like it changed nothing, and a mutation will
look uncaught when it is not. This has already cost time twice on this project.

For every test guarding specific behaviour: break it, confirm it fails, restore, report it.

No credential may appear in any file you write.

## Rules

Do not stage, commit, merge, rebase, force-push, reset, or create or delete branches or worktrees.
No TODO or placeholder comments, no emojis, strict TypeScript, `.js` extensions on relative imports.
Record _why_, citing `plan.md`.

## Checkpoints -- SendMessage to the lead

1. After the seam renders, with a screenshot path for a boundary in both themes, before polishing.
   **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

### 2026-08-22 — the seam, in two iterations (agent)

Shipped: body-page boundaries now read as two shadowed sheets with canvas between them, matching
the title-page/page-1 boundary the owner named as the target. Two files changed, both additive --
no existing geometry, break position, or margin arithmetic touched:

- **`apps/web/src/pagination.ts`** -- `buildPageBreakWidget` now appends two `.page-break-edge`
  divs into the spacer (`page-break-edge-outgoing`, `page-break-edge-incoming`), each holding one
  `.page-break-edge-caster` child. Both edges' positions are set via a `--fd-page-break-edge-top`
  custom property (not `style.top` directly, so styles.css's incoming-edge rule has something to
  `calc()` against) computed as `spacerHeightIn - PAGE_GAP_IN - MARGIN_TOP_IN` (outgoing) and
  `spacerHeightIn - MARGIN_TOP_IN` (incoming) -- both pure functions of `spacerHeightIn`, which the
  decoration key already includes, so **the key needed no change**. No other rendered value feeds
  either position.
- **`apps/web/src/styles.css`** -- `.page-break-edge` is a small (10px) `overflow: hidden` mask;
  `.page-break-edge-caster` inside it is a 40px-tall box carrying `.page`'s and `.title-page`'s own
  `box-shadow: 0 1px 5px var(--shadow-02)`, positioned so only the one edge flush with the physical
  boundary ever falls inside the mask's clipped strip. `.page.continuous .page-break-edge` is
  `display: none`, so continuous mode draws no page edges at all, unchanged from before.

#### Why two iterations

**First attempt** (checkpoint 1): a single hairline per edge (`height: 1px`, later corrected from
an initial `height: 0` that Chrome does not paint at all -- verified directly, an isolated 0-height
box-shadow line rendered nothing while the identical rule at 1px rendered a hairline). This
produced a visible seam in both themes and passed a side-by-side comparison the agent ran itself,
but the lead's review (comparing crops at the same scale) caught what the agent's own comparison
missed: light mode's falloff was flatter than the title-page reference's, even though both used the
identical `box-shadow` value. The lead's diagnosis, given before the agent had a chance to
investigate: a box only ~1px tall is a blurred point source, not a blurred edge, and cannot produce
a sheet-edge falloff regardless of the shadow value -- the fix is a taller invisible caster, not a
darker colour.

**Second attempt**: the mask+caster technique described above. Verified pixel-for-pixel against the
real title-page boundary (same built CSS, same browser): sampling a vertical strip through both
boundaries produced **identical** RGB sequences at every step of the falloff on both edges
(170,178,182 → 216,221,224 and the reverse), not merely visually similar.

**Verification note on the harness itself.** Both iterations were first checked with a static HTML
harness (real built CSS and hand-authored markup mirroring `buildPageBreakWidget`'s output) rather
than the real editor, calibrated so a fixed-height filler div made the `.page` background
gradient's own white/grey transitions land exactly at the widget's computed edge positions. The
lead correctly flagged this as a simulation whose calibration could hide the exact defect it was
meant to reveal, and verified the final result independently against the real editor instead (a
temporary spec against `playwright.persistence.config.ts`, since that config is the only route to a
real signed-in writer with a real multi-page screenplay open in the real editor -- see
`persistence.spec.ts`'s own comment on why). That confirmed the geometry holds in the real app: real
page number, real manuscript text, same two-sheets-with-canvas-between reading in both themes. The
lead removed the temporary spec and reverted the config change afterward.

#### Mutation-testing report

Every mutation below was applied, rebuilt (`pnpm --filter @finaler-draft/web build` -- necessary
every time, since `apps/web` serves a built bundle and a CSS edit that has not been rebuilt looks
like it changed nothing), checked in a real browser, then restored and diffed byte-identical against
the pre-mutation file.

1. **Zero-height edge instead of 1px** (found during the first iteration, not asked for): rendered
   nothing at all in a real Chrome build. Kept as the module comment's own explanation for why
   `height: 1px` was the starting point, superseded by the mask+caster technique.
2. **Caster height reduced from 40px to 2px** (below the 5px blur radius, at the lead's request):
   reproduces the original flat-hairline defect exactly. Sampled the same pixel column used for the
   pixel-for-pixel comparison above: the falloff's darkest point measured (192,198,202) against the
   healthy seam's (170,178,182) and the real title-page reference's (170,178,182) -- visibly weaker,
   confirming this mutation regresses to the defect the mask+caster technique exists to fix.
3. **`overflow: hidden` removed from the mask** (at the lead's request): the caster's far edge, no
   longer clipped, casts a stray shadow line well inside the page's actual content -- roughly 40px
   above the true boundary on the outgoing side and 40px below it on the incoming side, both clearly
   inside what should be plain white page. Visually obvious in a screenshot.

**No automated test caught either of the lead's two requested mutations, or would catch a
regression in this shadow technique generally.** Nothing in `pagination.test.ts`,
`page-rendering.spec.ts`, or `page-rendering-persistence.spec.ts` references `.page-break-edge` or
`.page-break-edge-caster` -- the only verification this technique has is the pixel-sampling done by
hand for this entry and the screenshots exchanged at checkpoints. This is a real gap, not an
oversight glossed over: see "Known limitations" below.

#### Gate results

1. `pnpm typecheck` -- clean.
2. `pnpm lint` -- clean, `--max-warnings=0`.
3. `pnpm test:coverage` -- clean, all packages. `apps/web`: 314 tests, `pagination.ts` at
   98.3%/93.44%/100%/98.3% statements/branches/functions/lines (unchanged uncovered lines are
   pre-existing, not touched by this change).
4. `pnpm build` -- clean.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 22/22 passed.
6. `PLAYWRIGHT_CHANNEL=chrome TEST_DATABASE_URL=... pnpm test:system:persistence` -- run **eleven**
   times total across this session (see "Known limitations" for why more than three), including
   after the final restore. The two `page-rendering-persistence.spec.ts` tests that actually
   exercise multi-page pagination -- and therefore this change's code -- passed in every single run,
   11/11. See below for the one test that did not.
7. `git diff --check` -- clean.
8. `pnpm format:check` -- run after this entry was written and confirmed clean; see the note at the
   very end of this entry.

#### Known limitations / things not done

- **The shadow-falloff technique has no automated regression test.** It is verified by hand
  (pixel-sampling a screenshot against a reference) in this entry and was checked visually at both
  checkpoints, but nothing in the test suite would catch a future refactor reintroducing the
  flat-hairline defect or removing the mask's clipping. A future slice could add a real-browser
  pixel-sampling assertion (comparing a sampled point on the seam against a sampled point on the
  title-page boundary, the same technique used for verification here) if this is judged worth the
  ongoing cost of a pixel-level visual test.
- **The persistence suite is not isolated per spec (the lead's finding, recorded here per their
  request).** While the lead's temporary verification spec was present in
  `playwright.persistence.config.ts`, `persistence.spec.ts`'s paste test failed; with the spec
  removed, three consecutive runs were 11/11. Adding a spec to that config can destabilise the
  existing ones through shared database state. The next person adding a persistence spec should
  expect this rather than suspect their own change first.
- **A second, separate flakiness source in the same test, observed independently.** Across this
  agent's own eleven runs of the persistence gate (all after the lead's spec and config edits were
  already reverted -- this repo's own state, not a leftover from their verification),
  `persistence.spec.ts:229` ("pasting content copied from this editor back into the same document
  regenerates ids and keeps saving") failed five times and passed six, always with the same symptom
  (`toHaveCount(2)` receiving `1` -- the paste read back stale or empty clipboard content). This
  test's own comments already document its history of async-OS-clipboard timing flakiness under
  this runner. It is mechanistically impossible for this change to cause it: the test's document is
  four short blocks, never long enough to paginate, so `computePageBreaks` returns an empty array
  and none of `buildPageBreakWidget`'s code -- including everything added in this slice -- ever
  runs. Every other test in every one of the eleven runs, including both real-editor pagination
  tests, passed every time. Worth flagging as its own reproducibility concern for this suite,
  distinct from the lead's DB-isolation finding above, since a ~45% failure rate on one specific
  test is high enough that the next person hitting it may reasonably suspect a real regression
  before reading this note.
- **The `(MORE)`/`CONT'D` weight inconsistency** the owner also reported is explicitly out of scope
  for this slice (see "Out of scope" above) and remains unaddressed.
- Zoom behaviour, `packages/layout`, and break positions were not touched and were not expected to
  need to be; the persistence gate's repeated green runs on the two pagination-specific tests are
  the evidence for that, not merely an assumption.

`pnpm format:check` run after this entry was written, confirmed clean, no further edits to this
file afterward.

### 2026-08-22 — the seam got a regression test (lead)

The implementation agent honestly recorded that nothing in the suite referenced `.page-break-edge`
or `.page-break-edge-caster` -- the seam was verified by eye at the checkpoints and by mutation, and
by nothing that would run again. That is the same shape of gap that let `.save-dot.attention` sit
with no CSS rule at all for months while the class was dutifully applied: a purely visual property
with no automated guard, invisible to every green run.

`page-rendering.spec.ts` now asserts the two structural properties the seam's appearance actually
depends on, chosen because both are exactly the mutations that were shown to break it visibly:

- **The mask clips.** Without `overflow: hidden` the caster's far edge escapes and paints a stray
  shadow line roughly 40px inside the page content on both sides.
- **The caster stays tall relative to the blur radius.** A box near the height of the boundary line
  is a blurred _point_ source rather than a blurred _edge_, and renders a visibly flatter falloff
  than `.page`'s own shadow no matter what box-shadow value it is given. This is not a hypothetical:
  it was the first attempt at this feature and the reason it needed a second iteration.

The blur radius is parsed back out of the computed `box-shadow` rather than restated in the test, so
retuning the shadow does not silently invalidate the assertion that the caster is tall enough for it.

Computed styles rather than a screenshot baseline: this catches both regressions deterministically,
without a golden image that would need regenerating on every unrelated visual change and that nobody
would trust after the third such regeneration.

**Mutation-tested, both ways, each with a rebuild first:** removing `overflow: hidden` fails the new
test by name; setting the caster height to 2px fails it by name. Restored and `diff`ed byte-identical
against the pre-mutation stylesheet afterwards.

**On the flaky persistence test.** The implementation agent measured `persistence.spec.ts:229` (the
OS-clipboard paste test) failing 5 of 11 runs. I measured it independently at 1 of 8, and 3 of 3
clean before that -- roughly 1 in 11. Both are real observations; the rate evidently varies with
machine load. The agent's mechanistic argument that it is unrelated to this change is sound: that
test's document is four short blocks and never paginates, so `buildPageBreakWidget` never executes
at all. It is a genuine flake inherited from the paste slice, whose own progress entry already
recorded async-clipboard timing trouble under this runner, and it wants its own attention rather
than being folded into this one. Recording both measured rates rather than either alone, because a
single sample here would misrepresent it in whichever direction it was taken.

### 2026-08-22 — the gap still had shadows on its sides (lead)

The owner reviewed the seam and reported it "slightly better, but theres still shadows on the sides
of them making them visibly separated from the background". Correct, and the cause was one the
earlier screenshots could not show: every capture had been clipped to the page's own width, so the
region where the defect lived was outside the frame each time.

**`.page` is a single element spanning every page, so its box-shadow runs continuously down the
column's left and right edges -- straight through each gap.** The gap's colour was already right:
the gradient paints it `--surface-11`, the exact token `.editor-region` uses for the canvas. What
gave it away was the paper's own side shadow bridging the two sheets, which read as a stripe on one
long sheet rather than canvas between two.

Fixed with a `.page-break-gap` cover, appended before the two edge masks so their shadows paint over
it in DOM order with no z-index: canvas-coloured, `--fd-page-gap` tall, positioned at the same
boundary the outgoing edge uses, and extended 8px past both page margins -- more than the 5px blur
radius of `.page`'s shadow, since anything less leaves a sliver of it surviving at each side. Hidden
in continuous mode, where there are no page edges for it to sit between and it would otherwise paint
a canvas-coloured band across an unbroken sheet.

Derived from `spacerHeightIn` like the edges, so the decoration key still needs no change.

**Verified in the real editor at a width that includes the canvas either side of the page** -- the
framing the earlier checks lacked. Two sheets, clean canvas edge to edge between them, page number
and manuscript text on the incoming page.

The lesson worth keeping: a visual defect at the boundary of an element will not appear in a
screenshot clipped to that element. Capture wider than the thing under test.
