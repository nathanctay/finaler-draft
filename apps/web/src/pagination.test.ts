import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import {
  paginateScreenplay,
  type AuthoredLine,
  type LayoutResult,
  type PageLine,
} from '@finaler-draft/layout';
import { DEFAULT_DOCUMENT_SETTINGS, type ScreenplayBlock } from '@finaler-draft/screenplay';
import { MARGIN_TOP_IN, PAGE_HEIGHT_IN } from '@finaler-draft/screenplay/pageFormat';
import { screenplayExtensions } from './screenplayEditor.js';
import {
  PAGE_GAP_IN,
  buildPageBreakWidget,
  buildPaginationDecorations,
  computeBlockStarts,
  computePageBreaks,
  computePageTopBlocks,
  computeSceneNumberDecorations,
  pageStackMinHeightIn,
  type PageBreak,
} from './pagination.js';

/**
 * Text that hard-splits at a fixed character budget into exactly `n` lines -- the same recipe
 * `@finaler-draft/layout`'s own test suite uses (see packages/layout/src/testFixtures.ts), kept
 * local here since that module is private test infrastructure to that package, not part of its
 * public API.
 */
function linesOfLength(budget: number, n: number): string {
  return 'x'.repeat(budget * (n - 1) + 1);
}

const ACTION_BUDGET = 60;
const DIALOGUE_BUDGET = 35;

/** A short, guaranteed single-line action beat, distinct per index for readable failures. */
function actionBeat(index: number): ScreenplayBlock {
  return { id: `a${index}`, type: 'action', text: `Beat number ${index} happens quietly.` };
}

/**
 * 29 short action blocks: the 28th (index 27, block `a27`) fills page 1 to exactly 55 lines (1
 * line for the first block, whose leading blank is suppressed as the document's own first block,
 * plus 2 lines -- blank before, then content -- for each of the next 27), and the 29th block
 * (`a28`) becomes page 2's sole, freshly-starting line. This is deliberately a block-BOUNDARY
 * break (no mid-block wrap involved), so it exercises the page-top / spacer / page-number path
 * with no `(MORE)`/`CONT'D` in it.
 */
function plainTwoPageBlocks(): ScreenplayBlock[] {
  return Array.from({ length: 29 }, (_, index) => actionBeat(index));
}

/**
 * The exact scenario from `@finaler-draft/layout`'s own
 * "splits a long speech with (MORE) and a CONT'D heading" fixture: a 50-line action block fills
 * page 1 to room 5, and a 4-line dialogue speech must then split 2-and-1 across the break. Page
 * 2's first line is a MID-block continuation of `d0` (not a fresh block), so this is the negative
 * case for page-top suppression and the positive case for `(MORE)`/`CONT'D`.
 */
function speechSplitBlocks(): ScreenplayBlock[] {
  return [
    { id: 'a0', type: 'action', text: linesOfLength(ACTION_BUDGET, 50) },
    { id: 'c0', type: 'character', text: 'ADA' },
    { id: 'd0', type: 'dialogue', text: linesOfLength(DIALOGUE_BUDGET, 4) },
  ];
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

function buildDoc(blocks: readonly ScreenplayBlock[]) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    content: docContentFor(blocks),
    element: mount,
    extensions: screenplayExtensions,
  });
  return { doc: editor.state.doc, editor, mount };
}

describe('computeBlockStarts', () => {
  it('maps every top-level screenplayBlock id to its document position', () => {
    const { doc, editor, mount } = buildDoc(plainTwoPageBlocks().slice(0, 3));
    const starts = computeBlockStarts(doc);

    expect(starts.get('a0')).toBe(0);
    // Block 1 starts after block 0's opening tag (1) + its text + its closing tag (1).
    const block0Text = (actionBeat(0) as { text: string }).text;
    expect(starts.get('a1')).toBe(1 + block0Text.length + 1);
    expect(starts.size).toBe(3);
    editor.destroy();
    mount.remove();
  });
});

describe('computePageTopBlocks', () => {
  it('finds the first block of every page, including the document-level first page', () => {
    const blocks = plainTwoPageBlocks();
    const { doc, editor, mount } = buildDoc(blocks);
    const layout = paginateScreenplay(blocks);
    expect(layout.pages).toHaveLength(2);
    const blockStarts = computeBlockStarts(doc);

    const topBlocks = computePageTopBlocks(doc, blockStarts, layout);

    expect(topBlocks).toHaveLength(2);
    expect(topBlocks[0]?.pos).toBe(blockStarts.get('a0'));
    expect(topBlocks[1]?.pos).toBe(blockStarts.get('a28'));
    editor.destroy();
    mount.remove();
  });

  it('does not mark a page whose first line is a mid-block continuation after CONT’D', () => {
    const blocks = speechSplitBlocks();
    const { doc, editor, mount } = buildDoc(blocks);
    const layout = paginateScreenplay(blocks);
    expect(layout.pages).toHaveLength(2);
    const blockStarts = computeBlockStarts(doc);

    const topBlocks = computePageTopBlocks(doc, blockStarts, layout);

    // Only page 1 (the document's own first block, `a0`) qualifies -- page 2 opens on a
    // continuation of `d0`'s wrapped text, which carries no block-level margin to suppress.
    expect(topBlocks).toHaveLength(1);
    expect(topBlocks[0]?.pos).toBe(blockStarts.get('a0'));
    editor.destroy();
    mount.remove();
  });
});

describe('computePageBreaks', () => {
  it('anchors a plain block-boundary break with no (MORE)/CONT’D', () => {
    const blocks = plainTwoPageBlocks();
    const { doc, editor, mount } = buildDoc(blocks);
    const layout = paginateScreenplay(blocks);
    const blockStarts = computeBlockStarts(doc);

    const breaks = computePageBreaks(doc, blockStarts, layout);

    expect(breaks).toHaveLength(1);
    const brk = breaks[0];
    expect(brk?.pageNumber).toBe(2);
    expect(brk?.more).toBeUndefined();
    expect(brk?.continued).toBeUndefined();
    // a27 is the last block placed on page 1 (see plainTwoPageBlocks's doc comment), and its own
    // last line ends the block (nothing of a27 continues onto page 2) -- exactly the case
    // pagination.ts's module comment on computePageBreaks documents: the widget must anchor
    // *after* the block (blockStart + nodeSize), not inside it, or ProseMirror appends a stray
    // `img.ProseMirror-separator` that silently adds a line of height (the defect this module
    // exists to avoid reintroducing). Deriving the expected position from the real node's
    // `nodeSize`, rather than hand-adding text length + a fixed offset, is what makes this
    // assertion fail loudly if that anchor ever regresses back to the inside-the-block formula.
    const a27Start = blockStarts.get('a27');
    expect(a27Start).toBeDefined();
    const a27Node = doc.nodeAt(a27Start ?? 0);
    expect(a27Node).not.toBeNull();
    expect(brk?.pos).toBe((a27Start ?? 0) + (a27Node?.nodeSize ?? 0));
    const page1 = layout.pages[0];
    expect(page1).toBeDefined();
    expect(brk?.spacerHeightIn).toBeCloseTo(
      (page1?.bottomMarginIn ?? 0) + PAGE_GAP_IN + MARGIN_TOP_IN,
      10,
    );
    editor.destroy();
    mount.remove();
  });

  it("anchors a split speech's break with both (MORE) and CONT'D", () => {
    const blocks = speechSplitBlocks();
    const { doc, editor, mount } = buildDoc(blocks);
    const layout = paginateScreenplay(blocks);
    const blockStarts = computeBlockStarts(doc);

    const breaks = computePageBreaks(doc, blockStarts, layout);

    expect(breaks).toHaveLength(1);
    const brk = breaks[0];
    expect(brk?.more).toMatchObject({ reason: 'more', text: '(MORE)' });
    expect(brk?.continued).toMatchObject({ reason: 'continued', text: "ADA (CONT'D)" });
    editor.destroy();
    mount.remove();
  });
});

describe('computePageTopBlocks and computePageBreaks: defensive guards against a doc/layout mismatch', () => {
  // `paginateScreenplay` never produces a `LayoutResult` whose block ids are absent from a doc
  // built from the same blocks, or whose lines make a page's authored content unreachable from
  // its end -- both modules' own comments say so (computePageTopBlocks: "a page whose first line
  // continues a block..."; the module comment on lastAuthoredLine: "paginateScreenplay never
  // actually produces [this] for a non-empty document but this module still guards against it
  // rather than assuming"). These guards exist for a `doc` and `layout` that have drifted apart
  // in a way this module cannot itself prevent -- and since `noUncheckedIndexedAccess` forces
  // some of them to exist purely as satisfiable type guards, they need a synthetic, deliberately
  // inconsistent `layout`/`blockStarts` pair to exercise at all. That is what these two fixtures
  // build: a real `doc` (so `doc.nodeAt` behaves like production code), paired with a hand-built
  // `LayoutResult` that a real `paginateScreenplay` call could never produce from it.
  const authoredLine = (blockId: string): AuthoredLine => ({
    blockId,
    element: 'action',
    endOffset: 1,
    kind: 'authored',
    startOffset: 0,
    text: 'x',
  });
  const blankLine: PageLine = { kind: 'blank' };

  it('computePageTopBlocks skips a page-top line whose block id is absent from blockStarts, and one whose position has no real node', () => {
    const { doc, editor, mount } = buildDoc(plainTwoPageBlocks().slice(0, 1));
    const blockStarts = new Map<string, number>([['a0', 0]]);
    // 'ghost' resolves through blockStarts (unlike 'missing', which does not) but to a position
    // with no real node at it (the last position inside a0's text, not a node boundary),
    // exercising the two distinct guards separately. A position genuinely outside the doc (e.g.
    // far past its end) makes `doc.nodeAt` throw rather than return null, so it has to be
    // in-range but off a node boundary, not merely large.
    blockStarts.set('ghost', doc.content.size - 1);
    const layout: LayoutResult = {
      pages: [
        { bottomMarginIn: 9, lineCount: 1, lines: [authoredLine('missing')], pageNumber: 1 },
        { bottomMarginIn: 9, lineCount: 1, lines: [authoredLine('ghost')], pageNumber: 2 },
      ],
    };

    expect(computePageTopBlocks(doc, blockStarts, layout)).toEqual([]);
    editor.destroy();
    mount.remove();
  });

  it('computePageBreaks skips a break whose outgoing page has no authored content, whose last line references an unknown block, and whose block id resolves to no real node', () => {
    const { doc, editor, mount } = buildDoc(plainTwoPageBlocks().slice(0, 1));
    const blockStarts = new Map<string, number>([['a0', 0]]);
    // See the comment in the previous test on why this must be in-range but off a node boundary.
    blockStarts.set('ghost', doc.content.size - 1);
    const layout: LayoutResult = {
      pages: [
        // An all-blank page: lastAuthoredLine scans back to a blank line before finding any
        // authored one and returns undefined, so computePageBreaks has no line to anchor at.
        { bottomMarginIn: 9, lineCount: 1, lines: [blankLine], pageNumber: 1 },
        // Its last authored line names a block id absent from blockStarts.
        { bottomMarginIn: 9, lineCount: 1, lines: [authoredLine('missing')], pageNumber: 2 },
        // Its last authored line resolves through blockStarts, but to a position with no node.
        { bottomMarginIn: 9, lineCount: 1, lines: [authoredLine('ghost')], pageNumber: 3 },
        { bottomMarginIn: 9, lineCount: 1, lines: [authoredLine('a0')], pageNumber: 4 },
      ],
    };

    expect(computePageBreaks(doc, blockStarts, layout)).toEqual([]);
    editor.destroy();
    mount.remove();
  });
});

describe('buildPageBreakWidget', () => {
  const base: PageBreak = {
    continued: undefined,
    more: undefined,
    pageNumber: 4,
    pos: 0,
    spacerHeightIn: 1.5,
  };

  it('renders a non-editable spacer and page number when there is no split', () => {
    const widget = buildPageBreakWidget(base);

    expect(widget.className).toBe('page-break-widget');
    expect(widget.contentEditable).toBe('false');
    expect(widget.getAttribute('data-page-break')).toBe('4');
    expect(widget.querySelector('.page-break-more')).toBeNull();
    expect(widget.querySelector('.page-break-continued')).toBeNull();
    const spacer = widget.querySelector<HTMLElement>('.page-break-spacer');
    expect(spacer?.style.height).toBe('1.5in');
    const pageNumber = widget.querySelector<HTMLElement>('.page-break-number');
    expect(pageNumber?.textContent).toBe('4.');
    expect(pageNumber?.style.top).toBe(`${1.5 - MARGIN_TOP_IN + 0.5}in`);
  });

  it('renders (MORE) and CONT’D lines when the break split a speech', () => {
    const widget = buildPageBreakWidget({
      ...base,
      continued: {
        kind: 'generated',
        reason: 'continued',
        sourceBlockId: 'c0',
        text: "ADA (CONT'D)",
      },
      more: { kind: 'generated', reason: 'more', sourceBlockId: 'c0', text: '(MORE)' },
    });

    expect(widget.querySelector('.page-break-more')?.textContent).toBe('(MORE)');
    expect(widget.querySelector('.page-break-continued')?.textContent).toBe("ADA (CONT'D)");
    // (MORE) precedes the spacer, which precedes CONT'D -- the visual order of the page break.
    const order = Array.from(widget.children).map((child) => child.className);
    expect(order).toEqual([
      'page-break-cue-line page-break-more',
      'page-break-spacer',
      'page-break-cue-line page-break-continued',
    ]);
  });

  it('renders Arabic numerals by default, matching every existing caller that omits the style', () => {
    const widget = buildPageBreakWidget(base);
    expect(widget.querySelector('.page-break-number')?.textContent).toBe('4.');
  });

  it('renders Roman numerals when documentSettings.pageNumberStyle is roman', () => {
    const widget = buildPageBreakWidget(base, 'roman');
    expect(widget.querySelector('.page-break-number')?.textContent).toBe('IV.');
  });

  it('renders every Roman numeral subtractive pair correctly, not just a single digit', () => {
    // 1994 = MCMXCIV exercises all four subtractive pairs (CM, XC, IV) plus M -- the classic
    // stress case for a greedy roman-numeral implementation.
    expect(
      buildPageBreakWidget({ ...base, pageNumber: 1994 }, 'roman').querySelector(
        '.page-break-number',
      )?.textContent,
    ).toBe('MCMXCIV.');
    expect(
      buildPageBreakWidget({ ...base, pageNumber: 9 }, 'roman').querySelector('.page-break-number')
        ?.textContent,
    ).toBe('IX.');
    expect(
      buildPageBreakWidget({ ...base, pageNumber: 40 }, 'roman').querySelector('.page-break-number')
        ?.textContent,
    ).toBe('XL.');
  });
});

describe('pageStackMinHeightIn', () => {
  it('reserves pages*height + (pages-1)*gap for a multi-page stack', () => {
    expect(pageStackMinHeightIn(1)).toBeCloseTo(PAGE_HEIGHT_IN, 10);
    expect(pageStackMinHeightIn(3)).toBeCloseTo(3 * PAGE_HEIGHT_IN + 2 * PAGE_GAP_IN, 10);
    expect(pageStackMinHeightIn(4)).toBeCloseTo(4 * PAGE_HEIGHT_IN + 3 * PAGE_GAP_IN, 10);
  });

  it('clamps an empty document (0 pages) to a single page height, matching the CSS fallback', () => {
    expect(pageStackMinHeightIn(0)).toBeCloseTo(PAGE_HEIGHT_IN, 10);
  });
});

describe('buildPaginationDecorations', () => {
  it('produces one node decoration per page-top block plus one widget per break', () => {
    const blocks = plainTwoPageBlocks();
    const { doc, editor, mount } = buildDoc(blocks);
    const layout: LayoutResult = paginateScreenplay(blocks);

    const decorations = buildPaginationDecorations(doc, layout);
    const found = decorations.find();

    // Page 1's own first block + page 2's first block = 2 page-top decorations, plus 1 widget.
    expect(found).toHaveLength(3);
    editor.destroy();
    mount.remove();
  });

  /**
   * A widget decoration's rendered DOM is not reachable from the `Decoration` object -- `toDOM`
   * only runs once the view mounts it. So this level of test can only prove *how many*
   * scene-number decorations exist, not what number each one carries; the exact numbering
   * (including renumbering on reorder, and both margin copies) is proven against real rendered
   * DOM in `paginationExtension.test.ts`, where the widget is actually queryable.
   */
  it('adds no scene-number decorations when sceneNumbersEnabled is off (the default)', () => {
    const blocks: ScreenplayBlock[] = [
      { id: 'h0', type: 'scene_heading', text: 'INT. APARTMENT - MORNING' },
      actionBeat(0),
      { id: 'h1', type: 'scene_heading', text: 'EXT. STREET - DAY' },
    ];
    const { doc, editor, mount } = buildDoc(blocks);
    const layout = paginateScreenplay(blocks);
    const blockStarts = computeBlockStarts(doc);
    const expectedWithoutSceneNumbers =
      computePageTopBlocks(doc, blockStarts, layout).length +
      computePageBreaks(doc, blockStarts, layout).length;

    const decorations = buildPaginationDecorations(doc, layout, DEFAULT_DOCUMENT_SETTINGS);

    expect(decorations.find()).toHaveLength(expectedWithoutSceneNumbers);
    editor.destroy();
    mount.remove();
  });

  it('adds one scene-number decoration per non-empty scene heading when the setting is on, skipping an empty one', () => {
    const blocks: ScreenplayBlock[] = [
      { id: 'h0', type: 'scene_heading', text: 'INT. APARTMENT - MORNING' },
      actionBeat(0),
      { id: 'h1', type: 'scene_heading', text: 'EXT. STREET - DAY' },
      { id: 'h2', type: 'scene_heading', text: '' }, // still being typed: no text yet
    ];
    const { doc, editor, mount } = buildDoc(blocks);
    const layout = paginateScreenplay(blocks);
    const blockStarts = computeBlockStarts(doc);
    const expectedWithoutSceneNumbers =
      computePageTopBlocks(doc, blockStarts, layout).length +
      computePageBreaks(doc, blockStarts, layout).length;

    // Two non-empty scene headings (h0, h1), not three: the blank one in progress (h2) consumes
    // no number and gets no decoration -- see computeSceneNumberDecorations's own comment for why.
    expect(computeSceneNumberDecorations(doc)).toHaveLength(2);

    const decorations = buildPaginationDecorations(doc, layout, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      sceneNumbersEnabled: true,
    });

    expect(decorations.find()).toHaveLength(expectedWithoutSceneNumbers + 2);
    editor.destroy();
    mount.remove();
  });
});
