# Block identity follows content, not position

Branch `fix/paste-split-block-identity`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/block-ids`, off `66185a3` (current `main`, slice 5
merged).

Two things in this slice: a block-identity defect the owner hit in ordinary use, and one label
change on the revision viewer. They are unrelated and are separate commits.

## The defect, as the owner hit it

He cut a line from the bottom of a page and pasted it at the top of the same page, then opened the
revision diff. It reported the relocated line as removed-and-added — expected, see "What is not
fixed" below — and it **also** reported the line that had merely been **pushed down one position**
as removed and re-added. In his words:

> "that line was not deleted and readded... It was simply pushed down. No other line on the page
> showed a difference."

The diff was reporting faithfully. It decides added/removed/moved purely by block id, with a
longest-increasing-subsequence over the ids common to both sides, and given ids that behave
correctly a relocated line shows added+removed while every shifted line shows `unchanged`. The ids
did not behave correctly: **the writer's line had lost its id to the pasted line.**

## Root cause

Reproduced at the editor level, through `EditorView.pasteHTML` (the real paste pipeline:
`transformPastedHTML` → `DOMParser.fromSchema` → `transformPasted` → `tr.replaceSelection`), with
the HTML a genuine cut actually puts on the clipboard. Before:

```
a1:"FIRST LINE"   b1:"SECOND LINE"
```

Caret at offset 0 of `a1`, paste one cut line. After, before the fix:

```
a1:"CUT ONE"   <fresh>:"FIRST LINE"   b1:"SECOND LINE"
```

`a1` — the writer's line — ends up labelling **pasted** text, and the writer's own "FIRST LINE",
untouched, ends up in a block with a brand-new id. By id, the untouched line was deleted and a new
one added. That is exactly what the diff reported.

The mechanism is ProseMirror's slice fitting. Selecting a line includes its trailing line break, so
`serializeForClipboard` records `openStart` 1, `openEnd` 1 over two children (the second empty) in
`data-pm-slice`. Pasted at a position inside a block, an open slice's **first** block merges into
the target block and the target block's own text merges into the slice's **last** block. The
identity stayed with the position; the content moved out from under it.

### One correction to the original diagnosis

The hand-off diagnosis had the symptom and the cause right, and one step of the mechanism wrong: it
said the writer's text "is pushed into the split tail, which inherits `a1`'s attrs, becomes a
duplicate id, and is reissued a fresh one by `regenerateDuplicateBlockIds`". That is true only of a
**fully closed** slice (`openStart` and `openEnd` both 0), which is the shape
`editing.test.ts`'s existing split test hand-authors with `data-pm-slice="0 0 []"`. A real cut or
copy of whole lines never produces a closed slice, and in the open case **no duplicate is created
at all** — confirmed by instrumenting the guard and watching it see a document with no duplicate in
it. So `regenerateDuplicateBlockIds`' document-order tie-break was never even consulted on the
owner's paste. Changing that tie-break would have fixed nothing.

This matters for more than bookkeeping: it is why the fix had to become a reassignment pass rather
than a better-arbitrated duplicate sweep.

## Why the old rationale was wrong

`regenerateDuplicateBlockIds` documented its tie-break as:

> The first block carrying a given id keeps it and every later one is reissued, which is document
> order and nothing more -- there is no sense in which one half of a split is more the original
> block than the other, and inventing a rule (prefer the half with text, prefer the longer one)
> would be a preference dressed up as a principle.

There is a sense, and `plan.md` states it:

> Stable scene and block IDs support comments, scene navigation, revision diffs, imports/exports,
> and future storyboard links **even when content is reordered**.

Identity is meant to follow content. Position is the one thing about a block that a paste is
entitled to change. That paragraph has been replaced in `packages/screenplay-editor/src/index.ts`
with the rule the code now implements and the reason the old one was false; leaving a falsified
rationale in place would have been worse than the defect.

Note also that "prefer the half with text" would not have resolved the owner's case even as a
heuristic: both halves carry text ("CUT ONE" and "FIRST LINE").

## The fix

`reconcileBlockIds` (replacing `regenerateDuplicateBlockIds`) in
`packages/screenplay-editor/src/index.ts`, still in `ScreenplayPasteSanitizer`'s
`appendTransaction` and still gated on a `paste`/`drop` `uiEvent` meta.

**The rule, in one sentence: a block id belongs to the text it was issued for, and follows that
text wherever the paste moves it.**

`contentHeirPositions` works out where each pre-paste block's content went, by mapping the
boundaries of that block's **surviving** content through the transaction's `Mapping` — composed
across the whole round, since `oldState` is the state before all of `transactions`. Per pre-paste
block:

- the leading boundary (immediately before the first surviving character) mapped with `assoc` **1**,
- the trailing boundary (immediately after the last surviving character) mapped with `assoc` **-1**.

The opposite associations are the whole trick. With `assoc` 1 at the front, content inserted at
exactly that spot pushes the boundary _past_ the insertion, so it follows the writer's text instead
of staying in front of the pasted text; with `assoc` -1 at the back, the mirror image. Mapped the
same way, a paste at offset 0 of a line and a paste at the end of one would be indistinguishable,
and only one of them should move an id.

If both boundaries land inside **one** new block, that block held this block's content whole and
inherits its id. Otherwise there is no heir. When two pre-paste blocks claim the same new block — a
selection running from the middle of one line into another leaves one joined block holding both
survivors — the earlier block in the pre-paste document wins, which is also the id ProseMirror's own
join already left on that node, so the common case costs nothing and the loser's id retires with the
line that stopped existing.

### Surviving content, not the block's outer boundaries

This started out reading the block's extreme content boundaries, with a `MapResult.deleted` check to
stop a _deleted_ block from resurrecting its id. Enumerating the paste space showed both halves of
that to be wrong, in opposite directions:

- A paste over the **first character** of a line deletes that line's first character, so the
  `deleted` check gave up and left the id where document order put it — on the block holding only
  pasted text. That is the original defect, reached by a selection instead of a bare caret. A line
  is not a different line for having lost its first letter.
- A paste that replaces a line **outright** deletes all of it, and both of its extreme boundaries
  then map to the junction its removal left behind, which sits inside a surviving block. Read
  literally, that says "its content was carried there whole", and the deleted line's id would be
  stamped onto the surviving line's text.

`survivingContentStart` / `survivingContentEnd` answer both at once: scan in from each end past
characters this transaction deleted, and bound the content that is actually still there. A block
with nothing left has no heir; a block with something left has its heir decided by where that
content went. The scans stop at the first survivor from each end, so the work is bounded by how much
of the block the transaction actually deleted — an ordinary paste exits both loops immediately, and
the worst case (select the whole document and paste) is one pass over the deleted content. Scanning
rather than reading a replaced range off the mapping, because a `Mapping` composed over a round of
transactions has no single replaced range: a drag-and-drop that moves content deletes in one step
and inserts in another.

This was measured, not argued. A throwaway enumeration ran every selection `[from, to]` in four
document shapes against six clipboard shapes — 3,546 scenarios, `crypto.randomUUID` stubbed to make
the output comparable — and scored each variant on how often a pre-paste id ended up on text sharing
no substring with the text it was issued for: **633** with no survival check at all, **414** with
the `MapResult.deleted` check, **258** with the surviving-content scan. No variant ever produced a
duplicate id. The 258 remaining are all the same shape and are not this pass's doing: a selection
that covers a whole line _and its boundary_ leaves ProseMirror's own node in place holding only new
text, and the pass declines to take an id away from a block it cannot prove moved. Declining is the
conservative side — stripping ids gratuitously is itself diff churn.

The second pass then gives every block the id belonging to the content it holds: an inherited one
where there is an heir, the id it already has otherwise, and a freshly minted one wherever that
would collide. The collision set **starts out holding every inherited id**, so a block whose id has
moved to its content's new home cannot keep a stale copy of it, and it grows as the pass goes, so
two blocks can never leave the function sharing one id.

### Why mapping and not text comparison

Pasted text can be a character-for-character copy of the text it lands beside — it usually is, the
clipboard came from this document — so no string match could tell the writer's "FIRST LINE" from a
pasted "FIRST LINE". Position mapping is exact and knows nothing about the characters.

### Why not a tie-break, and why not `handlePaste`

A tie-break cannot work: in the owner's case there is no duplicate to break. Re-implementing the
replace in `handlePaste` so the split is ours to label would mean re-implementing ProseMirror's
slice-fitting algorithm, which is the single most delicate thing in `prosemirror-transform` and
which this fix needs to keep behaving exactly as it does. Acting after the transaction, with the
transaction's own mapping as the source of truth about where content went, uses that algorithm's
answer instead of competing with it. It is also source-agnostic: it works for paste, drop, and the
plain-text fallback path without knowing how `prosemirror-view` built any of their transactions.

### What the rule answers, case by case

| Paste lands                               | Result                             | Which block keeps the id                                                                                    |
| ----------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Start of a line, multi-block slice        | `"CUT ONE"`, `"CUT TWOFIRST LINE"` | the second — all of the writer's text went there                                                            |
| End of a line, multi-block slice          | `"FIRST LINECUT ONE"`, `"CUT TWO"` | the first — same reason, mirrored                                                                           |
| Middle of a line                          | `"FIRSTCUT ONE"`, `"CUT TWO LINE"` | the first, by document order — the text was genuinely divided and neither half is the line the writer typed |
| Start of a line, single-block slice       | `"CUT ONEFIRST LINE"`              | itself; nothing split, nothing to follow                                                                    |
| Over a line's first character             | `"CUT ONE"`, `"IRST LINE"`         | the second — the line lost a letter, not its identity                                                       |
| Over a whole line and its break           | one joined block                   | the **surviving** line's own id; the replaced line's retires                                                |
| From mid-line into the next line          | one joined block                   | the earlier line's id; the later one's retires                                                              |
| Closed slice inside a line (a true split) | head + pasted + tail               | whichever half holds the content whole; document order when divided                                         |

Document order survives as the fallback for the one case with no right answer, and only there.

## The constraints, and how each is kept

**No duplicate ids, ever.** `screenplayIdSchema` enforces global uniqueness; a duplicate makes the
projection invalid and the status bar reads "Not saving · Stable id ... must be globally unique
within a screenplay". The pass mints a fresh id for any block whose id is already claimed, with the
running `used` set seeded from the inherited ids, so no two blocks can leave it sharing one. Every
new test asserts the projection valid as well as the ids pairwise distinct, which is the check that
actually matters in production.

**Copy-and-paste still mints fresh ids.** The editor cannot tell a cut from a copy at paste time,
so pasted content always gets new identity. `regeneratePastedIds` is unchanged and still rewrites
every id arriving in the slice before the transaction is built. `reconcileBlockIds` only ever moves
an id onto the block that inherited the content that id already labelled — never onto content that
arrived from the clipboard — and a dedicated test pastes a _copied_ (not cut) line at the start of
another line and asserts the source line still holds its own id, with no duplicate anywhere.

**Every existing paste, split and Enter test passes unchanged.** 99 → 109 tests in
`packages/screenplay-editor`; the ten are additions, nothing was adjusted to fit. In particular the
existing closed-slice split test still passes: under the new rule `originalId` follows
`"INT. HOUSE - DAY"` into the tail rather than staying on the empty head, and that test asserts
texts and id-uniqueness, not which block holds which id.

## What is not fixed, deliberately

**The relocated line still shows as removed + added rather than moved.** This is inherent. A paste
must mint fresh ids, because the editor cannot distinguish a cut from a copy at paste time, so a
cut-and-pasted line genuinely _is_ a new block. Making paste preserve ids would reintroduce the
duplicate-id save failure on every copy-paste — the failure
`progress/paste-sanitization.md` exists to close. The owner has accepted this ("honestly not a big
deal"). **Do not revisit it as a bug.** The defect fixed here is the _other_ line, the one that was
never touched.

## Tests

`packages/screenplay-editor/src/editing.test.ts`, in the existing `paste sanitisation` describe, ten
added (99 → 109 tests in this package; nothing existing was adjusted):

1. A multi-block paste at the start of a line keeps the line's id on the line's own text, and the
   block holding only pasted text gets an id belonging to neither the writer's line nor the
   clipboard.
2. The same, through the clipboard shape a real one-line cut produces — built by
   `serializeForClipboard` from an actual line-plus-break selection, asserted to carry
   `data-pm-slice="1 1 []"`, and pasted back with `pasteHTML`. This is the owner's literal action.
3. The same paste at the **end** of a line keeps the id on the first block.
4. A paste into the **middle** of a line falls back to document order.
5. A single-block paste at the start of a line merges in and changes nothing.
6. A paste over a line's **first character** keeps the id with the rest of the line.
7. A paste over a line **and its break** leaves the surviving line holding its own id, rather than
   the replaced line's.
8. A paste over a range running from mid-line into the next gives the merged block the **earlier**
   line's id.
9. A **copied** line pasted at the start of another leaves every pre-existing line holding its own
   id, with the pasted copy on a fresh one and no duplicate anywhere.
10. A block already in the document carrying **no id at all** (`addAttributes()` defaults `id` to
    `null`, and both earlier defects produced exactly that) is given a real one by the next paste,
    and its absent id is not mistaken for something another block could inherit.

Every one of the ten asserts `projection.valid`, so the canonical schema's uniqueness rule is
checked, not only the ids as this editor sees them.

### Mutation testing

This repo has shipped four assertions that passed with the thing they guarded removed, so **every**
decision in the fix was mutated individually and run against this suite specifically. Six mutations,
six caught:

| Mutation      | What it restores or breaks                                                         | Caught by               |
| ------------- | ---------------------------------------------------------------------------------- | ----------------------- |
| `oldorder`    | `contentHeirPositions` returns an empty map — exactly the old document-order sweep | 5 tests (1, 2, 6, 7, 9) |
| `extremes`    | read the block's outer content boundaries instead of its surviving ones            | 2 tests (6, 7)          |
| `nosurvguard` | let a block with no surviving content claim an heir                                | 1 test (7)              |
| `tailrule`    | the naive "give it to the tail" rule                                               | 2 tests (3, 4)          |
| `idguard`     | let a `null` id in the pre-paste document become an inheritable one                | 1 test (10)             |
| `firstclaim`  | let the later of two claimants on one block win                                    | 1 test (8)              |

Under `oldorder`, every **pre-existing** test in the file stays green — the measured proof that the
suite as it stood did not guard this property at all.

Two of these were caught only after being found to be _uncaught_. A first attempt at test 7 asserted
the right outcome but passed with its guard removed — the outcome was being produced by a different
check — so it was replaced with the selection shape that actually isolates it, found from the
enumeration above rather than by reasoning. Tests 3 and 4 are in the suite for the same reason in
reverse: they do not catch the original defect at all, they catch the plausible wrong fix for it
(`tailrule`), which would have moved a line's id onto pasted text at the other end of the line — the
identical defect, mirrored.

## Unproven

**Whether a real browser's clipboard produces the same slice shape as `pasteHTML` does.** The
tests drive `EditorView.pasteHTML`, which is the real paste pipeline from the HTML string onward:
`transformPastedHTML`, `DOMParser.fromSchema` against this schema, `transformPasted`, and
`tr.replaceSelection`. What they do not exercise is the OS clipboard and the browser's own HTML
parser between the Ctrl+X and that string — so the one assumption is that a real cut's
`text/html` flavour round-trips to the same `openStart 1 / openEnd 1` slice that
`serializeForClipboard` produces here. That assumption is well-founded (the clipboard HTML _is_
`serializeForClipboard`'s output, `data-pm-slice` included, and `parseFromClipboard` reads that
attribute back) but it is an assumption, and it is the gap between this suite and the owner's
actual action. `apps/web/e2e/persistence.spec.ts` already owns a real-browser paste test; extending
it to a real-browser cut-and-paste-at-line-start would close the gap and is not done here.

## The label change

On the revision viewer, **"Back to live document" is now "Back to revisions"**, and the destination
changed with the label: it navigates to the revision history, this route's parent, rather than to
the live editor.

- `apps/web/src/App.tsx` — `HistoricalRevisionInfo.onBackToLiveDocument` renamed to
  `onBackToRevisions`, since the old name no longer described what it does, with its doc comment
  rewritten to say where it goes and why.
- `apps/web/src/routes/projects/$projectId.screenplays.$screenplayId.revisions.$revisionId/index.tsx`
  — the callback now navigates to `/projects/$projectId/screenplays/$screenplayId/revisions`.
- `apps/web/src/test/routeHarness.tsx` — the editor stub now renders the back button, so a route
  test can assert the _destination_ rather than only the label.

The writer's path out is viewer → revisions → editor: the history page already links on to the live
editor ("Back to screenplay"), so the live document is two clicks away rather than unreachable. It
also matches the comparison view, which has had its own "Back to revisions" link since slice 4b.

## Lead verification

**The fix works on the original reproduction**, checked directly rather than through this slice's own
tests:

```
BEFORE  a1:"FIRST LINE"   b1:"SECOND LINE"
BROKEN  a1:"CUT ONE"      39:"CUT TWOFIRST LINE"   b1:"SECOND LINE"
FIXED   0f:"CUT ONE"      a1:"CUT TWOFIRST LINE"   b1:"SECOND LINE"
```

`a1` now follows the writer's own text instead of landing on pasted content, and the pasted content
takes a fresh id.

**Checked end to end, through the diff**, which is where the owner saw the defect. Driving a real
`serializeForClipboard` cut of a line plus its boundary, pasting it at the start of the first line,
then projecting and diffing:

| block                 | before                                                   | after the fix                   |
| --------------------- | -------------------------------------------------------- | ------------------------------- |
| the shifted line      | reported `removed`, with its text reappearing as `added` | **`matched`**                   |
| the lines below it    | unchanged                                                | unchanged (not reported at all) |
| the cut line's old id | `removed`                                                | `removed`                       |

That is the owner's complaint resolved: the merely-shifted line is no longer reported as deleted and
re-added.

**The "it was never guarded" claim is measured, not asserted.** Disabling content inheritance -- one
line, `heirs` forced empty so identity falls back to document order -- fails **5 of 109** tests in
`packages/screenplay-editor`, every one of them new in this slice, while **all 104 pre-existing tests
stay green**. The old code path guarded none of this.

It also confirms the diagnosis correction this slice rests on. The original hypothesis was that the
split tail inherited the target's id, became a duplicate, and was reissued by the dedupe sweep -- so
the fix would be a better tie-break in that sweep. That was wrong for the shape a real cut produces
(`openStart 1 / openEnd 1`), where no duplicate is created at all and the sweep is never consulted.
A tie-break change would have fixed nothing.

**Gates re-run by the lead:** lint 0, format:check 0, typecheck 0, `pnpm test` 0 (screenplay-editor
109, web 868, api 243, collab 128), coverage 0, bundle 0, integration 11 + 58 + 27, `test:system`
40/40.

## A pre-existing flake observed, and deliberately not fixed here

`apps/web/e2e/persistence.spec.ts`'s "pasting content copied from this editor back into the same
document regenerates ids and keeps saving" failed once (`Expected: 2, Received: 1`) and passed on
re-run, 33/33.

The cause is in the test, and it predates this slice: it dispatches its paste after `page.reload()`
**without placing the caret**, so the outcome depends on where the editor happens to leave the
selection on mount. Reproduced deterministically in jsdom -- pasting a copied line at position 0
(a block boundary) yields two blocks, which is what the test asserts; pasting at position 1 (inside
the line's text) merges into one, which is what it saw. Both leave the projection valid with unique
ids, so this is slice-fitting behaviour, not an id defect:

```
pos 0: valid=true ids=[2b,a1] unique=true
pos 1: valid=true ids=[a1]    unique=true
```

That merge/sibling choice is ProseMirror's own, and nothing in this slice touches it -- this pass
only ever reassigns ids. So this is a latent race in that test, surfaced rather than caused.

Not fixed here on purpose: making it deterministic means setting the caret explicitly before the
dispatch, which is a change to a browser test unrelated to block identity, and folding it in would
blur what this branch is for. It is worth its own small fix -- the test currently asserts an
intent ("the pasted copy becomes a second block") that its own setup does not guarantee.

## The actual root cause was the split, not the paste

The owner clarified what he really did, and it was not a cut-and-paste of a line carrying its own
line break:

> "I clicked at the beginning of the top line and hit enter to move it down, and then clicked into
> the top line to paste the line cut from the end. I did this because the elements do not have the
> new line highlighted when you select them, so I had to add it myself to get it to be its own line."

So the identity-destroying event is the **`Enter` at the start of a line**, before any pasting. And
`reconcileBlockIds` is gated on the `paste`/`drop` transactions, so it never saw it.

Measured directly:

```
BEFORE  a1:"TOP LINE"   b1:"SECOND LINE"
AFTER   a1:""           74:"TOP LINE"   b1:"SECOND LINE"
```

`splitScreenplayBlock` builds `preservedBlock` from the prefix and gives it `activeBlock.id`, and
`newBlock` from the suffix with `createStableId()`. With the caret at offset 0 the prefix is **empty**
and the suffix is the whole original line -- so the id stayed on the new empty block and the writer's
text was reissued. A revision diff then reports that line as deleted and re-added, which is exactly
what the owner saw, with no paste involved.

### The fix

The same rule the paste pass already applies: the id goes to the half that keeps the content it was
issued for. `originalIdBelongsToSuffix` is true only when this is a single-block split
(`activeBlock.position === endBlock.position`), the prefix is empty, and the suffix is not.

Deliberately narrow. Across a multi-block selection the surviving suffix comes from `endBlock`, which
has an id of its own, so moving `activeBlock`'s id onto it would be a second identity bug rather than
a fix for this one. Verified: a selection from the start of one block into the middle of the next
leaves the surviving `"ND"` with a fresh id, not the first block's.

Four cases checked, all with every id unique:

| action                         | result                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| `Enter` at the start of a line | empty new block gets a fresh id; the text keeps its own          |
| `Enter` mid-text               | unchanged -- the prefix keeps the id, the suffix is new material |
| `Enter` at the end of a line   | the text keeps its id; the new empty line below is new           |
| `Enter` across two blocks      | no id ever moves onto another block's text                       |

Mutation-tested: forcing `originalIdBelongsToSuffix` to `false` fails exactly one test -- "leaves a
line its own id when Enter at its very start pushes it down" -- and nothing else, 112 others green.

### Why the earlier paste work still belongs here

`reconcileBlockIds` fixes a real, separate instance of the same rule, reproduced independently and
mutation-proved (5 tests fail without it). The owner's report happened to come from the split path,
but both paths had the defect and both are now covered.

## The browser suite is flaky enough to be worth its own slice

Three consecutive `test:system:persistence` runs on the finished branch, same code:

| run | result                                                              |
| --- | ------------------------------------------------------------------- |
| 1   | 31/33 -- both `screenplay-diff-persistence.spec.ts` tests failed    |
| 2   | 32/33 -- `presence-persistence.spec.ts`'s click-through test failed |
| 3   | **33/33**                                                           |

A different test each time, none reproducible, and the first run's failure showed _garbled typed
text_ (`"Added after the milestone.tone."`) -- a typing race in the test, not a product defect. None
of these are caused by this slice: the diff tests do not exercise `Enter` at a line start, and the
presence flake is already documented in `progress/title-page-cursors.md` and
`progress/screenplay-diff.md`.

The point worth acting on is cumulative rather than individual: a suite that fails roughly two runs
in three, with a different test each time, cannot function as a gate. It teaches a reader to re-run
rather than to read, which is the same failure the title-page caret flake was fixed for. The known
offenders are the copy-paste test documented above (caret never placed before the paste), the
presence click-through test, and now the two diff tests. Worth a dedicated pass at the harness rather
than another one-at-a-time fix.
