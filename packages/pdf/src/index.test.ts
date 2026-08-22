import { describe, expect, it } from 'vitest';
import { paginateScreenplay } from '@finaler-draft/layout';
import { UnsupportedBlockError } from '@finaler-draft/layout';
import { DEFAULT_DOCUMENT_SETTINGS } from '@finaler-draft/screenplay';
import { screenplayToPdf } from './index.js';
import { extractPageRuns, extractPageText, extractPageTextRuns, loadPdf } from './pdfTestUtils.js';
import * as geometry from './geometry.js';
import {
  actionBlock,
  characterBlock,
  dialogueBlock,
  dualDialogueBlock,
  pageBreakBlock,
  parentheticalBlock,
  sceneHeadingBlock,
  screenplayWith,
  shotBlock,
  textForActionLineCount,
  textForDialogueLineCount,
  titlePageWith,
  transitionBlock,
} from './testFixtures.js';

describe('screenplayToPdf: page count is paginateScreenplay’s own count, never a restated number', () => {
  it('matches for a short, single-page screenplay', async () => {
    const blocks = [
      sceneHeadingBlock('sh0', 'INT. KITCHEN - DAY'),
      actionBlock('a0', 'Ada pours coffee.'),
    ];
    const layout = paginateScreenplay(blocks);
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    expect(pdfDoc.getPageCount()).toBe(layout.pages.length);
  });

  it('matches across three forced page breaks (four pages)', async () => {
    const blocks = [
      actionBlock('a0', 'PAGE ONE MARKER'),
      pageBreakBlock('pb0'),
      actionBlock('a1', 'PAGE TWO MARKER'),
      pageBreakBlock('pb1'),
      actionBlock('a2', 'PAGE THREE MARKER'),
      pageBreakBlock('pb2'),
      actionBlock('a3', 'PAGE FOUR MARKER'),
    ];
    const layout = paginateScreenplay(blocks);
    expect(layout.pages).toHaveLength(4); // sanity: this fixture actually spans four pages
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    expect(pdfDoc.getPageCount()).toBe(layout.pages.length);
  });

  it('matches a fixture that forces a dialogue split across two pages', async () => {
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(4)),
    ];
    const layout = paginateScreenplay(blocks);
    expect(layout.pages).toHaveLength(2);
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    expect(pdfDoc.getPageCount()).toBe(layout.pages.length);
  });

  it('adds exactly one unpaginated page in front when a title page is present', async () => {
    const blocks = [actionBlock('a0', 'Ada waits.')];
    const layout = paginateScreenplay(blocks);
    const withTitle = screenplayWith(blocks, {
      titlePages: [titlePageWith({ title: 'THE LAST STOP' })],
    });
    const bytes = await screenplayToPdf(withTitle);
    const pdfDoc = await loadPdf(bytes);
    expect(pdfDoc.getPageCount()).toBe(layout.pages.length + 1);
  });
});

describe('screenplayToPdf: per-page content lands on the page the layout model says it does', () => {
  it('places each marker action line on its own page, and nowhere else', async () => {
    const blocks = [
      actionBlock('a0', 'PAGE ONE MARKER'),
      pageBreakBlock('pb0'),
      actionBlock('a1', 'PAGE TWO MARKER'),
      pageBreakBlock('pb1'),
      actionBlock('a2', 'PAGE THREE MARKER'),
    ];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);

    const page0 = extractPageText(pdfDoc, 0);
    const page1 = extractPageText(pdfDoc, 1);
    const page2 = extractPageText(pdfDoc, 2);

    expect(page0).toContain('PAGE ONE MARKER');
    expect(page0).not.toContain('PAGE TWO MARKER');
    expect(page0).not.toContain('PAGE THREE MARKER');

    expect(page1).toContain('PAGE TWO MARKER');
    expect(page1).not.toContain('PAGE ONE MARKER');
    expect(page1).not.toContain('PAGE THREE MARKER');

    expect(page2).toContain('PAGE THREE MARKER');
    expect(page2).not.toContain('PAGE ONE MARKER');
    expect(page2).not.toContain('PAGE TWO MARKER');
  });

  it("places the generated (MORE) on the outgoing page and CONT'D on the incoming page", async () => {
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(4)),
    ];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);

    const page0 = extractPageText(pdfDoc, 0);
    const page1 = extractPageText(pdfDoc, 1);

    expect(page0).toContain('(MORE)');
    expect(page0).not.toContain("CONT'D");
    expect(page1).toContain("ADA (CONT'D)");
    expect(page1).not.toContain('(MORE)');
  });

  it('every screenplay element type renders its authored text somewhere in the document', async () => {
    const blocks = [
      sceneHeadingBlock('sh0', 'INT. KITCHEN - DAY'),
      actionBlock('a0', 'Ada pours coffee.'),
      characterBlock('c0', 'ADA'),
      parentheticalBlock('p0', '(quietly)'),
      dialogueBlock('d0', "It's ready."),
      shotBlock('s0', 'CLOSE ON THE CUP'),
      transitionBlock('t0', 'CUT TO:'),
    ];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    const text = extractPageText(pdfDoc, 0);

    expect(text).toContain('INT. KITCHEN - DAY');
    expect(text).toContain('Ada pours coffee.');
    expect(text).toContain('ADA');
    expect(text).toContain('(quietly)');
    expect(text).toContain("It's ready.");
    expect(text).toContain('CLOSE ON THE CUP');
    expect(text).toContain('CUT TO:');
  });
});

describe('screenplayToPdf: positions come from the grid, not merely "on the right page"', () => {
  // These assertions exist specifically to catch a class of mutation the page-content tests
  // above cannot: `painter.ts` drawing the *correct text* at the *wrong coordinate* -- for
  // example, calling `leftIndentPtFor('action', ...)` where `generatedLineLeftPt` belongs. Text
  // containment alone is blind to that; comparing the PDF's own `Tm` translation against
  // `geometry.ts`'s functions directly is not.
  it('every body element draws at its geometry-derived left indent and line-0 baseline', async () => {
    const blocks = [
      sceneHeadingBlock('sh0', 'INT. KITCHEN - DAY'),
      actionBlock('a0', 'Ada pours coffee.'),
    ];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    const runs = extractPageRuns(pdfDoc, 0);

    const heading = runs.find((run) => run.text === 'INT. KITCHEN - DAY');
    expect(heading?.x).toBe(geometry.leftIndentPtFor('scene_heading', DEFAULT_DOCUMENT_SETTINGS));
    expect(heading?.y).toBe(geometry.baselineForLine(0));

    // The action line follows one blank line (BLANK_LINES_BEFORE.action) after the heading, so
    // it lands on line index 2 (0: heading, 1: blank, 2: action) of the page's line grid.
    const action = runs.find((run) => run.text === 'Ada pours coffee.');
    expect(action?.x).toBe(geometry.leftIndentPtFor('action', DEFAULT_DOCUMENT_SETTINGS));
    expect(action?.y).toBe(geometry.baselineForLine(2));
  });

  it('character/parenthetical/dialogue draw at documentSettings-derived indents', async () => {
    const blocks = [
      characterBlock('c0', 'ADA'),
      parentheticalBlock('p0', '(quietly)'),
      dialogueBlock('d0', "It's ready."),
    ];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    const runs = extractPageRuns(pdfDoc, 0);

    expect(runs.find((run) => run.text === 'ADA')?.x).toBe(
      geometry.leftIndentPtFor('character', DEFAULT_DOCUMENT_SETTINGS),
    );
    expect(runs.find((run) => run.text === '(quietly)')?.x).toBe(
      geometry.leftIndentPtFor('parenthetical', DEFAULT_DOCUMENT_SETTINGS),
    );
    expect(runs.find((run) => run.text === "It's ready.")?.x).toBe(
      geometry.leftIndentPtFor('dialogue', DEFAULT_DOCUMENT_SETTINGS),
    );
  });

  it('transition right-aligns against TRANSITION_RIGHT_EDGE_PT, using the analytic width', async () => {
    const blocks = [transitionBlock('t0', 'CUT TO:')];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    const run = extractPageRuns(pdfDoc, 0).find((entry) => entry.text === 'CUT TO:');
    expect(run?.x).toBe(geometry.TRANSITION_RIGHT_EDGE_PT - geometry.widthPt('CUT TO:'));
  });

  it("(MORE)/CONT'D draw at generatedLineLeftPt, not the ordinary character/action indent", async () => {
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(4)),
    ];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    const more = extractPageRuns(pdfDoc, 0).find((run) => run.text === '(MORE)');
    const contd = extractPageRuns(pdfDoc, 1).find((run) => run.text === "ADA (CONT'D)");
    expect(more?.x).toBe(geometry.generatedLineLeftPt(DEFAULT_DOCUMENT_SETTINGS));
    expect(contd?.x).toBe(geometry.generatedLineLeftPt(DEFAULT_DOCUMENT_SETTINGS));
  });

  it('the page number sits at PAGE_NUMBER_RIGHT_EDGE_PT/PAGE_NUMBER_TOP_SLOT_PT, right-aligned', async () => {
    const blocks = [
      actionBlock('a0', 'PAGE ONE MARKER'),
      pageBreakBlock('pb0'),
      actionBlock('a1', 'PAGE TWO MARKER'),
    ];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    const run = extractPageRuns(pdfDoc, 1).find((entry) => entry.text === '2.');
    expect(run?.x).toBe(geometry.PAGE_NUMBER_RIGHT_EDGE_PT - geometry.widthPt('2.'));
    expect(run?.y).toBe(geometry.baselineForSlotTop(geometry.PAGE_NUMBER_TOP_SLOT_PT));
  });

  it('both scene-number copies sit at SCENE_NUMBER_LEFT_RIGHT_EDGE_PT/SCENE_NUMBER_RIGHT_LEFT_EDGE_PT', async () => {
    const blocks = [sceneHeadingBlock('sh0', 'INT. KITCHEN - DAY')];
    const screenplay = screenplayWith(blocks, {
      documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, sceneNumbersEnabled: true },
    });
    const bytes = await screenplayToPdf(screenplay);
    const pdfDoc = await loadPdf(bytes);
    const runs = extractPageRuns(pdfDoc, 0).filter((run) => run.text === '1');
    expect(runs).toHaveLength(2);
    const xs = runs.map((run) => run.x).sort((a, b) => a - b);
    expect(xs[0]).toBe(geometry.SCENE_NUMBER_LEFT_RIGHT_EDGE_PT - geometry.widthPt('1'));
    expect(xs[1]).toBe(geometry.SCENE_NUMBER_RIGHT_LEFT_EDGE_PT);
  });

  it('a centered title-page line straddles TITLE_PAGE_CENTER_X_PT symmetrically', async () => {
    const screenplay = screenplayWith([actionBlock('a0', 'Ada waits.')], {
      titlePages: [titlePageWith({ title: 'THE LAST STOP' })],
    });
    const bytes = await screenplayToPdf(screenplay);
    const pdfDoc = await loadPdf(bytes);
    const run = extractPageRuns(pdfDoc, 0).find((entry) => entry.text === 'THE LAST STOP');
    const width = geometry.widthPt('THE LAST STOP');
    expect(run?.x).toBe(geometry.TITLE_PAGE_CENTER_X_PT - width / 2);
  });
});

describe('screenplayToPdf: page numbering', () => {
  it('omits the printed number on the first body page and prints "2." on the second', async () => {
    const blocks = [
      actionBlock('a0', 'PAGE ONE MARKER'),
      pageBreakBlock('pb0'),
      actionBlock('a1', 'PAGE TWO MARKER'),
    ];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);

    expect(extractPageTextRuns(pdfDoc, 0)).not.toContain('1.');
    expect(extractPageTextRuns(pdfDoc, 1)).toContain('2.');
  });

  it('renders roman numerals when pageNumberStyle is "roman"', async () => {
    const blocks = [
      actionBlock('a0', 'PAGE ONE MARKER'),
      pageBreakBlock('pb0'),
      actionBlock('a1', 'PAGE TWO MARKER'),
      pageBreakBlock('pb1'),
      actionBlock('a2', 'PAGE THREE MARKER'),
      pageBreakBlock('pb2'),
      actionBlock('a3', 'PAGE FOUR MARKER'),
    ];
    const screenplay = screenplayWith(blocks, {
      documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, pageNumberStyle: 'roman' },
    });
    const bytes = await screenplayToPdf(screenplay);
    const pdfDoc = await loadPdf(bytes);
    expect(extractPageTextRuns(pdfDoc, 3)).toContain('IV.');
  });

  it('the title page carries no printed page number at all', async () => {
    const blocks = [actionBlock('a0', 'Ada waits.')];
    const screenplay = screenplayWith(blocks, {
      titlePages: [titlePageWith({ title: 'THE LAST STOP' })],
    });
    const bytes = await screenplayToPdf(screenplay);
    const pdfDoc = await loadPdf(bytes);
    expect(extractPageTextRuns(pdfDoc, 0)).not.toContain('1.');
  });
});

describe('screenplayToPdf: scene numbers', () => {
  it('renders nothing when sceneNumbersEnabled is off (the default)', async () => {
    const blocks = [
      sceneHeadingBlock('sh0', 'INT. KITCHEN - DAY'),
      actionBlock('a0', 'Ada waits.'),
    ];
    const bytes = await screenplayToPdf(screenplayWith(blocks));
    const pdfDoc = await loadPdf(bytes);
    const runs = extractPageTextRuns(pdfDoc, 0);
    expect(runs.filter((run) => run === '1')).toHaveLength(0);
  });

  it('renders the computed number twice (both margins) when sceneNumbersEnabled is on', async () => {
    const blocks = [
      sceneHeadingBlock('sh0', 'INT. KITCHEN - DAY'),
      actionBlock('a0', 'Ada waits.'),
    ];
    const screenplay = screenplayWith(blocks, {
      documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, sceneNumbersEnabled: true },
    });
    const bytes = await screenplayToPdf(screenplay);
    const pdfDoc = await loadPdf(bytes);
    const runs = extractPageTextRuns(pdfDoc, 0);
    expect(runs.filter((run) => run === '1')).toHaveLength(2);
  });

  it('a stored sceneNumber wins as the printed label', async () => {
    const blocks = [
      sceneHeadingBlock('sh0', 'INT. KITCHEN - DAY', '25A'),
      actionBlock('a0', 'Ada waits.'),
    ];
    const screenplay = screenplayWith(blocks, {
      documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, sceneNumbersEnabled: true },
    });
    const bytes = await screenplayToPdf(screenplay);
    const pdfDoc = await loadPdf(bytes);
    const runs = extractPageTextRuns(pdfDoc, 0);
    expect(runs.filter((run) => run === '25A')).toHaveLength(2);
  });

  it('skips an empty scene heading -- no number consumed or drawn', async () => {
    const blocks = [
      sceneHeadingBlock('sh0', ''),
      sceneHeadingBlock('sh1', 'EXT. STREET - NIGHT'),
      actionBlock('a0', 'Ada waits.'),
    ];
    const screenplay = screenplayWith(blocks, {
      documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, sceneNumbersEnabled: true },
    });
    const bytes = await screenplayToPdf(screenplay);
    const pdfDoc = await loadPdf(bytes);
    const runs = extractPageTextRuns(pdfDoc, 0);
    expect(runs.filter((run) => run === '1')).toHaveLength(2);
    expect(runs.filter((run) => run === '2')).toHaveLength(0);
  });
});

describe('screenplayToPdf: title page', () => {
  it('is absent when the screenplay has no title page', async () => {
    const bytes = await screenplayToPdf(screenplayWith([actionBlock('a0', 'Ada waits.')]));
    const pdfDoc = await loadPdf(bytes);
    expect(extractPageText(pdfDoc, 0)).not.toContain('THE LAST STOP');
  });

  it('renders title/credit/authors ahead of the script body', async () => {
    const screenplay = screenplayWith([actionBlock('a0', 'Ada waits.')], {
      titlePages: [
        titlePageWith({ title: 'THE LAST STOP', credit: 'written by', authors: ['Ada Lovelace'] }),
      ],
    });
    const bytes = await screenplayToPdf(screenplay);
    const pdfDoc = await loadPdf(bytes);
    const titlePageText = extractPageText(pdfDoc, 0);
    expect(titlePageText).toContain('THE LAST STOP');
    expect(titlePageText).toContain('written by');
    expect(titlePageText).toContain('Ada Lovelace');
    expect(extractPageText(pdfDoc, 1)).toContain('Ada waits.');
    expect(extractPageText(pdfDoc, 1)).not.toContain('THE LAST STOP');
  });

  it('renders draftDate (left-aligned) and every contact line (right-aligned)', async () => {
    const screenplay = screenplayWith([actionBlock('a0', 'Ada waits.')], {
      titlePages: [
        titlePageWith({
          draftDate: 'Third Draft, June 2026',
          contact: ['Ada Lovelace', '555-0100'],
        }),
      ],
    });
    const bytes = await screenplayToPdf(screenplay);
    const pdfDoc = await loadPdf(bytes);
    const titlePageText = extractPageText(pdfDoc, 0);
    expect(titlePageText).toContain('Third Draft, June 2026');
    expect(titlePageText).toContain('Ada Lovelace');
    expect(titlePageText).toContain('555-0100');
  });

  it('throws when more than one title page is present', async () => {
    const screenplay = screenplayWith([actionBlock('a0', 'Ada waits.')], {
      titlePages: [
        titlePageWith({ title: 'One' }),
        titlePageWith({ id: 'second-title', title: 'Two' }),
      ],
    });
    await expect(screenplayToPdf(screenplay)).rejects.toThrow(/at most one title page/);
  });
});

describe('screenplayToPdf: unsupported input', () => {
  it('propagates UnsupportedBlockError for dual_dialogue rather than guessing at layout', async () => {
    const screenplay = screenplayWith([dualDialogueBlock('dd0')]);
    await expect(screenplayToPdf(screenplay)).rejects.toThrow(UnsupportedBlockError);
  });

  it('throws an actionable error naming the character, its code point, and the block when text falls outside WinAnsiEncoding', async () => {
    const blocks = [actionBlock('a0', 'Ada speaks: 書')];
    const screenplay = screenplayWith(blocks);
    await expect(screenplayToPdf(screenplay)).rejects.toThrow(/書.*0x66f8/i);
    await expect(screenplayToPdf(screenplay)).rejects.toThrow(/block "a0", action/);
    await expect(screenplayToPdf(screenplay)).rejects.toThrow(/un-embedded Courier/);
  });
});

describe('screenplayToPdf: determinism', () => {
  it('produces byte-identical output for the same input, called twice', async () => {
    const blocks = [
      sceneHeadingBlock('sh0', 'INT. KITCHEN - DAY'),
      actionBlock('a0', 'Ada pours coffee.'),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', "It's ready."),
    ];
    const screenplay = screenplayWith(blocks, {
      titlePages: [titlePageWith({ title: 'THE LAST STOP', authors: ['Ada Lovelace'] })],
    });
    const first = await screenplayToPdf(screenplay);
    const second = await screenplayToPdf(screenplay);
    expect(Buffer.from(second)).toEqual(Buffer.from(first));
  });
});
