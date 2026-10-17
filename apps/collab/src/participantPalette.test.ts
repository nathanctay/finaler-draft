/**
 * The regression guard on `PARTICIPANT_COLOR_PALETTE` (presence.ts). Every assertion here
 * *computes* the property it is checking from the palette's own values; none of them names a hex
 * colour, and none of them can be satisfied by updating an expected string.
 *
 * That shape is deliberate, and it is the same reasoning `progress/screenplay-diff.md` records for
 * the diff marks' hue-dominance assertion: a test that pins colours proves nothing about contrast.
 * The palette this replaced was itself chosen to be "accessible" (its own comment said so) and
 * failed four separate measurable properties -- a hex-pinning test would have been green for all of
 * them, and would have stayed green while the next person retuned it.
 *
 * What the four properties are, and what the palette this replaced measured:
 *
 * | property                                  | floor | old worst           | new worst           |
 * | ----------------------------------------- | ----- | ------------------- | ------------------- |
 * | caret vs the white sheet (WCAG 1.4.11)    | 3:1   | 2.94 (amber)        | 3.11 (orange)       |
 * | label text vs the colour (APCA Lc)        | 60    | 42.4 (teal)         | 63.3 (teal)         |
 * | distance from the manuscript's own ink     | dE 25 | 30.2 (violet)       | 30.1 (blue)         |
 * | mutual distance under all three CVD types | dE 10 | 0.59 (blue/violet,  | 12.98 (rose/amber,  |
 * |                                           |       | deuteranopia)       | tritanopia)         |
 *
 * The third row was never a defect of the old palette, and is the only one of the four that is not
 * an improvement: it is a constraint on the *replacement*, because the obvious way to satisfy the
 * first two together is to make every colour near-black, and a near-black caret is legible but
 * indistinguishable from the writer's own.
 *
 * `apps/web/e2e/text-contrast.spec.ts` is the other half of this pass's guard, covering the fixed
 * colours in the stylesheet; this file covers the per-participant ones, which never appear in CSS
 * at all.
 */
import { describe, expect, it } from 'vitest';
import {
  PARTICIPANT_LABEL_INK,
  PARTICIPANT_LABEL_MINIMUM_LC,
  PARTICIPANT_LABEL_PAPER,
  apcaContrast,
  contrastRatio,
  participantLabelTextColor,
} from '@finaler-draft/screenplay-editor';
import { PARTICIPANT_COLOR_PALETTE } from './presence.js';
import { VISION_TYPES, colorDifference, simulate } from './test/colorVision.js';

/** WCAG 1.4.11, non-text contrast: the remote caret is a 2px painted stripe, not a glyph. */
const CARET_MINIMUM_RATIO = 3;

/**
 * The floor the chosen label text colour has to clear on every palette entry, as |APCA Lc|.
 *
 * This row used to be WCAG 1.4.3's 4.5:1. It is APCA now because the *choice* of label colour is
 * made by APCA (contrast.ts explains why at length: WCAG's ratio mis-ranks paper against ink on
 * mid-toned saturated colours, and put dark ink on three of these eight where white plainly reads
 * better). A floor measured in a metric other than the one the decision is made in would be a
 * guard against the wrong thing.
 *
 * What that trade cost, stated plainly so it is not mistaken later for an oversight: with paper on
 * all eight, orange, teal and violet measure 3.11-3.16:1, below 4.5:1, so those three labels do
 * not meet WCAG 1.4.3 at normal text size. That was a deliberate decision to favour the metric
 * that predicts legibility over the one that is the formal standard. Note also that APCA does not
 * certify them either -- at 10px/600 and 9px/700 its font tables want an Lc far above the 63 these
 * reach -- so the honest summary is that the label is small, both metrics know it, and of the two
 * colours available the more legible one is now the one used. Raising the font size is the real
 * remedy and has not been done.
 */
const LABEL_TEXT_MINIMUM_LC = PARTICIPANT_LABEL_MINIMUM_LC;

/** How far every participant colour must stay from the manuscript's own ink, so that a remote caret
 * can never read as the writer's own. Not a WCAG figure -- there is no success criterion for "this
 * cursor belongs to someone else" -- but it is the constraint that rules out satisfying the two
 * above by making every colour near-black, which is the easy and wrong answer. */
const INK_DISTANCE_MINIMUM = 25;

/** How far apart any two participant colours must stay, under normal vision and under each of the
 * three dichromacies. Well above the ~2.3 dE2000 just-noticeable difference, and well below the
 * 12.98 the palette actually achieves, so this is a floor that catches a collapse rather than an
 * equality that pins a palette. */
const MUTUAL_DISTANCE_MINIMUM = 10;

/** The sheet is white under both themes: `styles.css` gives `.page` and `.title-page`
 * `background-color: white` and `.dark` redefines neither. Imported rather than restated, so the
 * one place this colour is written down is the one the painters read. */
const SHEET = PARTICIPANT_LABEL_PAPER;

describe('the participant colour palette', () => {
  it('has one entry per slot that deriveParticipantColor can index', () => {
    expect(PARTICIPANT_COLOR_PALETTE.length).toBeGreaterThan(0);
    expect(new Set(PARTICIPANT_COLOR_PALETTE).size).toBe(PARTICIPANT_COLOR_PALETTE.length);
  });

  it.each(PARTICIPANT_COLOR_PALETTE)(
    'draws a caret on the white sheet that clears WCAG 1.4.11 at %s',
    (color) => {
      expect(contrastRatio(color, SHEET)).toBeGreaterThanOrEqual(CARET_MINIMUM_RATIO);
    },
  );

  it.each(PARTICIPANT_COLOR_PALETTE)(
    'has a name label whose chosen text colour clears the Lc floor at %s',
    (color) => {
      const text = participantLabelTextColor(color);
      expect([PARTICIPANT_LABEL_PAPER, PARTICIPANT_LABEL_INK]).toContain(text);
      expect(Math.abs(apcaContrast(text, color))).toBeGreaterThanOrEqual(LABEL_TEXT_MINIMUM_LC);
    },
  );

  it('is dark enough throughout that every label reads in paper, with none needing ink', () => {
    // Not a restatement of the rule -- a constraint on the palette. Every entry being dark enough
    // for paper-white is what makes the labels uniform, which is the property Nathan was after.
    // Adding a colour pale enough to want ink would make one collaborator's name read dark while
    // the rest read white, and would fail here rather than silently shipping.
    //
    // This does leave `participantLabelTextColor`'s ink branch unexercised *by the palette*; it is
    // covered against explicitly pale colours in `packages/screenplay-editor/src/contrast.test.ts`,
    // which is where that function's own behaviour belongs.
    expect(PARTICIPANT_COLOR_PALETTE.map(participantLabelTextColor)).toEqual(
      PARTICIPANT_COLOR_PALETTE.map(() => PARTICIPANT_LABEL_PAPER),
    );
  });

  it.each(PARTICIPANT_COLOR_PALETTE)(
    'stays visibly distinct from the manuscript ink at %s, so the caret reads as someone else’s',
    (color) => {
      expect(colorDifference(color, PARTICIPANT_LABEL_INK)).toBeGreaterThanOrEqual(
        INK_DISTANCE_MINIMUM,
      );
    },
  );

  it.each(VISION_TYPES)('keeps every pair of colours apart under %s', (vision) => {
    const failures: string[] = [];
    for (let i = 0; i < PARTICIPANT_COLOR_PALETTE.length; i += 1) {
      for (let j = i + 1; j < PARTICIPANT_COLOR_PALETTE.length; j += 1) {
        const first = PARTICIPANT_COLOR_PALETTE[i]!;
        const second = PARTICIPANT_COLOR_PALETTE[j]!;
        const distance = colorDifference(simulate(first, vision), simulate(second, vision));
        if (distance < MUTUAL_DISTANCE_MINIMUM) {
          failures.push(`${first} vs ${second}: dE2000 ${distance.toFixed(2)}`);
        }
      }
    }
    // Reported as a list rather than one failing pair at a time: retuning a palette changes every
    // pair at once, and seeing only the first collision makes the next attempt a guess.
    expect(failures).toEqual([]);
  });
});
