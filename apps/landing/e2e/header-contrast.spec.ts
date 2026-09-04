import { test, expect } from '@playwright/test';

/**
 * The header/skip-link bar (`--surface-chrome` background, `--text-on-chrome` text, and --
 * because `.button-ghost`'s border is `border-color: currentColor` -- the "Open app" button's
 * border too) shipped once with `--text-on-chrome` redefined to the exact same value as
 * `--surface-chrome` inside the `prefers-color-scheme: dark` block, painting the header's text
 * (and that button's border) in the header's own background colour: invisible, in dark mode only.
 *
 * jsdom has no computed styles worth trusting -- a unit/render test asserting a class name or
 * even the raw CSS custom-property *source* would have passed while this defect shipped, because
 * the bug was in what two properties independently *resolve to*, not in any class or attribute.
 * Only a real browser, with the real stylesheet, sees this. `apps/web/e2e/app-shell.spec.ts`
 * already established this exact pattern for the sibling app (its "not-saving dot", "disabled
 * button", and "read-only banner" tests all exist for the identical reason); this is the same
 * pattern applied to this app's one real instance of the class of bug.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test('the header text renders in a colour visibly different from the header background', async ({
      page,
    }) => {
      await page.goto('/');

      const colours = await page.evaluate(() => {
        const header = document.querySelector('.site-header');
        if (!header) throw new Error('Missing .site-header.');
        const style = getComputedStyle(header);
        return { background: style.backgroundColor, text: style.color };
      });

      expect(colours.text).not.toBe(colours.background);
    });

    test('the "Open app" button\'s border is not painted in the header background colour', async ({
      page,
    }) => {
      await page.goto('/');

      const colours = await page.evaluate(() => {
        const header = document.querySelector('.site-header');
        const button = document.querySelector('.site-header .button-ghost');
        if (!header || !button) throw new Error('Missing .site-header or its .button-ghost.');
        return {
          headerBackground: getComputedStyle(header).backgroundColor,
          buttonBorder: getComputedStyle(button).borderTopColor,
        };
      });

      // .button-ghost's border-color is `currentColor` -- it inherits whatever `color` the fix
      // above resolves to, so this is the exact seam a correct header-text fix could still leave
      // broken if only the header's own `color` were checked and this second consumer were not.
      expect(colours.buttonBorder).not.toBe(colours.headerBackground);
    });
  });
}
