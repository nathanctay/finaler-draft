/**
 * Wires `pagination.ts`'s decorations into the editor as a `requestAnimationFrame`-coalesced
 * ProseMirror plugin.
 *
 * History and why this is no longer a debounce (see progress/page-rendering.md's
 * pagination-latency entries for the full measurement record): the 300 ms debounce this plugin
 * used to use existed because `paginateScreenplay` cost roughly 0.038 ms per block -- about
 * 100 ms for a feature-length ~2,500-block screenplay -- which is far too slow to run
 * synchronously inside every keystroke's transaction. `wrap.ts` since gained an ASCII fast path
 * that cut that to roughly 5.4 ms for a 100-page script measured in Node, and isolated real-browser
 * keystrokes at that document size recompute in single digit milliseconds, comfortably inside a
 * frame. That is not the whole picture, though: measured under sustained fast typing at the same
 * document size, recomputes do not coalesce down to one per frame the way an idle-then-type
 * pattern does -- most keystrokes each get their own recompute -- and roughly a third of frames
 * during that burst exceeded a 16.7 ms budget. The debounce's 300 ms of deliberately withheld
 * feedback -- the page jump and the lagging cross-page move the owner reported -- is gone either
 * way, which is a strict improvement; whether the remaining sustained-typing cost needs further
 * work (incremental repagination, virtualization) is an open decision for the owner, deliberately
 * not made in this slice. See progress/page-rendering.md for the full numbers.
 *
 * The replacement coalesces to at most one recompute per animation frame, with at most one
 * queued at a time: `scheduleRepagination` is a no-op while a frame is already pending, so a
 * burst of keystrokes within one frame collapses to a single `requestAnimationFrame` callback
 * rather than queuing one per keystroke (never simply "setTimeout(fn, 0)", which would still
 * impose one task-boundary per keystroke and coalesce nothing). The pending handle is cancelled
 * in `destroy()` so a callback never fires against a torn-down view.
 *
 * The one property that must survive any change here, unchanged from the debounce this replaces:
 * pagination must never run synchronously inside the input event. `requestAnimationFrame` always
 * defers its callback to the next paint, off the transaction that triggered it, so `view.dispatch`
 * here -- like the `setTimeout` callback it replaces -- never blocks the keystroke that scheduled
 * it.
 *
 * Incremental repagination (resuming from a previously computed break instead of recomputing the
 * whole document) is explicitly out of scope -- see progress/page-rendering.md. This plugin
 * always recomputes from the full current document; frame-coalescing is the only mitigation used
 * here, deliberately.
 */
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { paginateScreenplay } from '@finaler-draft/layout';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@finaler-draft/screenplay';
import { LINES_PER_INCH, PAGE_WIDTH_IN } from '@finaler-draft/screenplay/pageFormat';
import { buildPaginationDecorations } from './pagination.js';
import { projectDocumentScreenplay } from './screenplayEditor.js';

/**
 * The plugin's state: the decorations ProseMirror renders, the page count the same `LayoutResult`
 * produced, and the `documentSettings` that produced both. `pageCount` rides the existing
 * frame-coalesced computation rather than triggering a second one -- see `App.tsx`'s use of it to
 * size `.page`'s minimum height (requirement 3, progress/page-rendering.md) via `pagination.ts`'s
 * `pageStackMinHeightIn`. It is exposed alongside `decorations`, not computed separately,
 * specifically so driving that CSS value never adds a second per-keystroke or per-frame
 * pagination pass.
 *
 * `documentSettings` lives here now, not only in `addProseMirrorPlugins()`'s closure, because a
 * settings change must repaginate the live document in place rather than remounting the editor
 * (plan.md requires local undo history to survive a settings change, and remounting destroys it --
 * see `updatePaginationDocumentSettings` below). Carrying the value that produced a given state
 * alongside it is what lets the `view()` handler's own repagination read back "the settings this
 * document is currently using" instead of the value the plugin was constructed with, which could
 * be stale the moment a setting changes.
 */
export type PaginationState = {
  readonly decorations: DecorationSet;
  readonly documentSettings: DocumentSettings;
  readonly pageCount: number;
};

export const paginationPluginKey = new PluginKey<PaginationState>('screenplayPagination');

/**
 * Projects `doc` to a canonical screenplay and paginates it, degrading to no decorations and a
 * zero page count rather than throwing when that is not currently possible. Two distinct cases
 * collapse to the same empty result on purpose:
 *
 *  - the projection is invalid (mid-edit or unsupported document state) -- there is no canonical
 *    screenplay to paginate yet, so there is nothing to decorate;
 *  - `paginateScreenplay` throws `UnsupportedBlockError` -- it only ever does so for
 *    `dual_dialogue`, which this text-block editor's schema cannot author (see
 *    `screenplayElementTypes` in screenplayEditor.ts), so this branch is defensive rather than
 *    reachable in practice, and the layout package must not be extended to avoid it (see
 *    progress/page-rendering.md's "do not modify packages/layout").
 */
function computePaginationState(
  doc: ProseMirrorNode,
  documentSettings: DocumentSettings,
): PaginationState {
  const projection = projectDocumentScreenplay(doc);
  if (!projection.valid) {
    return { decorations: DecorationSet.empty, documentSettings, pageCount: 0 };
  }
  try {
    const layout = paginateScreenplay(projection.screenplay.blocks, documentSettings);
    return {
      decorations: buildPaginationDecorations(doc, layout, documentSettings),
      documentSettings,
      pageCount: layout.pages.length,
    };
  } catch (error) {
    console.error('Screenplay pagination failed; rendering without page decorations.', error);
    return { decorations: DecorationSet.empty, documentSettings, pageCount: 0 };
  }
}

/**
 * The CSS specification's fixed definition of the `in` unit -- not a page-format figure, so it is
 * stated here rather than sourced from `pageGeometryCss.ts`, which owns the specification's own
 * inch values and nothing else. Used only as the floor `pixelsPerInch` below falls back to before
 * `.page` has ever been laid out (a torn-down view, or a view measured before its first paint --
 * this module's own unit tests, which run under jsdom and lay nothing out, exercise exactly that
 * floor).
 */
const CSS_PX_PER_IN = 96;

/**
 * Post-zoom pixels per manuscript inch, measured off `.page` itself: the one element the
 * manuscript renders whose CSS width is fixed at exactly `PAGE_WIDTH_IN` inches
 * (`styles.css`'s `.page { width: var(--fd-page-width) }`, sourced from `PAGE_WIDTH_IN` via
 * `pageGeometryCssVariables`) and which carries the same `transform: scale(zoom / 100)` App.tsx
 * applies to the whole manuscript (`App.tsx`'s `<article className="page" style={{ transform:
 * ... }}>`). Its painted width divided by `PAGE_WIDTH_IN` is therefore the page's current scale
 * expressed in the one unit `lineHeightPx` below needs.
 *
 * Measuring rather than reading `App.tsx`'s `zoom` state directly keeps this module ignorant of
 * where zoom lives or how it is expressed -- the same discipline `seamCaret.ts`'s own
 * `pixelsPerInch` follows for the identical problem (feature/page-seam-caret,
 * progress/page-seam-caret.md). `.page` not yet laid out -- torn down, or measured before layout
 * has ever run (jsdom; a view mounted but not yet painted) -- reports a zero width, so
 * `CSS_PX_PER_IN` is the floor, never a divide-by-zero or a zoom-blind guess.
 */
function pixelsPerInch(view: EditorView): number {
  const page = view.dom.closest<HTMLElement>('.page');
  const width = page?.getBoundingClientRect().width ?? 0;
  return width > 0 ? width / PAGE_WIDTH_IN : CSS_PX_PER_IN;
}

/** One manuscript line, in pixels, at whatever zoom is in effect right now -- see `pixelsPerInch`
 * above for how "right now" is measured. `LINES_PER_INCH` (packages/screenplay/pageFormat.ts) is
 * normative for the manuscript grid. */
function lineHeightPx(view: EditorView): number {
  return pixelsPerInch(view) / LINES_PER_INCH;
}

/**
 * How many manuscript lines the caret's own line sits above `.editor-region`'s bottom edge the
 * instant `maybeJumpScrollCaretIntoView` decides to scroll -- the owner's own requirement, given
 * directly in his own words: "hit enter to make a new line, and now I can see 5 lines worth ...
 * type stuff and hit enter again, now there are only 4 lines because I used 1" and so on down to
 * 0, at which point the next Enter jumps again. Five total lines, counted inclusively from the
 * caret's own line: the caret's line plus four empty lines visible beneath it.
 */
const JUMP_SCROLL_LINES = 5;

/**
 * A jump scroll, not a constant margin. The owner was explicit that a margin that maintains
 * itself continuously -- nudging the view by a little on every single line -- is the wrong
 * behaviour: he wants the view to hold completely still while there is still room below the
 * caret, then move in one five-line step the instant the caret would otherwise go off the bottom
 * edge, and then hold still again for the next five lines the writer fills. `EditorProps
 * .scrollMargin` (ProseMirror's own built-in mechanism, tried and abandoned for this) cannot
 * express that: it is a *margin*, applied every time ProseMirror scrolls at all, which produces
 * exactly the continuous nudge the owner rejected -- see progress/repagination-scroll-anchor.md
 * for the fuller account of why it was abandoned. This function is the real mechanism instead,
 * called directly rather than expressed through any ProseMirror prop.
 *
 * The rule is intentionally simple and stateless: if the caret's current line has reached or
 * passed `.editor-region`'s visible bottom edge (`caret.bottom >= regionRect.bottom` -- true
 * immediately after an edit that adds a new line at the very bottom, and equally true after any
 * other selection change that lands the caret there), scroll forward exactly enough that the
 * caret's line sits `JUMP_SCROLL_LINES` lines above that edge, and do nothing at all otherwise.
 * Because it re-derives "should I scroll" from the caret's *current* geometry on every call rather
 * than tracking how many of the five lines have been "used" as separate state, the five-lines-
 * remaining countdown the owner describes (5, 4, 3, 2, 1, 0, jump) falls out of it for free: each
 * one-line Enter moves the caret one line closer to the edge this same check re-evaluates next
 * time, with nothing scrolling until the caret reaches it again.
 *
 * Clamped to `.editor-region`'s own actual maximum `scrollTop` (`scrollHeight - clientHeight`):
 * at the very bottom of the last page there may not be a full five lines left to scroll into, and
 * this scrolls as far as the container allows and stops there, in one shot -- never attempting a
 * second read-modify-write to "finish the job", which is what would risk overshooting a container
 * that keeps rejecting the value.
 *
 * Never decreases `scrollTop`: the final `if` below only ever writes a larger value. In the
 * ordinary case the computed target is already ahead of the current position whenever the trigger
 * condition holds (the desired position is several lines *above* the caret's current,
 * off-the-bottom position), so this guard is normally a no-op -- but it is kept explicit, not
 * assumed, because an unusually tall caret rectangle (`readCaretRect`'s `top` far above its own
 * `bottom` -- not something the manuscript grid produces today, but not this function's invariant
 * to enforce either) could otherwise compute a target behind where the writer already is.
 */
function maybeJumpScrollCaretIntoView(view: EditorView): void {
  const region = findScrollRegion(view);
  if (!region) {
    return;
  }
  const caret = readCaretRect(view);
  if (!caret) {
    return;
  }
  const regionRect = region.getBoundingClientRect();
  if (regionRect.height <= 0) {
    return;
  }
  if (caret.bottom < regionRect.bottom) {
    // Comfortably on screen already: the whole point of a jump scroll, rather than a margin, is
    // staying completely still until the edge is actually reached.
    return;
  }

  const desiredCaretTop = regionRect.bottom - JUMP_SCROLL_LINES * lineHeightPx(view);
  const maxScrollTop = Math.max(region.scrollHeight - region.clientHeight, 0);
  const targetScrollTop = Math.min(region.scrollTop + (caret.top - desiredCaretTop), maxScrollTop);
  if (targetScrollTop > region.scrollTop) {
    region.scrollTop = targetScrollTop;
  }
}

/**
 * The caret's viewport rectangle, or `undefined` when there is no well-defined one to compensate
 * around: a destroyed view, or a selection head `coordsAtPos` cannot resolve against the current
 * document (it throws on an invalid position -- this is that guard).
 *
 * Deliberately not gated on `view.hasFocus()`, even though the writer's caret is the thing being
 * anchored: the owner's own canonical trigger for this path -- closing the document-settings
 * dialog (`updatePaginationDocumentSettings`, App.tsx's `updateDocumentSettings`) -- always steals
 * DOM focus onto the dialog's own first input the instant it opens
 * (`documentSettingsDialog.tsx`), so the editor is unfocused for the entire time a settings change
 * can trigger this. Gating on focus would silently disable compensation for exactly the scenario
 * the owner described. `coordsAtPos` is a pure DOM geometry read and needs no focus to be
 * accurate; visibility inside `.editor-region`, not focus, is the gate this function's caller
 * actually applies.
 */
function readCaretRect(view: EditorView): { top: number; bottom: number } | undefined {
  if (view.isDestroyed) {
    return undefined;
  }
  try {
    const { top, bottom } = view.coordsAtPos(view.state.selection.head);
    return { top, bottom };
  } catch {
    return undefined;
  }
}

/** The scroll container `App.tsx` gives `.editor-region` (`overflow: auto`, see styles.css) -- the
 * only element this compensation ever adjusts `scrollTop` on. */
function findScrollRegion(view: EditorView): HTMLElement | null {
  return view.dom.closest<HTMLElement>('.editor-region');
}

/**
 * Whether `rect` -- a caret rectangle, in viewport coordinates, from `readCaretRect` -- falls
 * inside `region`'s own visible viewport box. A region with no height (not yet laid out, or
 * hidden) shows nothing, so nothing in it counts as visible.
 *
 * Deliberately plain geometric overlap, not the tighter "would `maybeJumpScrollCaretIntoView`
 * consider this comfortable" test (`caret.bottom < regionRect.bottom`). They stay separate on
 * purpose, for the same reason `compensateScrollForRepagination`'s own comment gives for its
 * `wasVisible` gate existing at all: this function decides whether a repagination the writer did
 * *not* ask to scroll should preserve the caret's exact screen position, not whether that position
 * is the one the jump scroll would have chosen. Narrowing "visible" to "not at the jump-scroll
 * trigger line" would make the gate *more* restrictive, not more correct: a caret already sitting
 * right at the bottom edge -- visible, just not comfortably so -- would then be judged "not
 * visible" and left uncorrected, so a repagination could push it the rest of the way off screen
 * with nothing to catch it. That is a worse outcome than the one this function exists to prevent.
 * See `compensateScrollForRepagination`'s own comment for what runs *after* this gate, which is
 * where the jump scroll actually gets its say.
 */
function isRectVisibleInRegion(
  rect: { top: number; bottom: number },
  region: HTMLElement,
): boolean {
  const regionRect = region.getBoundingClientRect();
  if (regionRect.height <= 0) {
    return false;
  }
  return rect.bottom > regionRect.top && rect.top < regionRect.bottom;
}

/**
 * Views currently inside `compensateScrollForRepagination`'s own `dispatch()` call, below --
 * consulted by the plugin's `view().update()` hook to skip its own, general-purpose
 * `maybeJumpScrollCaretIntoView` call for exactly the one transaction this function is already
 * handling itself. See `compensateScrollForRepagination`'s own comment for why that hand-off
 * matters and cannot simply be left to both run independently.
 */
const viewsCompensatingForRepagination = new WeakSet<EditorView>();

/**
 * Repagination must not change whether the caret is visible, and must not appear to move the line
 * being typed (the owner's requirement -- see progress/repagination-scroll-anchor.md). A
 * repagination transaction changes neither the document nor the selection (it only carries a
 * freshly computed `PaginationState` as meta), so `EditorView` has no reason of its own to scroll
 * when the new page-break decorations it materializes push everything below a break down by the
 * spacer's height -- nothing corrects the caret's now-wrong screen position on its own.
 *
 * This wraps a repagination `dispatch` and restores the caret's exact screen position afterward,
 * by adjusting `.editor-region`'s `scrollTop` by precisely the shift the new decorations
 * introduced -- never by scrolling the caret back into view outright, which the owner rejected: it
 * would also fire when a writer had deliberately scrolled away (rereading page 1 while a
 * document-settings change repaginates the whole document), snapping their view back the instant
 * the repagination committed. The gate is therefore on the caret having been visible inside
 * `.editor-region` *before* this dispatch: only then is anything adjusted. If the shift measured
 * after is zero -- most repaginations move nothing near the caret at all -- `scrollTop` is left
 * completely untouched, not written with a zero delta, so a repagination that changes nothing
 * never introduces so much as a rounding drift.
 *
 * Decorations are applied synchronously inside `dispatch` (verified against Tiptap's
 * `Editor.dispatchTransaction`, which calls `view.updateState` -- itself synchronous -- before
 * returning, with no microtask or animation-frame boundary in between), so the "after" measurement
 * below is taken immediately after `dispatch` returns, with no `setTimeout` or second frame
 * needed.
 *
 * **The jump scroll's own place in this, re-decided for it specifically:** restoring the caret's
 * *exact* prior screen position can legitimately land it at or past `.editor-region`'s bottom edge
 * -- the writer could have been reading right at the edge, comfortably visible under the plain
 * geometric test `isRectVisibleInRegion` applies, when a repagination pushed everything below a
 * break down by a spacer's height. Preserving that exact position is still correct (the owner's
 * "must not appear to move the line being typed" requirement governs this function, not comfort),
 * but it can leave the caret in exactly the state the jump scroll exists to correct, so
 * `maybeJumpScrollCaretIntoView` gets an explicit call once this function's own correction has
 * settled -- and only inside the branch where the caret *was* being tracked (`wasVisible`). A
 * writer who had scrolled away must be left alone by this function entirely, per the gate above;
 * letting the jump scroll evaluate their unrelated, un-tracked viewport here would snap it toward
 * their caret regardless, which is exactly the surprise `wasVisible` exists to prevent. The
 * ordinary per-transaction call in the plugin's `view().update()` hook is deliberately skipped for
 * *this* transaction (`viewsCompensatingForRepagination`, above) so this single, deliberate call is
 * the only one that runs for it -- the generic hook's own caret measurement, taken from inside
 * `dispatch()` before this function's own "after" correction has been applied, would otherwise
 * measure a mid-correction position and both calls would fight over the same `scrollTop`.
 */
function compensateScrollForRepagination(view: EditorView, dispatch: () => void): void {
  const region = findScrollRegion(view);
  const before = region ? readCaretRect(view) : undefined;
  const wasVisible =
    before !== undefined && region !== null && isRectVisibleInRegion(before, region);

  viewsCompensatingForRepagination.add(view);
  dispatch();
  viewsCompensatingForRepagination.delete(view);

  if (!wasVisible || !region || !before) {
    return;
  }
  const after = readCaretRect(view);
  if (!after) {
    return;
  }
  const shift = after.top - before.top;
  if (shift !== 0) {
    region.scrollTop += shift;
  }
  maybeJumpScrollCaretIntoView(view);
}

/**
 * Applies a new `documentSettings` to the live pagination plugin, in place. Dispatches a
 * transaction carrying the freshly computed `PaginationState` as `paginationPluginKey`'s meta --
 * the identical mechanism the `view()` handler's own frame-coalesced repagination already uses
 * below, just invoked directly and computed synchronously rather than deferred to the next
 * animation frame.
 *
 * Running synchronously here (unlike the doc-change path, which is deliberately deferred off the
 * input event -- see this module's top-of-file comment) is correct, not an oversight: a settings
 * change is a deliberate, infrequent action (closing the document-settings dialog), not a
 * keystroke, so there is no burst to coalesce and no reason to withhold the result for a frame.
 * The cost is one full `paginateScreenplay` pass over the current document -- the same per-block
 * cost the frame-coalesced path already pays on every repagination (see the module comment's own
 * measurements) -- run once, synchronously, at the moment the writer applies the change.
 *
 * This is also the piece that lets `App.tsx` change `documentSettings` without remounting the
 * editor. `addProseMirrorPlugins()` used to close over `documentSettings` once, at plugin
 * construction, which is exactly why a settings change used to require building a fresh editor
 * instance -- destroying local undo history, which plan.md does not allow. The plugin's own state
 * now carries `documentSettings` (see `PaginationState` above), so this function, and the
 * `view()` handler's own repagination reading it back, are the only two places that still need to
 * know the current value; `addOptions()`'s `documentSettings` remains only the value the plugin is
 * seeded with when the editor first mounts.
 */
export function updatePaginationDocumentSettings(
  editor: Editor,
  documentSettings: DocumentSettings,
): void {
  const paginationState = computePaginationState(editor.state.doc, documentSettings);
  compensateScrollForRepagination(editor.view, () => {
    editor.view.dispatch(editor.state.tr.setMeta(paginationPluginKey, paginationState));
  });
}

export type PaginationExtensionOptions = {
  /**
   * The loaded screenplay's own settings — plan.md: "These values are document state, not
   * application preferences." Defaults to the specification's current fixed values so an editor
   * built without `.configure({ documentSettings })` (every existing call site before document
   * settings existed, including this extension's own tests) keeps pagination behavior unchanged.
   * `App.tsx` configures this from the loaded screenplay's real `documentSettings` when it builds
   * the editor, and again whenever a different screenplay (and thus a different
   * `documentSettings`) is loaded, since `useEditor`'s extensions are only read once per editor
   * instance and `App` remounts a new editor per screenplay (see its own top-of-file reasoning).
   */
  documentSettings: DocumentSettings;
};

export const PaginationExtension = Extension.create<PaginationExtensionOptions>({
  addOptions() {
    return { documentSettings: DEFAULT_DOCUMENT_SETTINGS };
  },
  addProseMirrorPlugins() {
    const { documentSettings } = this.options;
    return [
      new Plugin({
        key: paginationPluginKey,
        props: {
          decorations(state) {
            return paginationPluginKey.getState(state)?.decorations;
          },
        },
        state: {
          apply(tr, paginationState) {
            const recomputed = tr.getMeta(paginationPluginKey) as PaginationState | undefined;
            if (recomputed) {
              return recomputed;
            }
            return tr.docChanged
              ? {
                  ...paginationState,
                  decorations: paginationState.decorations.map(tr.mapping, tr.doc),
                }
              : paginationState;
          },
          init(_config, instance) {
            return computePaginationState(instance.doc, documentSettings);
          },
        },
        view(editorView) {
          let pendingFrame: number | undefined;
          const scheduleRepagination = () => {
            // A frame is already queued: the transaction that will run in it is already
            // scheduled to read the latest `editorView.state.doc` when it fires, so a second
            // request here would only queue a redundant callback, not capture anything new.
            if (pendingFrame !== undefined) {
              return;
            }
            pendingFrame = window.requestAnimationFrame(() => {
              pendingFrame = undefined;
              if (editorView.isDestroyed) {
                return;
              }
              // Reads the plugin's own current `documentSettings`, not the value this closure was
              // constructed with: a writer can change settings (via the document-settings dialog,
              // see `updatePaginationDocumentSettings`) at any point, including between a
              // keystroke and the animation frame that repaginates it. Falling back to the
              // closure's `documentSettings` only covers the state before the plugin's own state
              // has been initialized at all, which `init` above already guarantees never outlives
              // this view's construction.
              const currentDocumentSettings =
                paginationPluginKey.getState(editorView.state)?.documentSettings ??
                documentSettings;
              const paginationState = computePaginationState(
                editorView.state.doc,
                currentDocumentSettings,
              );
              compensateScrollForRepagination(editorView, () => {
                editorView.dispatch(
                  editorView.state.tr.setMeta(paginationPluginKey, paginationState),
                );
              });
            });
          };
          return {
            destroy() {
              if (pendingFrame !== undefined) {
                window.cancelAnimationFrame(pendingFrame);
              }
            },
            update(view, previousState) {
              // Every transaction, not only doc-changing ones: a plain selection move (arrow-key
              // navigation, a click) can just as well land the caret at the bottom edge as an
              // edit can. Skipped for a transaction `compensateScrollForRepagination` is already
              // handling itself (`viewsCompensatingForRepagination`) -- see that function's own
              // comment for why running both here would corrupt its own before/after measurement.
              if (!viewsCompensatingForRepagination.has(view)) {
                maybeJumpScrollCaretIntoView(view);
              }
              if (!view.state.doc.eq(previousState.doc)) {
                scheduleRepagination();
              }
            },
          };
        },
      }),
    ];
  },
  name: 'screenplayPagination',
});
