/**
 * Pins the contrast arithmetic itself against values each metric's own documentation states, so that
 * every other test in this repo that *computes* a contrast figure
 * (`apps/collab/src/participantPalette.test.ts`, `apps/web/e2e/text-contrast.spec.ts`,
 * `src/presence.test.ts`'s label assertions) is measuring with a ruler that has been checked. A
 * wrong luminance formula would make all of those green simultaneously and silently -- the one
 * failure mode a computed-property guard has that a hex-pinning one does not.
 *
 * Two rulers now, because the two metrics answer different questions: `contrastRatio` is WCAG
 * conformance and `apcaContrast` is the paper-or-ink ranking. See contrast.ts's top comment for why
 * the ranking stopped being WCAG's to make.
 */
import { describe, expect, it } from 'vitest';
import {
  PARTICIPANT_LABEL_INK,
  PARTICIPANT_LABEL_MINIMUM_LC,
  PARTICIPANT_LABEL_PAPER,
  apcaContrast,
  contrastRatio,
  parseHexColor,
  participantLabelTextColor,
  relativeLuminance,
} from './contrast.js';

describe('parseHexColor', () => {
  it('reads six-digit hex, case-insensitively', () => {
    expect(parseHexColor('#1E3067')).toEqual([30, 48, 103]);
    expect(parseHexColor('#1e3067')).toEqual([30, 48, 103]);
  });

  it('expands three-digit hex by doubling each digit', () => {
    expect(parseHexColor('#fff')).toEqual([255, 255, 255]);
    expect(parseHexColor('#0a3')).toEqual([0, 170, 51]);
  });

  it('tolerates surrounding whitespace, which a CSS-sourced value can carry', () => {
    expect(parseHexColor('  #000  ')).toEqual([0, 0, 0]);
  });

  it('returns undefined for anything else rather than guessing', () => {
    expect(parseHexColor('white')).toBeUndefined();
    expect(parseHexColor('rgb(0, 0, 0)')).toBeUndefined();
    expect(parseHexColor('#12345')).toBeUndefined();
    expect(parseHexColor('#gggggg')).toBeUndefined();
    expect(parseHexColor('')).toBeUndefined();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
  });

  it('weights the three channels the way WCAG does', () => {
    expect(relativeLuminance('#ff0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#00ff00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000ff')).toBeCloseTo(0.0722, 4);
  });

  it('uses the linear segment of the transfer curve for very dark channels', () => {
    // 10/255 = 0.0392, just below WCAG's 0.03928 threshold, so this goes through the /12.92 branch.
    expect(relativeLuminance('#0a0a0a')).toBeCloseTo(0.0392 / 12.92, 5);
  });

  it('throws for a value it cannot read, rather than returning a plausible number', () => {
    expect(() => relativeLuminance('cornflowerblue')).toThrow(RangeError);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black against white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
  });

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio('#345fdf', '#345fdf')).toBeCloseTo(1, 10);
  });

  it('is symmetric in its arguments', () => {
    expect(contrastRatio('#5f686d', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#5f686d'),
      10,
    );
  });

  it('agrees with the known 4.5:1 boundary case', () => {
    // #767676 on white is the canonical "exactly passes AA" grey; #777777 is the canonical near
    // miss. Both are quoted throughout WCAG's own contrast guidance.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });
});

describe('apcaContrast', () => {
  it('matches the two figures the APCA documentation states for the extremes', () => {
    // Lc 106 for black on white and Lc -107.9 for white on black are quoted throughout APCA's own
    // material, and are the standard way to confirm an implementation of it. Getting these right
    // means the exponents, the 1.14 scale and the 0.027 offset are all in the right places.
    expect(apcaContrast('#000000', '#ffffff')).toBeCloseTo(106.04, 1);
    expect(apcaContrast('#ffffff', '#000000')).toBeCloseTo(-107.88, 1);
  });

  it('signs the result by polarity, so the two directions are distinguishable', () => {
    expect(apcaContrast(PARTICIPANT_LABEL_INK, '#ffe08a')).toBeGreaterThan(0);
    expect(apcaContrast(PARTICIPANT_LABEL_PAPER, '#015a1e')).toBeLessThan(0);
  });

  it('is 0 for a pair too close together to rank, rather than a small number', () => {
    expect(apcaContrast('#345fdf', '#345fdf')).toBe(0);
    expect(apcaContrast('#345fdf', '#345fe0')).toBe(0);
  });

  it('is not symmetric in its arguments, which is the property contrastRatio lacks', () => {
    // The whole reason this metric is here. Swapping text and background changes the answer,
    // because which one is lighter changes which exponent pair applies.
    expect(Math.abs(apcaContrast('#000000', '#ffffff'))).not.toBeCloseTo(
      Math.abs(apcaContrast('#ffffff', '#000000')),
      1,
    );
  });

  it('disagrees with WCAG about polarity across a whole band of mid-toned greys', () => {
    // The documented weakness that made WCAG the wrong metric for the label decision. On a neutral
    // ramp the two metrics cross over from preferring paper to preferring ink at different points
    // -- WCAG at #808080, APCA not until #a6a6a6 -- so for every grey between them WCAG says ink
    // where APCA says paper. #999999 sits in that band.
    //
    // Pinned so that a later "simplification" back to contrastRatio fails a test that says why.
    expect(contrastRatio(PARTICIPANT_LABEL_INK, '#999999')).toBeGreaterThan(
      contrastRatio(PARTICIPANT_LABEL_PAPER, '#999999'),
    );
    expect(Math.abs(apcaContrast(PARTICIPANT_LABEL_PAPER, '#999999'))).toBeGreaterThan(
      Math.abs(apcaContrast(PARTICIPANT_LABEL_INK, '#999999')),
    );
    expect(participantLabelTextColor('#999999')).toBe(PARTICIPANT_LABEL_PAPER);
  });

  it('puts its own crossover where APCA does, not where WCAG does', () => {
    // The exact boundary, to one step either side. Pinning it catches a sign error or a swapped
    // exponent pair, which a ranking assertion on a single colour would not.
    expect(participantLabelTextColor('#a6a6a6')).toBe(PARTICIPANT_LABEL_PAPER);
    expect(participantLabelTextColor('#a7a7a7')).toBe(PARTICIPANT_LABEL_INK);
    // WCAG's crossover, well inside APCA's paper region, so both of these stay paper.
    expect(participantLabelTextColor('#808080')).toBe(PARTICIPANT_LABEL_PAPER);
    expect(participantLabelTextColor('#818181')).toBe(PARTICIPANT_LABEL_PAPER);
  });

  it('throws for a value it cannot read, as relativeLuminance does', () => {
    expect(() => apcaContrast('cornflowerblue', '#ffffff')).toThrow(RangeError);
    expect(() => apcaContrast('#ffffff', 'rebeccapurple')).toThrow(RangeError);
  });
});

describe('participantLabelTextColor', () => {
  it('chooses paper for a dark colour and ink for a genuinely pale one', () => {
    expect(participantLabelTextColor('#015a1e')).toBe(PARTICIPANT_LABEL_PAPER);
    expect(participantLabelTextColor('#ffe08a')).toBe(PARTICIPANT_LABEL_INK);
  });

  it('keeps paper on the mid-toned colours WCAG would have given ink', () => {
    // The three palette entries this decision was changed for. Asserted by name because this is
    // the behaviour change itself, not a derived property: under contrastRatio all three resolved
    // to ink, and the point of the switch to APCA was that white reads better on them.
    for (const color of ['#be865b', '#10a2a0', '#af79e2']) {
      expect(contrastRatio(PARTICIPANT_LABEL_INK, color)).toBeGreaterThan(
        contrastRatio(PARTICIPANT_LABEL_PAPER, color),
      );
      expect(participantLabelTextColor(color)).toBe(PARTICIPANT_LABEL_PAPER);
    }
  });

  it('always chooses whichever of the two actually reads better by APCA', () => {
    for (const color of ['#000000', '#ffffff', '#b85162', '#be865b', '#af79e2', '#9e0067']) {
      const chosen = participantLabelTextColor(color);
      const other =
        chosen === PARTICIPANT_LABEL_PAPER ? PARTICIPANT_LABEL_INK : PARTICIPANT_LABEL_PAPER;
      expect(Math.abs(apcaContrast(chosen, color))).toBeGreaterThanOrEqual(
        Math.abs(apcaContrast(other, color)),
      );
    }
  });

  it('falls back to paper for an unreadable value instead of throwing inside a decoration', () => {
    expect(participantLabelTextColor('not a colour')).toBe(PARTICIPANT_LABEL_PAPER);
  });

  it('clears the Lc floor for the client-side fallback colour, which is not a palette entry', () => {
    // `presence.ts`'s FALLBACK_COLOR, used when a peer's sanitized `user.color` has not arrived
    // yet. It is not a palette entry, so `participantPalette.test.ts` does not cover it. This one
    // happens to clear WCAG's 4.5:1 as well, so both are asserted -- unlike the three mid-toned
    // palette colours, there is no trade-off being made here.
    const fallback = '#6b7280';
    const text = participantLabelTextColor(fallback);
    expect(Math.abs(apcaContrast(text, fallback))).toBeGreaterThanOrEqual(
      PARTICIPANT_LABEL_MINIMUM_LC,
    );
    expect(contrastRatio(text, fallback)).toBeGreaterThanOrEqual(4.5);
  });
});
