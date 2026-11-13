# Find and replace

Menus slice 4, and the last of the Edit menu's planned items. `Edit > Find and replace…` (or `Mod-f`)
opens a bar over the live editor: a query, every match highlighted with the current one
distinguished, a count, next/previous navigation, Replace, Replace all, and a case-sensitivity
toggle.

## Scope, and what was deliberately left out

**In:** find, highlight all, current-match distinction, count, next/previous with wraparound,
replace one, replace all, case sensitivity.

**Out, deliberately:** regex and whole-word matching. Both are plausible next steps and neither was
built, because the owner scoped this slice to the one-at-a-time workflow and widening it would have
traded that for breadth. Regex in particular is not a small addition here: it changes what a "match
length" is, which the replacement-position arithmetic below depends on.

**Out, structurally:** the title page. It lives in `titlePageState`, not in the editor document this
operates on, so it is outside the document being searched entirely. This is worth flagging as a real
limitation rather than a technicality -- a writer searching for a character name will reasonably
expect the title page to be covered, and today it is not. Including it means searching two stores
with different shapes and reconciling one match list across them, which is its own slice.

## Matches are found by walking text, because blocks are plain text

`screenplayBlock` is `content: 'text*'` and every block is built with a single text node, with no
inline marks anywhere in the screenplay model. So a match never spans marks and never needs
mark-splitting -- the usual hard part of find/replace in ProseMirror simply does not arise here.
Matching runs per block over that block's own text string.

A match never spans a block boundary. A screenplay line is a unit, and a match crossing two lines
has no meaningful replacement.

**`prosemirror-search` was deliberately not added.** Given flat plain-text blocks, walking
`doc.descendants` is both simpler than adapting a general-purpose search plugin and avoids a new
dependency while the owner's dependency/licence review is still an open launch item. The whole
matching core is one file, `findReplace.ts`, with no new packages.

## Highlights live outside the document

Match highlights are `Decoration`s in a `DecorationSet` held in plugin state, never nodes or marks
in the document. This follows `smartTypeGhost.ts`, which keeps its ghost text the same way and for
the same reason: the canonical projection, Yjs, every export and the revision diff must never see
them. A highlight is a view-layer fact about a search session, not content.

That also means highlights cost nothing to a collaborator -- they are local to the searching
writer's own view and never sync.

## Replace goes through the editor, and replace-all is one undo step

The document is a Yjs projection, so a replace applied any other way would not sync to other
writers, would not enter the undo stack, and would not trigger the canonical projection. Every
replace is an ordinary editor transaction.

**Replace all applies every match in a single transaction**, so it is one undo step: a writer who
replaces forty occurrences and presses `Mod-Z` gets forty reversed, not one.

**One-at-a-time replaces are deliberately separate undo steps.** Each was a separate writer action,
and coalescing them would make the undo stack lie about what the writer did.

### Position shifting

Applying matches left-to-right invalidates every later position as soon as a replacement differs in
length from the search term. Tests cover a replacement **longer** than the term and one **shorter**,
because an off-by-one in the mapping only shows in one direction and a same-length test would pass
against a broken implementation.

## The one-at-a-time workflow

The owner asked for this explicitly after the slice was briefed, and it is the behaviour the slice is
really about: _"you should be able to use find to cycle through all occurrences and replace one at a
time."_ Four properties, each with its own test:

1. **Replace advances.** Replacing applies the current match and moves to the next, so repeated
   Replace presses walk forward without touching Find next in between.
2. **Skipping works.** Find next steps past an occurrence, and Replace then acts on wherever the
   writer now is -- so "replace this, skip two, replace the fourth" is supported by design.
3. **The count stays honest, including when the replacement contains the search term.** Replacing
   `"foo"` with `"foobar"` would, under a plain re-scan, find the term again inside the text just
   inserted -- walking forward forever, or reporting a count that grows with every replace.
   `replacedRanges` tracks every span this module has itself inserted during the current search
   session, carried forward through later edits' own position mapping, and subtracts them from the
   match list **before the count and the highlights are built**, not merely before advancing. So
   "17 matches" never silently becomes 18. A later, unrelated `"foo"` typed by the writer is still
   found and still replaceable -- the exclusion is of spans this search session produced, not of the
   text pattern.
4. **Wrapping.** Next, Previous, and the advance-after-Replace all wrap at either end rather than
   stopping. Deliberate: a writer who reaches the end of a long script and wants the occurrence they
   skipped near the top should not have to reopen the search.

## Opening with a selection seeds the query

Requested by the owner after the first pass: _"when a user has something highlighted and hits
command + f, it should auto populate the find with the portion that was highlighted."_ Standard
editor behaviour, and `findReplaceQuerySeed` decides it. Three cases, each deliberate:

- **A selection inside one block seeds its text, untrimmed.** Not trimmed, because trimming would
  search for something other than what the writer highlighted -- selecting two spaces and searching
  for two spaces is a legitimate thing to want, and there is a test for it.
- **A collapsed selection seeds nothing**, leaving any existing query alone. There is nothing to
  search for, and opening the bar should not blank a query in progress.
- **A selection spanning block boundaries seeds nothing.** This is the case worth explaining. A
  match in this module never spans blocks, so seeding a cross-block selection would open the bar
  with a query that **cannot** match by construction -- reporting "no results" for text the writer
  can plainly see in the document. `textBetween` is called with a `\n` block separator specifically
  so this case is detectable rather than silently flattened into an unmatchable string.

Both entry points -- `Mod-f` and the Edit menu item -- go through one handler, so highlighting a word
and reaching for either gets the same result. Two implementation details that are not obvious:

- **The seed is read inside the keyboard shortcut**, from the editor's own state at the moment the
  key fires, not later in `App.tsx`. By the time React has re-rendered the bar and focused its
  input, the selection the writer had is no longer what the view reports.
- **The menu route reads ProseMirror's selection, not the DOM's.** Opening a menu moves focus to its
  trigger and the browser selection goes with it, while ProseMirror's own selection state persists.

### Mutation

| Mutation                                              | Test it killed                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Seed cross-block selections too (drop the `\n` check) | "seeds nothing when the selection spans two blocks" -- `expected 'First line.\nSecond line.' to be undefined` |

That test also guards its own non-vacuity: it asserts the selection really does span both blocks
before asserting the seed is `undefined`, so it cannot pass because the selection was narrower than
intended.

### One bug worth recording from writing this

Wiring the extension as `onOpen: openFindReplaceBar` -- passing the handler by reference -- is a
temporal-dead-zone `ReferenceError`: the `configure` call runs in the component body _before_ the
handler's `const` is initialised. It needs an arrow (`onOpen: (seed) => openFindReplaceBar(seed)`)
to defer the lookup to call time. Typecheck does not catch it, and nor would a test that never
mounts the editor.

## Find and Replace are gated differently

Find carries **no** `editingAllowed` gate: a reviewer, or an account whose entitlement has lapsed,
may search a document they cannot edit. Searching reads nothing it is not already allowed to read.

**Replace and Replace all are gated**, with a `disabledReason`, exactly as the File menu's export
items are. A reviewer may search but not rewrite.

## Two invariants verified rather than assumed

**Block ids do not change.** A block id belongs to its text and must follow it; a replace that
reissued ids would make a revision diff report untouched lines as removed-and-re-added.
`reconcileBlockIds` is gated on paste/drop transactions, so an ordinary replace should not disturb
ids -- asserted rather than reasoned about.

**Pagination recomputes.** Replacing text changes line wrapping and therefore page breaks, so a
replace must leave the page count correct rather than stale.

## Both themes

Highlight colours are measured in a real browser against **their own resolved background**, not an
ancestor's, with cases added to `text-contrast.spec.ts` for `.find-match` and `.find-match-current`
under both themes. That specific framing matters because of two earlier regressions on this project:
an open menu rendered near-white on white, and a later "fix" setting `color` on `.dialog` drove all
eight dialogs' action buttons from 8.4:1 to 1.489:1 -- both because "stays light in both themes" was
treated as a property of a container rather than of each surface. The sheet a match sits on stays
white in both themes, so the highlight must be legible there specifically.

## Mutation testing

| Mutation                                                           | Test it killed                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Stop filtering already-replaced spans out of the match list        | both "replacement contains the search term" tests -- the count grows and replace-all reports leftovers |
| Ignore the advance anchor, restart the current match at position 0 | "advances to the match after the one just replaced" -- `expected +0 to be 2`                           |

Each mutation asserted an exact match count of 1 before being applied.

### A test gap the second mutation exposed

The anchor mutation initially **passed all 25 tests**. Every sequence test replaced matches starting
from the beginning of the document, where the match following the one just replaced _is_ the first
remaining match -- so they could not distinguish "resume from my own insertion point" from "restart
at position 0".

The distinguishing case is replacing a match in the **middle**: walk to the 3rd of four, replace it,
and the current match must become the 4th rather than the 1st. Restarting at 0 would silently throw
away the writer's position in the document, which on a feature-length script is the difference
between a usable tool and an infuriating one. That test now exists, fails under the mutation, and is
what makes the anchor load-bearing.

This is worth recording as a pattern, not just a fix: a sequence test that always starts from the
first element tends to be blind to ordering bugs, because index 0 is where a broken implementation
lands anyway.

## Gate results

The implementing agent was stopped by an infrastructure limit before finishing its own verification
and before writing this document. Everything below is the lead's own run.

| Gate                           | Result                                                |
| ------------------------------ | ----------------------------------------------------- |
| `pnpm lint`                    | exit 0                                                |
| `pnpm typecheck`               | exit 0                                                |
| `pnpm test`                    | exit 0 -- `apps/web` **1252 tests / 80 files**        |
| `pnpm test:integration`        | exit 0                                                |
| `pnpm test:coverage`           | exit 0 -- `findReplace.ts` 99.18 / 99 / 95.65 / 99.18 |
| `pnpm build`                   | exit 0                                                |
| `pnpm check:bundle-budget`     | exit 0 -- lazy editor chunk 171.16 / 200.00 kB        |
| `pnpm test:system`             | exit 0, **113 passed**                                |
| `pnpm test:system:persistence` | 1 failure, the known flake -- see below               |
| `pnpm format:check`            | exit 0, bare and last                                 |

`test:system:persistence` failed once on `screenplay-diff-persistence.spec.ts:82` with the documented
signature exactly: `"Added after the milestone.tone."` where `"Added after the milestone."` was
typed, a race inside `page.keyboard.type`. Re-run alone three times: **3/3 pass**. Attributed to the
known flake on the strength of the signature plus the clean re-runs, not on the signature alone.

Isolated Postgres on port 55471, deliberately not 5432 (the owner's own development database).
Removed afterwards.

## Known limitations

- **The title page is not searched** (see scope above). The most likely thing a writer notices.
- **No regex, no whole-word.**
- **Highlights are local.** A collaborator sees nothing of another writer's search, which is correct
  but worth stating since presence is otherwise shared in this editor.
- **Replace all's undo is one step by design**, which means a writer cannot undo _part_ of a replace
  all. That is the conventional behaviour and was chosen deliberately.
