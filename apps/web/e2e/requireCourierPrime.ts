import type { Page } from '@playwright/test';
import { MEASURED_COURIER_PRIME_ADVANCE_EM } from '@finaler-draft/screenplay/pageFormat';

/**
 * The rendered advance may differ from Courier Prime's own by this much before the guard treats
 * the page as rendering some other typeface. It is deliberately far tighter than the suites'
 * inch-level tolerances, because the two fonts this must separate are very close: on macOS the
 * generic `monospace` fallback renders sixty characters at 576.09px against Courier Prime's
 * 575.63px, an advance difference of 4.9e-4 em. Anything looser than that and the guard cannot
 * tell them apart at all.
 */
const ADVANCE_TOLERANCE_EM = 1e-4;

/**
 * Forces Courier Prime to load and confirms the page is *actually rendering it*, by measuring a
 * glyph advance rather than asking `document.fonts`.
 *
 * The obvious implementation -- `document.fonts.load()` then `document.fonts.check()` -- was what
 * this guard used, and it does not work. On the Linux CI runner `check()` returned `true`, the
 * `FontFace` entries reported `status: "loaded"`, and the page still rendered sixty characters at
 * 600px instead of 575.63px, because the runner's font hinting rounded each 9.6px advance to a
 * whole 10px. Every character-grid assertion downstream failed while the guard meant to catch
 * exactly that reported success. (The hinting itself is fixed in both Playwright configs; this
 * guard exists so the *next* cause of a wrong typeface fails here, loudly, instead of as a
 * scatter of unexplained geometry failures.)
 *
 * `document.fonts` answers "is a face with this family name available", which is not the question
 * the geometry suites need. The question is "do glyphs on this page advance at Courier Prime's
 * pitch", and the only way to answer that is to render some and measure. That also closes a hole
 * local runs never could: on macOS the fallback measures within half a pixel of the real font
 * across sixty characters, so a failure to load the webfont at all would have passed silently.
 *
 * A failure throws here, in the fixture, naming the measured advance, so the cause is legible
 * rather than inferred from a page of failed inch assertions.
 */
export async function requireCourierPrime(page: Page): Promise<void> {
  const measuredAdvanceEm = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load("16px 'Courier Prime'"),
      document.fonts.load("700 16px 'Courier Prime'"),
    ]);

    const span = document.createElement('span');
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    span.style.whiteSpace = 'pre';
    span.style.fontFamily = "'Courier Prime', monospace";
    // 12pt is a 16px em, the size the manuscript actually renders at, so the ratio below is
    // directly comparable to the typeface's own advance without scaling anything.
    span.style.fontSize = '12pt';
    span.textContent = 'X'.repeat(60);
    document.body.appendChild(span);
    const width = span.getBoundingClientRect().width;
    document.body.removeChild(span);

    return width / 60 / 16;
  });

  const deviation = Math.abs(measuredAdvanceEm - MEASURED_COURIER_PRIME_ADVANCE_EM);
  if (deviation > ADVANCE_TOLERANCE_EM) {
    throw new Error(
      `This page is not rendering Courier Prime. Measured a glyph advance of ${measuredAdvanceEm} em; ` +
        `Courier Prime's is ${MEASURED_COURIER_PRIME_ADVANCE_EM} em (deviation ${deviation}, ` +
        `tolerance ${ADVANCE_TOLERANCE_EM}). Every measurement in this suite would be against the ` +
        'wrong typeface. Two known causes: the webfont failing to load, leaving the fallback in ' +
        'the font-family stack; and font hinting rounding glyph advances to whole pixels, which ' +
        'both Playwright configs disable with --font-render-hinting=none.',
    );
  }
}
