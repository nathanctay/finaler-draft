import { expect, test } from '@playwright/test';

/**
 * TEMPORARY DIAGNOSTIC -- not part of the suite's contract, and must be deleted once the CI font
 * failure is understood. It asserts nothing about the application; it only reports what the
 * browser actually did, because `page-geometry.spec.ts` fails on the CI runner with a 0.25in
 * deviation across a 60-character measure (a substituted typeface) while passing locally, and
 * `requireCourierPrime`'s `document.fonts.check` guard reports the font as loaded in both places.
 *
 * Everything here is logged rather than asserted, so this file cannot itself turn CI red and
 * cannot mask the real failures alongside it.
 */
test('diagnostic: report what the runner actually renders', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load("16px 'Courier Prime'"),
      document.fonts.load("700 16px 'Courier Prime'"),
    ]);
  });

  const report = await page.evaluate(async () => {
    function widthOf(family: string, text: string): number {
      const span = document.createElement('span');
      span.style.position = 'absolute';
      span.style.visibility = 'hidden';
      span.style.whiteSpace = 'pre';
      span.style.fontFamily = family;
      span.style.fontSize = '12pt';
      span.textContent = text;
      document.body.appendChild(span);
      const width = span.getBoundingClientRect().width;
      document.body.removeChild(span);
      return width;
    }

    const sixty = 'X'.repeat(60);
    const faces = Array.from(document.fonts).map((face) => ({
      family: face.family,
      status: face.status,
      weight: face.weight,
    }));

    // Whether the stylesheet's own @font-face URL is actually fetchable from this origin. A 404
    // or a wrong content type here would explain a silent fallback completely.
    const fontUrls = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules);
        } catch {
          return [];
        }
      })
      .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule)
      .map((rule) => rule.style.getPropertyValue('src'))
      .filter((src) => src.includes('courier'));

    const probes: Record<string, number> = {};
    for (const family of [
      "'Courier Prime', monospace",
      "'Courier Prime'",
      'monospace',
      "'DejaVu Sans Mono'",
      "'Liberation Mono'",
      "'Courier New'",
      "'NoSuchFontExistsAnywhere', monospace",
    ]) {
      probes[family] = widthOf(family, sixty);
    }

    return {
      checkCourierPrime: document.fonts.check("16px 'Courier Prime'"),
      faces,
      fontFaceSrcMentioningCourier: fontUrls,
      fontsReadyStatus: document.fonts.status,
      probeWidthsPxFor60Chars: probes,
      userAgent: navigator.userAgent,
    };
  });

  // Fetched through the page's own origin, so this reports exactly what the running server serves.
  const cssProbe = await page.evaluate(async () => {
    const link = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(
      (el) => (el as HTMLLinkElement).href,
    );
    const results: { url: string; status: number; type: string | null }[] = [];
    for (const url of link) {
      try {
        const response = await fetch(url);
        results.push({
          status: response.status,
          type: response.headers.get('content-type'),
          url,
        });
      } catch (error) {
        results.push({ status: -1, type: String(error), url });
      }
    }
    return results;
  });

  console.log('FONT DIAGNOSTIC REPORT');
  console.log(JSON.stringify({ ...report, stylesheets: cssProbe }, undefined, 2));

  const sixtyCharInches = (report.probeWidthsPxFor60Chars["'Courier Prime', monospace"] ?? 0) / 96;
  console.log(`60 chars measured: ${sixtyCharInches.toFixed(4)}in (nominal 6.0in)`);

  // Deliberately not an assertion about the app: this only fails if the page never rendered.
  expect(report.userAgent.length).toBeGreaterThan(0);
});
