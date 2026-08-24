# Writing-flow behaviours

Branch `feature/writing-flow`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/writing-flow`.

## Why this scope exists

`plan.md`'s "Writing-flow behaviours borrowed from Final Draft" -- four behaviours the owner observed
directly in Final Draft 13 and asked for, sharing one purpose: **an element should never be able to
sit empty and unlabelled.** A blank block with an arbitrary inherited type is a formatting error the
writer has to notice and undo later, and it is not only cosmetic: an empty block still occupies a
line, so a stray one silently shifts every page after it and the page count with it.

Read that section in full before starting. It is short and every sentence is load-bearing.

## The four, and the order to take them

1. **Parentheticals own their parentheses.** Creating a parenthetical inserts `()` with the caret
   between them, and they cannot be deleted while the block is a parenthetical. Converting away from
   parenthetical removes them rather than stranding them in the text. **This is the one the owner
   asked for by name, and the one to be most careful with**, because it is the only one that writes
   characters into the canonical model: the parentheses are authored text once stored, so they
   round-trip, they export, and the wrapping must never be applied twice to a parenthetical that
   already has them -- including one arriving from FDX import, where they are already in the text.
2. **A line cannot begin with a space.** Indentation belongs to the element and is defined by the
   character grid; a leading space is either a mistake or an attempt to hand-indent something the
   format already positions.
3. **A second Enter opens an element menu** rather than stacking another empty block, with
   single-key shortcuts, and Enter again closes it. The writer is never trapped in it.
4. **An element cannot be left empty**: choosing a type and pressing Enter on a still-empty block
   re-opens the menu instead of creating another empty one.

They need not all land together -- `plan.md` says so explicitly. If 3 and 4 prove larger than they
look, stop after 1 and 2 and report; a smaller slice that works beats a bigger one that half does.

## Also in scope, a small correction with evidence

`(MORE)` and `CONT'D` render at different weights today: `styles.css` bolds `.page-break-continued`
on the reasoning that CONT'D repeats a character cue, while `(MORE)` stays regular. The owner
reported the inconsistency and doubted it was standard. **His own Final Draft reference file settles
it**: `packages/fdx/fixtures/final-draft-13-reference.fdx`'s `<MoresAndContinueds>` carries a single
`<FontSpec ... Style=""/>` covering both, so Final Draft renders them uniformly and unbolded. Make
them consistent, cite that fixture in the comment, and note that these are generated page-break
furniture rather than authored cues.

## Out of scope

SmartType. The Characters tab. Zoom. Anything in `packages/layout` -- these are editor-input
behaviours and must not change where pages break.

## Verification

The full gate list, `pnpm format:check` after the progress entry, and the persistence gate three
times. `main` is green.

**The canonical round-trip test (`apps/web/src/canonicalRoundTrip.test.ts`) is the thing most likely
to catch a mistake here, and it must stay green untouched.** If parenthesis handling breaks the
identity property, that suite is where it will show, and its failure means the fix is wrong -- not
that the test needs adjusting.

Mutation-test every behaviour: break it, confirm the test fails, restore, report. The likeliest
vacuous test here is the double-wrapping guard -- assert against a parenthetical whose text
_already_ contains parentheses, not only against a freshly created one.

No credential may appear in any file you write.

## Rules

Do not stage, commit, merge to `main`, force-push, reset, or create or delete branches or worktrees;
merging `origin/main` into this branch is allowed. No TODO or placeholder comments, no emojis, strict
TypeScript, `.js` extensions on relative imports. Record _why_, citing `plan.md`.

## Checkpoints -- SendMessage to the lead

1. After the parenthetical behaviour works, before starting the element menu: how it stores the
   parentheses, what happens on conversion away, and how double-wrapping is prevented for imported
   text. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

## 2026-08-23 -- implementation agent -- implemented and verified

Status: complete for behaviours 1 and 2, plus the (MORE)/CONT'D correction. Behaviours 3 and 4 (the
element menu) deliberately not started -- see "Known limitations" below.

### What shipped

**Parentheticals own their parentheses** (`apps/web/src/screenplayEditor.ts`,
`convertActiveScreenplayBlock`): converting a block's element crosses the parenthetical boundary in
either direction now also edits its text. Converting _to_ parenthetical wraps the block's current
text in `()`, unless `isParenWrapped` already finds a leading `(` and trailing `)`. Converting
_away_ strips a leading `(` and trailing `)`, but only when `isParenWrapped` finds both present.
Caret position is preserved relative to the text on both sides of the edit (between the two parens
for a freshly wrapped empty block, matching the owner's original ask). No new schema field and no
ProseMirror attribute: the parentheses are plain characters in the block's existing text content,
written by one `insertText`/`delete` pair inside the same transaction as the `setNodeMarkup` that
changes the element, and read back out by the same `node.textContent` path every other block's text
already goes through.

**This design changed mid-implementation, and the pivot matters more than the diff.** The first
pass (reported at checkpoint 1) additionally tried to make the two parentheses undeletable while the
block remained a parenthetical: dedicated `Backspace`/`Delete` keymap entries computed whether a
keypress would remove a boundary character and swallowed it if so. The lead reviewed that design and
asked for something simpler: once written, the parentheses are ordinary authored text, full stop --
selectable, deletable, exportable, indistinguishable from anything else the writer types. That is
better, not merely smaller, for two reasons. First, enforcing "undeletable" inside a real
`contenteditable` means intercepting every path that can remove text separately -- Backspace, Delete,
a range selection replaced by typing, a paste that overwrites the selection -- each one its own bug
surface, and a Backspace keypress that silently does nothing reads as a broken editor, not a
respected rule. Second, and more fundamentally: `packages/screenplay`'s canonical schema stores a
parenthetical block as `{ id, type: 'parenthetical', text: string }` -- one plain string, with no
concept of element-owned punctuation living inside it. The original design was enforcing a structure
the canonical model does not have, which is exactly the kind of mismatch this scope's own hard-part
warning (parentheses become part of the canonical model) was warning against. The simpler rule works
_with_ that model instead of against it: a single `isParenWrapped` check, consulted only at the
moment of conversion, serves both directions, and it is also what makes an FDX-imported
parenthetical ordinary rather than a special case -- its text already satisfies the check, so nothing
about import needs to know this rule exists. The `wouldDeleteParenthesisBoundary` helper, its two
keymap entries, and the tests written against them were all removed; `git diff` against `main`
carries no trace of that design except two comments that now explain, briefly, why nothing
intercepts `Backspace`/`Delete` -- the right kind of mention, not dead code.

**The strongest evidence the simplification was correct, not just smaller**: `canonicalRoundTrip.test.ts`
has a zero diff. `mapBlock` and `editorContentFromScreenplay` -- the two functions that move a
screenplay between canonical and editor form -- are untouched. Because the parentheses are ordinary
text, the round trip needed no special-casing at all: a parenthetical loaded directly (today's only
route for pre-existing "()"-shaped text, and FDX import's eventual one) round-trips exactly as
before, wrapped or not, including the pre-existing "leading whitespace" parenthetical case that
never touches the wrap/unwrap logic at all. All 84 of that suite's cases stayed green throughout,
unmodified.

**A line cannot begin with a space** (`ScreenplayBlockNode.addKeyboardShortcuts`, new `Space`
entry): blocks a space keypress whenever it would land at content-relative offset 0 of the active
block -- a collapsed caret at the very start, or a range selection starting there. Only the typed
keystroke is guarded; a screenplay loaded with existing leading whitespace is untouched, since
nothing outside this one keymap entry runs.

**(MORE)/CONT'D weight correction** (`apps/web/src/styles.css`): removed `.page-break-continued`'s
`font-weight: 700`, citing `packages/fdx/fixtures/final-draft-13-reference.fdx`'s single, unstyled
`<MoresAndContinueds><FontSpec ... Style=""/>` covering both `(MORE)` and `CONT'D`. Also updated the
pre-existing e2e assertion in `apps/web/e2e/page-rendering.spec.ts` (`(MORE) and CONT'D render at the
character indent...`), which had directly asserted the old, incorrect `700` -- it now asserts both
render at the same weight and that weight is `400`, with a comment explaining the correction rather
than silently changing the expected value.

**plan.md** ("Writing-flow behaviours borrowed from Final Draft"): rewritten, not layered. The
"Parentheticals own their parentheses" bullet and the paragraph beneath it now state the
wrap-on-creation/unwrap-on-conversion rule and the asymmetric-strip consequence (a writer can delete
just one paren, leaving `(beat` or `beat)`, which conversion-away then leaves alone). The old
"cannot be deleted" wording is gone.

### Mutation-testing report

All four behaviours load-bearing enough to matter were broken, confirmed to fail the exact test
built for them, then restored and reconfirmed green.

1. **Double-wrap guard** (`isParenWrapped` forced to always return `false`). Failed "does not wrap
   text that already begins and ends with parentheses" -- `(already wrapped)` became
   `((already wrapped))`. Also failed "strips both parentheses on conversion away" -- the guard
   gates both directions, so the strip branch stopped firing too and `(to herself)` stayed
   `(to herself)` instead of becoming `to herself`. Restored; green.
2. **"Both present" guard on the strip branch** (dropped the `isParenWrapped(activeBlock.text)`
   condition from the unwrap `else if`, leaving only the element checks). This is the guard the
   scope file itself flagged as the likeliest vacuous test. Failed all three asymmetric-case tests:
   `(beat` -> `bea` (the unconditional strip removed a trailing _letter_, since there was no real
   `)` to remove -- it deleted whatever character was actually last), `beat)` -> `eat`, and
   `no parens here` -> `o parens her`. Every case corrupted real authored text rather than leaving it
   alone. Restored; green.
3. **Wrap insertion** (dropped the closing-paren `insertText` call, keeping only the opening one).
   Failed both wrap tests: an empty block produced `(` instead of `()`, and `to herself` became
   `(to herself` instead of `(to herself)`. Also failed the Tab-keymap test for the same reason.
   Restored; green.
4. **Space guard** (`Space` handler's condition short-circuited to always `return false`). Failed
   both leading-space tests -- a space was typed at offset 0 instead of blocked, and a range
   selection starting at offset 0 typed one too. Restored; green.
5. **(MORE)/CONT'D weight correction** (reintroduced `font-weight: 700` on `.page-break-continued`
   in `styles.css`, rebuilt, reran the affected spec alone). Failed the updated e2e assertion at the
   exact line comparing `continuedFontWeight` to `moreFontWeight`/`'400'` -- received `700`.
   Restored, rebuilt, reran full `test:system`; green.

Every mutation reproduced the exact failure its corresponding test exists to catch, with a message
naming the actual broken behaviour. `git diff` against the pre-mutation state was checked identical
after each restore.

### Gate results (all commands run from the worktree)

1. `pnpm typecheck` -- clean across every package and both apps.
2. `pnpm lint` (`eslint . --max-warnings=0`) -- clean, no output, exit 0.
3. `pnpm test:coverage` -- exit 0, all packages. `apps/web`: 30 files, **341 tests passed** (up from
   330 before this slice), `screenplayEditor.ts` at 96.1%/90.29% stmt/branch (the uncovered lines are
   pre-existing, unrelated to this slice's additions). Every other package unchanged and passing.
4. `pnpm build` -- succeeded for all packages and both apps. Vite's default >500kB uncompressed-chunk
   warning still fires on `App.js` (810kB / 298.71kB gzip); unrelated to this slice (pre-existing) and
   explicitly not to be suppressed per the worktree instructions. Worth flagging on its own: this
   exceeds plan.md's documented 200kB-gzip "Lazy editor chunk" budget, but no CI script in this repo
   currently enforces that budget as a build-failing check -- `pnpm build`'s exit code is unaffected,
   and this slice added roughly 90 lines to one already-loaded file, not a new dependency.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 23 passed, including the corrected (MORE)/CONT'D
   weight assertion.
6. `PLAYWRIGHT_CHANNEL=chrome TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/finaler_draft
pnpm test:system:persistence` -- run **three times**, 11/11 passed every time.
7. `git diff --check` -- clean, no whitespace errors.
8. `pnpm format:check` -- run after this entry was written (see below).

### Known limitations / things not done

- **The element menu (behaviours 3 and 4) is deliberately unstarted.** Not an oversight: the lead
  judged that a new interactive surface changing what Enter does deserves its own slice rather than
  being appended to a branch already landing a different, finished piece of work, and `plan.md`
  explicitly allows the four behaviours to ship separately. Nothing in this slice's changes assumes
  or blocks the element menu -- `nextElementOnEnter`, `splitScreenplayBlock`, and the `Enter` keymap
  entry are all untouched.
- **No paste-time sanitisation of a leading space.** The "line cannot begin with a space" guard only
  intercepts a typed `Space` keypress; pasting text that already begins with a space is unaffected,
  matching plan.md's framing of the rule as being about typing/hand-indentation, not a blanket
  content constraint (and matching `canonicalRoundTrip.test.ts`'s "leading whitespace" samples, which
  require existing leading whitespace to keep round-tripping unmodified).
- **A writer can leave a parenthetical block asymmetric** (`(beat` or `beat)`) by deleting just one
  paren as ordinary text; converting away then leaves that text exactly as typed rather than
  stripping the surviving parenthesis. This is the deliberate consequence of the simplified design,
  not a bug -- see the pivot explanation above.
- **No CI-enforced bundle-size budget** exists in this repo for the "Lazy editor chunk" gzip figure
  plan.md documents; the build gate does not fail on it either before or after this slice. Noted, not
  fixed -- out of this scope, and pre-existing.
