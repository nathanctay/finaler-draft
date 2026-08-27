/**
 * The element menu: what `Enter` does at an empty block.
 *
 * plan.md's writing-flow behaviours 3 and 4, which are one rule seen from two sides -- **an
 * element cannot be left empty and unlabelled.** The first `Enter` ends a block and starts the
 * next one, exactly as `splitScreenplayBlock` always has. A second `Enter`, with that new block
 * still empty, would stack a further empty block on top of the first: a blank line carrying
 * whatever element the convention happened to inherit, which is a formatting error the writer has
 * to notice and undo later, and not a cosmetic one -- an empty block still occupies a line, so a
 * stray one shifts every page after it and the page count with it. So instead of the second empty
 * block, this offers the element types.
 *
 * **The rule is "the block at the caret is empty", not "the previous keystroke was Enter".** That
 * is deliberately wider than behaviour 3's wording and is what makes behaviour 4 fall out with no
 * machinery of its own: choose `Character` for an empty block, press `Enter` while it is still
 * empty, and the block is still an empty block -- so the menu opens again rather than creating a
 * further one. Provenance would have had to be tracked, could be lost by any transaction, and
 * would have answered "how did you get here?" when the question a writer is actually asking is
 * "what is this line?".
 *
 * **Only `Enter` is governed.** Deleting a block's text still leaves an empty block, clicking away
 * from one leaves it, and a paste or an import may contain one. Nothing here removes an empty
 * block or prevents one, and that is a requirement rather than a limitation:
 * `packages/layout/src/pageBreak.ts`'s `(MORE)`/`CONT'D` handling has a rule for empty content,
 * and making empty blocks impossible would quietly turn it into dead code.
 *
 * **Dismissing keeps the block.** `Enter` again, or `Escape`, closes the menu and leaves the empty
 * block exactly as the first `Enter` made it, with the element the convention gave it. The writer
 * can simply start typing. Undoing the block instead would make `Enter` a keystroke whose effect
 * depends on what the writer does next, and would take back a block they asked for.
 *
 * **Nothing enters the document except the type change on an explicit choice**, and not even that
 * when the choice is the element the block already has. Opening, moving the selection, and closing
 * all dispatch transactions with no steps: no document change, nothing undoable, and no save
 * (`App.tsx` saves from Tiptap's `onUpdate`, which only fires for document changes). Choosing a
 * type goes through `convertActiveScreenplayBlock`, the one function in this editor that changes a
 * block's element -- so a choice made here is the same edit the toolbar's `<select>` and `Tab`
 * already make, including the `()` a new parenthetical is given (behaviour 1).
 *
 * **The panel takes no part in layout.** It is a `position: fixed` box rendered at the application
 * root, outside `.page` entirely, for the reason `smartTypeList.tsx`'s panel is: the character
 * grid is normative here, and anything in the manuscript's box tree can move a line and therefore
 * a page break. `page-rendering-persistence.spec.ts` measures the whole page with the menu open
 * rather than taking the stylesheet's word for it.
 *
 * ## How `Enter` is arbitrated
 *
 * Three layers now have an opinion about `Enter`, and the order between them is set by extension
 * priority (Tiptap sorts extensions by priority, highest first, and installs one keymap plugin per
 * extension in that order; ProseMirror gives the key to the first plugin whose handler returns
 * true):
 *
 *  1. `SmartTypeListExtension` (priority 150) accepts the selected candidate **while its list is
 *     open**, and returns false otherwise. An open list is a panel the writer opened with a
 *     deliberate `ArrowDown`, with a highlighted row in it; accepting that row is what `Enter`
 *     does in every dropdown ever built.
 *  2. This extension (priority 120) opens or closes the menu at an empty block, and returns false
 *     otherwise.
 *  3. `ScreenplayBlockNode` (default priority 100) splits the block, unchanged.
 *
 * `SmartTypeGhostExtension` is not in that list, and that is the point: a ghost appears on its own
 * from typing, so an `Enter` that accepted one would sometimes split a block and sometimes not,
 * for reasons the writer never asked for. It binds `Tab` and `Escape` only, and its own header
 * says so. An empty scene heading *does* ghost (`INT.` -- the empty character cue deliberately
 * does not), and `Enter` there opens this menu.
 *
 * The list is additionally unable to be open at the same time as this menu, by a second and
 * independent route: opening the menu dismisses the ghost (below), and `readSmartTypeList` gates
 * the whole list on a ghost being on offer. Priority decides the collision; the ghost dismissal
 * means there is no collision to decide.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { placeAtCaret } from './floatingPanel.js';
import {
  convertActiveScreenplayBlock,
  displayElement,
  isScreenplayElementType,
  screenplayElementTypes,
  type ScreenplayElementType,
} from './screenplayEditor.js';
import { dismissSmartTypeGhost } from './smartTypeGhost.js';

/**
 * The single key that chooses each element, so a choice costs no more than the keystroke it
 * replaces (plan.md). Six are the first letter of the element's name.
 *
 * `H` for Shot is arbitrary and is meant to stay that way: `S` belongs to Scene Heading, which is
 * both far more frequent and the one every writer reaches for first, and `Shot`'s remaining
 * letters are no better than `H`. This is not an oversight waiting to be tidied into `S`.
 */
const ELEMENT_SHORTCUTS: Record<ScreenplayElementType, string> = {
  scene_heading: 'S',
  action: 'A',
  character: 'C',
  dialogue: 'D',
  parenthetical: 'P',
  transition: 'T',
  shot: 'H',
};

/** Whether the menu is showing and which row is highlighted. Nothing else: the rows are
 * `screenplayElementTypes` itself, in canonical order, so there is no second copy of the element
 * vocabulary here to fall out of step with the first. */
type ElementMenuState = {
  readonly index: number;
  readonly open: boolean;
};

type ElementMenuMeta =
  | { readonly kind: 'close' }
  | { readonly kind: 'open'; readonly index: number };

const CLOSED: ElementMenuState = { index: 0, open: false };

const elementMenuPluginKey = new PluginKey<ElementMenuState>('elementMenu');

const LISTBOX_ID = 'element-menu';
const OPTION_ID_PREFIX = 'element-menu-option';

/** The empty screenplay block the menu belongs to, when the caret is in one. */
type EmptyBlock = {
  readonly element: ScreenplayElementType;
  readonly position: number;
};

type ElementMenuView = {
  readonly block: EmptyBlock | undefined;
  readonly index: number;
  readonly open: boolean;
};

const NO_MENU: ElementMenuView = { block: undefined, index: 0, open: false };

/**
 * The empty block at the caret, or `undefined`. Every condition is a rule of the feature:
 *
 *  - a non-empty selection is a writer selecting text, and `Enter` there replaces the selection;
 *  - a caret outside a `screenplayBlock` -- an empty document, before any block exists -- has no
 *    element to change, and `Enter` there is `ScreenplayBlockNode`'s job of creating the first
 *    block, which must keep working;
 *  - a block with any text in it is a block the writer has labelled by writing in it, and `Enter`
 *    there splits, exactly as before.
 */
function emptyBlockAtCaret(state: EditorState): EmptyBlock | undefined {
  const { $from, empty } = state.selection;
  if (!empty) {
    return undefined;
  }
  const block = $from.parent;
  if (block.type.name !== 'screenplayBlock' || !isScreenplayElementType(block.attrs.element)) {
    return undefined;
  }
  if (block.content.size !== 0) {
    return undefined;
  }
  return { element: block.attrs.element, position: $from.before($from.depth) };
}

/**
 * Everything this layer knows, derived from editor state alone.
 *
 * The stored `open` flag is gated on the block still being empty rather than trusted, which is
 * what makes "the menu is open" and "there is an empty block under it" one fact instead of two
 * that could disagree. The plugin's `apply` closes on any document change or caret move anyway;
 * this is the same rule expressed where it is read, so a state that somehow outlived its block
 * shows nothing rather than showing a menu pointing at a block that has since been filled in.
 */
function readElementMenu(state: EditorState): ElementMenuView {
  const block = emptyBlockAtCaret(state);
  if (!block) {
    return NO_MENU;
  }
  const stored = elementMenuPluginKey.getState(state) ?? CLOSED;
  return { block, index: stored.index, open: stored.open };
}

function elementAt(index: number): ScreenplayElementType | undefined {
  return screenplayElementTypes[index];
}

/**
 * Opens the menu with `element`'s own row highlighted -- the type the first `Enter` gave this
 * block. The menu's first job is to tell the writer what this blank line currently is, which is
 * exactly the thing an unlabelled empty block fails to do; opening on a fixed row would throw that
 * away, and would make `Tab` on a freshly opened menu a silent change of element rather than a
 * confirmation.
 *
 * The ghost is dismissed on the way. An empty scene heading ghosts `INT.` deliberately, and
 * leaving it up would put greyed text offering `Tab` behind a panel offering element types: two
 * affordances competing over one caret. `dismissSmartTypeGhost` is the ghost's own API and takes
 * no argument about why -- so this is a one-way call into a layer that neither knows nor asks that
 * this menu exists, in the same direction and the same shape as `smartTypeList.tsx`'s use of
 * `overrideSmartTypeGhost`. The alternative, teaching the ghost to look for an open menu, would
 * have made stage 2 depend on a feature layered above it.
 *
 * The dismissal lasts until the writer types again, so closing the menu on an empty scene heading
 * leaves no ghost behind either -- correct, since the writer has just declined an offer at this
 * caret -- while choosing a type is itself a document change and brings the ghost straight back
 * for the type they chose.
 */
function openMenu(editor: Editor, element: ScreenplayElementType): void {
  const meta: ElementMenuMeta = {
    kind: 'open',
    index: Math.max(screenplayElementTypes.indexOf(element), 0),
  };
  editor.view.dispatch(editor.state.tr.setMeta(elementMenuPluginKey, meta));
  dismissSmartTypeGhost(editor.view);
}

function closeMenu(view: EditorView): void {
  const meta: ElementMenuMeta = { kind: 'close' };
  view.dispatch(view.state.tr.setMeta(elementMenuPluginKey, meta));
}

/**
 * `Enter`: open the menu at an empty block, choose the highlighted row if it is already open, and
 * decline everywhere else so `splitScreenplayBlock` keeps `Enter` for itself.
 *
 * Choosing rather than closing is what a panel with a highlighted row means everywhere else,
 * including `smartTypeList.tsx`'s own `Enter`, and pressing `Tab` instead is the surprise. It reads
 * narrower than plan.md's wording ("Pressing Enter again with the menu open closes it; the writer
 * is never trapped in it"), and it is not: the menu opens with the block's CURRENT element
 * highlighted, so `Enter` `Enter` chooses the element the block already has. That converts nothing
 * -- `chooseSelected` writes no step for a block that is already the chosen type -- and closes the
 * menu, which is the same two-presses-and-you-are-back-where-you-started behaviour that sentence
 * describes. `Escape` remains an unconditional dismiss, so "never trapped" holds outright rather
 * than by argument.
 *
 * The behaviours only diverge once the writer has moved the highlight, which is exactly when
 * choosing is what they meant. `Tab` still chooses too.
 */
function toggleOnEnter(editor: Editor): boolean {
  const menu = readElementMenu(editor.state);
  if (menu.open) {
    return chooseSelected(editor);
  }
  if (!menu.block) {
    return false;
  }
  openMenu(editor, menu.block.element);
  return true;
}

function closeOnEscape(view: EditorView): boolean {
  if (!readElementMenu(view.state).open) {
    return false;
  }
  closeMenu(view);
  return true;
}

/**
 * Chooses `element` for the block and closes the menu.
 *
 * The menu is closed first, by its own stepless transaction, and the conversion dispatched second;
 * both come from one keystroke handler, so no paint happens between them. Closing on the
 * conversion's own `docChanged` instead would work for six of the seven types and not for the
 * seventh -- a block that is already the chosen element is not converted at all, because nothing
 * about it needs to change and writing a `setNodeMarkup` step for it would put an edit in the
 * writer's history, and a save on the wire, for a choice that changed nothing.
 */
function chooseElement(editor: Editor, element: ScreenplayElementType): boolean {
  const menu = readElementMenu(editor.state);
  if (!menu.open || !menu.block) {
    return false;
  }
  closeMenu(editor.view);
  if (menu.block.element !== element) {
    convertActiveScreenplayBlock(editor, element);
  }
  return true;
}

/**
 * `Tab` accepts the highlighted row.
 *
 * `Enter` cannot be the accept (it is the close), so keyboard-only operation needs some other key
 * once `ArrowUp`/`ArrowDown` have moved the highlight, and `Tab` is the one this editor already
 * means "element" with: it accepts a SmartType completion, and it converts action to character and
 * dialogue to parenthetical. Returning false with the menu closed leaves all of that untouched.
 */
function chooseSelected(editor: Editor): boolean {
  const menu = readElementMenu(editor.state);
  if (!menu.open) {
    return false;
  }
  const element = elementAt(menu.index);
  return element === undefined ? false : chooseElement(editor, element);
}

/**
 * Moves the highlight, wrapping at either end -- the same wrap `OverflowMenu`, the Navigator's
 * tabs and SmartType's list already use.
 *
 * Unlike that list, neither arrow opens the menu: `Enter` is the only way in, which is what keeps
 * `ArrowUp`/`ArrowDown` ordinary caret movement at an empty block.
 */
function moveSelection(view: EditorView, delta: 1 | -1): boolean {
  const menu = readElementMenu(view.state);
  if (!menu.open) {
    return false;
  }
  const count = screenplayElementTypes.length;
  const meta: ElementMenuMeta = { kind: 'open', index: (menu.index + delta + count) % count };
  view.dispatch(view.state.tr.setMeta(elementMenuPluginKey, meta));
  return true;
}

/**
 * One binding per shortcut letter, in both cases.
 *
 * `prosemirror-keymap` looks a printable key up by the character the keystroke actually produced,
 * so `"S"` matches only a shifted `s` (or one typed with caps lock on) and `"s"` only an unshifted
 * one. Screenplay writers work in caps lock more than most, and neither case means anything
 * different here, so both are bound to the same choice rather than making the writer notice.
 *
 * Every one of them returns false while the menu is closed, which is what leaves these letters
 * ordinary typing everywhere else -- including in the empty block the menu was just dismissed
 * over.
 */
function shortcutBindings(editor: Editor): Record<string, () => boolean> {
  const bindings: Record<string, () => boolean> = {};
  for (const element of screenplayElementTypes) {
    const key = ELEMENT_SHORTCUTS[element];
    const choose = () => chooseElement(editor, element);
    bindings[key.toUpperCase()] = choose;
    bindings[key.toLowerCase()] = choose;
  }
  return bindings;
}

export const ElementMenuExtension = Extension.create({
  addKeyboardShortcuts() {
    return {
      ...shortcutBindings(this.editor),
      ArrowDown: () => moveSelection(this.editor.view, 1),
      ArrowUp: () => moveSelection(this.editor.view, -1),
      Enter: () => toggleOnEnter(this.editor),
      Escape: () => closeOnEscape(this.editor.view),
      Tab: () => chooseSelected(this.editor),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<ElementMenuState>({
        key: elementMenuPluginKey,
        state: {
          apply(tr, previous) {
            const meta = tr.getMeta(elementMenuPluginKey) as ElementMenuMeta | undefined;
            if (meta) {
              return meta.kind === 'close' ? CLOSED : { index: meta.index, open: true };
            }
            if (!previous.open) {
              return previous;
            }
            // The menu describes one empty block at one caret, so it survives exactly as long as
            // that description does. A document change means the block is no longer empty (the
            // writer typed) or is no longer what it was (they chose a type); a caret that moved
            // means they have gone somewhere else. Either way the menu was about somewhere they
            // are not any more. Unlike SmartType's list, typing does not refilter it into
            // something still useful -- there is nothing to filter, and the block it was offered
            // for is no longer empty.
            return tr.docChanged || tr.selectionSet ? CLOSED : previous;
          },
          init() {
            return CLOSED;
          },
        },
      }),
    ];
  },
  name: 'elementMenu',
  // Between `SmartTypeListExtension`'s 150 and `ScreenplayBlockNode`'s default 100, and both
  // bounds are load-bearing. Above the node: otherwise `splitScreenplayBlock` takes `Enter` first
  // and always handles it, and the menu could never open. Below the list: an open candidate list
  // must keep `Enter` for the candidate the writer highlighted. Stated as a number rather than
  // left to the order these are listed in `App.tsx` -- Tiptap breaks a priority tie by declaration
  // order, so equal priorities would make this depend on which line comes first.
  priority: 120,
});

/**
 * What the panel is placed against: the empty block's own box.
 *
 * The block is empty, so its box *is* the caret's line -- its left edge is where the caret sits
 * and its bottom is the bottom of that line -- which makes this measurement exact here in a way it
 * would not be in a block with text in it. `view.coordsAtPos` would be the general answer, but it
 * measures a DOM `Range`, and jsdom implements no rectangles for those at all; an element's own
 * box is something every environment this file runs in can answer.
 */
function blockRect(view: EditorView, position: number): DOMRect | undefined {
  const node = view.nodeDOM(position);
  return node instanceof HTMLElement ? node.getBoundingClientRect() : undefined;
}

/**
 * What a screen reader is told. The letter is named alongside the element, because the shortcut is
 * the whole point of the menu and a row that only reads "Scene Heading" hides it from the writers
 * least able to find it by looking.
 *
 * Only the highlighted row is announced, not the whole menu: the listbox has an accessible name of
 * its own and the canvas carries `aria-expanded` while it is open, so opening is already
 * described. Re-reading seven rows on every `ArrowDown` would not be.
 */
function announcement(menu: ElementMenuView): string {
  if (!menu.open) {
    return '';
  }
  const element = elementAt(menu.index);
  if (!element) {
    return '';
  }
  return `${displayElement(element)}, shortcut ${ELEMENT_SHORTCUTS[element]}, ${
    menu.index + 1
  } of ${screenplayElementTypes.length}.`;
}

/**
 * The panel, and the live region that describes it.
 *
 * **Roles.** The listbox pattern, with the same deliberate deviation `smartTypeList.tsx` documents
 * at length: the manuscript is a multi-line `role="textbox"` (`App.tsx`'s `editorProps`) and
 * ARIA's `combobox` role does not support `aria-multiline`, so the canvas keeps its role and gains
 * only the attributes that pair it with the popup -- `aria-expanded`, `aria-controls`,
 * `aria-activedescendant` -- for exactly as long as the popup exists. `aria-autocomplete` is not
 * among them, and that is the one difference from the list: nothing here completes text.
 *
 * Focus never leaves the manuscript, so the highlighted row is published by
 * `aria-activedescendant` rather than by moving focus into the panel -- keyboard operation must
 * not cost the writer their caret, which is sitting in the very block the menu is about.
 *
 * The two panels never coexist (see this file's header), so there is no question of both writing
 * these attributes at once.
 */
export function ElementMenu({ editor }: { editor: Editor | null }) {
  const [, setRenderCount] = useState(0);
  const panelRef = useRef<HTMLUListElement>(null);
  const selectedRef = useRef<HTMLLIElement>(null);

  // The menu is derived from editor state, and editor state changes without React knowing. Every
  // transaction is a possible change of what belongs on screen.
  useEffect(() => {
    if (!editor) {
      return;
    }
    const rerender = () => setRenderCount((count) => count + 1);
    editor.on('transaction', rerender);
    return () => {
      editor.off('transaction', rerender);
    };
  }, [editor]);

  const menu = editor ? readElementMenu(editor.state) : NO_MENU;
  const open = menu.open && editor !== null;
  const activeOptionId = open ? `${OPTION_ID_PREFIX}-${menu.index}` : undefined;

  useEffect(() => {
    const canvas = editor?.view.dom;
    if (!canvas || !activeOptionId) {
      return;
    }
    canvas.setAttribute('aria-activedescendant', activeOptionId);
    canvas.setAttribute('aria-controls', LISTBOX_ID);
    canvas.setAttribute('aria-expanded', 'true');
    return () => {
      canvas.removeAttribute('aria-activedescendant');
      canvas.removeAttribute('aria-controls');
      canvas.removeAttribute('aria-expanded');
    };
  }, [activeOptionId, editor]);

  // Position before paint, and again whenever the block could have moved under the panel: the
  // editor region scrolls independently of the window, so a wheel anywhere on the page can leave
  // the panel pointing at a line that has gone. `scroll` is captured, because the scrolling
  // element is `.editor-region`, not the window, and a scroll event does not bubble.
  const anchorPos = open ? menu.block?.position : undefined;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!editor || !panel || anchorPos === undefined) {
      return;
    }
    const reposition = () => {
      const anchor = blockRect(editor.view, anchorPos);
      if (anchor) {
        placeAtCaret(panel, anchor);
      }
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchorPos, editor]);

  // Keeps the highlighted row visible in a window too short to show all seven. `scrollIntoView` is
  // absent in jsdom, where this file's unit tests run; the check is for that environment, not for
  // a browser.
  useLayoutEffect(() => {
    const selected = selectedRef.current;
    if (selected && typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [menu.index, open]);

  return (
    <>
      {/* Always mounted, even with nothing to say: a live region has to be in the document before
          its text changes for that change to be announced. */}
      <div className="visually-hidden" role="status">
        {announcement(menu)}
      </div>
      {open && (
        <ul
          aria-label="Element types"
          className="element-menu"
          id={LISTBOX_ID}
          ref={panelRef}
          role="listbox"
        >
          {screenplayElementTypes.map((element, index) => (
            <li
              aria-selected={index === menu.index}
              className="element-menu-option"
              id={`${OPTION_ID_PREFIX}-${index}`}
              key={element}
              // `mousedown` is where the click is claimed, not `click`: the default action of
              // pressing the mouse inside a floating panel is to move focus and collapse the
              // caret, and the caret is what the menu is anchored to -- losing it would close the
              // menu out from under the choice being made.
              onMouseDown={(event) => {
                event.preventDefault();
                if (editor) {
                  chooseElement(editor, element);
                }
              }}
              ref={index === menu.index ? selectedRef : undefined}
              role="option"
            >
              <span>{displayElement(element)}</span>
              <span className="element-menu-key">{ELEMENT_SHORTCUTS[element]}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
