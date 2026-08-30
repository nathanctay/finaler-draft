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

/**
 * `buildEditor`, but with the mount wrapped in a real `.editor-region` div carrying a stubbed
 * `getBoundingClientRect` -- the scroll-anchor compensation
 * (`compensateScrollForRepagination` in paginationExtension.ts) looks up this ancestor by class
 * name exactly the way `App.tsx`'s real DOM does (see `styles.css`'s `.editor-region`, the
 * `overflow: auto` scroll container the compensation adjusts `scrollTop` on). jsdom lays out
 * nothing, so both this box and the caret's own rectangle (`coordsAtPos`, stubbed per test below)
 * are stated rather than measured -- the house precedent for stubbing a rect directly is
 * `floatingPanel.test.ts:29-33`.
 */
function buildEditorInRegion(
  blocks: readonly ScreenplayBlock[],
  regionRect: { top: number; height: number },
) {
  const region = document.createElement('div');
  region.className = 'editor-region';
  region.getBoundingClientRect = () => new DOMRect(0, regionRect.top, 800, regionRect.height);
  document.body.append(region);
  const mount = document.createElement('div');
  region.append(mount);
  const editor = new Editor({
    content: docContentFor(blocks),
    element: mount,
    extensions: [...screenplayExtensions, PaginationExtension],
  });
  return { editor, mount, region };
}

/**
 * `buildEditorInRegion`, further wrapping the mount in a `.page` div carrying its own stubbed
 * `getBoundingClientRect` of `pageWidthPx` -- the jump scroll's own pixels-per-inch measurement
 * (`pixelsPerInch` in paginationExtension.ts) looks up this ancestor by class name exactly the way
 * `App.tsx`'s real DOM does (`styles.css`'s `.page { width: var(--fd-page-width) }`,
 * `PAGE_WIDTH_IN` inches fixed, scaled by the same `transform: scale(zoom / 100)` App.tsx applies
 * to it). `pageWidthPx` stands in for "whatever zoom is currently in effect" -- callers pick it to
 * land on a clean pixels-per-inch figure rather than asserting against zoom-percentage arithmetic
 * this module never performs.
 *
 * Also stubs `.editor-region`'s `scrollHeight`/`clientHeight` (jsdom's own default for both is 0,
 * and jsdom performs no scroll clamping of its own the way a real browser does -- `scrollTop` is
 * a plain writable property here, so `maybeJumpScrollCaretIntoView`'s own clamp arithmetic is
 * exactly, and only, what keeps it in bounds in these tests) and leaves `region.scrollTop` at 0 for
 * the caller to set.
 */
function buildEditorInPageRegion(
  blocks: readonly ScreenplayBlock[],
  options: { regionTop: number; regionHeight: number; scrollHeight: number; pageWidthPx: number },
) {
  const { editor, mount, region } = buildEditorInRegion(blocks, {
    top: options.regionTop,
    height: options.regionHeight,
  });
  Object.defineProperty(region, 'scrollHeight', {
    configurable: true,
    value: options.scrollHeight,
  });
  Object.defineProperty(region, 'clientHeight', {
    configurable: true,
    value: options.regionHeight,
  });
  const page = document.createElement('article');
  page.className = 'page';
  page.getBoundingClientRect = () => new DOMRect(0, 0, options.pageWidthPx, 1100);
  page.append(mount);
  region.append(page);
  return { editor, mount, page, region };
}

/** A stubbed `coordsAtPos` result with an explicit `top` and `bottom` -- the jump-scroll tests
 * below need independent control over both, unlike `coordsAt`'s fixed 16px line, since the jump
 * distance itself depends on where each edge sits relative to `.editor-region`'s own bottom. */
function rectAt(
  top: number,
  bottom: number,
): { top: number; bottom: number; left: number; right: number } {
  return { top, bottom, left: 0, right: 0 };
}

/** A stubbed `coordsAtPos` result. Only `top`/`bottom` are read by the compensation, but the real
 * return type also carries `left`/`right`, so both are supplied here to match it. */
function coordsAt(top: number): { top: number; bottom: number; left: number; right: number } {
  return { top, bottom: top + 16, left: 0, right: 0 };
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

/**
 * Coverage for `compensateScrollForRepagination` (paginationExtension.ts): repagination
 * materializes a page-break spacer that can push everything below it down without ProseMirror
 * scrolling to correct for it (see that function's own comment for the full mechanism). These
 * exercise the fix through both places it is wired in -- the frame-coalesced doc-change path
 * (`scheduleRepagination`'s `requestAnimationFrame` callback), the actual site of the diagnosed
 * defect, and the synchronous `updatePaginationDocumentSettings` path, which is also where the
 * owner's own illustrative scenario (a document-settings change repaginating while the writer has
 * scrolled away to reread an earlier page) lives.
 */
describe('repagination scroll anchor', () => {
  it('compensates a caret visible before repagination and pushed down by it, by exactly the shift', () => {
    vi.useFakeTimers();
    const { editor, mount, region } = buildEditorInRegion(plainTwoPageBlocks().slice(0, 1), {
      top: 0,
      height: 600,
    });
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      region.remove();
    });
    const coordsSpy = vi
      .spyOn(editor.view, 'coordsAtPos')
      // Call 1: the plain insert transaction below is not wrapped by
      // `compensateScrollForRepagination`, so the plugin's own per-transaction jump-scroll check
      // (`maybeJumpScrollCaretIntoView`, unsuppressed for an ordinary edit) measures the caret for
      // itself first -- comfortably inside the 600px region, so it is a no-op.
      .mockReturnValueOnce(coordsAt(300))
      // Call 2, `compensateScrollForRepagination`'s own "before": the same comfortable position,
      // read again once the rAF-scheduled repagination actually runs.
      .mockReturnValueOnce(coordsAt(300))
      // Call 3, its "after": the same document position, now 193px lower -- a page-break spacer
      // materializing above it, the exact shift the real defect measured (see
      // progress/repagination-scroll-anchor.md).
      .mockReturnValueOnce(coordsAt(493))
      // Call 4: `compensateScrollForRepagination`'s own explicit jump-scroll check, run once its
      // shift correction has restored the caret to its exact prior 300px screen position -- still
      // comfortably inside the region, so this is a no-op too.
      .mockReturnValueOnce(coordsAt(300));
    region.scrollTop = 50;

    // Append the remaining blocks in one transaction, forcing the doc from one page to two --
    // the same "typing across a page boundary" shape `paginationExtension.test.ts`'s own "does
    // not repaginate until the next animation frame" test uses.
    const remaining = plainTwoPageBlocks().slice(1);
    const nodes = remaining.map((block) =>
      editor.schema.nodes.screenplayBlock!.create(
        { element: block.type, id: block.id },
        'text' in block && block.text !== '' ? editor.schema.text(block.text) : undefined,
      ),
    );
    editor.view.dispatch(
      editor.state.tr.insert(editor.state.doc.content.size, Fragment.fromArray(nodes)),
    );
    vi.runOnlyPendingTimers();

    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(1);
    expect(coordsSpy).toHaveBeenCalledTimes(4);
    // 50 (where the writer had already scrolled to) + 193 (the measured shift): the caret lands
    // back at the same 300px screen position it started at, not merely somewhere on screen. The
    // trailing jump-scroll check (call 4) finds that restored position comfortably in view and
    // leaves it completely alone -- proving the jump scroll does not disturb an already-correct
    // compensation, not merely that this particular scenario happens not to trigger it.
    expect(region.scrollTop).toBe(243);
  });

  it('leaves scrollTop alone when the caret was already out of view before repagination', () => {
    const { editor, mount, region } = buildEditorInRegion(plainTwoPageBlocks(), {
      top: 0,
      height: 600,
    });
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      region.remove();
    });
    // The writer scrolled away to reread an earlier page; the caret they left behind sits well
    // below the 600px-tall region, already out of view before a document-settings change
    // repaginates -- the owner's own example (see this module's header) of why the gate exists.
    const coordsSpy = vi.spyOn(editor.view, 'coordsAtPos').mockReturnValueOnce(coordsAt(900));
    region.scrollTop = 120;

    updatePaginationDocumentSettings(editor, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      pageNumberStyle: 'roman',
    });

    // The settings change itself still took effect...
    expect(mount.querySelector('.page-break-number')?.textContent).toBe('II.');
    // ...while the reading position the writer chose is completely untouched: only the one
    // "before" measurement ever happened -- proving no "after" measurement, and so no
    // compensation, was attempted at all, not merely that the two measurements happened to
    // cancel out.
    expect(coordsSpy).toHaveBeenCalledTimes(1);
    expect(region.scrollTop).toBe(120);
  });

  it('still compensates a visible caret even when the view is unfocused -- the document-settings dialog always unfocuses it', () => {
    const { editor, mount, region } = buildEditorInRegion(plainTwoPageBlocks(), {
      top: 0,
      height: 600,
    });
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      region.remove();
    });
    // Unfocused, deliberately not stubbed: jsdom's own default (nothing here ever calls
    // `.focus()`) already models exactly what the real app does the instant the document-settings
    // dialog opens -- it moves DOM focus onto its own first input (see
    // `documentSettingsDialog.tsx`), which is the only real-world trigger for this call site. If
    // compensation were gated on focus, it would never fire for that scenario at all.
    expect(editor.view.hasFocus()).toBe(false);
    // `updatePaginationDocumentSettings` (unlike an ordinary edit) calls
    // `compensateScrollForRepagination` directly, with no separate, unwrapped dispatch beforehand
    // -- so there is no extra leading jump-scroll call the way the doc-change test above has.
    // Three calls: the compensation's own before/after, then its trailing jump-scroll check.
    const coordsSpy = vi
      .spyOn(editor.view, 'coordsAtPos')
      .mockReturnValueOnce(coordsAt(200))
      .mockReturnValueOnce(coordsAt(240))
      // The jump-scroll check, run once the shift correction below has restored the caret to its
      // exact prior 200px screen position -- still comfortably inside the region, so a no-op.
      .mockReturnValueOnce(coordsAt(200));
    region.scrollTop = 30;

    updatePaginationDocumentSettings(editor, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      pageNumberStyle: 'roman',
    });

    expect(mount.querySelector('.page-break-number')?.textContent).toBe('II.');
    expect(coordsSpy).toHaveBeenCalledTimes(3);
    // 30 + 40 (the measured shift): compensated exactly as it would be if the view were focused.
    expect(region.scrollTop).toBe(70);
  });

  it('changes scrollTop by exactly zero when a repagination shifts nothing near the caret', () => {
    vi.useFakeTimers();
    const { editor, mount, region } = buildEditorInRegion(plainTwoPageBlocks().slice(0, 1), {
      top: 0,
      height: 600,
    });
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      region.remove();
    });
    // The same position measured both times: this repagination's new page break lands well below
    // the caret, so the new decorations move nothing around it.
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue(coordsAt(120));
    // An own-property override, not `region.scrollTop = 77` alone: a mutation that drops the
    // `if (shift !== 0)` guard and always writes `scrollTop += shift` would still read back 77
    // afterward (77 + 0), so a value-only assertion cannot catch it. This intercepts the write
    // itself and proves it never happens -- the guard against a per-keystroke rounding drift this
    // test exists for.
    let scrollTopValue = 77;
    const setScrollTop = vi.fn((value: number) => {
      scrollTopValue = value;
    });
    Object.defineProperty(region, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: setScrollTop,
    });

    const remaining = plainTwoPageBlocks().slice(1);
    const nodes = remaining.map((block) =>
      editor.schema.nodes.screenplayBlock!.create(
        { element: block.type, id: block.id },
        'text' in block && block.text !== '' ? editor.schema.text(block.text) : undefined,
      ),
    );
    editor.view.dispatch(
      editor.state.tr.insert(editor.state.doc.content.size, Fragment.fromArray(nodes)),
    );
    vi.runOnlyPendingTimers();

    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(1);
    expect(setScrollTop).not.toHaveBeenCalled();
    expect(region.scrollTop).toBe(77);
  });
});

/**
 * `maybeJumpScrollCaretIntoView` (the owner's "five lines of breathing room" requirement, as a
 * jump rather than a constant margin -- see that function's own comment for why `EditorProps
 * .scrollMargin` was tried and abandoned). Tested through `.editor-region`'s own `scrollTop`, the
 * same field the real mechanism writes, rather than through a real scroll -- jsdom lays nothing
 * out, so an actual pixel scroll is `page-rendering-persistence.spec.ts`'s job, matching this
 * file's own `.editor-region` scroll-anchor tests above.
 *
 * The plugin only evaluates the jump from its own `view().update()` hook, which -- like every
 * plugin-view `update` -- does not run at construction, only on a later transaction
 * (`prosemirror-view`'s `updatePluginViews`: the very first call after mount goes through the
 * "plugins changed" branch, which (re)builds plugin views rather than updating them). Every test
 * below dispatches at least one transaction after building the editor for exactly this reason --
 * modelling the first keystroke or selection change a real session always has before anything
 * needs to scroll.
 */
describe('jump scroll', () => {
  it("does nothing while the caret's line stays comfortably above the bottom edge", () => {
    const { editor, mount, page, region } = buildEditorInPageRegion(
      plainTwoPageBlocks().slice(0, 1),
      { regionTop: 0, regionHeight: 600, scrollHeight: 2000, pageWidthPx: 1020 },
    );
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      page.remove();
      region.remove();
    });
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValueOnce(rectAt(300, 316));
    region.scrollTop = 50;

    editor.view.dispatch(editor.state.tr);

    expect(region.scrollTop).toBe(50);
  });

  /**
   * The exact `>=` boundary, not merely "somewhere past it": one dispatch with the caret's bottom
   * one pixel short of the edge does nothing, and the very next dispatch, with it exactly at the
   * edge, jumps. `desiredCaretTop` is `.editor-region`'s bottom (600) minus five lines at 120
   * px/in (600 / 5 = 120, so `JUMP_SCROLL_LINES` lines is exactly 100px) -- 500 -- so the target
   * scroll position is the starting 50 plus the caret's own 84px head start above that (584 -
   * 500), landing on 134: a clean, exact number, not a tolerance.
   */
  it("stays still until the caret's bottom reaches the edge, then jumps forward exactly five manuscript lines", () => {
    const { editor, mount, page, region } = buildEditorInPageRegion(
      plainTwoPageBlocks().slice(0, 1),
      { regionTop: 0, regionHeight: 600, scrollHeight: 2000, pageWidthPx: 1020 },
    );
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      page.remove();
      region.remove();
    });
    const coordsSpy = vi
      .spyOn(editor.view, 'coordsAtPos')
      .mockReturnValueOnce(rectAt(583, 599))
      .mockReturnValueOnce(rectAt(584, 600));
    region.scrollTop = 50;

    editor.view.dispatch(editor.state.tr);
    expect(region.scrollTop).toBe(50);

    editor.view.dispatch(editor.state.tr);
    expect(region.scrollTop).toBe(134);
    expect(coordsSpy).toHaveBeenCalledTimes(2);
  });

  it("clamps the jump to .editor-region's own maximum scrollTop when five lines would overshoot it", () => {
    // clientHeight 600, scrollHeight 650: only 50px of scroll room exists at all, well short of
    // the 100px five lines would otherwise ask for.
    const { editor, mount, page, region } = buildEditorInPageRegion(
      plainTwoPageBlocks().slice(0, 1),
      { regionTop: 0, regionHeight: 600, scrollHeight: 650, pageWidthPx: 1020 },
    );
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      page.remove();
      region.remove();
    });
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValueOnce(rectAt(590, 606));
    region.scrollTop = 10;

    editor.view.dispatch(editor.state.tr);

    expect(region.scrollTop).toBe(50);
  });

  /**
   * Not reachable through any real caret today (`readCaretRect`'s `top` and `bottom` come from
   * one `coordsAtPos` call, which never returns a rectangle taller than a manuscript line), but
   * the guard is unconditional in the implementation, so it is proved directly with a stubbed
   * rectangle unusually tall enough to make the naive arithmetic ask for less scroll than the
   * container already has.
   */
  it('never scrolls backward even if the computed target would be behind the current scroll position', () => {
    const { editor, mount, page, region } = buildEditorInPageRegion(
      plainTwoPageBlocks().slice(0, 1),
      { regionTop: 0, regionHeight: 600, scrollHeight: 2000, pageWidthPx: 1020 },
    );
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      page.remove();
      region.remove();
    });
    // top 100 (far above the 500px desired position) but bottom 650 (past the 600px edge,
    // satisfying the trigger) -- an unusually tall caret rectangle.
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValueOnce(rectAt(100, 650));
    region.scrollTop = 50;

    editor.view.dispatch(editor.state.tr);

    expect(region.scrollTop).toBe(50);
  });

  /**
   * The same caret/region geometry, measured against three different `.page` widths, produces
   * three different jump distances -- proof this is a real DOM measurement, not a fixed dpi or a
   * pixel guess. `1020px` and `2040px` are 120 and 240 px/in respectively (`PAGE_WIDTH_IN` is
   * 8.5in), so five lines is 100px and 200px; no `.page` ancestor at all -- `buildEditorInRegion`,
   * not `buildEditorInPageRegion` -- falls back to ordinary 96 dpi, where five lines is 80px.
   */
  it("measures the jump distance off .page's current width, not a fixed dpi", () => {
    const scaleCases: ReadonlyArray<{ pageWidthPx: number; expectedScrollTop: number }> = [
      { pageWidthPx: 1020, expectedScrollTop: 100 },
      { pageWidthPx: 2040, expectedScrollTop: 200 },
    ];
    for (const { pageWidthPx, expectedScrollTop } of scaleCases) {
      const { editor, mount, page, region } = buildEditorInPageRegion(
        plainTwoPageBlocks().slice(0, 1),
        { regionTop: 0, regionHeight: 600, scrollHeight: 2000, pageWidthPx },
      );
      vi.spyOn(editor.view, 'coordsAtPos').mockReturnValueOnce(rectAt(600, 616));
      region.scrollTop = 0;

      editor.view.dispatch(editor.state.tr);

      expect(region.scrollTop).toBe(expectedScrollTop);
      editor.destroy();
      mount.remove();
      page.remove();
      region.remove();
    }

    const { editor, mount, region } = buildEditorInRegion(plainTwoPageBlocks().slice(0, 1), {
      top: 0,
      height: 600,
    });
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      region.remove();
    });
    // `buildEditorInRegion` (unlike `buildEditorInPageRegion`) leaves `scrollHeight`/`clientHeight`
    // at jsdom's own default of 0 -- stubbed here so the container's own clamp does not itself
    // become the reason nothing scrolls, which would prove nothing about `pixelsPerInch`'s fallback.
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 600 });
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValueOnce(rectAt(600, 616));
    region.scrollTop = 0;

    editor.view.dispatch(editor.state.tr);

    expect(region.scrollTop).toBe(80);
  });

  /**
   * The interaction the two fixes on this branch share: `compensateScrollForRepagination` can
   * restore the caret to its *exact* prior screen position, and that exact prior position can
   * itself have been sitting right at `.editor-region`'s bottom edge -- comfortably "visible" by
   * `isRectVisibleInRegion`'s plain geometric test (its `top` is still above the region's own
   * bottom), but exactly the state `maybeJumpScrollCaretIntoView` exists to correct. This proves
   * the hand-off end to end: the compensation's own shift correction runs first (its usual job,
   * unmodified), and only once that has settled does the jump scroll get its own, separate say.
   *
   * Sequence, matching the real call order: (1) the plain doc-change dispatch below is not
   * wrapped by `compensateScrollForRepagination`, so the plugin's per-transaction jump check runs
   * for it unsuppressed first, against an unrelated, comfortable caret -- a no-op, establishing
   * that this call exists and does not interfere. (2)-(3) are `compensateScrollForRepagination`'s
   * own before/after, once the rAF-scheduled repagination actually runs; its `dispatch()` is
   * suppressed for the per-transaction hook, so no jump check runs mid-dispatch. (4) is its
   * trailing, explicit jump-scroll call, reading the caret back at its restored (300 + 60 = 90
   * lower than "after", matching the shift correction) position -- which is exactly where "before"
   * was, at the bottom edge -- and this time the jump fires.
   */
  it("fires once compensateScrollForRepagination's own correction has restored the caret to a position at or past the bottom edge", () => {
    vi.useFakeTimers();
    const { editor, mount, page, region } = buildEditorInPageRegion(
      plainTwoPageBlocks().slice(0, 1),
      { regionTop: 0, regionHeight: 600, scrollHeight: 2000, pageWidthPx: 1020 },
    );
    cleanups.push(() => {
      editor.destroy();
      mount.remove();
      page.remove();
      region.remove();
    });
    const coordsSpy = vi
      .spyOn(editor.view, 'coordsAtPos')
      // (1) The doc-change dispatch's own, unsuppressed per-transaction jump check: an unrelated,
      // comfortable caret, a no-op.
      .mockReturnValueOnce(rectAt(300, 316))
      // (2) compensateScrollForRepagination's "before": already right at the bottom edge --
      // `isRectVisibleInRegion` still calls this visible (`top` 590 < the region's 600 bottom).
      .mockReturnValueOnce(rectAt(590, 606))
      // (3) its "after": pushed further down by the new page break's spacer.
      .mockReturnValueOnce(rectAt(750, 766))
      // (4) its trailing jump-scroll call, reading the caret back at its restored screen
      // position -- identical to (2), since the shift correction below restores it exactly.
      .mockReturnValueOnce(rectAt(590, 606));
    region.scrollTop = 50;

    const remaining = plainTwoPageBlocks().slice(1);
    const nodes = remaining.map((block) =>
      editor.schema.nodes.screenplayBlock!.create(
        { element: block.type, id: block.id },
        'text' in block && block.text !== '' ? editor.schema.text(block.text) : undefined,
      ),
    );
    editor.view.dispatch(
      editor.state.tr.insert(editor.state.doc.content.size, Fragment.fromArray(nodes)),
    );
    vi.runOnlyPendingTimers();

    expect(mount.querySelectorAll('.page-break-widget')).toHaveLength(1);
    expect(coordsSpy).toHaveBeenCalledTimes(4);
    // Shift correction: 50 + (750 - 590) = 210, restoring the caret to its exact prior 590px
    // screen position. Jump scroll, evaluated against that restored position: desired caret top
    // is 600 - 100 = 500, so the target is 210 + (590 - 500) = 300.
    expect(region.scrollTop).toBe(300);
  });
});
