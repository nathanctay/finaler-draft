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
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { paginateScreenplay } from '@finaler-draft/layout';
import { buildPaginationDecorations } from './pagination.js';
import { projectDocumentScreenplay } from './screenplayEditor.js';

/**
 * The plugin's state: the decorations ProseMirror renders, plus the page count the same
 * `LayoutResult` produced. `pageCount` rides the existing frame-coalesced computation rather than
 * triggering a second one -- see `App.tsx`'s use of it to size `.page`'s minimum height
 * (requirement 3, progress/page-rendering.md) via `pagination.ts`'s `pageStackMinHeightIn`. It is
 * exposed alongside `decorations`, not computed separately, specifically so driving that CSS
 * value never adds a second per-keystroke or per-frame pagination pass.
 */
export type PaginationState = {
  readonly decorations: DecorationSet;
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
function computePaginationState(doc: ProseMirrorNode): PaginationState {
  const projection = projectDocumentScreenplay(doc);
  if (!projection.valid) {
    return { decorations: DecorationSet.empty, pageCount: 0 };
  }
  try {
    const layout = paginateScreenplay(projection.screenplay.blocks);
    return { decorations: buildPaginationDecorations(doc, layout), pageCount: layout.pages.length };
  } catch (error) {
    console.error('Screenplay pagination failed; rendering without page decorations.', error);
    return { decorations: DecorationSet.empty, pageCount: 0 };
  }
}

export const PaginationExtension = Extension.create({
  addProseMirrorPlugins() {
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
            return computePaginationState(instance.doc);
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
              const paginationState = computePaginationState(editorView.state.doc);
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
