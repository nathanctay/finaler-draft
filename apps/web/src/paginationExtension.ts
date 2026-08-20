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
import { DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { paginateScreenplay } from '@finaler-draft/layout';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@finaler-draft/screenplay';
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
  editor.view.dispatch(editor.state.tr.setMeta(paginationPluginKey, paginationState));
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
              editorView.dispatch(
                editorView.state.tr.setMeta(paginationPluginKey, paginationState),
              );
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
