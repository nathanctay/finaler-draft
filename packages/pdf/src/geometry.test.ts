import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DEFAULT_DOCUMENT_SETTINGS } from '@finaler-draft/screenplay';
import {
  BODY_RIGHT_EDGE_PT,
  MARGIN_LEFT_PT,
  PAGE_HEIGHT_PT,
  PAGE_NUMBER_RIGHT_EDGE_PT,
  PAGE_NUMBER_TOP_SLOT_PT,
  POINTS_PER_CHARACTER,
  SCENE_NUMBER_LEFT_RIGHT_EDGE_PT,
  SCENE_NUMBER_RIGHT_LEFT_EDGE_PT,
  TITLE_PAGE_CENTER_X_PT,
  TRANSITION_RIGHT_EDGE_PT,
  baselineForLine,
  baselineForSlotTop,
  generatedLineLeftPt,
  leftIndentPtFor,
  lineTopPt,
  widthPt,
} from './geometry.js';

describe('the line grid', () => {
  it('places line 0 at the top margin and steps by the 12pt leading thereafter', () => {
    expect(lineTopPt(0)).toBe(72); // MARGIN_TOP_IN (1.0in) * 72
    expect(lineTopPt(1)).toBe(84);
    expect(lineTopPt(5)).toBe(132);
  });

  it('keeps baseline-to-baseline spacing at exactly the 12pt leading, regardless of the in-slot ratio', () => {
    expect(baselineForLine(0) - baselineForLine(1)).toBe(12);
    expect(baselineForLine(4) - baselineForLine(5)).toBe(12);
  });

  it('places the baseline inside its own 12pt slot (0.8 of the leading down from the slot top)', () => {
    const slotTop = PAGE_HEIGHT_PT - lineTopPt(0); // slot top, Y-from-bottom
    const slotBottom = slotTop - 12;
    const baseline = baselineForLine(0);
    expect(baseline).toBeLessThan(slotTop);
    expect(baseline).toBeGreaterThan(slotBottom);
    expect(slotTop - baseline).toBeCloseTo(0.8 * 12, 10);
  });

  it('baselineForSlotTop is the single conversion every caller (body lines, the page number, the title page) shares', () => {
    expect(baselineForSlotTop(lineTopPt(0))).toBe(baselineForLine(0));
    expect(baselineForSlotTop(PAGE_NUMBER_TOP_SLOT_PT)).toBe(PAGE_HEIGHT_PT - 36 - 0.8 * 12);
  });
});

describe('widthPt: analytic, from the character grid, never a font metric', () => {
  it('is exactly POINTS_PER_CHARACTER per character at the nominal 10 pitch', () => {
    expect(POINTS_PER_CHARACTER).toBe(7.2);
    expect(widthPt('x'.repeat(10))).toBeCloseTo(72, 10); // 10 chars = 1 inch
  });

  it('counts graphemes, not UTF-16 code units -- a ZWJ emoji family is one cell', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // man+ZWJ+woman+ZWJ+girl
    expect(widthPt(family)).toBeCloseTo(POINTS_PER_CHARACTER, 10);
  });

  it('cross-checks the 0.6em Courier assumption against pdf-lib’s own Standard-14 metric', async () => {
    // This is the one place this package compares its grid-derived width against pdf-lib's own
    // font object -- and only inside a test, never in production code driving a position (see
    // this module's own top comment and checkpoint 1). It exists to prove the assumption that
    // makes Courier the right interim choice actually holds in the library this package ships.
    const pdfDoc = await PDFDocument.create({ updateMetadata: false });
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    const sample = 'The quick brown fox jumps over 12 lazy dogs.';
    expect(font.widthOfTextAtSize(sample, 12)).toBeCloseTo(widthPt(sample), 10);
  });
});

describe('leftIndentPtFor', () => {
  it('reads character/parenthetical from documentSettings, in points', () => {
    expect(leftIndentPtFor('character', DEFAULT_DOCUMENT_SETTINGS)).toBeCloseTo(3.7 * 72, 10);
    expect(leftIndentPtFor('parenthetical', DEFAULT_DOCUMENT_SETTINGS)).toBeCloseTo(3.1 * 72, 10);
  });

  it('reads the fixed elements directly from ELEMENT_INDENTS', () => {
    expect(leftIndentPtFor('scene_heading', DEFAULT_DOCUMENT_SETTINGS)).toBeCloseTo(1.5 * 72, 10);
    expect(leftIndentPtFor('action', DEFAULT_DOCUMENT_SETTINGS)).toBeCloseTo(1.5 * 72, 10);
    expect(leftIndentPtFor('shot', DEFAULT_DOCUMENT_SETTINGS)).toBeCloseTo(1.5 * 72, 10);
    expect(leftIndentPtFor('dialogue', DEFAULT_DOCUMENT_SETTINGS)).toBeCloseTo(2.5 * 72, 10);
  });

  it('throws for transition, which is right-aligned and has no left indent', () => {
    expect(() => leftIndentPtFor('transition', DEFAULT_DOCUMENT_SETTINGS)).toThrow(/right-aligned/);
  });

  it('respects a custom characterIndentIn/parentheticalIndentIn', () => {
    const settings = {
      ...DEFAULT_DOCUMENT_SETTINGS,
      characterIndentIn: 4.0,
      parentheticalIndentIn: 3.4,
    };
    expect(leftIndentPtFor('character', settings)).toBeCloseTo(4.0 * 72, 10);
    expect(leftIndentPtFor('parenthetical', settings)).toBeCloseTo(3.4 * 72, 10);
  });
});

describe('generatedLineLeftPt', () => {
  it('places (MORE)/CONT\'D at the character indent, matching leftIndentPtFor("character")', () => {
    expect(generatedLineLeftPt(DEFAULT_DOCUMENT_SETTINGS)).toBe(
      leftIndentPtFor('character', DEFAULT_DOCUMENT_SETTINGS),
    );
  });
});

describe('fixed right/left edges', () => {
  it('derives the transition right edge from ELEMENT_INDENTS.transition.rightIn', () => {
    expect(TRANSITION_RIGHT_EDGE_PT).toBeCloseTo((8.5 - 1.0) * 72, 10);
  });

  it('derives the page number position from PAGE_NUMBER_TOP_IN/PAGE_NUMBER_RIGHT_IN', () => {
    expect(PAGE_NUMBER_RIGHT_EDGE_PT).toBeCloseTo((8.5 - 0.75) * 72, 10);
    expect(PAGE_NUMBER_TOP_SLOT_PT).toBeCloseTo(0.5 * 72, 10);
  });

  it('positions the scene-number margins 0.5in outside the body margins, matching styles.css', () => {
    expect(SCENE_NUMBER_LEFT_RIGHT_EDGE_PT).toBeCloseTo((1.5 - 0.5) * 72, 10);
    expect(SCENE_NUMBER_RIGHT_LEFT_EDGE_PT).toBeCloseTo((8.5 - 1.0 + 0.5) * 72, 10);
  });

  it('centers the title page between the body left and right margins, not the physical page', () => {
    expect(TITLE_PAGE_CENTER_X_PT).toBeCloseTo((MARGIN_LEFT_PT + BODY_RIGHT_EDGE_PT) / 2, 10);
    expect(TITLE_PAGE_CENTER_X_PT).toBeCloseTo(4.5 * 72, 10);
  });
});
