import { expect, test } from '@playwright/test';

/**
 * An open menubar menu must stay readable in the dark theme.
 *
 * This exists because of a defect `menubar-menus-position.spec.ts` could not have caught: its
 * markup renders the menubar without the `.dark` ancestor the editor shell actually carries, so
 * every colour it resolves is the light theme's. The dropdown list is one of the surfaces that
 * deliberately stays white in both themes (`styles.css`'s `--text-07-on-white` block), while
 * `.dark .menubar button { color: inherit }` reaches *into* the list -- a dropdown is a descendant
 * of `.menubar` -- and painted its items in the dark bar's near-white `--dark-text-03`. Measured
 * before the fix: `rgb(220, 227, 230)` text on `rgb(255, 255, 255)`.
 *
 * The property asserted is the light-island one rather than a contrast number: an item inside a
 * menu that did not go dark must read in the colour the light theme gives it. That holds whichever
 * greys the palette later moves to, where a hardcoded expected rgb would not.
 */
const MENU_MARKUP = `
  <nav class="menubar" aria-label="Application menu">
    <div class="menubar-menu menu-view">
      <div class="overflow-menu">
        <button class="overflow-menu-trigger" id="trigger" type="button">View</button>
        <div class="overflow-menu-list" id="list" role="menu">
          <button id="item" role="menuitem" type="button">Navigator</button>
          <button disabled id="disabled-item" role="menuitem" type="button">Inspector</button>
        </div>
      </div>
    </div>
  </nav>`;

test('an open menubar menu keeps its light-theme text colours inside the dark shell, where the list itself stays white', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const measured = await page.evaluate((markup) => {
    const probe = (shellClass: string) => {
      document.body.innerHTML = `<div class="application ${shellClass}">${markup}</div>`;
      const colorOf = (id: string) =>
        getComputedStyle(document.querySelector<HTMLElement>(`#${id}`)!).color;
      return {
        bar: getComputedStyle(document.querySelector<HTMLElement>('.menubar')!).backgroundColor,
        disabledItem: colorOf('disabled-item'),
        item: colorOf('item'),
        list: getComputedStyle(document.querySelector<HTMLElement>('#list')!).backgroundColor,
        trigger: colorOf('trigger'),
      };
    };
    return { dark: probe('dark'), light: probe('') };
  }, MENU_MARKUP);

  /*
   * The probe must actually be resolving two different themes, or every equality below passes for
   * the wrong reason -- a `.dark` class that never applied would make the two measurements
   * trivially identical. The menubar's own background and its trigger's text are the two things
   * that are *supposed* to differ between the themes, so they are the proof the switch took hold.
   */
  expect(measured.dark.bar).not.toBe(measured.light.bar);
  expect(measured.dark.trigger).not.toBe(measured.light.trigger);

  // The list is one of the stays-white surfaces, so its background must not have followed the bar.
  expect(measured.dark.list).toBe(measured.light.list);
  expect(measured.dark.list).toBe('rgb(255, 255, 255)');

  // ...and therefore its text must not have either, enabled or disabled.
  expect(measured.dark.item).toBe(measured.light.item);
  expect(measured.dark.disabledItem).toBe(measured.light.disabledItem);

  // A disabled item still has to read as quieter than an enabled one, in both themes.
  expect(measured.dark.disabledItem).not.toBe(measured.dark.item);
});
