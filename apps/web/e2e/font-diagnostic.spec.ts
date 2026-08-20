import { expect, test } from '@playwright/test';

/**
 * TEMPORARY DIAGNOSTIC -- delete once the CI font finding is resolved. Asserts nothing about the
 * application, so it cannot turn CI red on its own.
 *
 * Round one established that Courier Prime loads correctly on the runner but renders 60 characters
 * at exactly 600px (10.0px per character) instead of 575.6px (9.59px per character), while generic
 * `monospace` on the same runner measures a fractional 577.97px. Exactly 10.0px per character is
 * 9.6px rounded up to a whole pixel, which points at glyph advances being snapped to integers --
 * Chrome disables subpixel text positioning on Linux at 1x device scale.
 *
 * Round two tests that directly. If the mechanism is integer rounding of advances, then:
 *  - raising deviceScaleFactor should restore fractional advances, and
 *  - the relative error should shrink as font size grows, because a fixed sub-pixel rounding error
 *    is a smaller fraction of a larger advance.
 * Both are recorded below at several scales and sizes.
 */
const SIXTY = 'X'.repeat(60);

function measureScript(): string {
  return `(() => {
    function widthOf(family, sizeCss, text) {
      const span = document.createElement('span');
      span.style.position = 'absolute';
      span.style.visibility = 'hidden';
      span.style.whiteSpace = 'pre';
      span.style.fontFamily = family;
      span.style.fontSize = sizeCss;
      span.textContent = text;
      document.body.appendChild(span);
      const width = span.getBoundingClientRect().width;
      document.body.removeChild(span);
      return width;
    }
    const sixty = 'X'.repeat(60);
    const sizes = ['12pt', '24pt', '48pt', '96pt'];
    const bySize = {};
    for (const size of sizes) {
      const courier = widthOf("'Courier Prime', monospace", size, sixty);
      bySize[size] = {
        courierPerChar: courier / 60,
        courierTotal: courier,
        monospaceTotal: widthOf('monospace', size, sixty),
      };
    }
    return { bySize, dpr: window.devicePixelRatio };
  })()`;
}

test('diagnostic: advance rounding across device scale factors and font sizes', async ({
  browser,
}) => {
  const results: Record<string, unknown> = {};

  for (const deviceScaleFactor of [1, 2, 3]) {
    const context = await browser.newContext({ deviceScaleFactor });
    const page = await context.newPage();
    await page.goto('/');
    await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load("16px 'Courier Prime'"),
        document.fonts.load("700 16px 'Courier Prime'"),
      ]);
      await document.fonts.ready;
    });
    results[`deviceScaleFactor=${deviceScaleFactor}`] = await page.evaluate(measureScript());
    await context.close();
  }

  console.log('FONT DIAGNOSTIC ROUND TWO');
  console.log(JSON.stringify(results, undefined, 2));

  // Nominal Courier Prime advance is 0.6em. At 12pt (a 16px em) that is 9.6px per character.
  console.log('Expected per-character advance at 12pt: 9.6px (0.6em of a 16px em box)');
  expect(SIXTY).toHaveLength(60);
});
