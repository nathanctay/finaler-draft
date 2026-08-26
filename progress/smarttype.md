# SmartType: contextual completion

Branch `feature/smarttype`, merged as PR #21. Three stages, one commit each, plus two follow-ups.

Backfilled after the fact; see `progress/README-backfill.md`.

## Why it was designed before it was built

plan.md specifies SmartType in one paragraph: scene-heading input suggests prefixes then locations
and times already authored, character input suggests previously authored characters, suggestions are
keyboard-operable and never replace text without an explicit accept. That leaves the interaction
model, the accept key, the vocabulary source and the scope open — all of which change the
implementation materially. Those were settled with the owner before any code was written.

**The decisions, and the reasoning that is not recoverable from the code:**

- **Ghost completion primary, list on demand.** The owner is on the fence about the list, so
  removability became an architectural constraint rather than a preference.
- **Tab accepts.** `Enter` was already bound to `splitScreenplayBlock` and the element menu will
  claim a second-Enter behaviour later; two features competing for one key is a fight worth avoiding.
  `Tab` was unclaimed in the editor.
- **Times seeded with the conventional set**, not authored-only. plan.md's "reuse times already
  authored" read strictly gives a new document's first scene no help, which is when help is worth
  most.
- **Scene headings and character cues only.** Transitions were offered and declined as scope beyond
  the written requirement.

Uppercase-on-accept for locations and times was decided later, mid-implementation, on the same
reasoning as character cues: convention is uppercase, an accept is explicit, and the document is
never rewritten.

## Stage 1 — vocabulary and suggestions

`deriveVocabulary` and `suggest` in `packages/screenplay`, beside `deriveScenes` and
`deriveCharacters`, touching no DOM, ProseMirror or React. That purity is the seam: the ghost takes
`candidates[0]`, a list takes the whole array, and neither knows about the other.

**Two rules that are easy to get wrong and were mutation-proven:**

Scene headings split on the **last** space-hyphen-space separator, `" - "`. So
`INT. KITCHEN - BACK ROOM - DAY` yields location
`KITCHEN - BACK ROOM` and time `DAY`. Splitting on the first reads correctly on simple headings and
mangles real ones.

Prefixes are **matched** longest-first, so `INT./EXT.` is never read as `INT.` plus leftovers, but
**suggested** by document usage with conventional commonness as the tie-break. Conflating the two
orderings shipped in the first draft and was caught by exercising the built package directly:

```
suggest('scene_heading', 'IN', vocab) -> ["INT./EXT.", "INT."]
```

`INT.` is the single most common thing a screenwriter types. After the fix, a fresh document ranks
`INT.` first and a document that actually uses `INT./EXT.` heavily ranks that first.

## Stage 2 — the inline ghost

A widget decoration renders the completion remainder greyed after the caret. Nothing enters the
document before accept: never saved, never reloaded, never exported.

**The constraint that mattered most.** Text rendered inline inside a text block changes where that
line wraps, shifting every line below it and putting the DOM out of agreement with the paginated
model — the defect fixed in PR #16 and again in PR #20, reachable here by a third route. The ghost is
absolutely positioned with no offsets, so it paints at its static position while contributing no
advance width. A real-browser test compares every block box, every rendered line rectangle, every
page-break spacer and the page height with and without a ghost showing, and requires them identical.
Putting the ghost back into flow fails it — verified by mutation, not asserted.

**Two findings from the implementation worth keeping:**

`closeHistory` on accept is load-bearing. Without it, prosemirror-history merges the completion into
the typing group the writer just opened, and one undo takes their own characters with it.

The vocabulary reads the whole body **including the block being typed**, so a half-typed `INT. AP`
offers back `AP`, which matches exactly and completes to nothing — the ghost cancelling itself one
frame after every keystroke. The fix shows the best-ranked candidate _that has something to add_.
Excluding the caret's block instead was rejected: it forces a whole-document re-derivation on every
caret move, and a synchronous one would put a zod-validating projection inside the Enter keystroke.

## Stage 3 — the candidate list

`ArrowDown` opens a listbox; `Tab` or `Enter` accepts; `Escape` closes the list, a second `Escape`
dismisses the ghost.

**Enter accepts only while the list is open.** This reversed the original design decision, and the
reversal is principled rather than a concession: the objection to Enter-accept was that Enter's
meaning must not depend on state the writer cannot see. A ghost appears on its own from typing, so a
ghost-level Enter would qualify. An open list is state they chose — they pressed `ArrowDown`, there
is a panel on screen with a highlighted row, and accepting that row is what every dropdown does.

That narrowness is also what keeps the element menu's future second-Enter clear. An empty scene
heading does show a ghost, so a ghost-level Enter would have collided directly; reaching an open list
costs a deliberate `ArrowDown`, which a writer pressing Enter twice on a fresh block never does.

The binding lives in the list layer, not the ghost, so deleting the layer takes `Enter` back with it.

## Removability, and what it actually costs

The owner asked that the list not be "so tangled that the list can't be removed later". Verified by
**performing the removal**: the web suite returned to exactly the stage-2 baseline of 378.

It is not a two-file delete. The full sequence is in `smartTypeList.tsx`'s header and includes two
things nobody would predict from reading the code:

- `overrideSmartTypeGhost` and its state field and meta variant become dead code in the ghost. That
  seam exists so the list can say which candidate is on offer while accept stays a single writer to
  the document; the alternative was two independent code paths mutating the manuscript.
- The e2e geometry test was _extended_ rather than duplicated, so the list owns half of a test that
  fails loudly and names nothing. There is a `REMOVING THE LIST:` marker in that spec.

Extending rather than adding was the right call: the claim is that an open list changes nothing about
a page, which is only worth something measured against the identical document in the identical
browser moments earlier.

## Follow-ups after the three stages

The owner added six seeded times (`AFTERNOON`, `MOMENTS LATER`, `DAWN`, `DUSK`, `SAME`, `SAME TIME`).
Multi-word seeds had never been exercised and were verified to complete correctly across the internal
space.

That change broke three tests and voided a fourth, all repaired in `71f2f88`. Three had written the
seed count down as a literal. The fourth — `adds a novel time not in the seeded set` — used `DAWN` to
stand for a time the seeds did not contain, and `DAWN` had just become a seed, so it was asserting
nothing. Counts now derive from the seeding itself, so only the test that deliberately pins the whole
list in declaration order fails when the list changes.

## Known gaps at merge

- An empty scene heading ghosts `INT.` immediately, and an empty character cue ghosts the top-ranked
  name. Follows from "at the start, suggest prefixes"; may read as helpful or as noise. Open product
  decision.
- The list paints across a page seam rather than dodging it — deliberate, since it is fixed-position
  chrome in viewport coordinates.
- IME composition is untested with a ghost showing.
- The screen-reader announcement was verified as DOM text in a live region, not with a real screen
  reader.
- The list's flip-above-caret and viewport-clamping branches run in jsdom, where every box is
  zero-sized; only the below-caret case was measured in a real browser.
- One mutation could not be caught: lowering the list extension's `priority` from 150 to 100 breaks
  nothing, because at equal priority Tiptap breaks the tie by declaration order and this layer is
  mounted second. The explicit priority was kept and the comment corrected to say why.
- Two list tests were originally passing for the wrong reason and were rewritten to isolate the rule
  they claim to test — found by mutation, not by review.
