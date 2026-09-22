# Enter's borrowed fallback, and the two malformed blocks it could write

Branch `fix/enter-duplicate-ids`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/enter-ids`, off `acd9b82`.

## The defect, as reported

`@tiptap/core` bundles its own built-in `Enter` fallback (`handleEnter` -- a chain of
`newlineInCode` / `createParagraphNear` / `liftEmptyBlock` / `splitBlock`) with **every** `Editor`
instance, regardless of `extensions`. It runs whenever `ScreenplayBlockNode`'s own `Enter` keymap
entry declines (returns `false`). Two ordinary keyboard actions -- no paste, no drop -- reached it:

1. **Enter with the caret at the document's own top level** (position 0, before the first block's
   content -- a real, reachable `TextSelection`, not test artifice; `editing.test.ts`'s
   `selectAtDocumentBoundary`/`selectBeforeFirstBlock` both rely on it, and the paste-sanitisation
   tests already used it as an ordinary paste target). `getActiveBlock`'s depth-walk finds no
   `screenplayBlock` ancestor there (`$from.depth` is 0), so this editor's own `Enter` entry
   declined, and Tiptap's `createParagraphNear` inserted a brand-new `screenplayBlock` via
   `type.createAndFill()` -- which fills every attribute from its schema default, not from
   anything this editor chose. `id`'s default is `null`
   (`ScreenplayBlockNode.addAttributes()`), so the inserted block had no id at all.
2. **Enter with a selection spanning two blocks.** `splitScreenplayBlock`'s own bounds guard
   declined whenever `selection.to` reached past the active block's own end, so this editor's
   `Enter` entry returned `false` again. Tiptap's `splitBlock` deleted the selected range (which
   ProseMirror's join logic merges into one node) and then called `tr.split` on it with no
   explicit node types -- `tr.split`'s documented default when none are given is to copy the split
   node's own type and attrs onto **both** resulting halves, `id` included. Two `screenplayBlock`
   nodes came out sharing one stable id.

Case 1 is worse than it looks: `mapBlock` requires a string id and returns `undefined` for a block
that has none, which makes `projectDocumentScreenplay` return `{ valid: false }` for the whole
document, which makes `App.tsx`'s `scheduleSave` return early -- **autosave silently stops**, with
only a narrow status-bar line as any signal (see `progress/paste-sanitization.md`, which found and
fixed the identical downstream failure from a different cause). That exact failure mode cost two
full sessions of diagnosis earlier in the collaboration slice. Case 2 trips `screenplayIdSchema`'s
uniqueness rule directly: "Stable id ... must be globally unique within a screenplay," which
blocks saving outright with a visible error rather than a silent one, but is just as reachable by
an ordinary keystroke.

Both mechanisms were confirmed by reading the actual library source shipped in this repo
(`node_modules/.pnpm/@tiptap+core@3.23.6/.../src/extensions/keymap.ts`,
`prosemirror-commands@1.7.2/src/commands.ts`, `@tiptap/core`'s `commands/splitBlock.ts`), not
inferred from symptoms, and independently by mutation (see "Mutation-testing report" below).

## Why the existing guard did not catch it

`regenerateDuplicateBlockIds` (`packages/screenplay-editor/src/index.ts`) already repairs
duplicate ids, but its `appendTransaction` was gated on the transaction carrying a `paste`/`drop`
`uiEvent` meta -- deliberately, per its own long comment, because the scan is a whole-document
pass and the comment's stated assumption was "no other edit in this editor copies a block's attrs
onto a second node." That assumption was false, but not because any code _in this file_ violated
it: `@tiptap/core`'s own fallback did, running _as_ an edit in this editor whenever
`ScreenplayBlockNode`'s `Enter` entry declined. And the guard could not have caught case 1 at all
even if widened -- a `null` id is not a duplicate, so `regenerateDuplicateBlockIds`'s `seen`-set
logic has nothing to compare it against; it needed a different fix entirely.

## Where the fix went, and why

**Prevented at the source, in `ScreenplayBlockNode`'s own `Enter` keymap entry and
`splitScreenplayBlock`, rather than repaired after the fact by widening the paste/drop gate.**

The alternative the task laid out -- widen `ScreenplayPasteSanitizer`'s `appendTransaction` gate to
every `docChanged` transaction (or to some more targeted set) and measure the cost -- was rejected
because, once both trigger points inside this editor's own `Enter` handling were precisely
identified, the gate was not the right layer to fix either one:

- It could not have repaired case 1 regardless (null id, not a duplicate).
- Widening it to fix case 2 would still have let the malformed _transient_ state exist for one
  transaction (Tiptap's fallback still runs, still produces the duplicate, and only a second,
  document-wide `appendTransaction` pass would fix it up afterward) -- extra scan cost paid on
  every keystroke for a defect that has a cheap, exact fix at the one place it is created.

So no scan was added and nothing needed measuring: the fix is `O(1)` per keystroke, same as the
code it replaces, and the paste/drop gate is untouched.

**`splitScreenplayBlock`** now handles a selection whose far edge (`$to`) lands past the active
block's own end, instead of declining. `getActiveBlock`'s depth-walking logic was factored out
into a shared `blockAt(pos: ResolvedPos)` so the function can look up the block containing
`selection.$to` (`endBlock`) the same way it already looks up the block containing `$from`. The
split is then the same prefix/suffix operation as the single-block case, just reading the suffix
from `endBlock`'s text instead of `activeBlock`'s, and preserving `endBlock`'s own element (or
replacing it with the conventional next element, by the same "at its end" rule) rather than
`activeBlock`'s. `preservedBlock` always keeps `activeBlock`'s own id; `newBlock` always mints a
fresh one with `createStableId()` -- there is no path through the function that can produce a
duplicate. Any block strictly between `activeBlock` and `endBlock` sits inside the replaced range
and is removed entirely, id included, which is exactly what "the writer selected across several
elements and pressed Enter" should do. The single-block path is unchanged in behaviour (`endBlock
=== activeBlock` collapses the new arithmetic back to the original computation exactly), and every
pre-existing `Enter` test still passes unmodified.

**`ScreenplayBlockNode`'s `Enter` entry** now:

- Returns `true` **unconditionally** whenever `getActiveBlock` finds an active block, regardless of
  what `splitScreenplayBlock` reports, rather than passing its return value straight through. This
  is deliberately stronger than "handle the two known cases": once the caret is inside a real
  block, Enter must never again fall through to Tiptap's fallback, even via some
  `splitScreenplayBlock` guard not yet known to be reachable. A defensive guard inside
  `splitScreenplayBlock` returning `false` now means "swallow the keystroke," never "hand it to a
  fallback that can corrupt the document."
- Returns `true` (claiming the key, dispatching nothing) at the document's own top-level boundary,
  instead of `false`. Tab and Space already decline and leave the document untouched at this exact
  position (`editing.test.ts`'s "Tab and Space decline to act at the document boundary" test, kept
  unchanged); Enter now reaches the identical outcome -- document untouched -- but by claiming the
  key rather than declining it, since declining is what let Tiptap's fallback act instead.

## The null-id case and the duplicate-id case are handled by two different mechanisms

They are different defects and were fixed differently, as the task called out:

- **Null id** (case 1): there is nothing to "regenerate" -- the fix is to never let the malformed
  block get created in the first place, by claiming Enter at the document boundary instead of
  declining it.
- **Duplicate id** (case 2): `splitScreenplayBlock`'s existing single-block logic already minted a
  fresh id for every new half it created; extending that same logic to the cross-block case, rather
  than falling through to a generic `tr.split` with no explicit types, is what keeps every id
  distinct.

`regenerateDuplicateBlockIds`'s paste/drop gate did not need to change for either.

## Is Tiptap's fallback reachable by any other key?

Checked directly against `@tiptap/core`'s `Keymap` extension source
(`extensions/keymap.ts`), which is bundled unconditionally alongside `ScreenplayBlockNode` and
binds far more than `Enter`: `Mod-Enter`, `Backspace`, `Mod-Backspace`, `Shift-Backspace`,
`Delete`, `Mod-Delete`, `Mod-a`, and (on macOS) `Ctrl-h`, `Alt-Backspace`, `Ctrl-d`,
`Ctrl-Alt-Backspace`, `Alt-Delete`, `Alt-d`, `Ctrl-a`, `Ctrl-e`. None of those reach the
document-mutating chain this defect lives in:

- `Mod-Enter` maps to `exitCode` only, not `handleEnter`'s chain.
- Backspace/Delete (all their variants) map to `deleteSelection` / `joinBackward` /
  `joinForward` / `selectNodeBackward` / `selectNodeForward` / `undoInputRule` / `clearNodes` --
  none of which construct a new node by copying an existing node's type and attrs onto a second
  position the way `createParagraphNear`, `liftEmptyBlock`, and `splitBlock` do.
- `Mod-a` / `Ctrl-a` / `Ctrl-e` only change the selection.

So `createParagraphNear` / `liftEmptyBlock` / `splitBlock` -- the three commands capable of
producing a null-id or duplicate-id `screenplayBlock` -- are reachable **only** through the literal
`Enter` key in this editor, and the fix closes that one door completely (see the "unconditional
`true`" point above) rather than leaving others.

## Tests

`packages/screenplay-editor/src/editing.test.ts` had a comment (in the "no active block" describe
block and directly above where the cross-block case would have been tested) explaining that a
previous coverage pass deliberately declined to write tests asserting the buggy behaviour as
"expected." Both comments are now replaced with the tests they described withholding, driven
through the real keymap (`someProp('handleKeyDown')`, the same path every other `Enter` test in the
file uses):

- **`no active block > claims Enter at the document boundary, leaving the document untouched
rather than inserting a null-id block`** -- two-block document, caret set to position 0 via
  `selectAtDocumentBoundary`, presses Enter, asserts `handled === true`, the block list is
  byte-for-byte unchanged, and both ids are still their original strings.
- **`Enter across a selection spanning two blocks > splits at the selection boundary without
duplicating either block's id`** -- two action blocks (`"ABCDE"`, `"FGHIJ"`), a selection from
  offset 2 of the first to offset 3 of the second (spanning the block boundary), presses Enter,
  asserts `handled === true`, the resulting two blocks are `"AB"` and `"IJ"`, every id is a string,
  the two ids are distinct, the first is still `block-0`, and neither equals the original
  `block-1` (which sat entirely inside the replaced range and is gone).

A new `idsOf(editor)` helper (beside the existing `blocksOf`) reads every top-level block's raw
`id` attribute, untyped (`unknown[]`), so a test can see a `null` id directly rather than have it
coerced away.

### Mutation-testing report

Reverted the fix, confirmed the exact failures the defect described, restored, then repeated with
two isolated single-line mutations to confirm each new test is sensitive to its own fix and not
riding on the other's.

| #   | Mutation                                                                                                                                                                                                            | Result                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | Full revert of `packages/screenplay-editor/src/index.ts` to `main` (tests kept)                                                                                                                                     | **Both new tests killed.** The boundary test failed with a third, empty-text, `action` block inserted (the null-id block); the cross-block test failed with `Set` size 1 on the two resulting ids (the duplicate).                                                                                                                   |
| M2  | Only the document-boundary `return true` reverted to `return false`, cross-block fix left intact                                                                                                                    | Killed exactly the boundary test (extra block inserted); the cross-block test still passed, unaffected.                                                                                                                                                                                                                              |
| M3  | Only `splitScreenplayBlock`'s cross-block branch reverted to the old declining bounds check (`selection.to > activeBlockContentEnd` returns `false`), boundary fix and the unconditional-`true` wrapper left intact | Killed exactly the cross-block test (Enter became a silent no-op instead of splitting -- a different failure shape than M1's duplicate id, because the unconditional-`true` wrapper now prevents the fallback from running at all, but still a real, test-visible failure: the selection was never split). Boundary test unaffected. |

All three mutations restored and the full `editing.test.ts` suite reconfirmed green (45/45) after
each restoration.

## Gate results (all from the worktree, `TEST_DATABASE_URL` substituted exactly as specified)

1. `pnpm lint` -- clean, exit 0.
2. `pnpm format:check` -- clean, exit 0 (one file needed `prettier --write` mid-session for the
   import-line wrap and a quote-style pick on an apostrophe in a test name; both re-verified clean
   afterward).
3. `pnpm typecheck` -- clean across every package and every app (`apps/web`, `apps/api`,
   `apps/collab`, `apps/landing`), exit 0.
4. `pnpm test` -- exit 0. Every workspace green: `packages/screenplay-editor` 56/56 (up from 54,
   the two new tests), `apps/api` 158 passed / 39 skipped, `apps/collab` 36 passed / 6 skipped,
   `apps/web` 608/608, every other package unchanged and green.
5. `pnpm test:coverage` -- exit 0. `packages/screenplay-editor`: 96.5% statements / 90.71% branch /
   93.47% functions / 96.5% lines (from a 96.67%-statements baseline cited going in; the ~0.17-point
   drop is the new defensive guards -- `blockAt`'s "not found" branch inside
   `splitScreenplayBlock`, mirroring the sibling `if (!activeBlock)` / `if (!existingNode)` guards
   immediately above it, which were already uncovered by the same design convention before this
   fix). Threshold is 80% across the board; comfortably clear. The three uncovered line ranges
   reported (`501-502`, `646-647`, `836-837`) are all pre-existing, unrelated defensive branches
   (an `Unsupported screenplay block` throw in `editorContentFromScreenplay`, the
   `!newBlock`-on-empty-document guard, and `regenerateDuplicateBlockIds`'s own non-`screenplayBlock`
   early return) -- none are new.
6. `pnpm check:bundle-budget` -- exit 0. Entry 111.65 / 120 kB, lazy editor chunk 140.18 / 200 kB,
   CSS 6.31 / 20 kB -- all unchanged from before this fix (this change ships no new runtime cost
   to the bundle; the added code is a few branches inside an existing keymap handler).
7. `TEST_DATABASE_URL=... pnpm --filter @finaler-draft/api test:integration` -- exit 0, 39/39
   passed (`persistence.integration.test.ts` 19, `stripeSubscriptions.integration.test.ts` 11,
   `entitlements.integration.test.ts` 9).
8. `TEST_DATABASE_URL=... pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 6/6
   passed.
9. `TEST_DATABASE_URL=... pnpm test:system:persistence` -- exit 0, 18/18 passed, matching the
   baseline exactly. Checked ports 3001/4173-4175/5173/4400 for listeners before and after; none
   found either time, so nothing needed killing.

`git diff --check` clean throughout (no whitespace issues introduced).

## What was rejected

- **Widening `ScreenplayPasteSanitizer`'s `appendTransaction` gate** to `docChanged` generally, or
  to some Enter-specific transaction shape. Once both trigger points were precisely located inside
  this editor's own `Enter` handling, there was no longer a reason to pay for a whole-document
  repair pass on every keystroke (or even on every Enter) when the exact, cheap fix lives at the
  one place the malformed node would otherwise be created. Documented directly in
  `regenerateDuplicateBlockIds`'s own long comment, which previously asserted "no other edit in
  this editor copies a block's attrs onto a second node" -- a claim that had one real exception
  (Tiptap's fallback, running as an edit in this editor) and now, after this fix, has none.
- **Letting `splitScreenplayBlock` return `false` on any path once `ScreenplayBlockNode`'s `Enter`
  entry has confirmed an active block exists.** Its own remaining `return false`s (the
  `!existingNode` guard, the `selection.from < blockContentStart` guard, the new `!endBlock`
  guard) are all defensive and, as far as could be established, unreachable given how `Enter`
  calls it -- but the `Enter` entry no longer trusts that analysis blindly. It forces `true`
  regardless, so even an as-yet-unknown gap in that reasoning degrades to an inert keystroke, never
  to Tiptap's fallback.
