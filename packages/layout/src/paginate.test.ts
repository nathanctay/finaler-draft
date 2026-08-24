import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_SETTINGS, type ScreenplayBlock } from '@finaler-draft/screenplay';
import { paginateScreenplay } from './paginate.js';
import { UnsupportedBlockError } from './model.js';
import { graphemeLength } from './wrap.js';
import type { AuthoredLine, LayoutResult } from './model.js';
import {
  actionBlock,
  characterBlock,
  dialogueBlock,
  dualDialogueBlock,
  pageBreakBlock,
  parentheticalBlock,
  sceneHeadingBlock,
  shotBlock,
  singleActionBlockOfLines,
  textForActionLineCount,
  textForDialogueLineCount,
  transitionBlock,
} from './testFixtures.js';

/**
 * `paginateScreenplay` never refuses to produce a page just because its margin falls outside
 * plan.md's preferred 0.5-1.5 in range: it fails only on unsupported input (`dual_dialogue`),
 * never on a valid but unwelcome layout outcome. The worst-case margin this engine's rules can
 * still produce is bounded, though (see pageBreak.ts's top-of-file comment for the full
 * derivation): 50 lines / 1.667 in, reached when a parenthetical sits between a character cue and
 * the dialogue split it forces to move whole. This checks that bound as a property across every
 * fixture in this file that has no `page_break` (a `page_break`-ended page is deliberately
 * exempt — the author asked for that break, wherever it lands), so a future change to the break
 * rules that widens the worst case gets caught by a fixture here rather than discovered later.
 */
const MINIMUM_LINES_OUTSIDE_KNOWN_WORST_CASE = 50;

function assertNoShortPagesExceptLast(result: LayoutResult): void {
  for (let i = 0; i < result.pages.length - 1; i += 1) {
    const page = result.pages[i];
    expect(page, `page index ${i}`).toBeDefined();
    // lineCount/bottomMarginIn are the model's own exposed fields, not re-derived from `lines`,
    // so this also doubles as a check that they agree with the line count actually present.
    expect(page!.lineCount).toBe(page!.lines.length);
    expect(
      page!.lineCount,
      `page ${page!.pageNumber} of ${result.pages.length} has only ${page!.lineCount} lines (${page!.bottomMarginIn.toFixed(3)} in bottom margin)`,
    ).toBeGreaterThanOrEqual(MINIMUM_LINES_OUTSIDE_KNOWN_WORST_CASE);
  }
}

function assertNoPageStartsBlank(result: LayoutResult): void {
  for (const page of result.pages) {
    expect(page.lines[0]?.kind, `page ${page.pageNumber}`).not.toBe('blank');
  }
}

describe('paginateScreenplay: structural basics', () => {
  it('produces zero pages for an empty screenplay', () => {
    const result = paginateScreenplay([]);
    expect(result.pages).toEqual([]);
  });

  it('produces one page for a single short block', () => {
    const result = paginateScreenplay([actionBlock('a0', 'A single line of action.')]);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.pageNumber).toBe(1);
    expect(result.pages[0]?.lines).toHaveLength(1);
    expect(result.pages[0]?.lines[0]).toMatchObject({
      kind: 'authored',
      element: 'action',
      blockId: 'a0',
      text: 'A single line of action.',
    });
  });

  it('never starts a page with a blank line (space-before suppression), including page 1', () => {
    const result = paginateScreenplay([actionBlock('a0', 'Text.')]);
    assertNoPageStartsBlank(result);
  });

  it('maps an authored line back to its originating block id and a text-range within it', () => {
    const text = 'Rain falls on the empty platform.';
    const result = paginateScreenplay([actionBlock('a0', text)]);
    const line = result.pages[0]?.lines[0] as AuthoredLine;
    expect(line.blockId).toBe('a0');
    expect(line.startOffset).toBeGreaterThanOrEqual(0);
    expect(line.endOffset).toBeLessThanOrEqual(text.length);
    expect(text.slice(line.startOffset, line.endOffset)).toBe(line.text);
  });
});

describe('paginateScreenplay: page-capacity boundaries', () => {
  it('fits a screenplay of exactly 55 lines onto one page', () => {
    const result = paginateScreenplay(singleActionBlockOfLines(55));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.lines).toHaveLength(55);
  });

  it('overflows a screenplay one line over capacity (56) onto a second page', () => {
    const result = paginateScreenplay(singleActionBlockOfLines(56));
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.lines).toHaveLength(55);
    expect(result.pages[1]?.lines).toHaveLength(1);
    assertNoPageStartsBlank(result);
  });

  it('fits a screenplay one line under capacity (54) onto one page', () => {
    const result = paginateScreenplay(singleActionBlockOfLines(54));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.lines).toHaveLength(54);
  });

  it('fills two full 55-line pages exactly for 110 lines', () => {
    const result = paginateScreenplay(singleActionBlockOfLines(110));
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.lines).toHaveLength(55);
    expect(result.pages[1]?.lines).toHaveLength(55);
  });

  it('wraps a scene heading exactly at the measure onto one line, one character over onto two', () => {
    const atMeasure = paginateScreenplay([sceneHeadingBlock('h0', textForActionLineCount(1))]);
    expect(atMeasure.pages[0]?.lines).toHaveLength(1);

    const overMeasure = paginateScreenplay([sceneHeadingBlock('h0', textForActionLineCount(2))]);
    // blank(suppressed, first block) + heading line 1 + heading line 2 = 2 authored lines
    expect(overMeasure.pages[0]?.lines).toHaveLength(2);
  });
});

describe('paginateScreenplay: scene heading keep-together', () => {
  it('moves a scene heading to the next page rather than stranding it with no room for what follows', () => {
    // Page 1 fills to 54 lines with plain action, leaving room 1 -- enough for the heading's own
    // line but not the 2 lines of headroom the heading now requires for whatever follows it.
    const blocks = [
      actionBlock('a0', textForActionLineCount(54)),
      sceneHeadingBlock('h0', 'INT. OFFICE - DAY'),
      actionBlock('a1', 'She looks up.'),
    ];
    const result = paginateScreenplay(blocks);

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.lines).toHaveLength(54); // heading did NOT strand here
    assertNoShortPagesExceptLast(result);

    const page2 = result.pages[1]!;
    expect(page2.lines[0]).toMatchObject({
      kind: 'authored',
      element: 'scene_heading',
      blockId: 'h0',
    });
    // The heading is followed on the same page by its blank-before and the action line.
    expect(page2.lines[1]?.kind).toBe('blank');
    expect(page2.lines[2]).toMatchObject({ kind: 'authored', element: 'action', blockId: 'a1' });
  });

  it('keeps a scene heading at the end of the document without requiring headroom for nothing', () => {
    const blocks = [
      actionBlock('a0', textForActionLineCount(54)),
      sceneHeadingBlock('h0', 'INT. OFFICE - DAY'),
    ];
    const result = paginateScreenplay(blocks);
    // Nothing follows the heading at all, so it is not required to be kept with anything; it
    // simply lands wherever normal flow puts it.
    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    const allLines = result.pages.flatMap((p) => p.lines);
    const headingLine = allLines.find((l) => l.kind === 'authored' && l.blockId === 'h0');
    expect(headingLine).toBeDefined();
  });
});

describe("paginateScreenplay: dialogue orphan avoidance and MORE/CONT'D splitting", () => {
  it('moves an entire speech rather than leaving too little dialogue orphaned at a page foot', () => {
    // Page 1 fills to exactly 51 lines, leaving room 4: cue(1) + blank(1) + 2 dialogue lines
    // would fit content-wise, but reserving a line for (MORE) leaves no room for the required
    // 2-line dialogue minimum, so the whole 3-line-dialogue speech moves. 51 lines / 1.5 in is
    // the no-parenthetical worst case (see pageBreak.ts); still comfortably inside plan.md's
    // preferred range.
    const blocks = [
      actionBlock('a0', textForActionLineCount(51)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(3)),
    ];
    const result = paginateScreenplay(blocks);

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.lines).toHaveLength(51);
    expect(result.pages[0]?.bottomMarginIn).toBeCloseTo(1.5, 5);
    assertNoShortPagesExceptLast(result);

    const page2 = result.pages[1]!;
    expect(page2.lines[0]).toMatchObject({ kind: 'authored', element: 'character', blockId: 'c0' });
    // No (MORE)/CONT'D anywhere: this was a whole-speech move, not a split.
    expect(result.pages.flatMap((p) => p.lines).some((l) => l.kind === 'generated')).toBe(false);
  });

  it("splits a long speech with (MORE) and a CONT'D heading when a valid break point exists", () => {
    // Page 1 fills to 50 lines, leaving room 5. The dialogue has 4 lines -- one more than fits
    // in the room even before a split, so a split is actually required (unlike the 3-line case
    // above, which happens to fit whole): blank + cue + 2 dialogue lines + (MORE) = 5, exactly
    // filling the page; the split point (2 dialogue lines before, 2 after) is valid under the
    // two-and-one minimum.
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(4)),
    ];
    const result = paginateScreenplay(blocks);

    expect(result.pages).toHaveLength(2);
    const page1 = result.pages[0]!;
    const page2 = result.pages[1]!;

    expect(page1.lines).toHaveLength(55);
    const more = page1.lines.at(-1);
    expect(more).toMatchObject({
      kind: 'generated',
      reason: 'more',
      sourceBlockId: 'c0',
      text: '(MORE)',
    });

    const contd = page2.lines[0];
    expect(contd).toMatchObject({ kind: 'generated', reason: 'continued', sourceBlockId: 'c0' });
    expect((contd as { text: string }).text).toBe("ADA (CONT'D)");

    const continuation = page2.lines[1] as AuthoredLine;
    expect(continuation).toMatchObject({ kind: 'authored', element: 'dialogue', blockId: 'd0' });

    assertNoShortPagesExceptLast(result);
    assertNoPageStartsBlank(result);
  });

  it("splits a very long monologue more than once, generating a MORE/CONT'D pair at each break", () => {
    // 60 dialogue lines is far more than fits on any one page's remaining room, so the
    // continuation itself must split again after its own CONT'D heading -- a long monologue
    // spanning three pages, not just two.
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(60)),
    ];
    const result = paginateScreenplay(blocks);

    expect(result.pages).toHaveLength(3);
    assertNoShortPagesExceptLast(result);
    assertNoPageStartsBlank(result);

    const generated = result.pages.flatMap((p) => p.lines).filter((l) => l.kind === 'generated');
    // (MORE) then CONT'D at the first break, and again at the second.
    expect(generated.map((l) => (l.kind === 'generated' ? l.reason : undefined))).toEqual([
      'more',
      'continued',
      'more',
      'continued',
    ]);
    for (const line of generated) {
      expect(line).toMatchObject({ sourceBlockId: 'c0' });
    }
  });

  it("suppresses (MORE) and CONT'D entirely when the document setting is off, still placing every dialogue line", () => {
    // Identical fixture to "splits a long speech with (MORE) and a CONT'D heading..." above --
    // the only difference is the setting, so this isolates exactly what the toggle changes.
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(4)),
    ];
    const result = paginateScreenplay(blocks, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      autoMoreContinued: false,
    });

    expect(result.pages).toHaveLength(2);
    const generated = result.pages.flatMap((p) => p.lines).filter((l) => l.kind === 'generated');
    expect(generated).toHaveLength(0);

    const dialogueLines = result.pages
      .flatMap((p) => p.lines)
      .filter((l) => l.kind === 'authored' && l.blockId === 'd0');
    expect(dialogueLines).toHaveLength(4);
  });

  /**
   * The property the previous test does not actually check: plan.md says the setting "must not
   * change where pages break" and, with it off, "the outgoing page fills to capacity" rather than
   * leaving the `(MORE)` line's room unused. A test that only checks page count and total dialogue
   * lines placed (the previous test) passes whether or not that room is reserved -- the earlier,
   * buggy `pageBreak.ts` reserved a line for `(MORE)` unconditionally, so with the setting off it
   * produced the *same* split point as with it on, then simply emitted nothing into the reserved
   * row (page 1 landed at 54 lines, one short of capacity, not 55). This test instead compares the
   * two settings against each other directly and checks the row counts, which is what actually
   * distinguishes "fills to capacity" from "reserves and wastes a line."
   */
  it('fills every non-final outgoing page to the same capacity as when autoMoreContinued is on, moving no page break', () => {
    // Same fixture as "splits a very long monologue more than once" above: 60 dialogue lines force
    // two splits, so this exercises both placeSpeechGroup's first split and
    // placeSpeechContinuation's second one.
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(60)),
    ];
    const withMarkers = paginateScreenplay(blocks);
    const withoutMarkers = paginateScreenplay(blocks, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      autoMoreContinued: false,
    });

    expect(withMarkers.pages).toHaveLength(3);
    expect(withoutMarkers.pages).toHaveLength(3);

    // Every page but the last ends at the identical row count regardless of the setting: the room
    // a (MORE) line would have reserved goes to one more line of real dialogue instead of sitting
    // empty, so the physical boundary between pages -- and therefore where the next page begins --
    // never moves. (The last page is exempt for the same reason assertNoShortPagesExceptLast is:
    // it simply ends where the content runs out.)
    for (let index = 0; index < withMarkers.pages.length - 1; index += 1) {
      expect(withoutMarkers.pages[index]?.lineCount, `page index ${index}`).toBe(
        withMarkers.pages[index]?.lineCount,
      );
      expect(withoutMarkers.pages[index]?.bottomMarginIn, `page index ${index}`).toBeCloseTo(
        withMarkers.pages[index]?.bottomMarginIn ?? Number.NaN,
        10,
      );
    }

    // The mechanism, not just the outcome: with the setting off, each non-final page carries
    // exactly as many more authored dialogue lines as it had generated marker lines with the
    // setting on -- one (a trailing `(MORE)`) on the document's first page, two (a leading
    // `CONT'D` plus a trailing `(MORE)`) on a page that is itself a continuation of an earlier
    // split, per generated line freed. A fix that reached the same lineCount some other way (e.g.
    // by leaving the freed rows genuinely blank) fails this half even though the row-count
    // assertions above would still pass.
    for (let index = 0; index < withMarkers.pages.length - 1; index += 1) {
      const onPage = withMarkers.pages[index]!;
      const offPage = withoutMarkers.pages[index]!;
      const generatedOnPage = onPage.lines.filter((l) => l.kind === 'generated').length;
      const dialogueCountOn = onPage.lines.filter(
        (l) => l.kind === 'authored' && l.blockId === 'd0',
      ).length;
      const dialogueCountOff = offPage.lines.filter(
        (l) => l.kind === 'authored' && l.blockId === 'd0',
      ).length;
      expect(dialogueCountOff, `page index ${index}`).toBe(dialogueCountOn + generatedOnPage);
    }

    const generatedOff = withoutMarkers.pages
      .flatMap((p) => p.lines)
      .filter((l) => l.kind === 'generated');
    expect(generatedOff).toHaveLength(0);
    const dialogueTotalOff = withoutMarkers.pages
      .flatMap((p) => p.lines)
      .filter((l) => l.kind === 'authored' && l.blockId === 'd0').length;
    expect(dialogueTotalOff).toBe(60);
  });

  it('never splits a parenthetical across pages and never leaves it ending a page', () => {
    const blocks = [
      characterBlock('c0', 'ADA'),
      parentheticalBlock('p0', '(quietly)'),
      dialogueBlock('d0', 'Just a short line.'),
    ];
    const result = paginateScreenplay(blocks);
    const allLines = result.pages.flatMap((p) => p.lines);
    const parenIndex = allLines.findIndex((l) => l.kind === 'authored' && l.blockId === 'p0');
    expect(parenIndex).toBeGreaterThanOrEqual(0);
    // The parenthetical is exactly one line (its text is short), so "never split" is trivially
    // true here; the meaningful assertion is that nothing generated (MORE/CONT'D) surrounds it
    // and it is immediately followed by dialogue on the same page.
    const next = allLines[parenIndex + 1];
    expect(next).toMatchObject({ kind: 'authored', element: 'dialogue', blockId: 'd0' });
  });
});

describe("paginateScreenplay: the generated CONT'D heading wraps like any other line", () => {
  /**
   * `documentSettingsSchema` (packages/screenplay/src/index.ts) caps `characterIndentIn` at
   * `MAX_ADJUSTABLE_INDENT_IN - MIN_CHARACTER_CUE_ROOM_IN` = `(PAGE_WIDTH_IN - MARGIN_RIGHT_IN) -
   * 1` = 6.5in -- the schema's own maximum, reasoned about as "room for at least ten characters"
   * for an AUTHORED cue. Neither constant is exported from that module (they are schema-internal
   * sanity floors), so the derivation is restated here rather than imported; a schema change that
   * moves either value would need this comment updated too, which is the point -- it is not meant
   * to silently track a moving target.
   */
  const MAX_LEGAL_CHARACTER_INDENT_IN = 6.5;

  it("wraps the CONT'D heading onto two GeneratedLines when the appended text overflows a maximally-adjusted character indent, and still places every dialogue line", () => {
    // Identical fixture to "splits a long speech with (MORE) and a CONT'D heading..." above,
    // except characterIndentIn is pushed to the schema's own maximum. At that indent the wrap
    // budget is (8.5 - 1.0 - 6.5) * 10 = 10 characters -- room for "ADA " (4) but not also
    // "(CONT'D)" (8) on the same line, so the heading itself must wrap, exactly like an authored
    // character cue this long would. Before the fix, `pageBreak.ts` pushed exactly one
    // `GeneratedLine` regardless of whether it fit -- this is the case that line would not.
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(4)),
    ];
    const result = paginateScreenplay(blocks, {
      ...DEFAULT_DOCUMENT_SETTINGS,
      characterIndentIn: MAX_LEGAL_CHARACTER_INDENT_IN,
    });

    expect(result.pages).toHaveLength(2);
    const page2 = result.pages[1]!;
    const continuedLines = page2.lines.filter(
      (l) => l.kind === 'generated' && l.reason === 'continued',
    );

    expect(continuedLines).toHaveLength(2);
    expect(continuedLines.map((l) => (l as { text: string }).text)).toEqual(['ADA ', "(CONT'D)"]);
    for (const line of continuedLines) {
      expect(line).toMatchObject({ kind: 'generated', reason: 'continued', sourceBlockId: 'c0' });
    }

    // Both dialogue lines the split moved to page 2 are still placed, now after two heading rows
    // instead of one -- the model's own room accounting absorbed the extra line rather than
    // silently overrunning the page, which is exactly what the pre-fix, single-push model did: it
    // counted one row for a heading that actually occupies two.
    const dialogueOnPage2 = page2.lines.filter((l) => l.kind === 'authored' && l.blockId === 'd0');
    expect(dialogueOnPage2).toHaveLength(2);
    expect(page2.lineCount).toBe(page2.lines.length);
    expect(page2.lines).toHaveLength(4); // 2 CONT'D rows + 2 dialogue rows
  });

  it('keeps the ordinary case at exactly one line: "ADA (CONT\'D)" fits the default 3.7in character indent\'s 38-character budget whole', () => {
    // Regression guard for the common path -- the fix must not make an ordinary heading wrap
    // when it never needed to.
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      dialogueBlock('d0', textForDialogueLineCount(4)),
    ];
    const result = paginateScreenplay(blocks);
    const page2 = result.pages[1]!;
    const continuedLines = page2.lines.filter(
      (l) => l.kind === 'generated' && l.reason === 'continued',
    );
    expect(continuedLines).toHaveLength(1);
    expect((continuedLines[0] as { text: string }).text).toBe("ADA (CONT'D)");
  });

  it("never emits a generated CONT'D line longer than its own indent's character-cue budget, across a matrix of legal indents and name lengths, and never drops a dialogue line while doing it", () => {
    // Property check, not a single number: whatever characterIndentIn a document setting legally
    // sets, and whatever character name the speech has, the model must never claim a single
    // GeneratedLine holds more text than that line's own indent leaves room for -- that gap (a
    // model line the DOM cannot fit on one row) is exactly the defect. `graphemeLength` is the
    // same grid-cell count `wrap.ts` itself measures against, not `.length`, for the same reason
    // `wrap.ts` uses it (see its own doc comment). Some combinations below make the AUTHORED
    // character cue itself wrap (a long name at a deep indent) and the whole speech move to the
    // next page instead of splitting -- a legitimate, unrelated pagination outcome (see
    // `placeSpeechGroup`'s own comment) -- so this does not assert every combination produces a
    // CONT'D at all, only that every one it does produce is honest about its own line count, and
    // that no dialogue content is ever lost regardless of which path the engine took.
    const indentsIn = [1.5, 3.7, 5.0, MAX_LEGAL_CHARACTER_INDENT_IN]; // MARGIN_LEFT_IN, default, mid, schema max
    const names = ['A', 'ADA', 'BARTHOLOMEW', 'Vivamus (VO)'];

    for (const characterIndentIn of indentsIn) {
      for (const characterText of names) {
        const blocks = [
          actionBlock('a0', textForActionLineCount(50)),
          characterBlock('c0', characterText),
          dialogueBlock('d0', textForDialogueLineCount(4)),
        ];
        const result = paginateScreenplay(blocks, {
          ...DEFAULT_DOCUMENT_SETTINGS,
          characterIndentIn,
        });
        const budget = Math.round((8.5 - 1.0 - characterIndentIn) * 10);
        const label = `indent ${characterIndentIn}, name "${characterText}"`;

        const continuedLines = result.pages
          .flatMap((p) => p.lines)
          .filter((l) => l.kind === 'generated' && l.reason === 'continued') as {
          text: string;
        }[];
        for (const line of continuedLines) {
          expect(graphemeLength(line.text), `${label}, line "${line.text}"`).toBeLessThanOrEqual(
            budget,
          );
        }

        // No content lost: all 4 dialogue rows land somewhere, whether the speech split or moved
        // whole.
        const dialogueTotal = result.pages
          .flatMap((p) => p.lines)
          .filter((l) => l.kind === 'authored' && l.blockId === 'd0').length;
        expect(dialogueTotal, label).toBe(4);
      }
    }
  });
});

describe('paginateScreenplay: author page breaks', () => {
  it('forces a break at an author-inserted page_break, even leaving a short page', () => {
    const blocks = [
      actionBlock('a0', 'Short first page.'),
      pageBreakBlock('pb0'),
      actionBlock('a1', 'Second page.'),
    ];
    const result = paginateScreenplay(blocks);
    expect(result.pages).toHaveLength(2);
    // This page has far fewer than 50 lines, which is fine: it was ended by page_break, an
    // author's explicit choice, and paginateScreenplay never refuses to produce a valid layout
    // outcome just because its margin is outside the preferred range.
    expect(result.pages[0]?.lines).toHaveLength(1);
    expect(result.pages[1]?.lines).toHaveLength(1);
  });

  it('does not produce empty pages for a page_break with nothing before it', () => {
    const result = paginateScreenplay([pageBreakBlock('pb0'), actionBlock('a0', 'Only content.')]);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.lines).toHaveLength(1);
  });

  it('produces zero pages for a screenplay containing only a page_break', () => {
    const result = paginateScreenplay([pageBreakBlock('pb0')]);
    expect(result.pages).toEqual([]);
  });
});

describe('paginateScreenplay: unsupported blocks', () => {
  it('throws UnsupportedBlockError for dual_dialogue rather than guessing a layout', () => {
    const blocks = [actionBlock('a0', 'Before.'), dualDialogueBlock('dd0')];
    expect(() => paginateScreenplay(blocks)).toThrow(UnsupportedBlockError);
    try {
      paginateScreenplay(blocks);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedBlockError);
      const unsupported = error as UnsupportedBlockError;
      expect(unsupported.blockId).toBe('dd0');
      expect(unsupported.blockType).toBe('dual_dialogue');
    }
  });
});

describe('paginateScreenplay: elements without their own wrap rule (shot, transition)', () => {
  it('paginates shot elements at the 60-character action budget', () => {
    const result = paginateScreenplay([shotBlock('s0', 'CLOSE ON the clock.')]);
    expect(result.pages[0]?.lines[0]).toMatchObject({
      kind: 'authored',
      element: 'shot',
      blockId: 's0',
    });
  });

  it('paginates transitions', () => {
    const result = paginateScreenplay([transitionBlock('t0', 'CUT TO:')]);
    expect(result.pages[0]?.lines[0]).toMatchObject({
      kind: 'authored',
      element: 'transition',
      blockId: 't0',
    });
  });
});

describe('paginateScreenplay: determinism', () => {
  it('produces a byte-identical (deep-equal) result across repeated runs on a substantial fixture', () => {
    const blocks = [];
    for (let i = 0; i < 40; i += 1) {
      blocks.push(sceneHeadingBlock(`h${i}`, `INT. ROOM ${i} - DAY`));
      blocks.push(
        actionBlock(
          `a${i}`,
          `Something of moderate length happens in room number ${i}, described with enough words to sometimes wrap.`,
        ),
      );
      blocks.push(characterBlock(`c${i}`, `SPEAKER${i % 4}`));
      blocks.push(
        dialogueBlock(
          `d${i}`,
          `This is dialogue for scene ${i}. It is long enough that it will often wrap across more than one line of the thirty-five character measure.`,
        ),
      );
    }

    const first = paginateScreenplay(blocks);
    const second = paginateScreenplay(blocks);
    expect(second).toEqual(first);
    expect(first.pages.length).toBeGreaterThan(1);
    assertNoShortPagesExceptLast(first);
    assertNoPageStartsBlank(first);
  });
});

describe('paginateScreenplay: a parenthetical before a dialogue split widens the margin, correctly', () => {
  it('moves the whole speech to a 50-line, 1.667 in page rather than refusing to paginate', () => {
    // A parenthetical between a character cue and a dialogue block that would otherwise split
    // adds an atomic, uncounted line to the split's "before" room budget (see pageBreak.ts's
    // top-of-file comment: cue + blank + parenthetical + 2 dialogue + MORE = 6, one more than
    // the no-parenthetical case). Page 1 fills to 50 lines here, leaving room 5 -- one short of
    // what a valid split needs -- so the whole speech (cue, parenthetical, and all 3 dialogue
    // lines) moves to page 2 rather than splitting. This is the engine's known worst-case
    // margin, not a defect: it is 0.167 in past the 1.5 in preferred maximum, and
    // `paginateScreenplay` produces the page rather than refusing to. It does not, and must not,
    // throw for this input -- only `dual_dialogue` is unsupported.
    const blocks = [
      actionBlock('a0', textForActionLineCount(50)),
      characterBlock('c0', 'ADA'),
      parentheticalBlock('p0', '(beat)'),
      dialogueBlock('d0', textForDialogueLineCount(3)),
    ];
    const result = paginateScreenplay(blocks);

    expect(result.pages).toHaveLength(2);
    const page1 = result.pages[0]!;
    expect(page1.lines).toHaveLength(50);
    expect(page1.lineCount).toBe(50);
    expect(page1.bottomMarginIn).toBeCloseTo(11 - 1 - 50 / 6, 10);
    expect(page1.bottomMarginIn).toBeCloseTo(1.6667, 4);
    expect(page1.bottomMarginIn).toBeGreaterThan(1.5); // past the preferred max -- expected, not refused

    const page2 = result.pages[1]!;
    expect(page2.lines[0]).toMatchObject({ kind: 'authored', element: 'character', blockId: 'c0' });
    expect(page2.lines.some((l) => l.kind === 'authored' && l.blockId === 'p0')).toBe(true);
    // Moved whole, not split: no (MORE)/CONT'D anywhere.
    expect(result.pages.flatMap((p) => p.lines).some((l) => l.kind === 'generated')).toBe(false);
  });
});

describe('paginateScreenplay: the 50-line margin floor holds across fixtures', () => {
  it('never produces a non-last, non-page_break page below 50 lines, across every fixture built above', () => {
    // A dedicated sweep, per the instruction to make this a property check rather than one
    // targeted test: re-run several of the fixtures already exercised above and confirm the
    // bound holds for all of them together, so a future change to the break rules that widens
    // the worst case fails a test immediately rather than being noticed later.
    const fixtures: (readonly ScreenplayBlock[])[] = [
      [
        actionBlock('a0', textForActionLineCount(51)),
        characterBlock('c0', 'ADA'),
        dialogueBlock('d0', textForDialogueLineCount(3)),
      ],
      [
        actionBlock('a0', textForActionLineCount(50)),
        characterBlock('c0', 'ADA'),
        dialogueBlock('d0', textForDialogueLineCount(4)),
      ],
      [
        actionBlock('a0', textForActionLineCount(50)),
        characterBlock('c0', 'ADA'),
        dialogueBlock('d0', textForDialogueLineCount(60)),
      ],
      [
        actionBlock('a0', textForActionLineCount(50)),
        characterBlock('c0', 'ADA'),
        parentheticalBlock('p0', '(beat)'),
        dialogueBlock('d0', textForDialogueLineCount(3)),
      ],
      [
        actionBlock('a0', textForActionLineCount(54)),
        sceneHeadingBlock('h0', 'INT. OFFICE - DAY'),
        actionBlock('a1', 'She looks up.'),
      ],
    ];

    for (const blocks of fixtures) {
      const result = paginateScreenplay(blocks);
      assertNoShortPagesExceptLast(result);
    }
  });
});

describe('paginateScreenplay: a dialogue or parenthetical block with no preceding character cue', () => {
  it("is schema-legal but not a real speech: it reflows plainly instead of ever generating (MORE)/CONT'D", () => {
    // Nothing requires a character block before a dialogue block in the flat blocks array.
    // Without a character cue there is no name for a CONT'D heading, so this degenerate "speech"
    // is treated like plain action -- it never splits, it just reflows across pages.
    const blocks = [dialogueBlock('d0', textForDialogueLineCount(60))];
    const result = paginateScreenplay(blocks);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.lines).toHaveLength(55);
    expect(result.pages[1]?.lines).toHaveLength(5);
    expect(result.pages.flatMap((p) => p.lines).some((l) => l.kind === 'generated')).toBe(false);
    for (const line of result.pages.flatMap((p) => p.lines)) {
      expect(line).toMatchObject({ kind: 'authored', element: 'dialogue', blockId: 'd0' });
    }
  });

  it('also reflows plainly for an orphaned parenthetical with no preceding character cue', () => {
    const blocks = [
      parentheticalBlock('p0', 'not really a parenthetical here'),
      dialogueBlock('d0', 'hi'),
    ];
    const result = paginateScreenplay(blocks);
    const allLines = result.pages.flatMap((p) => p.lines);
    expect(allLines.some((l) => l.kind === 'authored' && l.blockId === 'p0')).toBe(true);
    expect(allLines.some((l) => l.kind === 'generated')).toBe(false);
  });
});
