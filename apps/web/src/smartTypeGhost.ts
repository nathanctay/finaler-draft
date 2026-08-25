/**
 * SmartType stage 2: the inline ghost completion, rendered in the real editor.
 *
 * Stage 1 (`packages/screenplay`'s `deriveVocabulary`/`suggest`) is the pure core -- no DOM, no
 * ProseMirror -- and this module is the only thing that turns its output into something a writer
 * can see. It draws the best candidate's `remainder` after the caret -- the best candidate that
 * has something to add, which is not always `candidates[0]`; see `resolveSmartTypeGhost` for why
 * that distinction is what makes the feature work at all -- and inserts that candidate on an
 * explicit accept. Nothing else about the editor changes.
 *
 * Three properties are load-bearing, in this order:
 *
 *  1. **Nothing enters the document before accept.** The ghost is a widget decoration, which
 *     lives in a `DecorationSet` beside the document rather than in it, so the canonical
 *     screenplay `projectDocumentScreenplay` reads is byte-identical whether a ghost is showing
 *     or not. That is what keeps it out of every save, every reload, and every export -- not a
 *     filter somewhere downstream, which would be one forgotten call site away from shipping
 *     ghost text into a writer's FDX.
 *
 *  2. **The ghost takes no part in layout.** The character grid is normative here (plan.md's
 *     "Vertical spacing between elements", and `pagination.ts`'s whole technique): text rendered
 *     inline inside a text block changes where that line wraps, which shifts every line after it
 *     and makes the DOM disagree with the paginated model. Two rendering defects of exactly that
 *     shape were fixed in PRs #16 and #19. The ghost is therefore absolutely positioned
 *     (`.smarttype-ghost` in styles.css) with no `top`/`left` of its own, so it paints at its own
 *     static position -- exactly where the next character would have gone -- while contributing
 *     nothing to the line box it sits in. `page-rendering-persistence.spec.ts` measures that
 *     claim in a real browser rather than asserting it: same document, ghost showing versus
 *     dismissed, identical block tops and identical page geometry.
 *
 *  3. **The widget key encodes the ghost text.** `prosemirror-view`'s `WidgetType.eq` short-
 *     circuits on `spec.key` alone, so two widgets with equal keys are the same widget and the
 *     old DOM is reused verbatim. A key that named only the position would leave the first
 *     ghost's text on screen for the rest of the word. See `ghostDecorations`.
 *
 * Deliberately not here: `Enter` is untouched (it belongs to `splitScreenplayBlock`, and the
 * element menu will claim a second-Enter behaviour later), and there is no list, popup, or
 * ranking UI -- stage 3's optional accept-by-list layer consumes the same `suggest` output
 * independently, from `App.tsx`, and can be removed again without unpicking anything here.
 */
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { deriveVocabulary, suggest, type ScreenplayVocabulary } from '@finaler-draft/screenplay';
import { isScreenplayElementType, projectDocumentScreenplay } from './screenplayEditor.js';

/**
 * The single completion currently on offer: what to draw (`text`, stage 1's `remainder`), where
 * to draw it (`pos`, the caret), and everything an accept needs (`insertText`, `matchedLength`)
 * without re-deriving the match. Accepting replaces the `matchedLength` code units before `pos`
 * with `insertText` -- stage 1's contract, restated as document positions.
 */
export type SmartTypeGhost = {
  readonly insertText: string;
  readonly matchedLength: number;
  readonly pos: number;
  readonly text: string;
};

/**
 * `vocabulary` is refreshed off the keystroke path (see the plugin's `view()` below), so it is
 * carried in plugin state rather than recomputed per transaction. `dismissed` is Escape's effect
 * and lasts until the writer types again. `ghost` is `undefined` whenever there is nothing to
 * offer, which is the overwhelmingly common case -- most keystrokes are not in a scene heading or
 * a character cue at all.
 */
export type SmartTypeGhostState = {
  readonly decorations: DecorationSet;
  readonly dismissed: boolean;
  readonly ghost: SmartTypeGhost | undefined;
  readonly vocabulary: ScreenplayVocabulary;
};

type SmartTypeGhostMeta =
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'vocabulary'; readonly vocabulary: ScreenplayVocabulary };

export const smartTypeGhostPluginKey = new PluginKey<SmartTypeGhostState>('smartTypeGhost');

/**
 * The vocabulary of a document with nothing authored in it yet: not actually empty, because
 * `deriveVocabulary` seeds all four scene-heading prefixes and the conventional times (see its
 * own doc comment). Used as the fallback whenever a projection is not currently possible, so a
 * mid-edit document that momentarily fails validation keeps offering the seeds rather than
 * throwing or flickering the ghost away.
 */
const SEED_VOCABULARY: ScreenplayVocabulary = deriveVocabulary([]);

/**
 * Derives the vocabulary from a live ProseMirror document, keeping `fallback` when the document
 * cannot currently be projected. Reuses `projectDocumentScreenplay` rather than walking the doc
 * separately: the canonical block list is exactly what `deriveVocabulary` consumes, and a second
 * hand-rolled projection here would be a second place for the two to disagree about what a block
 * is. The cost is one projection (`safeParseScreenplay` included) per call, which is why the only
 * caller is frame-coalesced.
 */
function deriveVocabularyForDoc(
  doc: ProseMirrorNode,
  fallback: ScreenplayVocabulary,
): ScreenplayVocabulary {
  const projection = projectDocumentScreenplay(doc);
  return projection.valid ? deriveVocabulary(projection.screenplay.blocks) : fallback;
}

/**
 * The completion to show for `state`'s current selection, or `undefined` for the many positions
 * that must never ghost. Every condition below is a rule of this feature, not a defensive check:
 *
 *  - a non-empty selection is a writer selecting text, not typing into it;
 *  - a caret outside a `screenplayBlock` (an empty document, before any block exists) has no
 *    element to suggest for;
 *  - **a caret that is not at the end of the block's text never ghosts.** Ghosting mid-text would
 *    draw the completion over the writer's own following characters, and accepting it would
 *    silently rewrite text they had already finished;
 *  - a candidate with an empty `remainder` has nothing to draw, so it is skipped. Stage 1 still
 *    offers such a candidate, because accepting one corrects the writer's case, but case
 *    correction needs a visible affordance of its own and invisible ghost text is not one.
 *
 * The ghost is therefore the best-ranked candidate **that has something to add**, rather than
 * `candidates[0]` unconditionally, and that distinction is load-bearing rather than a refinement.
 * `deriveVocabulary` reads the whole ordered body, and the block the writer is typing into is part
 * of that body -- so a heading half-typed as `INT. AP` puts the location `AP` into the very
 * vocabulary being offered back to them, where it matches their typing exactly, outranks the
 * `APARTMENT` they are reaching for (equal frequency, and their own block is by definition the most
 * recently authored one), and completes to nothing. Taking `candidates[0]` alone therefore makes
 * the ghost vanish a frame after every keystroke -- measured in a real browser, not reasoned about:
 * the ghost test in `page-rendering-persistence.spec.ts` failed on exactly this, waiting for a
 * completion that had cancelled itself out. Skipping the empty remainder is the whole fix, and it
 * leaves ranking entirely to stage 1: a self-match adds one candidate that draws nothing, it never
 * reorders the ones that do.
 *
 * Which elements complete at all is `suggest`'s decision, not this function's: it returns `[]` for
 * everything except `scene_heading` and `character`, so no element list is restated here.
 */
export function resolveSmartTypeGhost(
  state: EditorState,
  vocabulary: ScreenplayVocabulary,
): SmartTypeGhost | undefined {
  const { selection } = state;
  if (!selection.empty) {
    return undefined;
  }

  const { $from } = selection;
  const block = $from.parent;
  if (block.type.name !== 'screenplayBlock' || !isScreenplayElementType(block.attrs.element)) {
    return undefined;
  }
  if ($from.parentOffset !== block.content.size) {
    return undefined;
  }

  const candidate = suggest(block.attrs.element, block.textContent, vocabulary).find(
    (offered) => offered.remainder !== '',
  );
  if (!candidate) {
    return undefined;
  }

  return {
    insertText: candidate.insertText,
    matchedLength: candidate.matchedLength,
    pos: selection.from,
    text: candidate.remainder,
  };
}

/**
 * The ghost's DOM: one inline span carrying the remainder, marked `contenteditable="false"` so
 * the caret can never land inside it and `aria-hidden` so a screen reader reads the block's real
 * text rather than text the writer has not accepted. (Announcing an available completion is a
 * separate affordance that belongs with stage 3's list, not with a decoration that exists purely
 * to be looked at.) Everything visual -- the grey, the out-of-flow positioning that keeps it off
 * the character grid, `pointer-events: none` -- is `.smarttype-ghost` in styles.css.
 */
function buildGhostWidget(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'smarttype-ghost';
  // `setAttribute`, not the `contentEditable` property `pagination.ts`'s widgets assign: the two
  // are equivalent in a browser (the attribute is what the property reflects), but jsdom does not
  // implement the property at all, so only the attribute form can be asserted by the unit tests
  // beside this file rather than only in a real-browser spec.
  span.setAttribute('contenteditable', 'false');
  span.setAttribute('aria-hidden', 'true');
  span.textContent = text;
  return span;
}

/**
 * One widget decoration at the caret. Three spec choices, each load-bearing:
 *
 *  - `key` includes the ghost text itself. `prosemirror-view` compares keyed widgets by key alone
 *    (`WidgetType.eq`), reusing the existing DOM node for any widget whose key matches -- so a key
 *    of only the position would freeze the first character's suggestion on screen while the writer
 *    kept typing. The position is in the key as well, which costs nothing and keeps the key a
 *    complete description of what is drawn.
 *  - `side: 1` puts the ghost after the caret rather than before it, which is where a completion
 *    belongs and also what keeps the caret rendering at the end of the writer's own text.
 *  - `ignoreSelection` stops the widget from capturing a selection at that position: the ghost is
 *    display, never somewhere the caret can be.
 */
function ghostDecorations(doc: ProseMirrorNode, ghost: SmartTypeGhost): DecorationSet {
  return DecorationSet.create(doc, [
    Decoration.widget(ghost.pos, () => buildGhostWidget(ghost.text), {
      ignoreSelection: true,
      key: `smarttype-ghost|${ghost.pos}|${ghost.text}`,
      side: 1,
    }),
  ]);
}

/**
 * Accepts the ghost currently on offer, producing exactly stage 1's accept:
 * `textBeforeCaret.slice(0, length - matchedLength) + insertText`, with the caret after the
 * inserted text and everything after the caret untouched. One transaction, one step -- so one
 * undo takes the whole completion back and nothing else.
 *
 * `closeHistory` is what makes that true. `prosemirror-history` groups adjacent steps authored
 * within a few hundred milliseconds into a single undo event, and an accept is by definition
 * adjacent to the characters the writer just typed -- without this, one undo after `Tab` would
 * swallow the typed characters as well, leaving the writer nowhere to stand. Closing the history
 * event before the insertion makes the completion its own undoable act, which is what a writer
 * pressing Ctrl+Z immediately after a completion is asking to reverse.
 *
 * Returns `false` when there is no ghost, so `Tab` falls through to the element conversions
 * `ScreenplayBlockNode`'s own keymap already performs (action to character, dialogue to
 * parenthetical). Those two never overlap with this one: a ghost only ever exists in a scene
 * heading or a character cue, where that keymap already returns `false`.
 */
export function acceptSmartTypeGhost(view: EditorView): boolean {
  const ghost = smartTypeGhostPluginKey.getState(view.state)?.ghost;
  if (!ghost) {
    return false;
  }

  const from = ghost.pos - ghost.matchedLength;
  const transaction = closeHistory(view.state.tr).insertText(ghost.insertText, from, ghost.pos);
  transaction.setSelection(TextSelection.create(transaction.doc, from + ghost.insertText.length));
  view.dispatch(transaction);
  return true;
}

/**
 * Dismisses the ghost until the writer types again (`apply` clears `dismissed` on the next
 * document change). The dispatched transaction carries no steps, so it changes no document, adds
 * nothing undoable, and triggers no save -- `App.tsx` saves from Tiptap's `onUpdate`, which only
 * fires for document changes.
 *
 * Returns `false` when there is no ghost, so Escape keeps whatever meaning the rest of the
 * application gives it.
 */
export function dismissSmartTypeGhost(view: EditorView): boolean {
  if (!smartTypeGhostPluginKey.getState(view.state)?.ghost) {
    return false;
  }
  const meta: SmartTypeGhostMeta = { kind: 'dismiss' };
  view.dispatch(view.state.tr.setMeta(smartTypeGhostPluginKey, meta));
  return true;
}

function initialState(state: EditorState): SmartTypeGhostState {
  const vocabulary = deriveVocabularyForDoc(state.doc, SEED_VOCABULARY);
  const ghost = resolveSmartTypeGhost(state, vocabulary);
  return {
    decorations: ghost ? ghostDecorations(state.doc, ghost) : DecorationSet.empty,
    dismissed: false,
    ghost,
    vocabulary,
  };
}

/**
 * Inline ghost completion. Installed alongside `PaginationExtension` from `App.tsx` rather than
 * inside `screenplayExtensions`, for the same reason pagination is: it is a layer over the
 * screenplay editor, not part of what a screenplay block *is*, and every test that builds a bare
 * editor should keep getting one without a ghost in it.
 */
export const SmartTypeGhostExtension = Extension.create({
  addKeyboardShortcuts() {
    return {
      /**
       * Accept. `Enter` is deliberately not bound here, in any form: it belongs to
       * `splitScreenplayBlock` and the element menu will claim a second-Enter behaviour later, so
       * a completion that could be accepted with it would be a collision waiting to happen.
       */
      Tab: () => acceptSmartTypeGhost(this.editor.view),
      Escape: () => dismissSmartTypeGhost(this.editor.view),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<SmartTypeGhostState>({
        key: smartTypeGhostPluginKey,
        props: {
          decorations(state) {
            return smartTypeGhostPluginKey.getState(state)?.decorations;
          },
        },
        state: {
          apply(tr, previous, _oldState, newState) {
            const meta = tr.getMeta(smartTypeGhostPluginKey) as SmartTypeGhostMeta | undefined;
            const vocabulary = meta?.kind === 'vocabulary' ? meta.vocabulary : previous.vocabulary;
            // Escape holds until the writer types again -- a document change, not a selection
            // move: moving the caret away and back is not "typing again", and clearing the
            // dismissal there would make the ghost reappear on a click the writer used to get
            // rid of it.
            const dismissed =
              meta?.kind === 'dismiss' ? true : tr.docChanged ? false : previous.dismissed;

            // Most transactions -- pagination's own frame-coalesced decoration dispatch above
            // all, one per frame while typing -- change neither the document, the selection, nor
            // anything this plugin tracks. Returning the previous state object unchanged for
            // those keeps the `DecorationSet` identity stable and skips a `suggest` call that
            // could only produce the answer already in hand.
            if (
              !tr.docChanged &&
              !tr.selectionSet &&
              vocabulary === previous.vocabulary &&
              dismissed === previous.dismissed
            ) {
              return previous;
            }

            const ghost = dismissed ? undefined : resolveSmartTypeGhost(newState, vocabulary);
            return {
              decorations: ghost ? ghostDecorations(newState.doc, ghost) : DecorationSet.empty,
              dismissed,
              ghost,
              vocabulary,
            };
          },
          init(_config, state) {
            return initialState(state);
          },
        },
        /**
         * The vocabulary is a whole-document scan (`deriveVocabularyForDoc`), so it is refreshed
         * at most once per animation frame and never inside the transaction that triggered it --
         * the same technique, and the same reasoning, as `paginationExtension.ts`'s repagination:
         * a per-keystroke document-wide pass is exactly what that plugin's own comment exists to
         * forbid. The ghost therefore reads a vocabulary that can be one frame stale, which is
         * harmless by construction: it is the vocabulary of what the writer has *already*
         * authored, and the only thing a frame of staleness can hide is the term they are typing
         * at this instant -- which they do not need suggested back to them.
         *
         * The dispatched transaction carries no steps, exactly like the pagination plugin's, so
         * it changes no document and triggers no save.
         */
        view(editorView) {
          let pendingFrame: number | undefined;
          const scheduleVocabularyRefresh = () => {
            if (pendingFrame !== undefined) {
              return;
            }
            pendingFrame = window.requestAnimationFrame(() => {
              pendingFrame = undefined;
              if (editorView.isDestroyed) {
                return;
              }
              const previous =
                smartTypeGhostPluginKey.getState(editorView.state)?.vocabulary ?? SEED_VOCABULARY;
              const meta: SmartTypeGhostMeta = {
                kind: 'vocabulary',
                vocabulary: deriveVocabularyForDoc(editorView.state.doc, previous),
              };
              editorView.dispatch(editorView.state.tr.setMeta(smartTypeGhostPluginKey, meta));
            });
          };
          return {
            destroy() {
              if (pendingFrame !== undefined) {
                window.cancelAnimationFrame(pendingFrame);
              }
            },
            update(view, previousState) {
              if (!view.state.doc.eq(previousState.doc)) {
                scheduleVocabularyRefresh();
              }
            },
          };
        },
      }),
    ];
  },
  name: 'smartTypeGhost',
});
