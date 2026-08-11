import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import type { ScreenplayBlock } from '@finaler-draft/screenplay';
import { screenplayExtensions } from './screenplayEditor.js';
import { PaginationExtension, paginationPluginKey } from './paginationExtension.js';

/**
 * `safeParseScreenplay` requires every block id to be a UUID (see `stableIdSchema` in
 * `@finaler-draft/screenplay`), unlike `pagination.test.ts`'s fixtures, which call
 * `paginateScreenplay` directly and so never go through that validation. This extension test
 * exercises the full `projectDocumentScreenplay` -> `safeParseScreenplay` -> `paginateScreenplay`
 * pipeline, so its ids must be real UUIDs.
 */
function actionBeatId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function actionBeat(index: number): ScreenplayBlock {
  return {
    id: actionBeatId(index),
    type: 'action',
    text: `Beat number ${index} happens quietly.`,
  };
}

/** See pagination.test.ts's plainTwoPageBlocks: 29 short action blocks paginate to exactly 2 pages. */
function plainTwoPageBlocks(): ScreenplayBlock[] {
  return Array.from({ length: 29 }, (_, index) => actionBeat(index));
}

function docContentFor(blocks: readonly ScreenplayBlock[]) {
  return {
    type: 'screenplayDocument' as const,
    content: blocks.map((block) => ({
      type: 'screenplayBlock' as const,
      attrs: { element: block.type, id: block.id },
      ...('text' in block && block.text !== ''
        ? { content: [{ type: 'text', text: block.text }] }
        : {}),
    })),
  };
}

function buildEditor(blocks: readonly ScreenplayBlock[]) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    content: docContentFor(blocks),
    element: mount,
    extensions: [...screenplayExtensions, PaginationExtension],
  });
  return { editor, mount };
}

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  vi.useRealTimers();
});

describe('PaginationExtension', () => {
  it('paginates the initial document synchronously, before any animation frame elapses', () => {
    const { editor, mount } = buildEditor(plainTwoPageBlocks());
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
    });

    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(1);
    expect(mount.querySelectorAll('[data-screenplay-block].page-top')).toHaveLength(2);
    expect(mount.querySelector('.page-break-number')?.textContent).toBe('2.');
    // pageCount rides the same synchronous initial computation as the decorations -- see
    // App.tsx's syncPageCount, which reads this same plugin state rather than paginating a
    // second time to drive .page's minimum height (requirement 3).
    expect(paginationPluginKey.getState(editor.state)?.pageCount).toBe(2);
  });

  it('renders no page-break widget for a document that fits on one page', () => {
    const { editor, mount } = buildEditor(plainTwoPageBlocks().slice(0, 5));
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
    });

    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(0);
  });

  /** Appends `blocks` to `editor`'s document, one ProseMirror transaction per block -- each transaction stands in for one simulated keystroke landing in the same animation frame, before the browser has had a chance to paint. */
  function insertBlocksAsSeparateTransactions(
    editor: Editor,
    blocks: readonly ScreenplayBlock[],
  ): void {
    for (const block of blocks) {
      const node = editor.schema.nodes.screenplayBlock!.create(
        { element: block.type, id: block.id },
        'text' in block && block.text !== '' ? editor.schema.text(block.text) : undefined,
      );
      const insertAt = editor.state.doc.content.size;
      editor.view.dispatch(editor.state.tr.insert(insertAt, Fragment.fromArray([node])));
    }
  }

  it('does not repaginate until the next animation frame, and typing never blocks on it', () => {
    vi.useFakeTimers();
    const { editor, mount } = buildEditor(plainTwoPageBlocks().slice(0, 1));
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
    });
    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(0);

    // Append the remaining 28 blocks in one transaction, simulating the doc growing past a page
    // boundary. Building and dispatching the transaction itself must not block -- it is plain,
    // synchronous ProseMirror doc editing with no pagination work in it at all.
    const remaining = plainTwoPageBlocks().slice(1);
    const nodes = remaining.map((block) =>
      editor.schema.nodes.screenplayBlock!.create(
        { element: block.type, id: block.id },
        'text' in block && block.text !== '' ? editor.schema.text(block.text) : undefined,
      ),
    );
    const insertAt = editor.state.doc.content.size;
    editor.view.dispatch(editor.state.tr.insert(insertAt, Fragment.fromArray(nodes)));

    // Immediately after the edit: the plugin only mapped the old (empty) decoration set through
    // the transaction and scheduled a `requestAnimationFrame`, it has not recomputed yet, so no
    // widget exists -- the recompute is deferred to the next frame, not run inline.
    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(0);

    // The queued animation-frame callback has now run: exactly one recompute.
    vi.runOnlyPendingTimers();
    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(1);
    expect(paginationPluginKey.getState(editor.state)?.pageCount).toBe(2);
  });

  it('coalesces a burst of edits within one frame into a single recompute, not one per edit', () => {
    vi.useFakeTimers();
    // Scoped to `window.requestAnimationFrame` itself, counting only what this plugin schedules
    // -- not `vi.getTimerCount()`, which also counts unrelated timers ProseMirror/Tiptap's own
    // machinery schedules for its own purposes and would make this assertion about a number that
    // isn't this plugin's scheduling behaviour at all.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const { editor, mount } = buildEditor(plainTwoPageBlocks().slice(0, 1));
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
    });
    rafSpy.mockClear(); // ignore whatever construction/initial mount itself scheduled

    // All 28 remaining blocks are inserted as 28 separate transactions -- 28 simulated
    // keystrokes -- with no time advanced between them, so every one of them lands within the
    // same pending animation frame. `scheduleRepagination` is a no-op while a frame is already
    // queued (see paginationExtension.ts), so this must produce exactly one queued frame, not 28.
    insertBlocksAsSeparateTransactions(editor, plainTwoPageBlocks().slice(1));
    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(0);
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // Running the queued timers resolves that one frame.
    vi.runOnlyPendingTimers();
    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(1);
  });

  it('schedules a fresh frame for an edit that arrives after the previous frame already ran', () => {
    vi.useFakeTimers();
    const { editor, mount } = buildEditor(plainTwoPageBlocks().slice(0, 1));
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
    });

    const remaining = plainTwoPageBlocks().slice(1);
    insertBlocksAsSeparateTransactions(editor, remaining.slice(0, -1));
    vi.runOnlyPendingTimers();
    // Still one page: the last block (the one that pushes the doc past the first page) has not
    // been inserted yet.
    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(0);

    const lastBlock = remaining.at(-1);
    if (!lastBlock) {
      throw new Error('plainTwoPageBlocks() must yield at least 2 blocks.');
    }
    insertBlocksAsSeparateTransactions(editor, [lastBlock]);
    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(0);
    vi.runOnlyPendingTimers();
    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(1);
  });

  it('cancels a pending animation frame on destroy, never dispatching against a torn-down view', () => {
    vi.useFakeTimers();
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const { editor, mount } = buildEditor(plainTwoPageBlocks().slice(0, 1));
    rafSpy.mockClear();

    insertBlocksAsSeparateTransactions(editor, plainTwoPageBlocks().slice(1));
    expect(rafSpy).toHaveBeenCalledTimes(1);
    const scheduledHandle = rafSpy.mock.results[0]?.value as number;

    // Destroying before the frame fires must cancel it, not merely guard the callback: a
    // dangling `requestAnimationFrame` on a torn-down view would be a leak. Asserting the exact
    // handle was cancelled (not just that `cancelAnimationFrame` was called for something) proves
    // it is this plugin's own pending frame being cleaned up.
    editor.destroy();
    mount.remove();
    expect(cancelSpy).toHaveBeenCalledWith(scheduledHandle);
  });
});
