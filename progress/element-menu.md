# The element menu

Branch `feature/element-menu`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/element-menu`,
off `7c836af`.

## Why this scope exists

`plan.md`'s writing-flow behaviours **3** and **4** -- the two `progress/writing-flow.md` deliberately
left unstarted, on the lead's judgement that a new interactive surface changing what `Enter` does
deserves its own slice.

> A second Enter opens an element menu rather than creating another empty block. [...] Pressing
> Enter again with the menu open closes it; the writer is never trapped in it.

> An element cannot be left empty. Choosing a type for an empty block and pressing Enter re-opens
> the menu rather than creating a further empty block.

One purpose behind both: **an element should never sit empty and unlabelled.** A blank block with an
arbitrary inherited type is a formatting error the writer has to notice and undo later, and it is not
cosmetic -- an empty block still occupies a line, so a stray one shifts every page after it and the
page count with it.

## 2026-08-26 -- implementation agent -- implemented and verified

Status: complete. Both behaviours shipped, plus one pre-existing save-breaking defect this feature
exposed and which had to be fixed for the suite to be green (see "The paste defect this uncovered").

### What shipped

**`apps/web/src/elementMenu.tsx`** (new) -- a floating listbox at the caret, plus the extension that
owns its keys. Mounted from `App.tsx` beside SmartType's two layers, at the application root and
outside `.page`.

**The rule is "the block at the caret is empty", not "the previous keystroke was Enter".** This is
deliberately wider than behaviour 3's wording, and it is the single decision the whole design rests
on:

- Behaviour 4 falls out with no machinery of its own. Choosing `Character` for an empty block leaves
  it empty, so the next `Enter` is again "Enter at an empty block" and the menu opens again.
- Provenance would have had to be tracked in plugin state, could be lost by any transaction, and
  answers "how did you get here?" when the question the writer is actually asking is "what is this
  line?".
- It also fixes a smaller thing on the way: a brand-new screenplay opens with one seeded empty
  `action` block (`App.tsx`'s `editorContent` fallback), and `Enter` there used to split it into two
  empty blocks. Three e2e tests were opening with exactly that keystroke; the comment already in
  `page-rendering-persistence.spec.ts` called it out as a hazard.

**The interaction as built.** At an empty screenplay block:

| Key                     | Effect                                                                       |
| ----------------------- | ---------------------------------------------------------------------------- |
| `Enter`                 | Opens the menu, highlighting the element the block already has.              |
| `Enter` again           | Closes it. The block stays, empty, with the type the first `Enter` gave it.  |
| `Escape`                | Same as a second `Enter`.                                                    |
| `S A C D P T H`         | Chooses that element and closes. Both cases are bound.                       |
| `ArrowUp` / `ArrowDown` | Moves the highlight, wrapping at both ends.                                  |
| `Tab`                   | Chooses the highlighted element.                                             |
| anything else           | Ordinary typing. The first character closes the menu and lands in the block. |
| click a row             | Chooses it, on `mousedown`, with the default prevented so the caret stays.   |

`H` for Shot is arbitrary -- `S` belongs to Scene Heading -- and the code says so, in the comment on
`ELEMENT_SHORTCUTS`, so nobody "fixes" it later.

**`Tab` is the accept, not `Enter`.** `plan.md` gives `Enter` to closing ("the writer is never
trapped in it"), which leaves keyboard-only operation needing some other key once the arrows have
moved the highlight -- and the brief requires `aria-activedescendant`, which is meaningless without
one. `Tab` is the key this editor already means "element" with: it accepts a SmartType completion and
it converts action to character and dialogue to parenthetical.

**Nothing enters the document except the type change on an explicit choice.** Opening, moving the
highlight and closing all dispatch step-free transactions: no document change, nothing undoable, no
save (`App.tsx` saves from `onUpdate`, which only fires for document changes). Choosing goes through
`convertActiveScreenplayBlock`, the single existing writer of a block's element -- which is also what
gives a new parenthetical its `()` (behaviour 1), and that leaves the block non-empty, so `Enter`
after it splits normally rather than reopening the menu. **A choice that is the element the block
already has writes nothing at all**: no `setNodeMarkup` step, no history entry, no `PUT`.

**How `Enter` is arbitrated.** Three layers now have an opinion, ordered by extension priority
(Tiptap sorts extensions by priority descending and installs one keymap plugin per extension in that
order; ProseMirror gives the key to the first handler that returns true):

1. `SmartTypeListExtension` (150) -- accepts the highlighted candidate **while its list is open**,
   `false` otherwise.
2. `ElementMenuExtension` (120) -- opens or closes the menu **at an empty block**, `false` otherwise.
3. `ScreenplayBlockNode` (default 100) -- `splitScreenplayBlock`, untouched.

Both bounds are load-bearing and both were verified by mutation rather than by reading the numbers
(see below). `SmartTypeGhostExtension` is deliberately absent: a ghost appears on its own from
typing, so an `Enter` that accepted one would sometimes split a block and sometimes not. Its
`Tab`-only keymap and the long comment on the list's `Enter` binding both anticipated this feature by
name, and both have been updated from "will claim later" to what actually shipped.

The priority is stated as a number rather than left to the order the extensions are listed in
`App.tsx`: Tiptap breaks a priority tie by declaration order, so equal numbers would make the
arbitration depend on which line comes first.

**Ghost suppression lives in the menu, calling into the ghost.** `openMenu` calls
`dismissSmartTypeGhost(view)` -- the ghost's own exported API, which takes no argument about why. The
direction matters: `elementMenu` -> `smartTypeGhost`, the same direction and the same shape as
`smartTypeList`'s use of `overrideSmartTypeGhost`. **Rejected:** teaching the ghost to look for an
open menu, which would have made stage 2 depend on a layer above it and would have broken the ghost's
standing promise that it works with no caller at all.

That one call buys a second guarantee for free: `readSmartTypeList` gates the entire candidate list
on a ghost being on offer, so with the ghost dismissed the list **cannot** be opened while the menu
is up. Priority decides the collision; the dismissal means there is no collision left to decide. Both
routes have their own test.

The dismissal lasts until the writer types again (the ghost's own rule). So closing the menu on an
empty scene heading leaves no ghost behind -- correct, the writer just declined an offer at this
caret -- while _choosing_ a type is a document change and brings the ghost straight back for the type
chosen. Choose Scene Heading and the `INT.` ghost is there on the next frame.

**`apps/web/src/floatingPanel.ts`** (new) -- `placeAtCaret`, moved out of `smartTypeList.tsx`
unchanged. Two panels that appear at the caret must not be free to disagree about where "at the
caret" is. It could not stay in `smartTypeList.tsx`: that layer is built to be deleted in one pass
and its header enumerates the steps, so a helper the element menu depends on cannot live inside it.
That header's step 3 now says so.

The menu anchors on the **empty block's own box** rather than the ghost's (there is no ghost) or
`view.coordsAtPos` (which measures a DOM `Range`, and jsdom implements no rectangles for those). The
block is empty, so its box _is_ the caret's line -- exact here in a way it would not be in a block
with text in it.

**`displayElement` moved** from `App.tsx` to `screenplayEditor.ts` and exported. Three surfaces name
elements now (the toolbar `<select>`, the Inspector, this menu) and they must agree.

**Accessibility.** Listbox roles, `aria-selected` per row, `aria-activedescendant` /
`aria-controls` / `aria-expanded` set on the canvas for exactly as long as the panel exists, and a
`role="status"` live region -- following `smartTypeList.tsx`, which follows the Navigator tabs. The
canvas keeps `role="textbox"` rather than becoming a `combobox`, for the reason that file documents
at length (`combobox` has no `aria-multiline`). `aria-autocomplete` is the one attribute not copied:
nothing here completes text. The shortcut letter is real text in each row, so the accessible name is
"Scene Heading S" and the live region names it again -- a shortcut nobody can see is no shortcut for
the writers least able to find it by looking.

**Styling** reuses the tokens `.smarttype-list`, `.dialog` and `.toast` already agree on: the same
`--border-03` hairline, 4px radius, `--surface-01`, single restrained shadow, flat `--surface-05`
selected row. A separate CSS block rather than a shared selector, because `.smarttype-list`'s own
deletion checklist names its block by class. Nothing animates, so there is no motion for
`prefers-reduced-motion` to reduce.

### The paste defect this uncovered

**Not part of this scope, and fixed anyway, because there was no honest way to leave it.**

Removing the stray empty block that `Enter` used to leave at the top of a new screenplay changed
where `persistence.spec.ts`'s copy-paste test lands its paste: previously into an empty first block,
now at offset 0 _inside_ a block with text. That splits the block -- and ProseMirror's `replace`
gives both halves the original node's attrs, `id` among them. Two blocks, one id,
`Not saving · Stable id ... must be globally unique within a screenplay`. The writer's edits stop
reaching the server.

Reachable by an entirely ordinary action on `main` today: put the caret at the start of a line and
paste two or more lines copied from the manuscript. `regeneratePastedIds` could never have caught it
-- neither half came from the clipboard. Every existing paste test pastes at a block boundary
(`selectBeforeFirstBlock`, position 0) where nothing is split, which is why it survived the
paste-sanitisation slice and its suite.

The fix is in `ScreenplayPasteSanitizer`, which already owns exactly this guarantee: an
`appendTransaction` that reissues any duplicate `screenplayBlock` id, gated on a transaction carrying
`prosemirror-view`'s `uiEvent` meta of `paste` or `drop`. Gated rather than unconditional because it
is a whole-document scan, and no other edit in this editor copies a block's attrs onto a second node
(`splitScreenplayBlock` mints a fresh id; `convertActiveScreenplayBlock` changes one node in place).
The first block carrying an id keeps it and later ones are reissued -- document order and nothing
more; there is no sense in which one half of a split is more the original than the other.

Regression test: `screenplayEditor.test.ts`, "regenerates the id of a block split in two by a paste
dropped inside it". Mutation-confirmed.

**The three `persistence.spec.ts` tests that opened with `canvas.click()` then `Enter`** now type
straight into the seeded block. That is not a weakening: the `Enter` created a stray empty block the
tests never wanted, the document under test is otherwise identical, and every assertion is unchanged.
The copy-paste test's own comment describes "the three-block copy" -- which is now literally true.

### The geometry proof, and the hole found in it

`page-rendering-persistence.spec.ts` gains "an open element menu moves no line and no page, and only
an explicit choice reaches the document": a document long enough to break a page, an empty block made
by a real `Enter`, a baseline measured with nothing showing, and then the whole page re-measured with
the menu open, with the highlight moved, and after `Escape` -- each against that same baseline. Plus
the ghost-suppression case in a real browser (an empty scene heading really does ghost `INT.`, and
that ghost really is gone while the menu is up), behaviour 4 reopening the menu, and a final read of
the canonical screenplay through the real API showing one extra block, empty, carrying the one type
that was chosen.

The `measure()` closure inside the ghost test became a module-level `measurePage(page)` so both
overlay tests are held to one definition of "the page did not move". **And it had to be strengthened,
because it did not hold.** Moving the menu into `.script-body` and giving it `position: static` --
the exact regression class of PRs #16/#19/#20 -- passed the whole test: the panel renders _after_ the
last block, so it displaces no block top, no line rectangle and no spacer, and `.page`'s height is
fixed by the paper size. `measurePage` now also records `.script-body`'s own (content-sized) height
and the editor region's `scrollHeight`, and that mutation fails on `scriptBodyHeight` by 178px. The
ghost and list are held to the stronger measurement too.

The panel's placement is asserted as _adjacent to the block on whichever side it took_, not
specifically below: this fixture reaches `placeAtCaret`'s flip, because the empty block is the last
line of a multi-page document and sits too low in the window for seven rows beneath it.

### What was rejected

- **Tracking that the previous keystroke was `Enter`.** See above.
- **Removing or preventing empty blocks by any other route.** Deleting a block's text still leaves an
  empty block and clicking away from one leaves it. `packages/layout/src/pageBreak.ts`'s
  `(MORE)`/`CONT'D` handling has a rule for empty content, and making empty blocks impossible would
  turn it into dead code.
- **Undoing the empty block on dismiss.** `Enter` would become a keystroke whose effect depends on
  what the writer does next, and it would take back a block they asked for.
- **`Enter` as the accept.** `plan.md` gives it to closing.
- **Reading `smartTypeList`'s plugin state to decide whether to open.** It would have made a layer
  designed for deletion into a dependency. Priority plus ghost dismissal does the same job with no
  coupling.
- **The ghost checking for an open menu.** Wrong direction; see above.
- **A shared `.smarttype-list, .element-menu` CSS rule.** Deleting the SmartType list would break the
  menu.
- **A second, standalone geometry test.** Extending the file with a shared `measurePage` follows the
  reasoning `smartTypeList.tsx`'s header already sets out for measuring against a baseline from the
  same document in the same browser moments earlier.

### Mutation-testing report

Every behavioural claim was broken, the failure observed, and the mutation reverted and reconfirmed
green. **Two tests were found passing for the wrong reason, both by mutation and neither by review.**

| #   | Mutation                                                        | Result                                                                                   |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| M1  | `priority: 160` (above the SmartType list)                      | Killed -- "leaves Enter to an open SmartType candidate list".                            |
| M2  | `priority: 90` (below `ScreenplayBlockNode`)                    | Killed -- 6 tests; the menu never opens at all.                                          |
| M3  | Drop `dismissSmartTypeGhost` from `openMenu`                    | Killed -- 3 tests, including "leaves no candidate list to open while it is showing".     |
| M4  | Drop the same-element guard in `chooseElement`                  | Killed -- "writes nothing to the document when the choice is the element the block has". |
| M5  | Second `Enter` does not close                                   | Killed -- "closes on a second Enter...".                                                 |
| M6  | Plugin `apply` never closes on `docChanged`/`selectionSet`      | **SURVIVED.** See below.                                                                 |
| M7  | Empty-block condition always false (menu opens anywhere)        | Killed -- 2 tests.                                                                       |
| M8  | `placeAtCaret` never flips above the caret                      | Killed -- "flips above the caret when the space below would put rows off screen".        |
| M9  | Duplicate-id sweep disabled                                     | Killed -- "regenerates the id of a block split in two by a paste dropped inside it".     |
| M10 | Only the shifted letter bound / only the unshifted letter bound | Killed both ways -- 4 tests and 1 test respectively.                                     |
| M11 | Menu always opens on row 0 instead of the block's own element   | Killed -- 4 tests.                                                                       |
| M12 | `Tab` does not accept the highlighted row                       | **SURVIVED.** See below.                                                                 |
| M13 | `mousedown` default not prevented                               | Killed -- the click test.                                                                |
| M14 | `Escape` does not close                                         | Killed -- 3 tests.                                                                       |
| M15 | `aria-activedescendant` never set                               | Killed -- the ARIA test.                                                                 |
| M16 | Menu rendered inside `.script-body`, `position: static`         | **SURVIVED** against the geometry test as inherited. See below.                          |

**M6 survived** because `readElementMenu` gates the stored `open` flag on there still being an empty
block at the caret, so typing or clicking into a block with text hides the panel whether or not the
plugin closed it. The two tests written for that rule could not tell "closed" from "not currently
drawn". Only a caret landing on a _different_ empty block, or a block emptied again after typing,
reaches the plugin's own rule -- and in both of those the stored state would put the panel back on
screen with no `Enter` behind it. Two tests added; M6 now kills both.

**M12 survived** because the test moved from an `action` block to `character` -- which is exactly what
`ScreenplayBlockNode`'s own `Tab` already does. It passed whether the menu handled `Tab` or merely
declined it. Rewritten to go from `transition` to `Shot`, a `Tab` nothing else in the editor claims;
M12 now kills it.

**M16 survived** against the geometry measurement as inherited from the ghost slice, which is the
defect class this file exists for. `measurePage` strengthened as described above; M16 now fails on
`scriptBodyHeight` (1658 vs 1480).

**Not caught by any test, and honestly reported:**

- The panel's **visual style** -- colours, radius, shadow, the muted shortcut column. Asserted by
  nothing; the e2e checks only that the panel has a non-zero box and sits beside the caret's line.
  Consistent with how `.smarttype-list`, `.dialog` and `.toast` are treated.
- **`prefers-reduced-motion`.** Nothing animates, so there is nothing to assert. A future animation
  would have no test standing in its way.
- **Scroll and resize repositioning** (the `scroll`/`resize` listeners). jsdom reports zero-sized
  boxes, so the unit tests can only show the code path runs; the e2e never scrolls with the menu
  open. `smartTypeList.tsx` is in the same position for the same reason.
- **Real caps-lock input.** Both letter cases are bound and both are tested through synthesised
  `KeyboardEvent`s; a real caps-lock keystroke in a real browser is not exercised.
- **Anything about `H` being a good key for Shot.** That is a judgement, not a behaviour.

### Gate results (all from the worktree)

1. `pnpm lint` -- clean, exit 0.
2. `pnpm typecheck` -- clean across every package and both apps.
3. `pnpm format:check` -- clean (run again after this entry).
4. `pnpm test:coverage` -- exit 0. `apps/web`: **441 tests** (from 406), 36 files. `elementMenu.tsx`
   96.9% statements / 93.1% branches / 100% functions; `floatingPanel.ts` 100% across the board.
   `packages/screenplay` 118, `apps/api` 86 -- both unchanged.
5. `pnpm build` -- succeeded for every package and both apps.
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- **31 passed** (unchanged).
7. `PLAYWRIGHT_CHANNEL=chrome TEST_DATABASE_URL=... pnpm test:system:persistence` -- **14 passed**
   (from 13), run three times.
8. `pnpm check:bundle-budget` -- entry **111.40 / 120 kB** (unchanged), lazy editor chunk
   **112.25 / 200 kB** (from 111.4, +0.85 kB), CSS **5.66 / 20 kB** (unchanged). Nothing near a
   budget; the entry chunk's 8.6 kB of headroom is untouched, since all of this lands in the editor
   chunk.
9. `git diff --check` -- clean.

### Known limitations / things not done

- **No mouse route into the menu.** It opens on `Enter` only. A writer who clicks into an empty block
  and wants to relabel it uses the toolbar's element `<select>`, which is unchanged.
- **A non-shortcut letter typed with the menu open is inserted as text and closes the menu**, which
  is right; but a writer who wanted a literal `s` at the start of an empty block gets Scene Heading
  instead. That is the cost of the single-key shortcuts `plan.md` asks for, and the escape is one
  `Escape` first. Not otherwise mitigated.
- **The menu does not close on blur.** An unfocused editor with the panel still up is possible.
  `smartTypeList.tsx` behaves the same way; deliberate parity rather than an oversight, but neither
  is tested.
- **`progress/smarttype.md` does not exist**, though this scope's brief cites it as a format
  reference. `progress/writing-flow.md` was used instead. Worth knowing if the SmartType slice's
  progress entry was meant to exist and was missed.
