import { describe, expect, it } from 'vitest';
import {
  BODY_HEIGHT_IN,
  BODY_WIDTH_CHARACTERS,
  BODY_WIDTH_IN,
  ELEMENT_INDENTS,
  LEADING_PT,
  LINE_HEIGHT_RATIO,
  LINES_PER_INCH,
  LINES_PER_PAGE_MAX,
  LINES_PER_PAGE_MIN,
  MARGIN_BOTTOM_MAX_IN,
  MARGIN_BOTTOM_MIN_IN,
  MARGIN_LEFT_IN,
  MARGIN_RIGHT_IN,
  MARGIN_TOP_IN,
  MEASURED_COURIER_PRIME_ADVANCE_EM,
  NOMINAL_CHARACTERS_PER_INCH,
  PAGE_HEIGHT_IN,
  PAGE_NUMBER_RIGHT_IN,
  PAGE_NUMBER_TOP_IN,
  PAGE_WIDTH_IN,
  TYPEFACE,
  TYPE_SIZE_PT,
} from './pageFormat.js';

describe('page geometry', () => {
  it('is US Letter', () => {
    expect(PAGE_WIDTH_IN).toBe(8.5);
    expect(PAGE_HEIGHT_IN).toBe(11);
  });

  it('has the specified margins', () => {
    expect(MARGIN_LEFT_IN).toBe(1.5);
    expect(MARGIN_RIGHT_IN).toBe(1.0);
    expect(MARGIN_TOP_IN).toBe(1.0);
    expect(MARGIN_BOTTOM_MIN_IN).toBe(0.5);
    expect(MARGIN_BOTTOM_MAX_IN).toBe(1.5);
  });

  it('derives body width from the page width and margins', () => {
    expect(BODY_WIDTH_IN).toBeCloseTo(6.0, 10);
    expect(BODY_WIDTH_CHARACTERS).toBe(60);
  });

  it('derives body height at the minimum bottom margin', () => {
    expect(BODY_HEIGHT_IN).toBeCloseTo(9.0, 10);
  });

  it('positions the page number from the physical page edge', () => {
    expect(PAGE_NUMBER_TOP_IN).toBe(0.5);
    expect(PAGE_NUMBER_RIGHT_IN).toBe(0.75);
  });
});

describe('typeface and pitch', () => {
  it('is 12 pt Courier Prime, not adjustable', () => {
    expect(TYPEFACE).toBe('Courier Prime');
    expect(TYPE_SIZE_PT).toBe(12);
  });

  it('specifies exactly 10 characters per inch as the nominal informative pitch', () => {
    expect(NOMINAL_CHARACTERS_PER_INCH).toBe(10);
  });

  it('records a measured Courier Prime advance ratio deliberately not exactly 0.6 em', () => {
    // 1228 / 2048 unitsPerEm, measured in Chrome; see the module comment for the full
    // measurement method. This unit test only pins the arithmetic and the size/direction of
    // the deviation -- it cannot check the constant against anything rendered, because it
    // never renders anything. The browser-level regression test that asserts this ratio
    // against real rendering (and fails if a fallback font is measured instead) lives in
    // apps/web/e2e/page-geometry.spec.ts.
    const deviation = Math.abs(MEASURED_COURIER_PRIME_ADVANCE_EM - 0.6) / 0.6;
    expect(deviation).toBeLessThan(0.001);
    expect(MEASURED_COURIER_PRIME_ADVANCE_EM).toBeLessThan(0.6);
  });
});

describe('vertical metrics', () => {
  it('sets leading equal to type size, single-spaced', () => {
    expect(LEADING_PT).toBe(TYPE_SIZE_PT);
  });

  it('produces exactly six lines per inch at line-height 1', () => {
    expect(LINE_HEIGHT_RATIO).toBe(1);
    expect(LINES_PER_INCH).toBe(6);
  });

  it('bounds lines per page at 54 to 55', () => {
    expect(LINES_PER_PAGE_MIN).toBe(54);
    expect(LINES_PER_PAGE_MAX).toBe(55);
  });
});

describe('element indents', () => {
  it('matches the specification table exactly', () => {
    expect(ELEMENT_INDENTS.scene_heading).toEqual({
      leftIn: 1.5,
      rightIn: 1.0,
      widthIn: 6.0,
      characters: 60,
      align: 'left',
    });
    expect(ELEMENT_INDENTS.action).toEqual({
      leftIn: 1.5,
      rightIn: 1.0,
      widthIn: 6.0,
      characters: 60,
      align: 'left',
    });
    expect(ELEMENT_INDENTS.character).toEqual({ leftIn: 3.7, align: 'left' });
    expect(ELEMENT_INDENTS.dialogue).toEqual({
      leftIn: 2.5,
      rightIn: 2.5,
      widthIn: 3.5,
      characters: 35,
      align: 'left',
    });
    expect(ELEMENT_INDENTS.parenthetical).toEqual({
      leftIn: 3.1,
      widthIn: 2.0,
      characters: 20,
      align: 'left',
    });
    expect(ELEMENT_INDENTS.transition).toEqual({ rightIn: 1.0, align: 'right' });
    expect(ELEMENT_INDENTS.shot).toEqual({
      leftIn: 1.5,
      rightIn: 1.0,
      widthIn: 6.0,
      characters: 60,
      align: 'left',
    });
  });

  it('keeps dialogue width consistent with its left and right offsets', () => {
    const dialogue = ELEMENT_INDENTS.dialogue;
    expect(dialogue.leftIn).toBeDefined();
    expect(dialogue.rightIn).toBeDefined();
    expect(dialogue.widthIn).toBeCloseTo(
      PAGE_WIDTH_IN - (dialogue.leftIn ?? 0) - (dialogue.rightIn ?? 0),
      10,
    );
  });
});
