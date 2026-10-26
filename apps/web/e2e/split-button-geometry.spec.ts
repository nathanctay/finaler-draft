import { expect, test, type Page } from '@playwright/test';

/**
 * Task 3 of the FDX-import slice (`progress/fdx-import.md`): the split-button control
 * (`CreateScreenplaySplitButton.tsx`) that replaced the standalone "Import FDX…" button. Its
 * arrow opens a menu that must sit *directly below* the whole control and must never overlap it.
 *
 * Why a real browser and not a unit test: jsdom performs no layout at all, so a dropdown
 * positioned by CSS (`position: absolute`, `top`, cascade-resolved against whichever ancestor
 * ends up positioned) renders with every box at `{0, 0, 0, 0}` in jsdom regardless of whether the
 * CSS is right -- a unit test asserting the `className` or even the raw `top` *declaration* would
 * pass whether the menu ends up below the button or on top of it. `text-contrast.spec.ts`
 * recorded the identical reasoning for computed colors; this is the same argument applied to
 * geometry. **This is not hypothetical**: the sibling branch changing `OverflowMenu.tsx` shipped
 * exactly this defect -- a flyout submenu rendering on top of its own parent menu, caught only by
 * the owner looking at it, because a broader selector elsewhere in `styles.css` outranked the
 * flyout's own single-class rule. Asserting a *relationship between measured boxes* (not a
 * computed `left`/`top` string, which can be present and still lose the cascade) is what catches
 * that class of bug.
 *
 * Follows `text-contrast.spec.ts`'s harness exactly: navigate to an already-served route so the
 * real, built stylesheet applies, then inject the exact markup the component renders (same
 * classes: `.split-button`, `.split-button-primary`, `.split-button-divider`, `.split-button-
 * arrow`, `.split-button-menu`) rather than driving the authenticated project page -- the
 * geometry is a property of the shipped CSS alone, not of any particular project's data, so no
 * database is required and this spec runs under the ordinary `playwright.config.ts`.
 */
async function measureSplitButtonGeometry(page: Page): Promise<{
  button: { top: number; bottom: number; left: number; right: number };
  menu: { top: number; bottom: number; left: number; right: number };
}> {
  return page.evaluate(() => {
    document.body.innerHTML = '';
    const host = document.createElement('main');
    host.className = 'project-screen';
    // Offsets the control away from the page origin -- `.project-list`'s own real `margin: 64px
    // auto` already does this on the live page, but this fixture skips that wrapper, so it is
    // reproduced directly. Without this, a correctly-anchored menu and one mis-anchored against
    // the viewport (the other common shape of this defect -- `position: absolute` resolving
    // against the initial containing block because no ancestor is actually positioned) would
    // coincidentally land at the same `left: 0`, which is exactly the false pass the second test
    // below exists to rule out.
    host.style.paddingLeft = '120px';
    host.style.paddingTop = '80px';
    host.innerHTML =
      '<form class="create-row">' +
      '<div class="split-button">' +
      '<button class="primary-button split-button-primary" type="submit">New screenplay</button>' +
      '<span aria-hidden="true" class="split-button-divider"></span>' +
      '<button aria-expanded="true" aria-haspopup="menu" aria-label="Import a screenplay" ' +
      'class="primary-button split-button-arrow" type="button">▾</button>' +
      '<div class="split-button-menu" role="menu">' +
      '<button role="menuitem" type="button">Import FDX…</button>' +
      '</div>' +
      '</div>' +
      '</form>';
    document.body.append(host);

    const buttonUnit = host.querySelector('.split-button');
    const menu = host.querySelector('.split-button-menu');
    if (!(buttonUnit instanceof HTMLElement) || !(menu instanceof HTMLElement)) {
      throw new Error('Fixture is missing .split-button or .split-button-menu.');
    }
    const buttonBox = buttonUnit.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    return {
      button: {
        top: buttonBox.top,
        bottom: buttonBox.bottom,
        left: buttonBox.left,
        right: buttonBox.right,
      },
      menu: { top: menuBox.top, bottom: menuBox.bottom, left: menuBox.left, right: menuBox.right },
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/sign-in');
});

test('the import menu sits below the split button and never overlaps it', async ({ page }) => {
  const { button, menu } = await measureSplitButtonGeometry(page);

  // The core defect this spec exists to catch: a menu rendering on top of its own button. Any
  // vertical overlap at all -- not merely "mostly below" -- fails this.
  expect(menu.top).toBeGreaterThanOrEqual(button.bottom);

  // "Directly below," not merely "somewhere further down the page": the gap between the button's
  // own bottom edge and the menu's top edge is small, matching `.overflow-menu-list`'s own
  // `calc(100% + 4px)` convention for the identical relationship elsewhere in this app.
  expect(menu.top - button.bottom).toBeLessThanOrEqual(16);

  // Anchored under the control, not floating off to one side or past it entirely: the menu's
  // horizontal span overlaps the button's.
  expect(menu.left).toBeLessThan(button.right);
  expect(menu.right).toBeGreaterThan(button.left);
});

test('the import menu is anchored to the split button itself, not to the page', async ({
  page,
}) => {
  // The other common shape of this defect: `position: absolute` with no positioned ancestor (or
  // one that stopped being positioned) resolves against the initial containing block instead of
  // the button. The first test above cannot distinguish that from a correct anchor by itself --
  // comparing only `menu.top` to `button.bottom` and `menu.left` to `button.right`/`.left` could
  // pass "by coincidence" if a mis-anchored menu happened to land in roughly the right place. The
  // fixture offsets the whole control well away from the page origin (`paddingLeft`/`paddingTop`
  // above) specifically so a menu anchored to the *viewport* instead of the button would land
  // somewhere else entirely -- near `(0, 0)` -- and this test would catch that divergence even if
  // it coincidentally still cleared the first test's looser relationship checks.
  const { button, menu } = await measureSplitButtonGeometry(page);
  expect(Math.abs(menu.left - button.left)).toBeLessThanOrEqual(1);
});
