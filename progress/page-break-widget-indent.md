# The page-break widget's indent, and the generated line count

Branch `fix/page-break-widget-indent`, merged as PR #16.

Backfilled after the fact. This slice and the four after it ran without a progress log; the
reasoning below was recovered from the work itself while it was still fresh, and the omission is
recorded in `progress/README-backfill.md`.

## The reported symptom

A writer's dialogue continued across a page break, and the `CHARACTER (CONT'D)` heading on the
continuation page rendered the character name on one line and `(CONT'D)` beneath it, indented
roughly 5 inches instead of 3.7. `(MORE)` on the previous page lined up with it, at the same wrong
indent.

Three separate observations, one cause.

## What it was

`apps/web/src/pagination.ts`:

```ts
const pos = endsBlock ? blockStart + block.nodeSize : blockStart + 1 + last.endOffset;
```

A break that ends a block anchors the widget as a sibling in `.script-body`'s flat top-level flow.
A break **mid-block** — which is exactly and only when a `(MORE)`/`CONT'D` pair is generated, since
a speech can only split between two dialogue lines — has no block boundary to anchor at, so the
widget is inserted as a **child of the dialogue block's own DOM node**.

Every rule beneath `.page-break-widget` assumed the widget box sat in `.script-body`'s coordinate
frame:

```css
.script-body .page-break-cue-line {
  margin-left: calc(var(--fd-character-indent) - var(--fd-page-margin-left)); /* 2.2in */
}
```

2.2in is correct measured from the page content box. The dialogue block's content box already
begins at 2.5in. They add.

Measured in real Chrome, Courier Prime 12pt, default settings:

| widget position              | indent | line box | `Vivamus (VO) (CONT'D)` |
| ---------------------------- | ------ | -------- | ----------------------- |
| sibling (break ends a block) | 3.7in  | 38 chars | 1 line                  |
| nested (mid-dialogue split)  | 4.7in  | 13 chars | 2 lines                 |

21 characters into a 13-character box wraps after 12, which puts `(CONT'D)` on its own line under
the name. That is the reported symptom exactly, including the eyeballed "about 5 inches".

The page number and the page-separation seam masks were displaced by the same 1.0in, because they
are positioned absolutely against the widget and spacer boxes. Nobody had reported that; it was
found while measuring.

## Two independent defects, not one

**Defect 2, found while reading the model rather than the DOM.** `packages/layout/src/pageBreak.ts`
did `builder.push(continuedLine(...))` — one push, one line, unconditionally, with no wrapping. So
the model counted the heading as one line while the DOM could paint two. The incoming page then ran
a line long and every page after it drifted.

This was reachable without any nesting: `documentSettingsSchema` caps `characterIndentIn` at
`MAX_ADJUSTABLE_INDENT_IN - MIN_CHARACTER_CUE_ROOM_IN` = 6.5in, reserving ten characters — while the
appended `" (CONT'D)"` is nine characters on its own. `MIN_CHARACTER_CUE_ROOM_IN = 1` was reasoned
about the authored cue alone and never about the suffix the paginator adds. The wrap cliff was
measured at exactly 6.0in for a 16-character heading.

## The fix, and why it was generalised

The first fix corrected the widget box for `dialogue` only. That was wrong in scope, and the
scoping was caught by measuring the other elements rather than by review:

| widget nested in | indent, dialogue-scoped fix | after generalising |
| ---------------- | --------------------------- | ------------------ |
| dialogue         | 3.7in                       | 3.7in              |
| parenthetical    | **5.3in**                   | 3.7in              |
| character        | **5.9in**                   | 3.7in              |
| action           | 3.7in (no left offset)      | 3.7in              |

Mid-block breaks in a parenthetical or character block are reachable, not theoretical:
`placeSimpleGroup` -> `placeLinesPlain` splits any block that cannot fit a fresh page. Measured with
the real paginator, a single parenthetical of 200 words spans 2 pages and 400 words spans 4. No
`CONT'D` is generated there, but the widget still renders the spacer, the page number and the seam
masks, so the damage is displaced page furniture.

The shipped fix corrects the widget box **once, generically**: every indented element declares its
own offset as `--fd-block-indent`, and the widget cancels whatever it inherits.

```css
margin-left: calc(var(--fd-page-margin-left) - var(--fd-block-indent, var(--fd-page-margin-left)));
```

Custom properties inherit, so a nested widget picks up its host block's indent while a top-level
sibling inherits nothing and resolves to zero. `transition` offsets with `margin-right`, so its
content box's left edge never moves and it needs no declaration.

Defect 2 was fixed by running the generated heading through `wrap.ts`'s
`characterWrapBudgetFor(characterIndentIn)` — the same budget every authored cue uses — and emitting
as many lines as it occupies. Model and DOM then agree by construction, rather than by a second
bound kept in sync with the first by hand.

## What was rejected

**Adding a second reserved-room constant** so the heading always fits. Rejected: it would have to be
maintained in lockstep with `MIN_CHARACTER_CUE_ROOM_IN` forever, and it fixes the disagreement only
for the values someone thought of.

**A second hard-coded selector** for `parenthetical` alongside the `dialogue` one. Rejected for the
same reason the first scoping was wrong: it fixes instances, not the class. Dual dialogue is already
in the layout model and will have column offsets.

## Verification

Mutation-tested. Removing the correction fails the parity tests per element. Restoring the earlier
dialogue-only scoping fails exactly the parenthetical and character tests while dialogue keeps
passing — proving the tests discriminate per element rather than merely detecting that some
correction exists. Truncating `continuedLines` to a single line fails the paginate test.

Parity was also confirmed at a non-default `characterIndentIn`, which the implementing agent had
listed as unverified.

## Known gaps at merge

- The browser parity tests loop a hardcoded list of hosts, so an element added later that sets
  `margin-left` without declaring `--fd-block-indent` would not be caught. Closed in the next slice
  by a guard test, not by a lint rule — the project lints only JS/TS and a CSS toolchain was not
  warranted by one invariant.
- At a maximally-adjusted character indent the heading still wraps; the model and DOM simply now
  agree that it does. Whether the schema should make that unreachable is a document-settings
  decision, unresolved.
