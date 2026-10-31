import { expect, test, type Page } from '@playwright/test';

/**
 * The editor's and the revision-diff view's own brand (`applicationShell.tsx`'s `.brand-wipe`):
 * the owner's own words, "when you hover over the logo, lets have it wipe from the logo to
 * 'return to project'" -- and specifically a *wipe*, not the fade `title-rename-appearance.spec.ts`'s
 * own sibling defects warn against assuming is equivalent.
 *
 * jsdom runs no layout and resolves no CSS transition at all, so none of what this file measures
 * -- that the two panels are actually stacked rather than both visible at once, that hovering (or
 * focusing) moves one out and the other in rather than cross-fading their opacity, and that
 * `prefers-reduced-motion` actually removes the transition -- is something a unit test could
 * prove. `applicationShell.test.tsx`'s own brand-wipe suite covers the DOM/accessible-name
 * contract (both panels are real content; the name never depends on which is showing); this file
 * covers what only a real browser's computed styles and `:hover`/`:focus-visible` can.
 *
 * Written before `.brand-wipe` existed in styles.css, and run against that absence to confirm it
 * failed, matching `title-rename-appearance.spec.ts`/`submenu-position.spec.ts`'s own discipline
 * -- see `progress/app-bar-navigation.md`'s mutation table for exactly what removing which rule
 * does to which assertion here.
 */

const BRAND_MARKUP = `
<header class="titlebar">
  <a aria-label="Finaler Draft — Return to project" class="brand brand-wipe" href="/projects/project-1" id="brand">
    <span class="brand-face" id="face">
      <span class="brand-mark">F</span>
      <span>Finaler Draft</span>
    </span>
    <span class="brand-wipe-label" id="label">Return to project</span>
  </a>
</header>`;

async function openFixture(page: Page, reducedMotion = false): Promise<void> {
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/sign-in');
  await page.evaluate((markup) => {
    document.body.innerHTML = markup;
  }, BRAND_MARKUP);
}

function translateX(transform: string): number {
  // `getComputedStyle(...).transform` resolves to a `matrix(...)` string, never the authored
  // `translateX(...)`, once any transform is applied -- the 5th of the six values is the X
  // translation (https://developer.mozilla.org/docs/Web/CSS/transform-function/matrix).
  if (transform === 'none') return 0;
  const match = /matrix\(([^)]+)\)/u.exec(transform);
  if (!match) throw new Error(`Not a matrix() transform: ${transform}`);
  const values = match[1]!.split(',').map((value) => Number.parseFloat(value.trim()));
  return values[4]!;
}

test('at rest, only the logo is in view -- the label sits fully outside the brand’s own box', async ({
  page,
}) => {
  await openFixture(page);
  const brandWidth = await page
    .locator('#brand')
    .evaluate((el) => el.getBoundingClientRect().width);
  const labelTransform = await page
    .locator('#label')
    .evaluate((el) => getComputedStyle(el).transform);
  // A positive translation of (at least) the box's own width pushes the label's left edge to, or
  // past, the box's right edge -- genuinely offscreen within the wipe's own clipped container,
  // not merely "somewhere to the right".
  expect(translateX(labelTransform)).toBeGreaterThanOrEqual(brandWidth - 1);
});

test('hovering slides the logo out and the label in -- a wipe, not a fade', async ({ page }) => {
  await openFixture(page);
  const before = {
    faceOpacity: await page.locator('#face').evaluate((el) => getComputedStyle(el).opacity),
    faceX: await page.locator('#face').evaluate((el) => getComputedStyle(el).transform),
    labelX: await page.locator('#label').evaluate((el) => getComputedStyle(el).transform),
  };

  await page.locator('#brand').hover();
  // The transition has a duration; wait for it to settle rather than racing it.
  await page.waitForTimeout(300);

  const after = {
    faceOpacity: await page.locator('#face').evaluate((el) => getComputedStyle(el).opacity),
    faceX: await page.locator('#face').evaluate((el) => getComputedStyle(el).transform),
    labelX: await page.locator('#label').evaluate((el) => getComputedStyle(el).transform),
  };

  // Positional movement happened on both panels -- the signature of a wipe (one slides out as the
  // other slides in), not of a fade (which would move neither and only change opacity instead).
  expect(translateX(after.faceX)).not.toBeCloseTo(translateX(before.faceX), 0);
  expect(translateX(after.labelX)).not.toBeCloseTo(translateX(before.labelX), 0);

  // And specifically not a fade: opacity is untouched by this transition in either state. A
  // regression that replaced the slide with `opacity` would still move nothing above, which is
  // exactly why this is asserted too, not left implied by the position checks alone.
  expect(after.faceOpacity).toBe(before.faceOpacity);

  // The label has fully taken the logo's place: its translation is at (or past) zero, the box's
  // own resting position, rather than merely having moved partway.
  expect(translateX(after.labelX)).toBeLessThanOrEqual(0.5);
  // And the face has been pushed out by (at least) its own width -- genuinely swapped, not just
  // nudged.
  const brandWidth = await page
    .locator('#brand')
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.abs(translateX(after.faceX))).toBeGreaterThanOrEqual(brandWidth - 1);
});

test('keyboard focus wipes the same way hover does, with no pointer involved', async ({ page }) => {
  await openFixture(page);
  await page.locator('#brand').focus();
  await page.waitForTimeout(300);

  const labelX = await page.locator('#label').evaluate((el) => getComputedStyle(el).transform);
  expect(translateX(labelX)).toBeLessThanOrEqual(0.5);
});

test('the accessible name states the destination before any hover or focus, unchanged by either', async ({
  page,
}) => {
  await openFixture(page);
  const nameAtRest = await page.locator('#brand').evaluate((el) => el.getAttribute('aria-label'));
  await page.locator('#brand').hover();
  await page.waitForTimeout(300);
  const nameOnHover = await page.locator('#brand').evaluate((el) => el.getAttribute('aria-label'));

  expect(nameAtRest).toBe('Finaler Draft — Return to project');
  expect(nameOnHover).toBe(nameAtRest);
});

test('prefers-reduced-motion removes the transition entirely, while the label still swaps', async ({
  page,
}) => {
  await openFixture(page, true);
  const transitionAtRest = await page
    .locator('#label')
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  // `transition: none` resolves computed `transition-duration` to `0s` -- the browser's own
  // signal that no animation will run, rather than this test racing a real one to prove its
  // absence.
  expect(transitionAtRest).toBe('0s');

  await page.locator('#brand').hover();
  const labelX = await page.locator('#label').evaluate((el) => getComputedStyle(el).transform);
  // The functional swap still happens -- reduced motion removes the *transition*, not the
  // control's actual behaviour.
  expect(translateX(labelX)).toBeLessThanOrEqual(0.5);
});
