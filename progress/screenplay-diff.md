# Collaboration slice 4b: the screenplay-aware diff

Branch `feature/screenplay-diff`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/diff`,
off `01ad48c` (current `main`, slice 4a merged).

## Why this scope exists

Slice 4a (`progress/collaboration-revisions.md`) built durable, immutable `document_revisions` and
read-only historical preview. `plan.md`'s "Collaboration, history, and restoration" bundles revision
history, a screenplay-aware diff, and restore-as-current into one phase but is explicit that they are
separate deliverables built in sequence. This slice is the diff: a pure function comparing two
canonical screenplays, a route that serves it for two real, stored revisions (or a revision against
the screenplay's current live content), and a dedicated, read-only view. **Restore-as-current is not
built here** — nothing in this slice creates a `restore` revision, cuts an epoch, or offers a "make
this current" action. It is slice 5's epoch cutover, explicitly last in `plan.md`, and this slice only
makes sure the comparison that restore's own preview step needs is already available.

## The view was redesigned: the document, with changes marked in place

The first version of this slice's view was a nested-list change **report**: a `<section>` for document
settings, one for the title page, then a `<ul>` of scenes each holding a `<ul>` of changed blocks. The
owner rejected it, in these words:

> "I don't really like the 'compare to current' page. It is not something that is easily readable by a
> person. I like how google drive or github does it where it shows the changes on the document, but
> highlights whats been added or removed."

He was right, and the reason is worth stating precisely rather than treating this as a taste
disagreement. A change report never shows the reader the screenplay. It shows fragments, grouped by a
structure (scene → block) that is not the structure the reader thinks in (page → line), with every
unchanged line — most of the document, and all of the context that makes a change mean anything —
omitted entirely. To understand "dialogue changed: `I waited by the window.` → `I waited by the
doorway.`" a reader has to find that speech in their head, place it in its scene, and recall what came
before it. That is work the diff should have done for them.

**What it renders now.** The screenplay, in document order, as a screenplay: the real element indents
and measures, the real inter-element line spacing, scene headings and character cues at their real
weight — every line of it, unchanged lines included — with additions, removals, changes and moves
marked in place. One continuous read, the way Google Docs' suggested-edits view and GitHub's unified
diff both work.

The **newer** document is the spine, because that is the screenplay as it now stands. Removed content is
re-inserted into that spine immediately after the surviving line it used to follow — the same rule a
unified diff uses for a deleted line. (Anchoring to the _preceding_ survivor rather than the following
one matters in one case this feature has to get right: when the line after a deletion belongs to a scene
that was relocated to the far end of the script, a following-survivor rule drags the deletion across the
whole document to sit beside its old neighbour's new home.)

**Where the new code lives.** The diff engine is unchanged apart from the one addition below:
`diffScreenplays` is still the single source of truth for what changed, and move detection and scene
grouping were not touched. Two new modules:

- `packages/screenplay/src/textDiff.ts` — the word-level intra-block diff (below). Pure, schema-free,
  in the domain package because it is domain logic over two strings.
- `apps/web/src/inlineScreenplayDiff.ts` — `buildInlineScreenplayDiff(result)`, the pure render model:
  which side is the spine, where a removed line is re-inserted for reading, whether a moved scene's
  individual lines should each announce their own move. Those are _presentation_ decisions, they differ
  per view, and keeping them out of `@finaler-draft/screenplay` is what lets the diff engine stay one
  verified answer rather than acquiring a second, view-shaped one.

### The one engine addition: word-level intra-block text diff

`ScreenplayBlockDiffEntry.textChanged` is a boolean. That is the right granularity for deciding whether
a block is interesting and far too coarse for reading: a one-word fix in a twelve-line speech would mark
the entire speech, which is indistinguishable from having rewritten it, and leaves the reader comparing
the two texts by eye — exactly the work an inline diff exists to remove.

`diffWords(before, after): TextDiffSegment[]` returns an ordered list of `'equal'` / `'removed'` /
`'added'` segments whose equal-plus-removed parts rebuild `before` exactly and whose equal-plus-added
parts rebuild `after` exactly (both identities asserted on every comparison in the test file, not only
where a case looked risky).

**Algorithm: Myers' greedy shortest-edit-script / LCS** (Eugene W. Myers, "An O(ND) Difference Algorithm
and Its Variations", _Algorithmica_ 1/2, 1986) over **tokens**, preceded by common-prefix and
common-suffix elimination.

- **Complexity: `O((N + M) · D)` time, `O(D²)` space**, where `N`/`M` are the two token counts _after_
  trimming and `D` is the token edit distance between what remains. Cost therefore tracks the size of
  the **change**, not the size of the text. The trim is what makes the dominant real case trivial: a
  one-word edit anywhere in a block reduces to `N = M = 1`, `D = 2`, however long the block is. A plain
  `O(N · M)` dynamic-programming LCS table would have paid for the whole block every time — at
  `MAX_AUTHORED_TEXT_LENGTH` (20,000 code units, thousands of tokens) millions of cells to report one
  corrected typo. Measured, not only argued: a one-word change inside a 4,000-word block is asserted to
  complete well inside a 500 ms budget (it runs in single-digit milliseconds).
- **Word-level, deliberately not character-level.** Screenplay text is prose. Marking prose by character
  turns `Saturday` → `Sunday` into per-letter confetti that reads as noise rather than as "this word
  changed". There is no character-level mode and none is wanted.
- **Tokens carry their own trailing whitespace.** Measured against the alternative: with whitespace runs
  as separate tokens, the space between two consecutively-rewritten words is identical on both sides, so
  it is reported `'equal'` and a single rewritten phrase renders as two struck fragments with an
  unmarked gap between them. Carrying the space with its word marks a rewritten phrase as one continuous
  span. The stated cost — a spacing-only change marks the word the spacing follows — is recorded in its
  own test rather than only in a comment.
- **`MAX_WORD_DIFF_EDIT_DISTANCE = 256`**, past which the comparison degrades to a wholesale
  replacement of the trimmed middle. Myers' greedy variant keeps one frontier per `d`, which is the
  `O(D²)` term; unbounded, two different 20,000-code-unit action blocks with nothing in common would ask
  for tens of millions of frontier entries to tell a reader something they can already see (the block was
  rewritten). Any comparison whose two trimmed token counts sum to no more than the bound is answered
  exactly, so a whole rewritten _line_ — tens of tokens — is still reported word by word. The fallback
  keeps the shared prefix and suffix equal, so even the degraded answer never over-reports.

### Moves stay moves

A relocated scene is rendered as **a marker at each end** — "Scene moved from here: EXT. ROOFTOP - DAWN
was scene 2, now scene 3" where it used to be, and "Scene moved to here: …" immediately before the scene
at its new position — with the scene's own lines left completely unmarked.

Why that reading, and not delete-plus-add: a relocated scene is the one thing this codebase's diff knows
that neither reference tool does, detected from `plan.md`'s stable block ids via the
longest-increasing-subsequence backbone described above. Rendering it as a deletion plus an insertion
throws that answer away and hands the reader the harder problem instead — two large, unrelated-looking
blocks of marked text that must be read in full and compared word by word before the reader can discover
they are the same scene, and in a long relocation those two blocks may be dozens of lines apart. Two
marker rows cost two lines, name the scene, and state both positions; the reader learns the scene is
intact and only its position changed without reading it twice. Leaving the scene's lines unmarked is also
simply _true_: nothing in them changed.

The same reasoning extends one step further. Every block inside a relocated scene is flagged `moved` in
the document-wide block diff — correctly, their document positions did change — but restating that on
each of them would bury "this scene moved" under a wall of individually-moved lines. The view suppresses
per-block `moved` for blocks inside a scene that itself moved, which is the identical reasoning
`ScreenplaySceneDiffEntry.blocks` was already built on. A line that moved **on its own**, with no scene
moving around it, still reports its own move (`MOVED` in the gutter), and is still never rendered as a
deletion plus an insertion.

### Accessibility: colour is never the only signal

Every marked row carries three non-colour cues, and colour is the fourth:

1. **A gutter glyph** — `+` added, `-` removed, `~` changed, plus the word `MOVED` beneath it for a
   relocated line and an abbreviated element change (`ACTION>DIAL`) where one happened. Drawn
   `position: absolute` out into the page's own left margin, so it contributes no layout at all (the
   technique `.scene-number`, `.smarttype-ghost` and `.remote-cursor` already use).
2. **A text decoration on the marked words themselves** — `line-through` for removed, `underline` for
   added. Strikethrough versus underline is legible with no colour perception whatsoever, and neither
   decoration affects layout metrics.
3. **A visually-hidden label in words** — `Added.` / `Removed.` / `Changed.` / `Moved.` /
   `Element changed from action to dialogue.` — placed first in the row's reading order, so a screen
   reader announces what the row _is_ before reading a struck-out line that is no longer in the script.

The on-page legend states the same vocabulary (glyph + word + a rendered sample of each decoration), so
the mapping is discoverable rather than something a reader has to infer. `<del>` and `<ins>` are used
rather than styled `<span>`s, so assistive technology that surfaces them does so without this view
inventing an ARIA vocabulary. `apps/web/e2e/screenplay-diff-persistence.spec.ts` reads the computed
`text-decoration-line` of both, the gutter glyph of each mark, and confirms the gutter paints entirely
left of the text.

### Reusing the real screenplay geometry, without the editor

The sheet reuses the editor's own containers and rules verbatim: `.pages` → `.page` → `.script-body`,
with each row as a `<div data-screenplay-block data-screenplay-element="…">` — the exact tag and
attributes `ScreenplayBlockNode.renderHTML` emits (`packages/screenplay-editor/src/index.ts`). Every
indent, measure, inter-element blank-line margin, and the scene-heading/character-cue weight therefore
come from `styles.css`'s existing manuscript rules, fed by `pageGeometryCssVariables`'s projection of
`@finaler-draft/screenplay/pageFormat` — the same single authority the editor and the PDF path read.
There is no parallel set of indents anywhere in this view, and no page-format figure is restated in its
CSS. `applyPageGeometryCssVariables` is applied to this subtree's own root (not the document element)
with the **newer** side's `documentSettings`, since the newer document is the spine.

**No editor, and no editor chunk.** Nothing this route imports reaches Tiptap, a `Y.Doc`, a
`HocuspocusProvider`, or the pagination plugin. The lazy editor chunk measures **144.72 kB gzip,
byte-identical to `main`** — see the gates below. That required one deliberate decision: the comparison
view's zoom presets are defined locally rather than imported from `zoom.ts`. `zoom.ts` is reachable only
from `App.tsx` today, so it is part of the lazy editor chunk; importing two literals from it made Rollup
hoist it into a shared chunk and the editor chunk moved to 144.33 kB. The editor's bundle composition
should not change because a comparison view borrowed two constants, and the two controls are genuinely
different things anyway — `zoom.ts` models a `ZoomMode` (fixed, fit-page, fit-width) with resize
recompute, centred scroll anchoring and pointer-anchored pinch; this is a reading scale on a static
sheet. Measured both ways and recorded in the route's own comment.

**`@finaler-draft/layout` is deliberately not used.** It is the _pagination_ engine, and pagination is
the one thing this view cannot do truthfully — see the next section.

### What this view cannot do, and says so

Showing removed content inline necessarily puts more lines on the sheet than the document actually has,
so **this view's page breaks cannot match the live document's**. That is accepted: it is a reading view,
not a page-fidelity view. It is not left for a reader to discover:

- A note in the comparison header, above the sheet: _"Reading view, not a paginated script. Removed
  lines are shown where they used to be, so this comparison is longer than the screenplay and its page
  breaks are not the document's — no page boundaries or page numbers are drawn here for that reason.
  Nothing on this page can be edited, accepted, or rejected."_
- `.page.diff-manuscript` removes `.page`'s repeating page-boundary gradient and its multi-page stack
  height, so **no page boundary and no page number is drawn anywhere**. A view that cannot compute a
  truthful page boundary must not paint one. What is left is one continuous content-sized sheet at the
  real page width and the real margins.
- A summary line of counts (`1 line added, 1 line removed, 1 line changed, 1 scene moved`) above the
  read, so the reader knows the scale of what they are about to read.

Both the unit tests and the browser test assert the note's presence and wording, and that no
`.page-number` and no page-boundary background image exists on the sheet.

### Still not revision marks, and still not Track Changes

`plan.md`'s "Locked scripts" revision marks are asterisks in the **printed** margin computed against the
most recent **lock**, with frozen scene numbers and `OMITTED` scenes, and `plan.md` requires that
revision history, Track Changes and production revision sets never share one implementation or interface
state. Nothing here is reusable as one, and the view refuses to be printed at all: `.diff-print-refusal`
is hidden on screen and is the **only** thing a print renders, every other child of `.diff-screen` being
`display: none` under `@media print`. The markers are `+`/`-`/`~` glyphs in a screen-only gutter,
computed between two arbitrary revisions rather than against a lock. There is no accept or reject control
anywhere, asserted directly (`queryByRole('button', { name: /accept|reject/i })` → none), because this is
a read-only comparison of two snapshots, not Track Changes.

### Response shape: why two whole screenplays now travel with the diff

`ScreenplayDiff` reports only what is _interesting_ (`isEntryInteresting` — "what keeps a feature-length
script's diff proportional to the actual amount of change"), so an untouched block appears in it nowhere
at all. That is exactly right for a change report and exactly wrong for a document view, where the
unchanged lines between the changes are most of what the reader reads. `GET /api/screenplays/:id/
revisions/:revisionId/diff` therefore now also returns `olderScreenplay` and `newerScreenplay`, the two
canonical projections the diff was computed from.

They travel with the diff rather than being fetched separately for one reason that is not convenience:
**consistency**. With `against` omitted the newer side is the screenplay's _live_ projection, which
collaborators may be editing continuously. A client that fetched it again in a second request could
render a document that the marks beside it were never computed from, and the view would be quietly,
unreproducibly wrong. These are the exact inputs `diffScreenplays` was given, read in the same request.

The cost, stated plainly: this response now carries two whole screenplays. That is inherent to serving a
document view rather than a summary — there is no smaller payload from which the unchanged majority of a
script could be reconstructed — and it is the same order of payload the historical-preview endpoint
already returns for one. Both are validated by `screenplaySchema` itself on both sides of the wire, not
by a hand-mirrored shape.

## Where it lives, and what it reuses from 4a

The diff itself, `diffScreenplays(before, after): ScreenplayDiff`, is a new pure function in
`packages/screenplay/src/diff.ts` — the same package 4a's `measureStructuralChange` and
`computeRevisionPreviewMetadata` already live in, for the identical reason: it is domain logic over
two canonical `Screenplay` values with no database or HTTP dependency, consumed by more than one
process (`apps/api`'s route, and — via the same package — anything else that later needs to compare
two screenplays, including slice 5's restore preview).

**Reused directly, not reimplemented:**

- `flattenScreenplayBlocks` and `blockSignature` (`packages/screenplay/src/revisions.ts`) — exported
  from that module for the first time in this slice, rather than copied. `blockSignature`'s internals
  were refactored (not its output: `revisions.test.ts`'s existing assertions, run unchanged, confirm
  that) to split out a `blockComparableText` helper, because the diff needs to tell "the element type
  changed" apart from "the text changed" — two facts a single opaque signature string cannot answer on
  its own, but which the diff's per-block `changed` flag still derives from the same signature
  comparison `measureStructuralChange` already trusted.
- `deriveScenes` (`packages/screenplay/src/index.ts`) — the identical scene derivation Navigator and
  4a's structural-change trigger already use. Scene identity in this diff (a heading block's own
  stable id) is the same anchor every other scene-aware feature in this codebase relies on.
- `screenplayBlockSchema` and `titlePageSchema` — the latter newly exported from
  `packages/screenplay/src/index.ts` (the same way `screenplayBlockSchema` already was) so the API and
  web response schemas can validate a diff's block/title-page payloads against the one real
  definition of each shape, rather than a second, hand-mirrored zod schema that could drift.
- `getRevisionById` (`packages/database/src/revisions.ts`) — unchanged, used to fetch both the base
  revision and, when given, the `against` revision.
- `apps/api/src/revisions.ts`'s existing "read the screenplay's current `canonical_screenplay`" query
  was pulled out into a shared `fetchCurrentScreenplay` helper and is now used by both `createRevision`
  (4a) and the new `getRevisionDiff` (this slice), rather than duplicated.

**New in this slice:** the move-detection algorithm, the generic `diffIdentifiedSequence` primitive,
scene grouping, the `RevisionStore.getRevisionDiff` method and its route, the web diff view, and all
tests described below.

## How moves are detected, and why this algorithm

`measureStructuralChange` (4a) compares before/after by block id and detects added, removed, and
content-changed blocks — but not moves: a reordered block has an unchanged signature at a different
position, and a position-based or purely-by-id-unordered comparison reports a reordered sequence as
unrelated deletions and insertions, which is exactly the wrong answer `plan.md` warns against (stable
scene and block IDs exist specifically so "revision diffs... keep working even when content is
reordered").

The algorithm: for the ids common to both sequences (block ids, or scene-heading ids), take their
positions in the **after** sequence, read off in **before** order. The **longest increasing
subsequence** (LIS) of that list is the largest possible subset of common ids whose relative order is
identical in both sequences — the maximal "nothing here moved relative to anything else in this set"
backbone. Every id _not_ in that backbone is reported as moved.

This is the minimal-reordering explanation, not "did this item's position change since the exact same
index" (which would flag nearly everything after a single insertion near the start — inserting one
new scene at the front moves nothing by this definition, because every existing scene's order relative
to every other existing scene is unchanged). It is also, deliberately, the same idea diff tools and
UI-reconciliation algorithms already use for "what is the minimal set of moves that explains this
reordering" — not a novel technique invented for this slice.

Implementation: a standard `O(n log n)` patience-sort LIS construction
(`longestIncreasingSubsequenceIndices`), wrapped by `computeMovedIds`, which both the block-level and
scene-level comparisons call — one primitive, not two copies of the same idea at two different
granularities.

**A known, stated limitation of LIS-based move detection:** when exactly two elements swap and nothing
else distinguishes them, the LIS has more than one valid longest subsequence, so the algorithm can only
ever call _one_ of the two "moved" — the other serves as the arbitrary-but-deterministic fixed
reference point. This is mathematically inherent to the minimal-move definition, not a bug: a two-
element swap genuinely has no sound way to say "both of these moved" while still being minimal. The
integration test covering a real two-scene swap (see below) asserts on this honestly — it checks that
_some_ scene is reported moved (never deleted-and-re-added), not which specific one.

## How scene-level grouping works, and why

A screenplay's scene list is its skeleton (the same reasoning 4a's `measureStructuralChange` gives for
why any scene added or removed counts as structural on its own). A writer who reordered a sequence of
scenes wants to read "this scene moved," not reconstruct that fact from dozens of individually-moved
action and dialogue blocks. `diffScenes` builds one entry per scene-heading id present on either side
(via `diffIdentifiedSequence` over the heading sequence itself, for scene-level move detection — see
above), plus one `'preamble'` pseudo-scene for any blocks before the first scene heading (matching
`deriveScenes`'s own documented behavior for that case), when either side has any.

**Each scene's own `blocks` list is an independent diff of that scene's own before/after body**
(`sceneLocalBlocks` re-runs `diffScreenplayBlocks` scoped to just that scene's two bodies), not a
filtered slice of the document-wide block list. This was not the first design tried, and the first
design was wrong: projecting the document-wide entries by scene membership correctly identified
added/removed-from-this-scene blocks, but a block that stayed _within_ the same scene inherited the
document-wide `moved` flag — which, for a whole-scene relocation, is `true` for every block in the
relocated scene (their position in the _whole document_ changed), even though nothing moved _relative
to its neighbors inside that scene_. That buried "this scene moved" under a list of every one of its
own blocks individually marked moved too — exactly the noise this feature exists to eliminate. Running
an independent local diff on each scene's own two-sided body instead answers the question this field
exists to answer ("what changed within this scene's own boundary"), and for a pure whole-scene
relocation, correctly yields an empty `blocks` list (nothing moved _relative to its neighbors inside
the scene_) while the scene's own `moved` flag (from the heading-id LIS) still reports the relocation.
A test (`detects a reorder of blocks within one scene that itself did not move`) and the bug this
replaced are both recorded in `diff.ts`'s own comments.

**One deliberate, documented consequence:** a block that relocates to a _different_ scene shows as
`'removed'` from its old scene's local list and `'added'` to its new scene's, even though the
document-wide `blocks` entry for the same id correctly says `'matched', moved: true` (it survived, just
not in that scene). The two views intentionally answer different questions — "did this block survive,
and where" (document-wide) versus "what changed within this scene's own boundary" (scene-local) — and
are expected to disagree in exactly that case. Tested directly
(`shows a block that relocates to a different scene as removed from its old scene and added to its new
scene, while the document-wide entry says it moved, not deleted`).

Only scenes (and the preamble) with something interesting to report are included in the output — an
untouched scene contributes nothing, which is what keeps a feature-length script's diff proportional
to the actual amount of change rather than restating every unchanged scene.

## How an element-type-only change is represented

`ScreenplayBlockDiffEntry` carries `elementTypeChanged` and `textChanged` as two independent booleans,
not one undifferentiated "changed" bit. `elementTypeChanged` is `before.type !== after.type`;
`textChanged` is the pre-existing `changed` flag (from `blockSignature` comparison) with
`elementTypeChanged` subtracted out — since a block's signature already encodes both type and
comparable text, a signature difference with an unchanged type can only mean the text differs, so this
needed no separate text-extraction logic. A line converted from `action` to `dialogue` with byte-
identical text therefore reports `elementTypeChanged: true, textChanged: false` — a change, not a
no-op, which is exactly `plan.md`'s own stated requirement ("A line moving from `action` to `dialogue`
reads completely differently on the page").

## Title page and document settings

Both are reported, independently of blocks/scenes:

- **Title pages** diff by stable id through the same generic `diffIdentifiedSequence` primitive used
  for blocks (one implementation of "diff an ordered, id-keyed list," not two near-identical copies) —
  added/removed/moved/changed, with `changed` computed by a flat structural comparison
  (`JSON.stringify`, safe here because `screenplaySchema.parse` always builds a `TitlePage` in the
  schema's own declared key order, confirmed against zod's `ZodObject` parse behavior, not the input's
  arbitrary key order).
- **Document settings** diff field by field (`DocumentSettingsDiffEntry[]`), not as one opaque
  "settings changed" boolean — a writer can tell at a glance whether only `sceneNumbersEnabled` flipped
  versus the whole block having been touched.
- **The screenplay title itself** (`titleChanged`/`titleBefore`/`titleAfter`) is reported as a top-level
  field, since it is neither a block nor a title page.

## Complexity, and whether it holds at feature length

Every step — flattening, map construction, the LIS-based move detector, scene derivation and grouping
— is linear or `O(n log n)` in the total flattened block count across both screenplays; there is no
quadratic step. `packages/screenplay/src/diff.performance.test.ts` backs this with a real measurement,
not just the asymptotic argument: a fixture at 90% of `MAX_ROOT_BLOCKS` (the schema's own ceiling,
~7,200 blocks after flattening — at least as large as this codebase ever has to diff), with a realistic
mix of scattered edits and a relocated run of five scenes, diffs in **well under 100ms** on this
machine (measured, not asserted-away: the test's own time budget is a generous 5 seconds specifically
so it guards against an accidental quadratic regression rather than ordinary machine variance). The
test also asserts correctness at this scale: the relocated scenes show up as moved, with zero
spuriously added/removed blocks.

## How the diff view avoids displacing the character grid

The first version of this view sidestepped the question by never rendering the manuscript at all. The
redesign cannot: the whole point is that it renders the screenplay. So the defect class this codebase has
introduced and fixed five times is now in scope, and it is answered by measurement rather than by
avoidance.

**Nothing drawn into the manuscript occupies a character cell.** There are exactly two kinds of mark:

- **The gutter** (glyph, `MOVED`, element-change abbreviation) is `position: absolute` with
  `right: calc(100% + 0.18in)` measured from its own block's left edge — out of flow, so it adds no
  advance width to any line, and placed left of the text whatever that element's indent is, with no rule
  per element and no page-format figure restated. The same technique `.scene-number`, `.smarttype-ghost`
  and `.remote-cursor` already use, each for this same reason.
- **The inline marks** are `<del>`/`<ins>` carrying only a `background` and a `text-decoration`. Every
  property that could move a glyph is explicitly neutralised in the stylesheet (`margin: 0; border: 0;
padding: 0; font: inherit`), and neither background nor text decoration participates in layout.
- The visually-hidden announcement label is `position: absolute` via the existing `.visually-hidden`
  utility, so it too contributes nothing.

**Measured, in a real browser, at two zoom levels** — `apps/web/e2e/screenplay-diff-persistence.spec.ts`,
following `page-rendering-persistence.spec.ts`'s precedent, with `requireCourierPrime` first so the
measurement is against the real typeface rather than a fallback. Three assertions over one measurement of
the real route:

1. **Every row's box is the element's specified indent and measure**, derived in the test from
   `ELEMENT_INDENTS` and `DEFAULT_DOCUMENT_SETTINGS` rather than written down — so the assertion fails if
   this view ever stops reading the specification's own geometry. Covers `scene_heading`, `action`,
   `character`, `parenthetical`, `dialogue` and the right-aligned `transition`. Read from `offsetLeft`/
   `offsetWidth`, which CSS `zoom` does not scale, within one integer rounding step (a specified 355.2px
   is reported as 355).
2. **Every character of every row sits on its own grid cell.** For each row, a DOM `Range` is taken over
   every single code unit of its real text (ornament subtrees excluded by `data-diff-ornament`) and its
   `getBoundingClientRect()` read: each character's horizontal offset from the row's left edge must be a
   whole multiple of one character cell, and each must sit on a whole multiple of the line height. This
   covers the hardest case directly — a `changed` row whose text is interleaved `equal` / `<del>` /
   `<ins>` runs. The cell width is calibrated from the rendered text at that zoom and then cross-checked
   against Courier Prime's own advance at the specified 12 pt, so this measures the real grid rather than
   an assumed one. Vertical offsets are measured from the row's own first character, not its box top: at
   the specification's `line-height: 1` the font's ascent and descent together slightly exceed one em, so
   every character's ink sits about a pixel above the line box — a constant offset shared by every line
   in the row, and nothing to do with the grid, which requires successive lines be exactly one line
   height apart.
3. **A marked row and its byte-identical unmarked twin place every character at the same coordinates.**
   The fixture is built with deliberate control pairs: the added long action line (which wraps onto two
   lines) and the removed short action line each have an unchanged twin carrying identical text. Their
   `offsetLeft`, `offsetWidth`, `offsetHeight` and every per-character `(dx, dy)` must match. This is the
   assertion that makes the claim an equality rather than an estimate, and it covers a wrap point.

All three run at the default 100% and again at 50% through the view's own zoom control, and the unscaled
layout boxes are additionally asserted byte-identical across the two zooms — the same invariant every
other zoom mechanism in this app is held to.

**Measured results.** Both zoom levels pass with no character off its column or its line, and with the
marked/unmarked control pairs matching to within 0.01px on every character. The rendered cell width
matched Courier Prime's own advance at 12 pt at both scales. Two measurement details were corrected
while writing the test, both in the test rather than the implementation (recorded here because they are
easy to get wrong again): `offsetLeft`/`offsetWidth` are integer-rounded, and a character's client rect
is its ink box, which at `line-height: 1` begins about a pixel above the line box.

The route remains lazily code-split and the lazy editor chunk is byte-for-byte identical to `main`
(144.72 kB gzip) — see "Reusing the real screenplay geometry, without the editor" above for the one
decision that required.

## Revision-vs-current, for slice 5

`diffScreenplays(before, after)` takes two ordinary `Screenplay` values with no special case for "the
live one" — a revision's own canonical projection and the screenplay's current, live
`canonical_screenplay` are structurally identical inputs to this function. `RevisionStore.
getRevisionDiff(actorId, screenplayId, revisionId, against?)` makes this concretely available: with
`against` omitted, it diffs `revisionId` against the screenplay's current live content (the exact
comparison `plan.md`'s restore flow step 1 needs — "An authorized owner/editor previews a screenplay-
aware diff and confirms the target revision"); with `against` supplied, it diffs two stored revisions.
Both sides are ordered by `createdAt` (not by which one the caller passed first), so "moved from
position 3 to 7" always reads in forward chronological order regardless of call-site argument order;
the live side is treated as always-newest by construction (`Number.POSITIVE_INFINITY`), since it is by
definition whatever the document looks like right now. Nothing here builds restore itself — no
`restore` revision kind is created, no epoch is touched — but the one comparison restore's own
confirmation step depends on already works, end to end, against a real database
(`apps/api/src/revisions.integration.test.ts`'s "with no `against`, diffs a named revision against the
screenplay's current live content").

## Route and response shape

`GET /api/screenplays/:id/revisions/:revisionId/diff`, optional `?against=<uuid>` querystring.
Membership-only authorization (the same bar `listRevisions`/`getRevision` already set) — a diff is a
read-only comparison of two immutable-or-read-only snapshots, never a write, so there is no reason to
require edit rights to view one; a lapsed or reviewer-only account can diff exactly as it can already
preview and export. Response:

```ts
{
  screenplayId: string;
  older: {
    id: string /* or 'current' */;
    kind: RevisionKind | null;
    label: string | null;
    createdAt: string | null;
  }
  newer: {
    /* same shape */
  }
  diff: ScreenplayDiff;
  olderScreenplay: Screenplay;
  newerScreenplay: Screenplay;
}
```

`older`/`newer` are named by chronology, not by "the one in the URL" vs. "the one in the query string"
— see the ordering reasoning above. `olderScreenplay`/`newerScreenplay` were added by the redesign, and
both are validated by `screenplaySchema` itself on each side of the wire rather than by a mirrored shape
— see "Response shape: why two whole screenplays now travel with the diff" above for why they travel with
the diff instead of being fetched separately, and what that costs.

## Boundaries honored

**Not production revision marks.** No asterisk-beside-the-line computation, no comparison against a
_lock_, no scene-number suffixes or `OMITTED` handling — those are production revision sets
(`plan.md`'s "Locked scripts"), a later, explicitly separate phase. This diff compares two arbitrary
points in ordinary revision history (or the live document), never a lock.

**Not Track Changes.** No accept/reject, no per-block author attribution, no proposals. `diffScreenplays`
is a pure, read-only comparison of two immutable (or read-only-to-this-endpoint) snapshots; nothing
here writes anything.

**Not restore-as-current.** No `restore` revision kind, no epoch increment, no "make this current"
action anywhere in this slice's routes or UI.

## Tests

- **Unit** (`packages/screenplay/src/diff.test.ts`, 25 tests): added/removed/content-changed/element-
  type-changed/moved blocks; a pure reorder reported as a move, not delete-plus-add; a realistic whole-
  scene relocation reported as "this scene moved" with zero spurious add/remove entries; an intra-scene
  reorder that does not move the scene itself; the cross-scene-relocation local/global disagreement
  documented above; scene-level grouping including the preamble case; title-page and document-settings
  changes; two identical screenplays producing `isEmpty: true`; and direct tests of the generic
  `diffIdentifiedSequence` move primitive in isolation.
- **Performance** (`diff.performance.test.ts`, 1 test): the near-`MAX_ROOT_BLOCKS` fixture described
  above.
- **API unit** (`apps/api/src/revisions.test.ts`, `getRevisionDiff` describe block): membership
  denial, missing base/against revision, parse-failure fallback to `'missing'`, the default
  diff-against-current path, and chronological reordering when the caller's `revisionId` is in fact the
  _later_ side.
- **API route** (`apps/api/src/revisionRoutes.test.ts`): 401 for unauthenticated, default (no
  `against`) and explicit-`against` query handling forwarded correctly to the store, 400 for a
  malformed `against`, 404 for an unresolvable diff, and the route absent entirely when the port is not
  supplied.
- **API integration** (`apps/api/src/revisions.integration.test.ts`, real Postgres): a real scene
  relocation across two real, named revisions, diffed end to end through the real store; diffing a
  named revision against the screenplay's real current live content after a further live edit;
  membership/missing-id denial.
- **Web unit** (`...revisions.$revisionId.diff.test.tsx`, 12 tests): auth guard, malformed params,
  loading/error states, the "No differences." empty state, side labeling including the `'current'`
  sentinel, a moved scene rendered as "Moved," an element-type-only change rendered distinctly from a
  plain content change, a changed scene heading, and added/removed blocks.
- **Web unit** (`revisionDisplay.test.ts`, +3 tests): `humanizeRevisionDiffSide`, including the
  `'current'` sentinel.
- **Web unit** (`...revisions/index.test.tsx`, +1 test): the new "Compare to current" link per row.
- **Browser** (`apps/web/e2e/screenplay-diff-persistence.spec.ts`, real signed-in session, real
  Hocuspocus-backed document, real database): types content, saves a named revision through the real
  File menu, makes a further live edit, opens that revision's own "Compare to current" diff view
  through the real UI, confirms the real difference renders, confirms **no editable screenplay canvas
  of any kind exists on the page** (structurally incapable of disturbing the live document, not merely
  disabled), and confirms the live document — fetched independently afterward — still has the
  post-milestone edit untouched.

### Added by the redesign

- **Unit** (`packages/screenplay/src/textDiff.test.ts`, 18 tests): the four cases the brief names — a
  one-word change marks one word (asserted both as an exact segment list and as a proportion: over 80% of
  a long speech stays `'equal'`); a whole-line rewrite marks the line as one span each side; an insertion
  within a line; a deletion within a line; identical text produces no marks at all (and two empty strings
  produce no segments) — plus changes at the very start and very end of a line, two separate word changes
  marked separately rather than as one span covering the middle, a word-order swap reported as the minimal
  pair of edits, a re-cased word, the trailing-whitespace trade-off, both empty-side directions,
  `tokenizeWords`'s code-unit-preserving round trip, the `MAX_WORD_DIFF_EDIT_DISTANCE` fallback still
  keeping the shared ends equal, and the complexity claim measured on a 4,000-word block. Both
  reconstruction identities (equal+removed rebuilds `before`; equal+added rebuilds `after`) and the
  canonical-form guarantees (no empty segment, no two adjacent segments of one kind) are checked on
  **every** comparison in the file, not only where a case looked risky.
- **Unit** (`apps/web/src/inlineScreenplayDiff.test.ts`, 17 tests): every case drives the **real**
  `diffScreenplays` over two real screenplays rather than a hand-written diff fixture, because the
  composition's whole job is to read that function's actual output. Covers: an unchanged screenplay still
  rendering as the whole screenplay (the redesign's core property — the old view rendered nothing here);
  each row carrying its element kind; the newer side's document settings; an added line marked in place; a
  removed line re-inserted in front of the surviving line it used to precede; a removal with nothing
  surviving after it placed last in its own original order; word-level marking of a changed line including
  the proportion assertion; an element-type change; a scene-number change; a forced page break; an
  authored blank line staying blank; a relocated scene rendered as two markers and **never** as a deletion
  plus an insertion (asserted over every row, not a filtered subset); the markers' placement; the
  relocated scene's lines left unmarked and not each announcing their own move; a single line that moved
  on its own still reporting its move; an added and a removed scene never reported as moves; and the
  combined fixture (an edit, an addition, a deletion and a relocated scene) asserted as an exact reading
  order with per-word marks.
- **Unit** (`...revisions.$revisionId.diff.test.tsx`, 22 tests, up from 12): the guards and states as
  before, plus the rendered markup — the whole document in order with no change-report sections surviving;
  each row at the real element geometry reusing the editor's own manuscript classes; no editing canvas and
  no accept/reject control; `<del>`/`<ins>` for removed/added; word-level marking inside a changed line;
  **all three non-colour cues for added, removed and changed, plus the legend**; a relocated scene as a
  move at each end with its own lines unmarked and no mark anywhere claiming it was deleted or inserted;
  the counts summary; the pagination caveat's wording and the absence of any page number; the print
  refusal; and the zoom control.
- **Browser** (`apps/web/e2e/screenplay-diff-persistence.spec.ts`, +1 test): the real route, real React,
  real stylesheet, real Chrome layout and the real Courier Prime webfont, served a fixture containing an
  edit, an addition, a deletion and a relocated scene — asserting the exact reading order with per-word
  marks, both scene-move markers, the computed `text-decoration-line` of `<del>`/`<ins>`, each mark's
  gutter glyph, the gutter painting entirely left of the text, the caveat, the absence of a page number
  and of any page-boundary background, the absence of any editing canvas, and the full character-grid
  measurement at 100% and 50% described under "How the diff view avoids displacing the character grid".

  A fixture is served to the real route (one `page.route` interception of the diff request) rather than
  typed, for one reason: the shapes this has to cover include a scene **relocated whole** with nothing
  inside it touched, and there is no deterministic way to produce that by typing — it needs a selection
  cut and re-pasted across a scene boundary, which depends on clipboard permissions and on paste
  preserving block ids, neither of which this spec should be asserting about. Everything that matters stays
  real: the signed-in route (its `beforeLoad` session guard still runs against the real API), the component,
  the stylesheet and Chrome's own layout. The server half is covered by the API integration tests against a
  real database and by the live-document browser test above it.

- **Browser** (same file, existing test): one assertion was **inverted**, and it is worth naming. It
  previously asserted that content common to both sides did **not** appear on the page — true of the change
  report, and precisely the owner's objection to it. It now asserts that the common line _is_ present, as
  an `unchanged` row carrying no `<del>`/`<ins>`, and the added line's assertions were tightened from a bare
  `getByText('Added')` to the marked row itself, its `<ins>`, its gutter glyph and its announced label. No
  other test anywhere was weakened, skipped or deleted, and no coverage threshold was lowered. One file was
  added to a coverage `include` list (`packages/screenplay/vitest.config.ts` gained `src/textDiff.ts`).

## Mutation testing

Both mutations applied directly to `packages/screenplay/src/diff.ts`, rebuilt
(`pnpm --filter @finaler-draft/screenplay build`) so the change was visible to `apps/api`'s own
compiled `dist/` dependency before the cross-boundary check, confirmed to fail in exactly the expected
way, then reverted and reconfirmed byte-identical with `diff` before moving on — the same discipline
4a's own mutation testing established.

**1. Move detection disabled** (`computeMovedIds` replaced with a body that unconditionally returns an
empty set — "nothing is ever moved").

- `packages/screenplay/src/diff.test.ts`: **7 of 154** tests failed — exactly the ones this property is
  named for: `'reports a pure reorder as a move...'`, `'reports a block that both moved and changed...'`,
  `'reports a realistic whole-scene relocation...'`, `'detects a reorder of blocks within one scene...'`,
  `'shows a block that relocates to a different scene...'`, and `diffIdentifiedSequence`'s own
  `'finds the minimal set of moves...'`. `diff.performance.test.ts`'s own assertion on the relocated-
  scene count also failed, for the same reason. Every other test in the file — added/removed/changed/
  element-type/title-page/document-settings/empty-diff — passed unchanged, confirming those properties
  do not accidentally depend on move detection.
- Cross-boundary, real database (`apps/api/src/revisions.integration.test.ts`, after rebuilding the
  screenplay package): **1 of 7** tests failed — `'diffs two real, stored revisions: a relocated scene
is reported as moved, not deleted and re-added'`, the exact test this property is named for at the
  integration level. The other six (membership, parse-failure, diff-against-current, chronological
  reordering) passed unchanged.
- Reverted; `diff` confirmed byte-identical; both suites reconfirmed fully green afterward.

**2. Element-type-change detection disabled** (`toBlockDiffEntry`'s `elementTypeChanged` hardcoded to
`false`, folding every type change into an undifferentiated `textChanged`).

- `packages/screenplay/src/diff.test.ts`: **exactly 1 of 154** tests failed —
  `'reports an element-type change with identical text as a change, even though the text itself is
untouched'`, the one test this property is named for. Every other test, including the sibling
  `'reports a content-only change (same element type) as changed, with textChanged true and
elementTypeChanged false'`, passed unchanged — confirming the two properties are independently
  tested, not conflated.
- Reverted; `diff` confirmed byte-identical; suite reconfirmed 154/154 afterward.

No prior assertion was weakened to make a mutation pass, and no suite other than the one meant to prove
each specific property was used as evidence for it.

### The redesign's two mutations

The two properties this redesign exists for, each mutation re-run against **the suite meant to prove that
property** — not against a different suite that happens to go red. Each was applied, observed, then
reverted and the suite reconfirmed green.

**3. The word-level diff broken so a changed block marks its entire text** (`diffWords`'s body, after the
identical-input short circuit, replaced with "return all of `before` removed, then all of `after`
added").

- `packages/screenplay/src/textDiff.test.ts` — the suite that exists to prove word-level marking:
  **12 of 18** failed, including every case the brief names by name: `'marks exactly one word for a
one-word change, leaving the rest of a long speech untouched'`, `'marks only the inserted words for an
insertion within a line'`, `'marks only the deleted words for a deletion within a line'`, and
  `'marks two separate word changes separately rather than as one span covering the middle'`. The six that
  still passed are the ones that genuinely do not depend on the property — identical text producing no
  marks, the two empty-string cases, tokenisation, and the pure addition/removal directions — which is
  what confirms the failures are specific to the property rather than collateral damage.
- The two view suites, with the screenplay package rebuilt so the mutation was visible through
  `apps/web`'s compiled dependency: **4 failed** —
  `inlineScreenplayDiff.test.ts`'s `'marks only the changed words of a changed line, leaving the rest of
the speech equal'` and the combined-fixture test, and the route suite's `'marks only the changed words
inside a changed line, leaving the rest of the speech unmarked'` and its whole-document reading-order
  test. So the property is guarded at the engine, at the render model, and at the rendered markup
  independently. (Worth recording: the first attempt at this mutation did **not** show up in the web
  suites at all, because `apps/web` imports the screenplay package from its built `dist/` and the package
  had not been rebuilt. A mutation across that boundary is only meaningful after
  `pnpm --filter @finaler-draft/screenplay build`.)
- Reverted; both suites reconfirmed green (18/18 and 39/39).

**4. A relocated scene rendered as a deletion plus an insertion** (`buildInlineScreenplayDiff`: the two
scene-move marker rows removed entirely, the scene's before-side lines re-emitted as removals at its old
position, and its after-side lines forced to `status: 'added'` at its new one — exactly the rendering the
design rejects).

- `apps/web/src/inlineScreenplayDiff.test.ts`'s `'a move stays a move'` block — the suite that exists to
  prove it: **4 of 17** failed, namely `'marks a relocated scene with a marker at each end and never as a
deletion plus an insertion'`, `'places the origin marker where the scene used to be and the destination
marker at the scene itself'`, `'leaves the relocated scene's own lines unmarked, because nothing in them
changed'`, and the combined-fixture test.
- The route's rendering suite: **3 of 22** failed, including
  `'renders a relocated scene as a move at each end, never as a deletion plus an insertion'` and the
  counts summary (which under the mutation reported two added and two removed lines and no moved scene).
- The **browser** test also failed, on the real route in real Chrome, with the reading order showing
  exactly what the mutation produces: `removed[-EXT. ROOFTOP - DAWN]`, `removed[-Wind lifts the tarp.]`
  where the two markers belonged, and `added[+EXT. ROOFTOP - DAWN]`, `added[+Wind lifts the tarp.]` at the
  destination. This is the strongest of the three, because it is the rendered page a reader would actually
  have seen.
- Reverted; all three reconfirmed green.

## Known limitations, stated plainly

- **The LIS two-element-swap ambiguity** described above under "How moves are detected" is inherent to
  the algorithm, not a gap in this slice's testing of it — the integration test covering a real swap
  asserts the honest, tie-break-independent property (exactly one of the two scenes is reported moved)
  rather than a specific scene identity.
- **`diffIdentifiedSequence`'s result ordering** (primarily by `afterIndex`, with a removed-only entry
  placed by its own `beforeIndex`) is a readability heuristic for a UI rendering the list top to bottom,
  not a claim of perfect positional interleaving when several items are both removed and reordered in
  the same edit. Stated directly in that function's own doc comment.
- **The inline view's page breaks are not the document's**, by construction — see "What this view cannot
  do, and says so" above. It is stated in the interface, and no page boundary or page number is drawn.
- **The word diff degrades past `MAX_WORD_DIFF_EDIT_DISTANCE` (256 token edits)** to a wholesale
  replacement of the non-shared middle. Asserted directly rather than left implicit. Real text does not
  reach it: a whole rewritten line of dialogue or action is tens of tokens.
- **A spacing-only change marks the word the spacing follows**, the stated cost of carrying trailing
  whitespace with its token (`tokenizeWords`'s own comment). Recorded in its own test.
- **Removed-content placement is a readability rule, not a canonical position.** A deleted line is
  anchored after the nearest surviving line that preceded it, which is right in every ordinary case and is
  the rule a unified diff uses; when several things were both deleted and reordered in the same edit, two
  deletions can land at anchors that are not in their original relative order. Each still sits beside its
  own former neighbour, which is the property that matters for reading.
- **The `shot` element is not exercised by any diff-view fixture.** Its geometry comes from the same
  `ELEMENT_INDENTS` entry and the same stylesheet rule as `action` (identical indent and measure), so there
  is nothing specific to it that could be wrong independently — but the grid measurement does not cover it,
  and nor does any rendering test. Stated rather than implied by "every element".
- **A `documentSettings` geometry change between the two sides renders at the newer side's indents**, with
  the change reported in the document-level summary. There is no browser-level proof of that specific case:
  the unit test asserts the render model carries the newer settings, and the grid measurement runs against
  default settings only.
- **No UI entry point exists for revision-to-revision comparison** (only "compare this revision to
  current," from the revision history list). The route and store both support an explicit `against`
  revision id (proven by `revisionRoutes.test.ts` and the API integration test), but nothing in the web
  app currently lets a writer pick two historical revisions to compare against each other rather than
  one against current. This was a deliberate scope cut: `plan.md`'s restore flow only ever needs
  revision-vs-current, and building a second UI flow (a revision picker) for a comparison nothing in
  this phase's requirements calls for was not worth doing speculatively.

## New environment variables

None.

## Gates — every one run and checked by `$?`

### Re-run in full after the redesign

Every gate below was re-run after the view redesign, each checked by `$?` immediately rather than read
off a pipeline's tail. Nothing regressed against the lead's measured baseline on this branch (screenplay
154, web 718, api 203, collab 106, database 40, screenplay-editor 99, collab-token 9; integration
5 + 47 + 23; persistence 32/32; system 40/40; entry 111.92 kB, editor 144.72 kB).

```
pnpm lint
```

Exit **0**. No output beyond the banner.

```
pnpm format:check
```

Exit **0**. `All matched files use Prettier code style!`

```
pnpm typecheck
```

Exit **0**. Clean across every package and both apps, including `apps/landing`'s `astro check`
(`22 files: 0 errors - 0 warnings - 0 hints`).

```
pnpm test
```

Exit **0**. `packages/screenplay`: **172 passed** (154 baseline + 18 in the new `textDiff.test.ts`).
`apps/web`: **745 passed** (718 baseline + 17 in the new `inlineScreenplayDiff.test.ts` + 10 more in the
rewritten diff-route suite, 12 → 22). `apps/api`: **203 passed**, unchanged — the two new response fields
are covered by the existing route tests, whose fixture now carries them (a response missing them is a 500
under the route's own response schema, which is what makes that fixture load-bearing rather than
decorative). `packages/database` **40**, `packages/screenplay-editor` **99**, `apps/collab` **106**,
`packages/collab-token` **9** — all unchanged. Every other package unchanged and green.

```
pnpm test:coverage
```

Exit **0**. One file added to a coverage `include` list (`packages/screenplay/vitest.config.ts` gained
`src/textDiff.ts`); **no threshold was lowered**. Measured: `packages/screenplay/src/textDiff.ts`
**100/100/100/100** (stmts/branch/funcs/lines), `apps/web/src/inlineScreenplayDiff.ts`
**98.03/86.13/100/98.03**, the diff route **99.66/90/94.73/99.66**, `apps/api/src/revisions.ts`
**100/100/100/100**. `apps/web` is on `perFile` 80% thresholds, so each of those is an individual pass, not
an average.

```
pnpm check:bundle-budget
```

Exit **0**. `Entry chunk 111.92 kB / 120.00 kB`, `Lazy editor chunk 144.72 kB / 200.00 kB`,
`CSS 7.21 kB / 20.00 kB`. **The entry chunk and the lazy editor chunk are both byte-identical to the
pre-redesign baseline** — the editor chunk in particular, which is the number that proves this route still
does not reach the editor bundle. Keeping it there required the local-zoom-presets decision recorded under
"Reusing the real screenplay geometry, without the editor"; the alternative was measured at 144.33 kB.
CSS grew from 6.79 kB to 7.21 kB, the inline view's own rules.

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "<repo>/.env" | cut -d= -f2-)" pnpm test:integration
```

Exit **0**. `packages/database` **5/5**, `apps/api` **47/47**, `apps/collab` **23/23** — all unchanged.

```
TEST_DATABASE_URL="..." pnpm test:system:persistence
```

Exit **0**, first run, **33/33 passed** (32 baseline + the redesign's new grid-measurement and
readability test). No flakes on this run; the two flake classes recorded under the pre-redesign gate runs
below did not recur.

```
pnpm test:system
```

Exit **0**. **40/40**, unchanged — the new browser test needs the persistence harness's real database and
mail capture, so it lives in `playwright.persistence.config.ts`'s `testMatch`, the same convention every
other `*-persistence.spec.ts` file follows.

### The pre-redesign run, kept for the record

These are the gate results from the first version of this slice, before the view was redesigned. Kept
because the mutation-testing evidence for move detection and element-type detection (sections 1 and 2
above) was gathered against them.

```
pnpm lint
```

Exit 0. Clean, no output (after fixing one real lint error this slice introduced: an interface declaring
no members over `IdentifiedDiffEntry<TitlePage>`, changed to a type alias).

```
pnpm format:check
```

Exit 0. `All matched files use Prettier code style!`

```
pnpm typecheck
```

Exit 0. Clean across every package and both apps, including `apps/landing`'s `astro check`
("0 errors - 0 warnings - 0 hints").

```
pnpm test
```

Exit 0. `packages/screenplay`: **154 passed** (128 baseline + 26 new: 25 in `diff.test.ts`, 1 in
`diff.performance.test.ts`). `apps/api`: **203 passed** (190 baseline + 13 new, across
`revisions.test.ts`'s `getRevisionDiff` block and `revisionRoutes.test.ts`'s diff-route tests).
`apps/web`: **718 passed** (703 baseline + 15 new: 12 in the new diff-route test, 3 in
`revisionDisplay.test.ts`, split further by +1 in the revisions-list test for the new "Compare to
current" link). `packages/database`: **40 passed**, unchanged. `packages/screenplay-editor`:
**99 passed**, unchanged. `apps/collab`: **106 passed**, unchanged. `packages/collab-token`:
**9 passed**, unchanged. Every other package unchanged and green.

```
pnpm test:coverage
```

Exit 0. New files added to each package's coverage `include` list (`packages/screenplay/vitest.config.ts`
gained `src/diff.ts`; `apps/api` and `apps/web` already included every source file / `revisions.ts`).
Measured: `packages/screenplay/src/diff.ts` **100/97.7/100/100** (stmts/branch/funcs/lines),
`apps/api/src/revisions.ts` **100/100/100/100** (including the new `getRevisionDiff`),
`apps/api/src/app.ts` **99.76/95.16/100/99.76** (two pre-existing uncovered lines, unrelated to this
slice), the pre-redesign web diff route **100/83.33/100/100** — every one comfortably above the 80%
thresholds.

```
pnpm check:bundle-budget
```

Exit 0. `Entry chunk 111.92 kB / 120.00 kB`, `Lazy editor chunk 144.72 kB / 200.00 kB` (byte-for-byte
unchanged from the pre-slice baseline — confirming the new route never touches the editor chunk),
`CSS 6.79 kB / 20.00 kB`. The pre-redesign diff route's own lazy chunk measured 1.15 kB gzip; after the
redesign it is 4.52 kB gzip, still entirely separate from both the entry and editor chunks.

```
TEST_DATABASE_URL="..." pnpm test:integration
```

Exit 0. `packages/database`: 5/5 (unchanged). `apps/api`: **47/47** (44 baseline + 3 new,
`revisions.integration.test.ts`'s diff tests). `apps/collab`: **23/23**, unchanged.

```
TEST_DATABASE_URL="..." pnpm test:system:persistence
```

First run: **2 of 32 failed** — `persistence.spec.ts`'s "pasting content copied from this editor back
into the same document..." (a poll timeout, this suite's own documented flake class under worker
contention) and, genuinely, this slice's own new spec: a strict-mode violation, because automatic
revisions alongside the named one meant more than one "Compare to current" link existed on the page,
and the test's original selector matched all of them. Fixed by scoping the click to the named
revision's own row (`page.getByRole('listitem').filter({ hasText: 'Before the rewrite' })`). Re-run
after the fix: **1 of 32 failed** — `presence-persistence.spec.ts`'s "clicking exactly on a remote
cursor..." ("Block has no text node."), the exact flake already documented as a known, pre-existing
issue in `progress/collaboration-revisions.md`'s own baseline note, with the new diff spec itself now
passing. Third, final run: **32/32 passed**, confirming the only genuine failure this slice's own work
caused was the row-scoping bug above, now fixed, and that the remaining single-test failures on the
first two runs were different, unrelated pre-existing flakes under this suite's own worker contention,
never the same test twice.

```
pnpm test:system
```

Exit 0. **40/40**, unchanged — this slice's browser test needs the persistence harness's real database
and mail capture, so it was added to `playwright.persistence.config.ts`'s `testMatch` and
`playwright.config.ts`'s `testIgnore`, the same convention every other `*-persistence.spec.ts` file
already follows.

## Everything above is proven, not assumed, with one exception stated plainly

The redesign's own unproven points are listed individually under "Known limitations, stated plainly"
above — the `shot` element's rendering, and a `documentSettings` geometry change, each have no
browser-level proof. Beyond those:

The revision-to-revision comparison path (`?against=<uuid>`) is proven at the unit, route, and
real-database integration levels, but has no browser-level proof — the one browser test this slice adds
exercises only the revision-vs-current path (the one a writer can actually reach today, via "Compare to
current"). This is consistent with there being no UI entry point for revision-to-revision comparison
yet (see "Known limitations" above); if a UI path to it is added later, it should get its own browser
coverage at that time rather than being assumed to work because the underlying route is tested.

## Independent verification by the lead

The central claims were checked directly against the built package rather than only through this
slice's own tests, because "screenplay-aware" rests entirely on them:

| Scenario                                | Result                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| A whole scene relocated to the front    | 0 added, 0 removed, 3 blocks moved, exactly one scene entry reported `matched/moved` |
| A brand-new scene inserted at the front | 2 added, **0 moved**                                                                 |
| Two identical screenplays               | empty diff: no block entries, no scene entries, `titleChanged: false`                |
| `action` to `dialogue`, identical text  | `elementTypeChanged: true`, `textChanged: false`                                     |

The second row is the one worth keeping. A position-comparison diff -- "is this block at a different
index than before" -- would mark every block after an insertion as moved, which at feature length
means a one-line insertion near the front reports the entire script as rearranged. The
longest-increasing-subsequence backbone is what makes the answer zero, and that is the difference
between a diff a writer trusts and one they learn to ignore.

**Move detection mutation-tested independently.** Forcing `computeMovedIds` to return an empty set
fails **7 of 154** `packages/screenplay` tests and nothing else -- among them "reports a realistic
whole-scene relocation as 'this scene moved,' not a pile of deletes and inserts", the within-scene
reorder test, the cross-scene relocation test, and the generic primitive's own minimal-moves test.
147 tests are unaffected, so the failures are specific to the property rather than collateral.

Worth noting what that mutation actually degrades to, because it is worse than the delete-plus-add
the brief worried about: with ids still matching on both sides, a relocated scene becomes _matched
and uninteresting_, so a pure reorder would be reported as **no change at all**.

**Gates re-run by the lead on this branch:** lint 0, format:check 0, typecheck 0, `pnpm test` 0
(screenplay 154, web 718, api 203, collab 106, database 40), coverage 0, bundle 0 (editor chunk
144.72 kB, byte-identical to `main` -- the diff view genuinely does not reach the editor bundle),
integration 5 + 47 + 23, `test:system:persistence` 32/32, `test:system` 40/40.

## Lead verification of the redesign

**The grid-displacement guard was mutation-tested independently**, because this is the first thing in
the project to deliberately mark up the manuscript and the defect class has been introduced and fixed
five times. Adding `padding-inline: 2px` to `.diff-manuscript ins` -- the authentic form of the
defect, since the rule set zeroes `margin`/`border`/`padding` precisely to prevent it -- fails exactly
one test, the grid measurement, with `Expected: < 0.05` against `Received: 0.208`. The deviation is
expressed as a fraction of one character cell, so the assertion detects roughly a fifth of a
character's displacement. That is a genuinely tight measurement rather than a tolerance wide enough
to be decorative.

**No established coverage was weakened.** The browser assertion this redesign inverted (common
content must now be _present_ as an unchanged row, where it previously had to be absent) lived in this
branch's own uncommitted spec, not in anything merged -- the old form encoded exactly the behaviour
the owner objected to. Separately, the five test cases that `git` reports as removed from
`$revisionId.test.tsx` were **moved** into `$revisionId/index.test.tsx` when that route became a
directory to host the diff child; all five are present at the new path.

**Gates re-run by the lead on this branch:** lint 0, format:check 0, typecheck 0, `pnpm test` 0
(screenplay 172, web 745, api 203, collab 106, database 40), coverage 0 with no thresholds lowered,
bundle 0 (entry 111.92 kB, lazy editor **144.72 kB -- byte-identical to `main`**, CSS 7.21 kB),
integration 5 + 47 + 23, `test:system:persistence` 33/33, `test:system` 40/40.

**Carried forward as a cost, not a defect:** `GET .../diff` now returns `olderScreenplay` and
`newerScreenplay` alongside the diff, so the response carries two whole screenplays. The reasoning is
sound -- the diff reports only interesting entries, so it cannot render a document on its own, and
fetching the newer side separately could render a document the marks were never computed from. But a
feature-length screenplay's canonical projection is hundreds of kilobytes, so this endpoint is now the
heaviest in the API. Worth revisiting if diff views are ever opened in bulk; harmless at one-at-a-time
human pace.

## The comparison wears the editor's chrome

The owner's objection to the view as built, verbatim:

> "My bigger concern is just UI consistency. I like the UI we've built out for the editor, and don't
> want users thrust into some plain UI when looking at the difference."

He was right, and the diagnosis is narrower than it sounds. The manuscript _inside_ the comparison was
already correct -- the editor's own `.pages` / `.page` / `.script-body` and the real page geometry, as
the sections above describe. What was wrong was everything around it: the route rendered
`<main className="project-screen diff-screen">` with a `.project-header` holding one link and a
`.eyebrow` reading `COMPARISON`, which is the vocabulary of the sign-in page and the project list, not
of the application. For contrast, the historical-revision preview has never had this problem for the
simple reason that it _is_ the editor (`App.tsx` with `historicalRevision` set, forced into a local
unconnected `Y.Doc`, read-only).

### What moved: `apps/web/src/applicationShell.tsx`

The chrome is now one component, `ApplicationShell`, plus `ApplicationTitlebar`, in a module of their
own. 146 lines, and the whole dependency list is `import type { ReactNode } from 'react'` -- no
`Editor`, no `Y.Doc`, no ProseMirror, no router, no application state. `App.tsx` imports it; it imports
nothing of `App.tsx`'s, so the dependency runs one way only.

`App.tsx` no longer renders `<main className="application">` or any of its rows directly. It fills
slots: `titlebar`, `menubar`, `banner`, `toolbar`, `workspace`, `statusbar`, and `outOfFlow` for the
children that occupy no grid row (the two dialogs, the toast, SmartType's list, the element menu).
Every row's JSX is unchanged apart from indentation; the one real change is that the five
mutually-exclusive banner blocks are now one `banner` expression instead of a `has-readonly-banner`
class computed from five conditions _and_ five separate conditional children rendered a hundred lines
further down. The shell derives the class from the slot, so the track and its occupant cannot disagree
-- which is exactly the pair that _did_ disagree in the production defect `.application`'s own comment
in `styles.css` records.

`ApplicationTitlebar` exists because the brand mark, the accessible name, the `/projects` anchor and
the account badge are byte-identical on every screen that wears the chrome. The document title is the
one thing that differs, and the save dot is passed in as an `indicator` only by a screen that has a
document state worth reporting.

### Why `.application` stopped using grid auto-placement

`.application` used to be a fixed five-track list filled by auto-placement in document order. That
worked only because exactly one screen rendered it and that screen always rendered every row, and it
had already broken once in production in the way the file's own comment records: `.readonly-banner`,
an extra child with no track budgeted for it, took the toolbar's 47px row, which shoved the toolbar
into the workspace's `minmax(0, 1fr)`, the workspace into the status bar's 30px, and the status bar
into an implicit, unstyled row past the end of the list.

A comparison view that legitimately has no menubar and no toolbar cannot be expressed by
auto-placement at all: the workspace would slide up into the menubar's 31px. So each chrome element
now names its own area (`grid-area: titlebar` and friends) against a six-row
`grid-template-areas`, and each optional row's height is its own custom property
(`--fd-shell-menubar-row` and friends) that one `.shell-without-*` modifier collapses to `0px`. One
declaration per absent row, not one track list per combination of rows.

Two things fell out of that which are improvements rather than side effects. First, an unexpected child
can no longer displace any chrome row at all -- the cascade above is now structurally unreachable (see
the mutation below for what it does instead). Second, the `max-width: 600px` block used to restate the
whole track list twice, once per banner state, to change the toolbar's height from 47px to 42px; the
file's own comment flagged that duplication as a drift risk. It now overrides one custom property, and
`.application.shell-without-toolbar`'s two-class specificity keeps winning over it in either source
order, so there is no second copy to keep in step.

### Which slots the comparison fills, and why

| Row       | Filled? | Why                                                                                                                                                                                                                                                                                                                               |
| --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Titlebar  | yes     | Application identity, the document's name, and the only way out that does not depend on the browser's back button. Nothing about it is editor-specific except the save dot, which is omitted -- nothing here is saving.                                                                                                           |
| Menubar   | **no**  | Every item in it commands the document. There is nothing here to command, and a menubar of disabled labels is worse than no menubar: it advertises that this screen is a crippled editor rather than a different kind of view.                                                                                                    |
| Banner    | yes     | The comparison's counterpart to the preview's "Historical revision." banner, and for the same reason: a writer must not have to infer that they are not looking at the live document. It carries the two sides and both of this view's actions ("Back to revisions", the comparison zoom), because both are about the comparison. |
| Toolbar   | **no**  | Every control in it writes to the document. Same argument as the menubar, more strongly: an undo button on a snapshot is a lie.                                                                                                                                                                                                   |
| Workspace | yes     | The sheet, inside `.diff-manuscript-region` -- the comparison's `.editor-region`: the single flex child of the workspace row, and the only region on the screen that scrolls. The reading apparatus (legend, pagination caveat, document-level changes) scrolls with it rather than sitting pinned above the lines it explains.   |
| Statusbar | yes     | See below.                                                                                                                                                                                                                                                                                                                        |

**The statusbar: filled, with the change counts, and nothing else.** Leaving it out was the real
alternative, and the argument against the editor's own content is sound -- the bar reports a document's
_live_ state (active scene, sync, save, word count, who else is here) and a comparison has none of
that. Worse, the two figures a reader might expect of a bar in this position are the two this view is
least entitled to state: showing removed lines in place puts more content on the sheet than either
document holds, so this view's pages are not the document's pages, and it may not report a page count.

What is left is the change counts, and they turn out to be the right content rather than a consolation
prize. They are _document state_, not reading apparatus -- the same distinction that puts the editor's
word count in the bar and its legend nowhere -- and they are true without qualification. So
`.diff-summary` moved out of the sheet's header and into the status bar, where it is the bar's only
content. Omitting the row would have cost a writer the bottom 30px of the application on the one
screen this work exists to make feel like the application; the alternative cost nothing.

`.eyebrow` and `.diff-sides` left the body: the first was the plain-page vocabulary itself, the second
moved into the banner's own sentence, which is where the preview names its revision too.

### Proof that the editor's layout did not move

`page-rendering-persistence.spec.ts`'s zoom-modes test gained `measureShellGeometry`, measured against
the real editor with the real stylesheet:

| Measurement                 | Result                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| Declared grid rows          | 6 tracks: `38, 31, 0, 47, 574, 30` px at a 720px viewport                 |
| Rendered chrome row heights | titlebar 38, menubar 31, toolbar 47, statusbar 30, workspace 574          |
| Tiling                      | every row's top is the previous row's bottom; statusbar bottom = the fold |
| `.application` height       | equals `window.innerHeight`; `document.scrollHeight` never exceeds it     |
| In-flow children            | exactly `titlebar, menubar, toolbar, workspace, statusbar`, in that order |
| At a second zoom level      | the whole measurement is deep-equal to itself at 100% and 50%             |

The banner row resolving to `0px` rather than being absent is the only difference from the old
five-track list, and it is a difference in the track list's _shape_, not in any rendered pixel: the
four fixed heights sum to the same 146px and the workspace's `1fr` resolves to the same number.

The manuscript half of the claim -- "still on its character grid at two zoom levels" -- is the
`measureGrid` deep equality that test already asserted at 50%, 70%, 100%, 150%, fit-width and
fit-page, against one `gridAt100` baseline. It still passes unchanged.

This runs as a further phase of that test's existing session rather than as a new `test.describe`, per
that test's own top-of-function comment: a nineteenth real account against the rate-limited API is what
produced the "Projects could not be loaded." failure that comment describes.

### Chrome parity, measured

`screenplay-diff-persistence.spec.ts` measures the chrome off the real editor, navigates to the real
comparison, and measures it again. Asserted equal: the titlebar's box and its resolved
`background-color`/`color`/`font-size`/`gap`/`padding`, its brand `href`, its accessible name, its
brand mark, its account badge; the scroll region's resolved `background-color` and `overflow-y`; the
statusbar's height and its resolved `background-color`/`border-top`/`color`/`font-size`. Asserted
_different_, from the resolved track list rather than by implication: the comparison's menubar and
toolbar rows are `0px` and those elements do not exist, while the editor's are 31px and 47px. Asserted
of the comparison specifically: the banner is the editor's own `.readonly-banner` with `role="status"`,
the shell opened an `auto` row whose resolved height equals the banner's own, the banner sits directly
below the titlebar and directly above the workspace, and the statusbar's bottom edge is still the fold.

### The regression risk, mutation-tested

**Mutation 1 -- a stray child in the shell** (`<div className="mutation-stray-child">Stray</div>`
before `{titlebar}`): the editor-layout measurement fails, on `inFlowChildren`, with the stray child
first in the list. Three of the eleven `applicationShell.test.tsx` tests fail, and the comparison's own
row census fails. Verified by running the mutation, reverting it, and re-running the same suites green.

The informative part is what did _not_ fail: the tiling assertions. Under explicit grid placement the
stray child is auto-placed into the only area no explicit child claims -- the collapsed `0px` banner
row -- and overflows it without moving any chrome row. So the cascade the old auto-placed track list
suffered is genuinely unreachable now, and the child census, not the tiling, is the load-bearing guard
against a shell that renders one child too many. Both are kept: the census catches the child whatever
its height, the tiling catches the layout consequence if placement is ever loosened again.

**Mutation 2 -- the banner row's class no longer derived from the banner slot** (the exact pair that
disagreed in the original production defect, reachable only by breaking the shell itself now): the
comparison's chrome measurement fails on `hasBannerRow`. The editor-layout measurement does _not_ fail,
correctly -- the editor in that session has no banner, so there is nothing for the mutation to break
there. A different suite going red would have proved nothing; this is the suite that owns the property.

### Not done, deliberately

The comparison and preview routes are still two routes, and diff marks are still not rendered inside
the real editor. Both were considered and deferred for the reason this slice's own sections above give:
showing removed lines in place is incompatible with truthful pagination, because the pagination engine
measures the document and not decorations. This work is chrome consistency only. Restore-as-current is
still slice 5.

## Lead verification of the shell extraction

The extraction changed `.application` from grid auto-placement to explicit named areas, which is a
larger change to the editor's own layout mechanism than the task asked for. That made "the editor is
unchanged" the claim worth checking hardest, and it holds **by construction, not only by assertion**:

|                     | row track list                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `main`, no banner   | `38px 31px 47px minmax(0, 1fr) 30px`                                                     |
| `main`, with banner | `38px 31px auto 47px minmax(0, 1fr) 30px`                                                |
| this branch         | `38px 31px 0px 47px minmax(0, 1fr) 30px`, banner row `auto` under `.has-readonly-banner` |

A `0px` track contributes no height and no gap, so the rendered geometry is arithmetically the same
list `main` produces -- the four fixed heights still sum to 146 and the workspace `1fr` still resolves
to 574 at a 1280x720 viewport. The banner variant matches `main`'s six-row form exactly.

**The editor-geometry guard was mutation-tested independently.** Changing
`--fd-shell-titlebar-row` from `38px` to `40px` -- a two-pixel regression of exactly the kind this
refactor risks -- fails precisely one test, with `Expected: 38 / Received: 40` at
`page-rendering-persistence.spec.ts`'s `declaredRows[0]` assertion. One test, the right one.

**The one-way dependency was verified against the built output**, not inferred from the import graph:
the comparison route's chunk contains **zero** occurrences of `prosemirror`, `tiptap`, `hocuspocus`
or `IndexeddbPersistence`, and `applicationShell` is its own 1002-byte shared chunk imported by both
callers. The lazy editor chunk is 144.71 kB, slightly _smaller_ than the 144.75 kB it replaced.

**Gates re-run by the lead:** lint 0, format:check 0, typecheck 0, `pnpm test` 0 (web 768,
screenplay 172, api 203, collab 106, database 40), coverage 0, bundle 0, integration 5 + 47 + 23,
`test:system:persistence` 33/33, `test:system` 40/40.

**Accepted without independent proof, and worth a reader knowing:** the agent's own report is explicit
that under explicit grid placement the stray-child mutation is caught by the **child census**, not by
the tiling assertions -- a stray child lands in the collapsed banner row and overflows it without
moving any chrome row. That is an honest narrowing of what the tiling proves, and the right one to
record rather than let a future reader assume the tiling guards it. Also unproven: nothing here was
checked visually. Every parity claim is resolved computed style and geometry from real Chrome, which
cannot tell whether the arrangement reads well.

## The comparison wears the editor's **whole** frame

The pass above gave the comparison the application shell -- title bar, banner, workspace, status bar
-- and deliberately left the menubar and toolbar out, on the argument that "a menubar of disabled
labels advertises a crippled editor." The owner looked at the result and disagreed:

> "Its better now, but still doesn't quite feel consistent. There is no toolbar, even if theres not
> much in the toolbar that could actually be used here. Theres no scene/character navigator. Theres
> no inspector. It still just feels like a free floating thing, not like part of the greater
> product"

He is the authority on this, and he is also in good company: Google Docs' and Word's version-history
views both keep the full chrome, with what cannot apply greyed out. **The absence is what broke the
sense of one product.** This pass gives the comparison every region the editor has -- menubar,
toolbar, navigator panel, inspector panel, status bar -- in the same grid rows, rendered by the same
components, with every control that cannot act **genuinely disabled** rather than absent.

### What was extracted, and where it lives

Four presentational components, beside `applicationShell.tsx`, each taking data and callbacks as
props. The editor passes live state and real handlers; the comparison passes diff-derived data and
disabled states. Neither renders a lookalike of the other's chrome, because there is only one of
each.

| Module                                | What it renders                                                                                          | Previously                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `apps/web/src/applicationMenubar.tsx` | The File menu (items are a prop), the five inert labels plan.md has still to activate, the canvas toggle | ~60 lines of JSX inside `App.tsx`  |
| `apps/web/src/applicationToolbar.tsx` | The whole toolbar, plus `ToolButton`                                                                     | ~121 lines of JSX inside `App.tsx` |
| `apps/web/src/navigatorPanel.tsx`     | The Navigator: heading, tablist (WAI-ARIA tabs pattern, arrow keys, roving tabindex), entry list, footer | ~115 lines inside `App.tsx`        |
| `apps/web/src/inspectorPanel.tsx`     | The Inspector's frame: heading, close affordance, `.inspector-section`/`<h2>` rhythm                     | ~30 lines inside `App.tsx`         |

Two supporting modules came with them:

- `apps/web/src/zoomPresets.ts` -- the reachable range, the step, the default, the preset list and
  `clampZoomPercent`, moved out of `zoom.ts` (which re-exports every name, so nothing that already
  imported them changed). `zoom.ts` is the editor's zoom _mechanism_ -- `ZoomMode`, fit-mode
  resolution against `.editor-region`, pointer-anchored scroll capture -- and is reachable only from
  `App.tsx`, which is what keeps it inside the lazy editor chunk. The shared toolbar needs exactly
  the numbers and nothing else. This is what lets both screens offer the _identical_ zoom control
  from one authority; the comparison's own `COMPARISON_ZOOM_PERCENTS` is gone.
- `apps/web/src/diffNavigator.ts` -- the comparison Navigator's model (below).

The dependency runs one way only: `App.tsx` imports these modules; none of them imports anything of
`App.tsx`'s, and none imports `@finaler-draft/screenplay-editor` (whose entry point pulls in
`@tiptap/core` and `@tiptap/pm`). That is why the element `<select>`'s options are a prop rather than
an import.

### Every control, and which are disabled

**Menubar.** Identical on both screens: the File menu, `Edit`/`View`/`Format`/`Tools`/`Help` as inert
`<span>` labels (not controls, so there is no disabled state for them to get wrong), and the canvas
toggle.

| File item                    | Comparison   | Why                                                                                                                                                                                         |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document settings…           | **disabled** | A read-only reading view of two stored snapshots has no settings to change.                                                                                                                 |
| Save named revision…         | **disabled** | Nothing here to save.                                                                                                                                                                       |
| Revision history…            | live         | It genuinely applies -- this comparison came from that list. Navigates to the same place the banner's "Back to revisions" does; a command in both a menu and a visible control is ordinary. |
| Download FDX… / DOCX… / PDF… | **disabled** | A comparison is not a screenplay. Exporting one would be a new feature, not a shared control.                                                                                               |

Dark canvas is **live**: the comparison has a canvas, and `.dark` restyles the chrome and the
surround rather than the manuscript, so it is a view preference. One stylesheet consequence had to be
handled: `.dark` redefines `--surface-10` for the chrome's benefit, and that token is also the inline
_added_-mark background, which is painted on a sheet that stays white. `--fd-diff-added-surface` is
derived on `:root` (where a `var()` reference is substituted, so the dark redefinition does not follow
it down) and used by `.dark .diff-manuscript ins`.

**Toolbar.** The same eleven controls, in the same order, under the same accessible names.

| Control                             | Comparison                                      | Why                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Undo local change                   | **disabled**                                    | No edit history on this screen, and nothing here can write to either document.                                                                                                                                                                                                                                                                         |
| Redo local change                   | **disabled**                                    | Same.                                                                                                                                                                                                                                                                                                                                                  |
| Active screenplay element           | **disabled**                                    | There is no caret, so there is no active element. It shows a disabled placeholder reading "No active element" rather than a greyed-out element name, because naming one would be false.                                                                                                                                                                |
| Zoom out / Zoom level / Zoom in     | live                                            | One sheet, readable at more than one scale. Same stepper, same floor and ceiling, same `<output>`.                                                                                                                                                                                                                                                     |
| Zoom preset                         | live, with **both fit options really disabled** | "Fit page"/"Fit width" are computed from `.editor-region`'s measured available area and recomputed on resize and panel toggle (`zoom.ts`'s `resolveZoomPercent`). This view has no such lifecycle, and adding one would be a second zoom mechanism rather than a shared control. The options stay present and named; `disabled` is on each `<option>`. |
| Toggle element labels               | **disabled**                                    | The overlay draws each block's element name into the same left margin this view's change gutter occupies. They cannot both be shown, and the gutter is the reason this screen exists.                                                                                                                                                                  |
| Toggle continuous scroll            | **disabled**                                    | It switches the drawn page boundary off and on, and this view draws none at all -- showing removed lines in place makes every boundary it could compute a boundary no real document has. There is no pagination here to switch between.                                                                                                                |
| Toggle navigator / Toggle inspector | live                                            | Both panels carry real content.                                                                                                                                                                                                                                                                                                                        |

Disabled everywhere means the DOM `disabled` attribute on a real control. There is no `aria-disabled`
anywhere in `applicationToolbar.tsx`, and a unit test asserts that directly, because `aria-disabled`
is exactly the attribute that makes a control _look_ unavailable to assistive technology while
staying focusable and clickable.

### What the panels carry

**Navigator -- the scene skeleton, with the changed scenes marked and jumpable.**

`diffNavigator.ts` builds the model. Three decisions worth recording:

1. **The skeleton comes from the two documents, not from `diff.scenes`.** `diffScreenplays`
   deliberately returns only scenes with something to report ("what keeps a feature-length script's
   diff proportional to the actual amount of change"). That is right for a diff and wrong for a
   navigator: a panel listing only changed scenes is a change report, not a way to move around a long
   comparison, and a reader who clicks scene 7 has to be able to find scene 6. Every scene on either
   side is listed and the diff's entries are looked up against it; a scene with no entry is, by that
   function's own contract, untouched. Removed scenes are interleaved at the position they used to
   occupy, by the same preceding-survivor anchoring rule `inlineScreenplayDiff.ts` uses for a removed
   line, and carry no newer-side number because they have none.
2. **`'changed'` outranks `'moved'`** when a scene did both, because the edit is what a reader has to
   go and read; the relocation is still reported through a separate `moved` flag the row shows beside
   the count. Read the other way round, `'moved'` then means what the manuscript's own scene-move
   markers mean -- the scene is intact and only its position changed.
3. **A move is not a changed line.** A scene dragged elsewhere with nothing inside it touched reports
   every one of its blocks as `moved` in the document-wide block list; counting those would tell a
   reader forty lines changed when none did.

Each row carries three agreeing cues: `data-navigator-status` (what the stylesheet colours and what a
test asserts), an `aria-hidden` glyph (`+`, `-`, `~` -- the manuscript gutter's own three; `⇄` for a
move, in the sans face because Courier Prime is not guaranteed to carry U+21C4), and the status as a
word, both visually-hidden-first in the row's reading order and visible in the trailing figure.
Nothing in the panel is signalled by colour alone. Choosing a row scrolls that scene's own manuscript
row into view (`[data-diff-block-id]`, which every rendered row already carries) and makes it the
status bar's active scene.

**The character list earns its place, but only in one form.** It lists **characters whose own lines
changed**, never the whole cast. A complete cast list answers nothing a comparison's reader is
asking, and it would be the one panel on this screen saying nothing a comparison knows -- the editor
already lists the cast, from the live document, where it is useful for navigation. "Whose lines
changed" is a question only a diff can answer, it is how a writer thinks about a revision ("what did
they do to MARA?"), and it is derivable from data already on screen: `deriveCharacters` over both
sides, intersected with the diff's own content-change set. A speaker whose speech merely travelled
with its scene is not listed. The tab itself stays, because dropping it would make the comparison's
tablist structurally different from the editor's -- and an empty tab says why it is empty rather than
rendering blank.

**Inspector -- the comparison's own metadata.** Four sections: **Comparing** (the two sides),
**Changes** (the counts, itemised rather than comma-joined as in the status bar, built from the same
`counts` so the two cannot disagree), **Document** (the title / `documentSettings` / title-page
differences that have no line in the body to be marked on -- present only when there are any, so there
is never a heading with nothing under it), and **Legend**.

### What moving the legend out did to the layout

`.diff-page-body` -- the band above the sheet -- held the legend, the pagination caveat and the
document-level change list. It now holds **the caveat and nothing else**. The legend and the
document-level list are per-document detail, which is what the Inspector is for; the caveat stayed
because it is a correctness warning about the sheet directly below it ("these page breaks are not the
document's") and must not be hideable by closing a panel. `.diff-page-body`'s width also changed from
`min(860px, calc(100vw - 40px))` to `min(860px, 100%)`: the workspace row now holds two panels beside
the scrolling region, so the viewport is no longer the width that band may take, and the old figure
would have overflowed the region by exactly the panels' width.

The banner kept naming the two sides even though the Inspector names them too. That duplication is
deliberate: the banner cannot be closed, and a reader who collapsed the Inspector must not thereby
lose which two revisions are on screen.

### A real keyboard defect this surfaced, and fixed

`OverflowMenu` focused the first `[role="menuitem"]` on open and computed arrow-key movement from the
full item list. A disabled `<button>` cannot take focus, so a menu whose **first** item is disabled
swallowed the opening focus move (focus stayed on the trigger), which left `indexOf(activeElement)` at
`-1`, which sent ArrowDown back to the same unfocusable item -- and left Escape unhandled, because the
Escape handler lives on the list. The whole menu was keyboard-inert while looking open.

Nothing had exercised it: every existing caller's first item was enabled. The comparison's File menu
is the first whose first item never is -- and the editor's own File menu has had the same latent fault
all along for a read-only screenplay, where `editingAllowed` disables that same first item. The fix:
focus and arrow-navigate only `[role="menuitem"]:not(:disabled)`, and handle Escape on the trigger as
well, so a menu with no enabled item at all can still be dismissed. Three tests added; none weakened.

### Proof the editor did not change

- **Behaviour: the editor's existing tests passed unchanged, not adjusted.** `apps/web` went from 768
  tests to 837 (+69 new). Not one pre-existing editor assertion was edited to accommodate the
  refactor. `App.test.tsx` in particular -- which asserts the toolbar's tooltip inventory, the element
  selector, every zoom interaction, the Navigator's tabs and derived lists, and the Inspector's active
  element -- is byte-identical.
- **Appearance: measured.** The extracted components reproduce the editor's markup exactly, including
  the `className={x ? 'selected' : ''}` empty-string form and the absence of a `disabled` attribute
  where `false` is passed. `page-rendering-persistence.spec.ts`'s shell-geometry measurement is
  unchanged and still passes: six declared grid rows resolving to 38 / 31 / 0 / 47 / `1fr` / 30, each
  chrome element rendering at its declared row's height, the five rows tiling the viewport with the
  status bar's bottom edge as the fold, the document never scrolling, and the in-flow children of
  `.application` being exactly the five chrome rows. The manuscript's character grid is unchanged at
  50/70/100/150%/fit-width/fit-page.
- The **only** editor-side behavioural change in this pass is the `OverflowMenu` keyboard fix above,
  which is a fix to a defect the editor also had.

### The comparison chunk still contains no editor code

Measured against the built output, not inferred. Walking the Vite manifest from the comparison
route's entry through every static import gives seven chunks; `prosemirror`, `tiptap`, `hocuspocus`
and `IndexeddbPersistence` occur **0** times across all of them.

```
diff route entry: src/routes/.../$revisionId.diff.tsx?tsr-split=component
ok   assets/_projectId.screenplays._screenplayId.revisions._revisionId.diff-*.js
ok   assets/index-*.js
ok   assets/useQuery-*.js
ok   assets/api-*.js
ok   assets/navigatorPanel-*.js      <- the shared chrome chunk, 2.21 kB gzip
ok   assets/OverflowMenu-*.js
ok   assets/revisionDisplay-*.js
TOTAL editor-dependency occurrences in the comparison route graph: 0
```

| Artifact          | Before this pass | After         | Budget |
| ----------------- | ---------------- | ------------- | ------ |
| Entry chunk       | 111.94 kB        | 111.95 kB     | 120 kB |
| Lazy editor chunk | 144.71 kB        | **143.99 kB** | 200 kB |
| CSS               | 7.36 kB          | 7.48 kB       | 20 kB  |

The editor chunk got _smaller_: the toolbar, menubar and panels left it for a chunk shared with the
comparison. It did not grow.

### Mutations

Each was applied, run against the suite that owns the property, and reverted.

| Mutation                                                                                                   | Suite re-run                  | Result                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolButton` renders `aria-disabled` + a `disabled-looking` class instead of the real `disabled` attribute | `applicationToolbar.test.tsx` | **3 failed** -- "puts the real disabled attribute on every control a read-only screen cannot use", "is unreachable by click and by keyboard when disabled", "uses no aria-disabled anywhere". The route suite independently caught it too (2 failed). |
| `NavigatorPanel` stops rendering `data-navigator-status`, the glyph and the hidden status word             | `navigatorPanel.test.tsx`     | **2 failed** -- "marks every status with its own attribute, glyph and word", "announces the status before the entry's own line". The route suite independently caught it too (2 failed: the scene-skeleton marking and the character list).           |

### Not done, deliberately

The comparison and preview routes are still separate. No diff marks in the real editor. No
restore-as-current. No fit-zoom modes on the comparison (they would need a second recompute
lifecycle). No participant indicator in the comparison's status bar -- a stored snapshot has no
participants, and that is the one chrome difference between the two status bars, asserted explicitly
rather than left as an unchecked remainder.

### Gates — every one run and checked by `$?`

| Gate                           | Exit | Result                                                                                                                                                                                                                               |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint`                    | 0    | clean                                                                                                                                                                                                                                |
| `pnpm format:check`            | 0    | clean                                                                                                                                                                                                                                |
| `pnpm typecheck`               | 0    | clean                                                                                                                                                                                                                                |
| `pnpm test`                    | 0    | web 837 (was 768), screenplay 172, api 203, collab 106, database 40, screenplay-editor 99, collab-token 9, entitlements 25, layout 72, fdx 45, docx 58, pdf 61, landing 31, auth-server 24, server-config 20, config 2, xml-escape 9 |
| `pnpm test:coverage`           | 0    | per-file 80% thresholds met on every new module                                                                                                                                                                                      |
| `pnpm check:bundle-budget`     | 0    | entry 111.95/120, lazy editor 143.99/200, CSS 7.48/20                                                                                                                                                                                |
| `pnpm test:integration`        | 0    | 5 + 47 + 23                                                                                                                                                                                                                          |
| `pnpm test:system:persistence` | 0    | 33/33                                                                                                                                                                                                                                |
| `pnpm test:system`             | 0    | 40/40                                                                                                                                                                                                                                |

### What is **not** proven

The browser assertions are resolved computed style, resolved grid tracks and real geometry from real
Chrome, plus an enumeration of both screens' controls by accessible name and `disabled` property.
Those establish that the two screens render the _same frame_; they cannot establish that the
arrangement reads well.

Unlike the previous pass, this one did look at the rendered result: a screenshot of each screen was
captured from the real browser run and inspected, which is how the Navigator's marker column was
narrowed from 40px to 28px (the status word was wrapping onto its own line). That is an eyeball check
of two screenshots at one viewport width in one theme, not a design review, and nothing in the test
suite depends on it.

## Lead verification of the full-frame pass

**The strongest claim checked first, and it holds.** `apps/web/src/App.test.tsx` is **byte-identical to
`origin/main`** (`git diff --stat` reports nothing), and `page-rendering-persistence.spec.ts` is
**+132 insertions, 0 deletions** -- purely additive. So the editor's behavioural and layout coverage
was added to and never adjusted to accommodate the refactor, which is the failure mode a chrome
extraction invites: quietly relaxing the editor's own assertions until the shared components fit.
`apps/web` went 768 -> 837 tests entirely through new files.

**The `OverflowMenu` fix is genuinely guarded.** Reverting `:not(:disabled)` to the original selector
fails exactly two named tests -- "moves opening focus past a disabled first item, to the first one
that can take it" and "skips disabled items when the arrow keys move between them" -- and nothing
else. The diagnosis is also correct on its own terms: a disabled `<button>` cannot take focus, so the
original `querySelector('[role="menuitem"]')?.focus()` was a silent no-op that left focus on the
trigger, left `indexOf(document.activeElement)` at `-1`, and left the menu keyboard-inert while
appearing open. This was latent in the editor for any read-only screenplay, where `editingAllowed`
disables that same first item; the comparison's File menu is simply the first place it is permanent.

**Bundle verified against built output, not the import graph.** The comparison route's chunk and the
shared `navigatorPanel` chunk each contain **0** occurrences of `prosemirror`, `tiptap`, `hocuspocus`
and `IndexeddbPersistence`. The lazy editor chunk went 144.71 kB -> **143.99 kB** -- smaller, because
the chrome left it for chunks shared with the comparison.

**Gates re-run by the lead:** lint 0, format:check 0, typecheck 0, `pnpm test` 0 (web 837, screenplay
172, api 203, collab 106, database 40), coverage 0, bundle 0 (111.95 / 143.99 / 7.48 kB),
integration 5 + 47 + 23, `test:system:persistence` 33/33, `test:system` 40/40.

**The disclosed flake matches what the lead has seen independently.** `presence-persistence.spec.ts`'s
click-through test failing with `Block has no text node` and passing on re-run is the same
DOM-read race recorded against that spec when it was written. Nothing in this pass touches presence,
Yjs or the canvas. It is a known pre-existing flake, not a regression and not a glossed pass -- and
worth fixing on its own, since it is now the second flake in that file's history.

**Still unproven, and this is the honest boundary of the whole three-pass effort:** every parity claim
is resolved computed style, resolved grid tracks, real geometry, and an enumeration of both screens'
controls by accessible name and DOM `disabled` property. Those establish that the two screens render
the same frame. They cannot establish that the arrangement reads well. This pass did check two
screenshots at one viewport in one theme -- which is how the Navigator's marker column was narrowed
from 40px to 28px after the status word wrapped -- but that is an eyeball pass, not a design review,
and no test depends on it.

## The removed mark is red, not grey

Raised by the owner after looking at the finished view: the removed highlight was grey while the added
one is a pale blue, and "at a glance those are close to the same color."

Measured, rather than judged: the removed mark's `--surface-12` (`#c9d0d4`) sat **dE 8.9** from the
added mark's `--surface-10` (`#d9e9ef`). Both are desaturated blue-greys -- `#c9d0d4` is very nearly a
slightly darker, less saturated `#d9e9ef` -- and dE 8.9 is in the band where two colours are
distinguishable when set side by side and effectively the same once they are not. On a comparison sheet
the two marks are usually many lines apart, which is the worst case for that band. The owner's eye was
reading a real property.

Now `--fd-diff-removed-surface: #f3d2d4`, a pale rose:

|                    | dE vs added blue | dE vs white page | text contrast |
| ------------------ | ---------------- | ---------------- | ------------- |
| old grey `#c9d0d4` | 8.9              | 17.2             | 9.3:1         |
| new rose `#f3d2d4` | **18.4**         | 17.9             | 8.7:1         |

Better than twice the separation from the added mark, while sitting almost exactly as far from the page
as the grey did (17.9 against 17.2) -- so removals became legible _as removals_ without becoming louder
on the sheet, and the struck text keeps 8.7:1, far above WCAG AA's 4.5:1.

A dedicated token, not a change to `--surface-12`, which the toolbar's `.rule` separator also owns. And
a literal rather than a `var(--surface-*)` derivation: the sheet stays white in both themes, so unlike
`--fd-diff-added-surface` -- which needed an escape from `.dark`'s redefinition of `--surface-10` --
this needs none, and a literal is what keeps it that way.

**Red against blue is also the better pair than the convention it resembles.** GitHub's red/green is
the worst possible choice for red-green colour blindness, the most common form; red/blue is one of the
safest. And colour remains not the only cue regardless: strikethrough versus underline, the gutter
glyph, and a visually-hidden word each say the same thing.

**Guarded by hue, not by inequality.** The browser spec now asserts the removed mark's red channel
exceeds its blue and the added mark's blue exceeds its red. Asserting merely that the two differ would
have passed the arrangement this replaces. Mutation-tested by pointing the token back at
`--surface-12`: exactly one test fails, with `Expected: > 212 / Received: 201` -- the grey's red channel
against its own blue. No two greys can satisfy the assertion, so folding the removed mark back onto a
shared neutral token fails immediately.

Re-verified after the change: `pnpm test` 0 (web 837, screenplay 172), `test:system:persistence` 33/33,
lint / format:check / typecheck 0.
