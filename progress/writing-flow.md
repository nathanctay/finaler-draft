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
*already* contains parentheses, not only against a freshly created one.

No credential may appear in any file you write.

## Rules

Do not stage, commit, merge to `main`, force-push, reset, or create or delete branches or worktrees;
merging `origin/main` into this branch is allowed. No TODO or placeholder comments, no emojis, strict
TypeScript, `.js` extensions on relative imports. Record *why*, citing `plan.md`.

## Checkpoints -- SendMessage to the lead

1. After the parenthetical behaviour works, before starting the element menu: how it stores the
   parentheses, what happens on conversion away, and how double-wrapping is prevented for imported
   text. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.
