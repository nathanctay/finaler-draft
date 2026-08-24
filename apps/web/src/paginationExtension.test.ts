import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { DEFAULT_DOCUMENT_SETTINGS, type ScreenplayBlock } from '@finaler-draft/screenplay';
import { screenplayExtensions } from './screenplayEditor.js';
import {
  PaginationExtension,
  paginationPluginKey,
  updatePaginationDocumentSettings,
} from './paginationExtension.js';

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

/**
 * `linesOfLength`/`speechSplitBlocks`: the same recipe as `pagination.test.ts`'s own fixture of
 * the same name -- a 50-line action block fills page 1 to room 5, forcing a 4-line dialogue
 * speech to split 2-and-2 across the break, generating `(MORE)` and a `CONT'D` heading -- with
 * UUID ids, since this file (unlike that one) exercises the full
 * `projectDocumentScreenplay -> safeParseScreenplay -> paginateScreenplay` pipeline.
 */
function linesOfLength(budget: number, n: number): string {
  return 'x'.repeat(budget * (n - 1) + 1);
}

function speechSplitBlocks(): ScreenplayBlock[] {
  return [
    { id: '00000000-0000-4000-a000-000000000000', type: 'action', text: linesOfLength(60, 50) },
    { id: '00000000-0000-4000-a000-000000000001', type: 'character', text: 'ADA' },
    { id: '00000000-0000-4000-a000-000000000002', type: 'dialogue', text: linesOfLength(35, 4) },
  ];
}

function sceneHeading(index: number, text: string): ScreenplayBlock {
  return {
    id: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
    type: 'scene_heading',
    text,
  };
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

/**
 * `documentSettings` is optional and, when passed, configures the extension with it -- every
 * existing call site in this file omits it and gets the bare, unconfigured extension (matching
 * `DEFAULT_DOCUMENT_SETTINGS`), unchanged from before this parameter existed.
 */
function buildEditor(
  blocks: readonly ScreenplayBlock[],
  documentSettings?: typeof DEFAULT_DOCUMENT_SETTINGS,
) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    content: docContentFor(blocks),
    element: mount,
    extensions: [
      ...screenplayExtensions,
      documentSettings ? PaginationExtension.configure({ documentSettings }) : PaginationExtension,
    ],
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

  it("renders a mid-dialogue break's widget as a DESCENDANT of the dialogue block's own DOM element, not a sibling", () => {
    // The precondition styles.css's page-break-widget CSS depends on (see its own comment there):
    // a break whose page-break lands mid-speech has no block boundary to anchor at
    // (pagination.ts's computePageBreaks), so the widget decoration is inserted inside the
    // dialogue block's inline content and therefore renders as its DOM child, not its sibling.
    // jsdom does not compute real layout (no font metrics, every getBoundingClientRect is zero),
    // so this only proves the DOM ancestry the CSS fix's selector
    // (`[data-screenplay-element='dialogue'] .page-break-widget`) matches against; the actual
    // rendered geometry that ancestry produces is proven separately, against real Chrome layout,
    // in page-rendering.spec.ts.
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const widget = mount.querySelector('.page-break-widget');
    expect(widget).not.toBeNull();
    const dialogueAncestor = widget?.closest('[data-screenplay-block]');
    expect(dialogueAncestor).not.toBeNull();
    expect(dialogueAncestor?.getAttribute('data-screenplay-element')).toBe('dialogue');
    // And the widget is genuinely a descendant, not the block element itself.
    expect(dialogueAncestor).not.toBe(widget);
    expect(dialogueAncestor?.contains(widget)).toBe(true);

    // The control case, for contrast: a plain block-boundary break (plainTwoPageBlocks) renders
    // its widget as a sibling of every block, inside .ProseMirror directly -- no
    // `[data-screenplay-block]` ancestor at all.
    const { editor: plainEditor, mount: plainMount } = buildEditor(plainTwoPageBlocks());
    const plainWidget = plainMount.querySelector('.page-break-widget');
    expect(plainWidget).not.toBeNull();
    expect(plainWidget?.closest('[data-screenplay-block]')).toBeNull();

    editor.destroy();
    mount.remove();
    plainEditor.destroy();
    plainMount.remove();
  });
});

describe('updatePaginationDocumentSettings', () => {
  it('re-renders the page number in the new style immediately, proving the decoration key busts on a style change', () => {
    const { editor, mount } = buildEditor(plainTwoPageBlocks());
    // Default is arabic.
    expect(mount.querySelector('.page-break-number')?.textContent).toBe('2.');

    updatePaginationDocumentSettings(editor, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      pageNumberStyle: 'roman',
    });

    // This is the trap `buildPaginationDecorations`'s widget key comment describes: if the key
    // did not encode `pageNumberStyle`, ProseMirror would treat this as the same widget it
    // already drew (same page number, same spacer height, same absent (MORE)/CONT'D) and reuse
    // the stale arabic DOM node without calling `buildPageBreakWidget` again at all -- the text
    // would still read "2." here. Testing through the key, not just `toRomanNumeral` in
    // isolation, is what a passing assertion on the function alone would not catch.
    expect(mount.querySelector('.page-break-number')?.textContent).toBe('II.');
    editor.destroy();
    mount.remove();
  });

  it('applies synchronously: no animation frame needs to elapse for the new style to render', () => {
    vi.useFakeTimers();
    const { editor, mount } = buildEditor(plainTwoPageBlocks());
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    rafSpy.mockClear();

    updatePaginationDocumentSettings(editor, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      pageNumberStyle: 'roman',
    });

    expect(mount.querySelector('.page-break-number')?.textContent).toBe('II.');
    expect(rafSpy).not.toHaveBeenCalled();
    editor.destroy();
    mount.remove();
  });

  it("updates the plugin's own pageCount-bearing state, readable the same way App.tsx's syncPageCount reads it", () => {
    const { editor, mount } = buildEditor(plainTwoPageBlocks());
    expect(paginationPluginKey.getState(editor.state)?.pageCount).toBe(2);

    updatePaginationDocumentSettings(editor, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      pageNumberStyle: 'roman',
    });

    // Page count itself is unaffected by a purely cosmetic setting, but the state object was
    // genuinely replaced (not merely mutated in place) -- see the next assertion.
    expect(paginationPluginKey.getState(editor.state)?.pageCount).toBe(2);
    expect(paginationPluginKey.getState(editor.state)?.documentSettings.pageNumberStyle).toBe(
      'roman',
    );
    editor.destroy();
    mount.remove();
  });

  it('a later doc-change repagination reads the updated settings back from plugin state, not the stale construction closure', () => {
    vi.useFakeTimers();
    const { editor, mount } = buildEditor(plainTwoPageBlocks());
    updatePaginationDocumentSettings(editor, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      pageNumberStyle: 'roman',
    });
    expect(mount.querySelector('.page-break-number')?.textContent).toBe('II.');

    // A plain doc edit after the settings change: append one more block, which shifts the break
    // but must not fall back to the plugin-construction closure's arabic default.
    const lastBlock = plainTwoPageBlocks().at(-1);
    if (!lastBlock) {
      throw new Error('plainTwoPageBlocks() must yield at least one block.');
    }
    const node = editor.schema.nodes.screenplayBlock!.create(
      { element: lastBlock.type, id: '00000000-0000-4000-8000-000000000099' },
      'text' in lastBlock && lastBlock.text !== '' ? editor.schema.text(lastBlock.text) : undefined,
    );
    editor.view.dispatch(
      editor.state.tr.insert(editor.state.doc.content.size, Fragment.fromArray([node])),
    );
    vi.runOnlyPendingTimers();

    expect(mount.querySelector('.page-break-number')?.textContent).toBe('II.');
    editor.destroy();
    mount.remove();
  });
});

describe('scene numbers (live)', () => {
  it('renders nothing when sceneNumbersEnabled is off, the default', () => {
    const { editor, mount } = buildEditor([
      sceneHeading(0, 'INT. APARTMENT - MORNING'),
      actionBeat(0),
      sceneHeading(1, 'EXT. STREET - DAY'),
    ]);

    expect(mount.querySelectorAll('[data-scene-number]')).toHaveLength(0);
    editor.destroy();
    mount.remove();
  });

  it('numbers every scene heading 1-based in document order once enabled, live, with no editor remount', () => {
    const { editor, mount } = buildEditor([
      sceneHeading(0, 'INT. APARTMENT - MORNING'),
      actionBeat(0),
      sceneHeading(1, 'EXT. STREET - DAY'),
    ]);

    updatePaginationDocumentSettings(editor, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      sceneNumbersEnabled: true,
    });

    const numbers = Array.from(mount.querySelectorAll('[data-scene-number]')).map((el) =>
      el.getAttribute('data-scene-number'),
    );
    expect(numbers).toEqual(['1', '2']);
    editor.destroy();
    mount.remove();
  });

  it('renumbers as scene headings reorder, without any settings change at all', () => {
    const heading0 = sceneHeading(0, 'INT. APARTMENT - MORNING');
    const heading1 = sceneHeading(1, 'EXT. STREET - DAY');
    const { editor, mount } = buildEditor([heading0, heading1], {
      ...DEFAULT_DOCUMENT_SETTINGS,
      sceneNumbersEnabled: true,
    });

    const before = Array.from(mount.querySelectorAll('[data-scene-number]')).map((el) =>
      el.getAttribute('data-scene-number'),
    );
    expect(before).toEqual(['1', '2']);

    // Swap the two top-level scene-heading nodes -- the ProseMirror-level equivalent of a writer
    // dragging the second scene above the first, exercising the plugin's own doc-change ->
    // requestAnimationFrame -> recompute path (not `updatePaginationDocumentSettings`, which this
    // test deliberately never calls, since a reorder is not a settings change).
    vi.useFakeTimers();
    const nodes: ProseMirrorNode[] = [];
    editor.state.doc.forEach((node) => nodes.push(node));
    const reordered = [nodes[1], nodes[0]] as ProseMirrorNode[];
    editor.view.dispatch(
      editor.state.tr.replaceWith(0, editor.state.doc.content.size, Fragment.fromArray(reordered)),
    );
    vi.runOnlyPendingTimers();

    const after = Array.from(mount.querySelectorAll('[data-scene-number]')).map((el) =>
      el.getAttribute('data-scene-number'),
    );
    // Same two headings, same two numbers 1 and 2 -- but now attached to the heading that moved
    // to the front. `canonical_hash` is untouched by this (a pure reorder of already-canonical
    // blocks), which is the whole point: the numbers followed the reorder, nothing was written.
    expect(after).toEqual(['1', '2']);
    const frontHeading = mount.querySelector('[data-screenplay-block]');
    // The number the writer sees beside this heading, read from the widget the heading now
    // carries rather than from the block's own attributes: scene numbers render in both margins
    // (plan.md's "Locked scripts"), which one pseudo-element on the block could not do.
    expect(
      frontHeading?.querySelector('[data-scene-number]')?.getAttribute('data-scene-number'),
    ).toBe('1');
    // The heading's authored text, with the widget's own two margin copies excluded. The widget
    // lives inside the block's DOM, so a bare `textContent` reads '11EXT. STREET - DAY'; the
    // canonical document is unaffected either way, since widgets never enter it -- proven
    // separately by the byte-identical-blocks test in App.test.tsx.
    const headingText = Array.from(frontHeading?.childNodes ?? [])
      .filter(
        (child) => !(child instanceof HTMLElement && child.classList.contains('scene-number')),
      )
      .map((child) => child.textContent)
      .join('');
    expect(headingText).toBe('EXT. STREET - DAY');

    editor.destroy();
    mount.remove();
  });
});
