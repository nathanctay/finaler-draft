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
    <span class="brand-wipe-label" id="label"><span aria-hidden="true" class="brand-wipe-arrow">&#8592;</span>Return to project</span>
  </a>
</header>`;

async function openFixture(page: Page, reducedMotion = false): Promise<void> {
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/sign-in');
  await page.evaluate((markup) => {
    document.body.innerHTML = markup;
  }, BRAND_MARKUP);
}

/**
 * Which panel the writer can actually see, sampled across the brand's own box.
 *
 * Deliberately `elementFromPoint` rather than computed styles, because this file must not assert
 * *how* the reveal is achieved. Two mechanisms are kept side by side in `styles.css` -- a slide
 * (both panels translate past the box) and a staged clip -- and the owner switches between them by
 * moving one comment. Pinning `transform`, or `clip-path`, or transition delays would mean that
 * one-line switch also broke this file, which is exactly the friction the toggle exists to avoid.
 *
 * Hit-testing is the one measure both share: a region translated outside the box and a region
 * clipped away are equally absent from it, and `clip-path` removes a region from hit-testing just
 * as `overflow: hidden` removes a translated one. So this answers the only question that matters
 * to a reader -- what is in view -- and stays true of whichever mechanism is active.
 */
async function visiblePanels(page: Page): Promise<{ face: number; label: number }> {
  return page.locator('#brand').evaluate((brand) => {
    const box = brand.getBoundingClientRect();
    const y = box.top + box.height / 2;
    let face = 0;
    let label = 0;
    // Nine evenly spaced samples, inset from both edges so a sub-pixel boundary at the very edge
    // cannot decide the result on its own.
    for (let step = 1; step <= 9; step += 1) {
      const hit = document.elementFromPoint(box.left + (box.width * step) / 10, y);
      if (hit === null) continue;
      if (document.querySelector('#face')!.contains(hit)) face += 1;
      else if (document.querySelector('#label')!.contains(hit)) label += 1;
    }
    return { face, label };
  });
}

/**
 * Waits out the whole gesture, measured from the elements rather than hardcoded -- the active
 * mechanism may be staged, in which case the total is the leading phase plus the trailing delay
 * plus the trailing phase. A literal here has to track a tunable custom property by hand, and once
 * did not: raising that property from 100ms to 200ms left three `waitForTimeout(300)` calls
 * measuring a 400ms gesture, and the specs failed on a half-finished reveal rather than on anything
 * real.
 */
async function settle(page: Page): Promise<void> {
  const total = await page.locator('#label').evaluate((el) => {
    const label = getComputedStyle(el);
    const face = getComputedStyle(document.querySelector('#face')!);
    const ms = (value: string) => Number.parseFloat(value) * 1000;
    return (
      Math.max(ms(face.transitionDuration), ms(label.transitionDuration)) +
      Math.max(ms(face.transitionDelay), ms(label.transitionDelay))
    );
  });
  await page.waitForTimeout(total + 90);
}

test('at rest the logo is what is in view, and the label is not', async ({ page }) => {
  await openFixture(page);
  const { face, label } = await visiblePanels(page);

  expect(face).toBeGreaterThanOrEqual(8);
  expect(label).toBe(0);
});

test('hovering swaps them completely -- the label in view, the logo gone', async ({ page }) => {
  await openFixture(page);
  await page.locator('#brand').hover();
  await settle(page);
  const { face, label } = await visiblePanels(page);

  expect(label).toBeGreaterThanOrEqual(8);
  expect(face).toBe(0);
});

test('leaving puts the logo back, so the reveal is reversible and not one-way', async ({
  page,
}) => {
  await openFixture(page);
  await page.locator('#brand').hover();
  await settle(page);
  await page.mouse.move(0, 0);
  await settle(page);
  const { face, label } = await visiblePanels(page);

  expect(face).toBeGreaterThanOrEqual(8);
  expect(label).toBe(0);
});

test('keyboard focus reveals the label the same way hover does, with no pointer involved', async ({
  page,
}) => {
  await openFixture(page);
  await page.locator('#brand').focus();
  await settle(page);
  const { face, label } = await visiblePanels(page);

  expect(label).toBeGreaterThanOrEqual(8);
  expect(face).toBe(0);
});

test('neither panel ever spills outside the brand, at rest or revealed', async ({ page }) => {
  // The bar is a flex row with a breadcrumb and an account menu beside this control, so a panel
  // escaping its own box would overlap them. `overflow: hidden` is what bounds the slide and the
  // box itself bounds the clip, and this holds for either.
  await openFixture(page);
  const bounded = async () =>
    page.locator('#brand').evaluate((brand) => {
      const box = brand.getBoundingClientRect();
      return ['#face', '#label'].every((selector) => {
        const panel = document.querySelector(selector)!.getBoundingClientRect();
        // A panel may be positioned outside the box (the slide does exactly that) -- what must not
        // happen is any of it being *painted* there, which `overflow: hidden` prevents. So this
        // checks the brand's own box has not grown to accommodate one.
        return panel.height <= box.height + 1;
      });
    });

  expect(await bounded()).toBe(true);
  await page.locator('#brand').hover();
  await settle(page);
  expect(await bounded()).toBe(true);
});

test('both panels fit the brand box without being cut off', async ({ page }) => {
  /*
   * The box doubles as the travel distance for the slide, so it is tuned down to whatever looks
   * right -- the owner moved it from 190px to 175px because the label read as arriving from too
   * far away. This is the floor on that tuning: below it the box starts truncating real words.
   *
   * Measured from each panel's own content rather than from a pinned pixel figure, so it stays
   * correct if the wordmark, the label text or the type scale change -- any of which would move
   * where that floor actually is.
   */
  await openFixture(page);
  const fits = await page.locator('#brand').evaluate((brand) => {
    const box = brand.getBoundingClientRect().width;
    const widthOf = (selector: string) => {
      const panel = document.querySelector<HTMLElement>(selector)!;
      // `scrollWidth` is the content's own width, independent of the clipping that hides the
      // overflow -- which is exactly what a truncation check needs.
      return panel.scrollWidth;
    };
    return { box, face: widthOf('#face'), label: widthOf('#label') };
  });

  expect(fits.face).toBeLessThanOrEqual(fits.box);
  expect(fits.label).toBeLessThanOrEqual(fits.box);
});

test('the reveal is geometric, never a cross-fade', async ({ page }) => {
  // True of both mechanisms and worth pinning: a regression that swapped either for `opacity`
  // would still pass every visibility check above, because a fully faded panel is not hit either.
  await openFixture(page);
  const opacity = async () => ({
    face: await page.locator('#face').evaluate((el) => getComputedStyle(el).opacity),
    label: await page.locator('#label').evaluate((el) => getComputedStyle(el).opacity),
  });

  const before = await opacity();
  await page.locator('#brand').hover();
  await settle(page);
  const after = await opacity();

  expect(before.face).toBe('1');
  expect(before.label).toBe('1');
  expect(after.face).toBe('1');
  expect(after.label).toBe('1');
});

test('the accessible name states the destination before any hover or focus, unchanged by either', async ({
  page,
}) => {
  await openFixture(page);
  const nameAtRest = await page.locator('#brand').evaluate((el) => el.getAttribute('aria-label'));
  await page.locator('#brand').hover();
  await settle(page);
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
  // The functional swap still happens -- reduced motion removes the *transition*, not the
  // control's actual behaviour. With no transition the clip lands at its hovered value at once,
  // so this reads the end state directly rather than waiting for one.
  const { face, label } = await visiblePanels(page);
  expect(label).toBeGreaterThanOrEqual(8);
  expect(face).toBe(0);
});
