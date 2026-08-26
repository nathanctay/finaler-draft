/**
 * SmartType stage 3: the optional list of candidates, opened on demand.
 *
 * Stage 2's ghost (`smartTypeGhost.ts`) shows one completion -- the best-ranked one that has
 * something to add. `suggest` ranked the others too, and this is the only place a writer can see
 * them: `ArrowDown` opens a listbox at the caret, `ArrowUp`/`ArrowDown` move the selection, `Tab`
 * accepts, `Escape` closes it again with the ghost still standing.
 *
 * **This layer is designed to be deleted.** The writer it is built for is not yet sure they want a
 * list at all, so removability is the first requirement rather than a courtesy, and it is what
 * every structural decision below answers to:
 *
 *  - It reads stage 1 (`suggest`) directly, so it holds no logic moved out of the ghost and the
 *    ghost holds none of its.
 *  - It never inserts anything. `Tab` calls the ghost's own `acceptSmartTypeGhost`, which is the
 *    single writer to the document on this path -- so "nothing enters the document except through
 *    accept" is still one function, not two that must agree.
 *  - The one thing it asks of the ghost is `overrideSmartTypeGhost`: which completion is currently
 *    on offer. That is what keeps the ghost and the list from ever disagreeing about what `Tab`
 *    will do -- they are not two views of the same ranking that could drift apart, they are one
 *    value read twice.
 *
 * **Removing it** is mechanical, and this is the whole list. Nothing else in the product refers to
 * this layer, and the ghost passes its own suite untouched at every step:
 *
 *  1. Delete `smartTypeList.tsx` and `smartTypeList.test.tsx`.
 *  2. In `App.tsx`: the `SmartTypeList, SmartTypeListExtension` import, the `SmartTypeListExtension`
 *     entry in the editor's `extensions` array, and the `<SmartTypeList editor={editor} />` element
 *     at the end of the render -- each with its own comment.
 *  3. In `styles.css`: the `.smarttype-list` / `.smarttype-list-option` block. Leave
 *     `floatingPanel.ts` alone -- the panel placement moved there when the element menu
 *     needed the same arithmetic, and that layer is not part of this one.
 *  4. In `page-rendering-persistence.spec.ts`: the list section of the ghost geometry test, between
 *     the canonical-screenplay read-back and `// Escape dismisses it`, and the two references to
 *     the list in that test's name and doc comment. **This step is not optional and nothing in the
 *     application will point you at it**: the list was measured by extending the ghost's own
 *     geometry test rather than by adding a second one, so a build with this layer deleted and that
 *     test left alone fails on a listbox that is never going to appear.
 *
 *     The extension was still the right shape. The claim being proved is that an open list changes
 *     nothing about a page, and that is only worth anything against the identical document, in the
 *     identical browser, measured moments earlier -- which is exactly the `withoutGhost` baseline
 *     that test already holds. A standalone test would have rebuilt a 55-character fixture, an
 *     earlier scene and two filler blocks to compare against a baseline of its own, for a weaker
 *     comparison. The cost is this line in this list.
 *  5. In `smartTypeGhost.ts`, the override seam becomes dead code with nothing calling it, and this
 *     project keeps only active code -- so delete `overrideSmartTypeGhost` and its doc comment, the
 *     `override` field on `SmartTypeGhostState`, the `'override'` variant of `SmartTypeGhostMeta`,
 *     the `const override = ...` assignment in the plugin's `apply` (with the comment above it),
 *     the `override === previous.override` clause in the unchanged-state early return, the
 *     `override ??` in the line that resolves `ghost`, and the `override` key in both returned
 *     state objects (`apply`'s and `initialState`'s). Then delete the `an overridden ghost`
 *     describe block from `smartTypeGhost.test.ts` and drop `overrideSmartTypeGhost` from its
 *     import. That leaves stage 2 byte-identical to how it shipped.
 *
 * `Enter` needs no step of its own: the binding is in this file's extension, so step 1 takes it.
 *
 * `Enter` accepts the selected candidate while the list is open, and is untouched everywhere else
 * -- including at a caret where the ghost alone is showing, which stays `Tab`-only. See the
 * `Enter` binding in `SmartTypeListExtension` for why that line is drawn there and why it leaves
 * `splitScreenplayBlock` and the element menu's second-`Enter` (`elementMenu.tsx`) alone.
 *
 * The list cannot move the manuscript. It renders at the application root, outside `.page`
 * entirely, as a `position: fixed` box in viewport coordinates -- so it is not merely out of flow
 * inside a text block, the way the ghost has to be; it is not in the manuscript's box tree at all.
 * `page-rendering-persistence.spec.ts` measures that with the list open, against the same
 * with-nothing baseline the ghost is measured against.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { suggest } from '@finaler-draft/screenplay';
import { placeAtCaret } from './floatingPanel.js';
import { isScreenplayElementType } from './screenplayEditor.js';
import {
  acceptSmartTypeGhost,
  overrideSmartTypeGhost,
  smartTypeGhostPluginKey,
  type SmartTypeGhost,
} from './smartTypeGhost.js';

/** Whether the list is showing, and which candidate is selected while it is. Nothing else: the
 * candidates themselves are derived from the document on demand (`readSmartTypeList`) rather than
 * stored, so there is no second copy of the ranking to keep in step with the first. */
type SmartTypeListState = {
  readonly index: number;
  readonly open: boolean;
};

type SmartTypeListMeta =
  | { readonly kind: 'close' }
  | { readonly kind: 'select'; readonly index: number };

const CLOSED: SmartTypeListState = { index: 0, open: false };

const smartTypeListPluginKey = new PluginKey<SmartTypeListState>('smartTypeList');

const LISTBOX_ID = 'smarttype-list';
const OPTION_ID_PREFIX = 'smarttype-option';

type SmartTypeListView = {
  readonly candidates: readonly SmartTypeGhost[];
  readonly index: number;
  readonly open: boolean;
};

const EMPTY_LIST: SmartTypeListView = { candidates: [], index: 0, open: false };

/**
 * Everything this layer knows, derived from the editor state alone: the ranked candidates, whether
 * the list is showing, and which one is selected.
 *
 * The candidates are gated on the ghost rather than on a re-statement of the ghost's own rules.
 * `smartTypeGhost.ts` decides where a completion may be offered at all -- caret at the end of the
 * text, no selection, inside a screenplay block, in an element `suggest` completes -- and every one
 * of those is a judgement about the feature, not a detail. Re-deriving them here would be two
 * copies of the same policy, free to drift; asking "is a ghost showing?" is one copy, and it is
 * also exactly the interaction the brief describes ("`ArrowDown` opens the list when a ghost is
 * showing"). The filter that follows is stage 2's, restated for the same reason it exists there: a
 * candidate whose `remainder` is empty draws nothing, so `candidates[0]` here is the ghost's own
 * choice by construction rather than by coincidence.
 *
 * `index` is clamped rather than trusted. The stored index outlives the transaction that set it,
 * and the candidate list under it shrinks as the writer types.
 */
function readSmartTypeList(state: EditorState): SmartTypeListView {
  const ghostState = smartTypeGhostPluginKey.getState(state);
  if (!ghostState?.ghost) {
    return EMPTY_LIST;
  }

  const { $from, from } = state.selection;
  const element = $from.parent.attrs.element;
  if (!isScreenplayElementType(element)) {
    return EMPTY_LIST;
  }

  const candidates = suggest(element, $from.parent.textContent, ghostState.vocabulary)
    .filter((candidate) => candidate.remainder !== '')
    .map((candidate) => ({
      insertText: candidate.insertText,
      matchedLength: candidate.matchedLength,
      pos: from,
      text: candidate.remainder,
    }));
  if (candidates.length === 0) {
    return EMPTY_LIST;
  }

  const listState = smartTypeListPluginKey.getState(state) ?? CLOSED;
  return {
    candidates,
    index: Math.min(listState.index, candidates.length - 1),
    open: listState.open,
  };
}

/**
 * Selects `index` and tells the ghost to show that candidate. Two transactions rather than one
 * because `overrideSmartTypeGhost` is the ghost's own API, taking a view the way its
 * `acceptSmartTypeGhost` and `dismissSmartTypeGhost` siblings do; neither carries steps, so both
 * are free of the document, of history and of saving. The pair is dispatched from one keystroke
 * handler, so no paint happens between them.
 *
 * The override is set even when `index` is 0 and the ghost is already showing that candidate. The
 * point is not the pixels, which are identical either way -- it is that "the ghost is the selected
 * candidate" holds because one value was written to one field, not because two filters over the
 * same ranking happened to agree.
 */
function selectCandidate(view: EditorView, list: SmartTypeListView, index: number): void {
  const meta: SmartTypeListMeta = { kind: 'select', index };
  view.dispatch(view.state.tr.setMeta(smartTypeListPluginKey, meta));
  overrideSmartTypeGhost(view, list.candidates[index]);
}

/** Closes the list and hands the ghost back to its own ranking. */
function closeList(view: EditorView): void {
  const meta: SmartTypeListMeta = { kind: 'close' };
  view.dispatch(view.state.tr.setMeta(smartTypeListPluginKey, meta));
  overrideSmartTypeGhost(view, undefined);
}

/**
 * `ArrowDown` opens the list, and both arrows move the selection once it is open, wrapping at
 * either end -- the same wrap `OverflowMenu` and the Navigator's tabs already use, so the three
 * lists in this product behave alike.
 *
 * Returns `false` in every case this layer has no opinion about, which is what leaves the arrow
 * keys as ordinary caret movement everywhere else -- including at a caret where a completion is
 * offered but the writer has not opened the list, where only `ArrowDown` is claimed and `ArrowUp`
 * still moves the caret.
 */
function moveSelection(view: EditorView, delta: 1 | -1): boolean {
  const list = readSmartTypeList(view.state);
  if (list.candidates.length === 0) {
    return false;
  }
  if (!list.open) {
    if (delta !== 1) {
      return false;
    }
    selectCandidate(view, list, 0);
    return true;
  }
  const count = list.candidates.length;
  selectCandidate(view, list, (list.index + delta + count) % count);
  return true;
}

/**
 * Accepts the selected candidate, through the ghost. The list's selection is already the ghost's
 * ghost (`selectCandidate`), so there is nothing to pass: `acceptSmartTypeGhost` inserts exactly
 * what the writer has been looking at.
 *
 * Returns `false` when the list is closed, so `Tab` falls through to the ghost's own accept and,
 * failing that, to the element conversions in `ScreenplayBlockNode`'s keymap -- untouched.
 */
function acceptSelected(view: EditorView): boolean {
  if (!readSmartTypeList(view.state).open) {
    return false;
  }
  const accepted = acceptSmartTypeGhost(view);
  closeList(view);
  return accepted;
}

/**
 * The first `Escape` closes the list and leaves the ghost showing; the second reaches the ghost's
 * own `Escape` and dismisses it. That ordering is the whole reason this extension carries a
 * priority above the ghost's: Tiptap runs keyboard shortcuts in extension-priority order, and at
 * the ghost's own priority the ghost would win both keys -- one `Escape` would dismiss the
 * completion out from under an open list, and `Tab` would insert the top-ranked candidate rather
 * than the selected one.
 */
function closeOnEscape(view: EditorView): boolean {
  if (!readSmartTypeList(view.state).open) {
    return false;
  }
  closeList(view);
  return true;
}

export const SmartTypeListExtension = Extension.create({
  addKeyboardShortcuts() {
    return {
      ArrowDown: () => moveSelection(this.editor.view, 1),
      ArrowUp: () => moveSelection(this.editor.view, -1),
      /**
       * `Enter` accepts the selected candidate **only while the list is open**, and `acceptSelected`
       * returns `false` in every other state, so with the list closed this binding does nothing at
       * all and `Enter` reaches `splitScreenplayBlock` exactly as it always has.
       *
       * That narrowness is the whole justification, and the next person to touch `Enter` needs the
       * reasoning rather than the rule. `Enter`'s meaning must never depend on state the writer
       * cannot see -- which is why the ghost alone does not claim it: a completion appears on its
       * own, from typing, so an `Enter` that accepted a ghost would sometimes split a block and
       * sometimes not, for reasons the writer never asked for. An open list is the opposite: it
       * exists only because they pressed `ArrowDown` to open it, it is a panel on screen with a
       * highlighted row, and in that state accepting the highlighted row is what every dropdown in
       * every application does. Requiring `Tab` there would be the surprise.
       *
       * This is also what keeps the element menu's second-`Enter`-on-an-empty-block
       * (`elementMenu.tsx`, now shipped) clear of it. An empty scene heading does show a ghost --
       * `suggest` offers all four prefixes at an empty caret -- so a ghost-level `Enter` would have
       * collided with that directly. A list-level one cannot: reaching this state costs a
       * deliberate `ArrowDown`, and a writer pressing `Enter` `Enter` on a fresh empty block never
       * passes through it. The menu takes `Enter` at priority 120, below this binding's 150, so an
       * open list still wins it -- and opening the menu dismisses the ghost, which is what keeps
       * this list from being open at the same time as the menu at all.
       *
       * The binding lives here rather than in `smartTypeGhost.ts` deliberately. Deleting this layer
       * has to take `Enter` back with it; a binding left behind in the ghost would quietly hold onto
       * a key it no longer had any use for.
       */
      Enter: () => acceptSelected(this.editor.view),
      Escape: () => closeOnEscape(this.editor.view),
      Tab: () => acceptSelected(this.editor.view),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<SmartTypeListState>({
        key: smartTypeListPluginKey,
        state: {
          apply(tr, previous) {
            const meta = tr.getMeta(smartTypeListPluginKey) as SmartTypeListMeta | undefined;
            if (meta) {
              return meta.kind === 'close' ? CLOSED : { index: meta.index, open: true };
            }
            if (!previous.open) {
              return previous;
            }
            // Typing refilters rather than closing -- that is what a combobox does, and a writer
            // who opened the list to find a location is usually still typing towards it. The
            // selection goes back to the top of the new ranking, which is also what returns the
            // ghost to agreeing with the list: the ghost's own override is cleared by this same
            // document change, so both are showing the new best candidate again.
            if (tr.docChanged) {
              return previous.index === 0 ? previous : { index: 0, open: true };
            }
            // A caret that moved without the document changing is a writer who has gone somewhere
            // else -- a click, an arrow key this layer did not claim. The candidates were for the
            // position they left.
            return tr.selectionSet ? CLOSED : previous;
          },
          init() {
            return CLOSED;
          },
        },
      }),
    ];
  },
  name: 'smartTypeList',
  // Above `SmartTypeGhostExtension`'s default 100, so this layer sees `Tab` and `Escape` first and
  // declines the ones it has no use for (see `closeOnEscape`). Stated explicitly rather than left
  // to the order the two are listed in `App.tsx`: Tiptap breaks a priority tie by declaration
  // order, so at equal priority this happens to win today purely because it is mounted second, and
  // reordering those two lines would silently move `Escape` back to the ghost.
  priority: 150,
});

/**
 * What the panel is placed against: the ghost's own box. It sits exactly at the caret already --
 * `smartTypeGhost.ts` draws it at the static position of the next character -- so the panel and the
 * completion it lists alternatives to are placed by one measurement, and the panel lands under the
 * text it is offering to replace rather than merely near it.
 *
 * The obvious alternative, `view.coordsAtPos`, measures a DOM `Range`, which jsdom implements no
 * rectangles for at all; an element's own box is something every environment this file runs in can
 * answer. The panel exists only while a ghost does (`readSmartTypeList` gates on it), so the
 * `undefined` case is a ghost that has not been painted yet, where there is nothing to measure
 * against and the previous position is the best available answer.
 */
function ghostRect(view: EditorView): DOMRect | undefined {
  return view.dom.querySelector('.smarttype-ghost')?.getBoundingClientRect();
}

/**
 * What a screen reader is told. The ghost is `aria-hidden` -- correct, since it is a preview of
 * text that does not exist -- which leaves an offered completion announced to nobody at all, so
 * the announcement belongs here with the list rather than there.
 *
 * The closed message names only the count, which is what makes it bearable while typing: a polite
 * live region re-announces when its text changes, and text that changes only when the number of
 * candidates changes stays quiet through the keystrokes that merely narrow them. Naming the best
 * candidate there would read a new sentence on almost every keystroke.
 */
function announcement(list: SmartTypeListView): string {
  if (list.candidates.length === 0) {
    return '';
  }
  const count = list.candidates.length;
  if (!list.open) {
    return `${count} completion${count === 1 ? '' : 's'} available. Press Down Arrow to review.`;
  }
  return `${list.candidates[list.index]?.insertText ?? ''}, ${list.index + 1} of ${count}.`;
}

/**
 * The panel, and the live region that describes it.
 *
 * **Roles.** This is the combobox/listbox pattern with one deliberate deviation: the text input is
 * the manuscript itself, a multi-line `role="textbox"` (`App.tsx`'s `editorProps`), and ARIA's
 * `combobox` role does not support `aria-multiline`. Relabelling the whole screenplay canvas as a
 * combobox to satisfy a pattern would misdescribe it for every second the list is not open, so the
 * canvas keeps its role and gains only the attributes that pair it with the popup --
 * `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete` -- for exactly as
 * long as the popup exists. Those are set on the editor's own DOM node from an effect rather than
 * in `App.tsx`, which is what keeps removing this layer a matter of deleting files: with the
 * component gone, no attribute was ever added and none needs taking away.
 *
 * Focus never leaves the manuscript, so the selected option is published by
 * `aria-activedescendant` rather than by moving focus into the list -- the reason that attribute
 * exists, and the same reason the Navigator's tabs use a roving `tabIndex` instead: keyboard
 * operation should not cost the writer their caret.
 */
export function SmartTypeList({ editor }: { editor: Editor | null }) {
  const [, setRenderCount] = useState(0);
  const panelRef = useRef<HTMLUListElement>(null);
  const selectedRef = useRef<HTMLLIElement>(null);

  // The list is derived from editor state, and editor state changes without React knowing. Every
  // transaction is a possible change of what belongs on screen -- a keystroke, a caret move, the
  // ghost plugin's own vocabulary refresh -- so each one is a render.
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

  const list = editor ? readSmartTypeList(editor.state) : EMPTY_LIST;
  const open = list.open && editor !== null;
  const activeOptionId = open ? `${OPTION_ID_PREFIX}-${list.index}` : undefined;

  useEffect(() => {
    const canvas = editor?.view.dom;
    if (!canvas || !activeOptionId) {
      return;
    }
    canvas.setAttribute('aria-activedescendant', activeOptionId);
    canvas.setAttribute('aria-autocomplete', 'list');
    canvas.setAttribute('aria-controls', LISTBOX_ID);
    canvas.setAttribute('aria-expanded', 'true');
    return () => {
      canvas.removeAttribute('aria-activedescendant');
      canvas.removeAttribute('aria-autocomplete');
      canvas.removeAttribute('aria-controls');
      canvas.removeAttribute('aria-expanded');
    };
  }, [activeOptionId, editor]);

  // Position before paint, and again whenever the caret could have moved under the panel: the
  // editor region scrolls independently of the window, so a wheel anywhere on the page can leave
  // the panel pointing at a caret that has gone. `scroll` is captured, because the scrolling
  // element is `.editor-region`, not the window, and a scroll event does not bubble.
  const anchorPos = open ? list.candidates[list.index]?.pos : undefined;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!editor || !panel || anchorPos === undefined) {
      return;
    }
    const reposition = () => {
      const anchor = ghostRect(editor.view);
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

  // Keeps the selected option visible once the ranking is longer than the panel. `scrollIntoView`
  // is absent in jsdom, where this file's unit tests run; the check is for that environment, not
  // for a browser.
  useLayoutEffect(() => {
    const selected = selectedRef.current;
    if (selected && typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [list.index, open]);

  return (
    <>
      {/* Always mounted, even with nothing to say: a live region has to be in the document before
          its text changes for that change to be announced. */}
      <div className="visually-hidden" role="status">
        {announcement(list)}
      </div>
      {open && (
        <ul
          aria-label="SmartType completions"
          className="smarttype-list"
          id={LISTBOX_ID}
          ref={panelRef}
          role="listbox"
        >
          {list.candidates.map((candidate, index) => (
            <li
              aria-selected={index === list.index}
              className="smarttype-list-option"
              id={`${OPTION_ID_PREFIX}-${index}`}
              key={candidate.insertText}
              // `mousedown` is where the click is claimed, not `click`: the default action of
              // pressing the mouse inside a floating panel is to move focus and collapse the
              // caret, and the caret is what the completion is anchored to. Preventing it leaves
              // the writer exactly where they were, which is also where the accept has to happen.
              onMouseDown={(event) => {
                event.preventDefault();
                if (!editor) {
                  return;
                }
                selectCandidate(editor.view, list, index);
                acceptSelected(editor.view);
              }}
              ref={index === list.index ? selectedRef : undefined}
              role="option"
            >
              {candidate.insertText}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
