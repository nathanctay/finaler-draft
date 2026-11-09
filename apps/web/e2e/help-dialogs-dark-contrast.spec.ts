import { expect, test, type Page } from '@playwright/test';

/**
 * The Help menu's two dialogs (`progress/menus-slice-3.md`) must stay readable in the dark theme,
 * for the identical reason `menubar-menu-dark-contrast.spec.ts` and
 * `word-count-dialog-dark-contrast.spec.ts` already exist: this app has shipped two real defects
 * of exactly this shape because a slice tested markup with no `.dark` ancestor at all, so every
 * colour it resolved was the light theme's. This spec follows `word-count-dialog-dark-contrast
 * .spec.ts`'s own technique precisely -- render each dialog's actual markup wrapped in the real
 * `.application.dark` ancestor `App.tsx` and the diff route both put it inside (`ApplicationShell`
 * 's `outOfFlow` slot, a direct child of `<main class="application dark">`, not a descendant of
 * `.menubar` at all).
 *
 * `.dialog` itself is one of the surfaces that deliberately stays white in both themes
 * (`--surface-01`, never redefined by `.dark`). Every new text rule this slice wrote sets its own
 * colour from a token `.dark` does not redefine (`--text-09`, `--text-13`, `--text-07` via
 * `.muted`) rather than inheriting, so each is expected to read identically in both themes -- the
 * same "stays white" property `word-count-dialog-dark-contrast.spec.ts` proved for its own stat
 * columns. Both dialogs' own Cancel/Close/Send buttons are `.dialog-actions button`, the one
 * control that is deliberately *not* held to that rule (its background, `--surface-03`, does
 * follow the theme, so its inherited text colour correctly follows too) -- already proven once by
 * `word-count-dialog-dark-contrast.spec.ts`'s own Close-button case and `text-contrast.spec.ts`'s
 * ratio case; re-measured here only to confirm the property still holds for these two dialogs'
 * own markup, not to re-argue it.
 */
const FEEDBACK_DIALOG_MARKUP = `
  <div class="dialog-overlay">
    <div aria-modal="true" class="dialog feedback-dialog" role="dialog">
      <h2 id="heading">Send feedback</h2>
      <p class="muted" id="intro">Tell us what went wrong or what would help.</p>
      <form>
        <label class="dialog-field">
          <span id="field-label">Message</span>
          <textarea id="message"></textarea>
        </label>
        <p class="muted feedback-dialog-count" id="count">0 / 4000</p>
        <div class="dialog-actions">
          <button id="cancel-button" type="button">Cancel</button>
          <button class="primary-button" disabled id="send-button" type="submit">Send</button>
        </div>
      </form>
    </div>
  </div>`;

const KEYBOARD_SHORTCUTS_DIALOG_MARKUP = `
  <div class="dialog-overlay">
    <div aria-modal="true" class="dialog keyboard-shortcuts-dialog" role="dialog">
      <h2 id="heading">Keyboard shortcuts</h2>
      <ul class="keyboard-shortcuts-list">
        <li class="keyboard-shortcut-row">
          <span class="keyboard-shortcut-keys"><kbd id="keys">Cmd+Z</kbd></span>
          <span class="keyboard-shortcut-description" id="description">Undo</span>
        </li>
      </ul>
      <div class="dialog-actions">
        <button id="close-button" type="button">Close</button>
      </div>
    </div>
  </div>`;

/** Shared by both tests below: wraps `markup` in the real dark/light shell ancestor and reads back
 * every colour/background this spec cares about, keyed by the ids each dialog's own markup above
 * carries. */
async function probeTheme(page: Page, markup: string, shellClass: string, ids: readonly string[]) {
  return page.evaluate(
    ({ markup: html, shellClass: cls, ids: elementIds }) => {
      document.body.innerHTML = `<main class="application ${cls}">${html}</main>`;
      const colorOf = (id: string) =>
        getComputedStyle(document.querySelector<HTMLElement>(`#${id}`)!).color;
      const result: Record<string, string> = {
        application: getComputedStyle(document.querySelector<HTMLElement>('.application')!).color,
        dialogBackground: getComputedStyle(document.querySelector<HTMLElement>('.dialog')!)
          .backgroundColor,
      };
      for (const id of elementIds) result[id] = colorOf(id);
      return result;
    },
    { markup, shellClass, ids },
  );
}

test('the Send feedback dialog keeps its light-theme surface and text colours inside the dark shell', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const ids = ['heading', 'intro', 'field-label', 'count'] as const;
  const dark = await probeTheme(page, FEEDBACK_DIALOG_MARKUP, 'dark', ids);
  const light = await probeTheme(page, FEEDBACK_DIALOG_MARKUP, '', ids);

  // The probe must actually be resolving two different themes, or every equality below passes for
  // the wrong reason.
  expect(dark.application).not.toBe(light.application);

  // `.dialog` is a "stays white" surface in both themes.
  expect(dark.dialogBackground).toBe(light.dialogBackground);

  // Every text rule painted directly onto that white surface reads identically in both themes.
  for (const id of ids) {
    expect(dark[id]).toBe(light[id]);
  }

  // The field label's text is distinct from the muted intro/count copy, proof the two are
  // genuinely different rules rather than this probe measuring the same value under two ids.
  expect(light['field-label']).not.toBe(light.intro);
});

test('the Keyboard shortcuts dialog keeps its light-theme surface and text colours inside the dark shell', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const ids = ['heading', 'keys', 'description'] as const;
  const dark = await probeTheme(page, KEYBOARD_SHORTCUTS_DIALOG_MARKUP, 'dark', ids);
  const light = await probeTheme(page, KEYBOARD_SHORTCUTS_DIALOG_MARKUP, '', ids);

  expect(dark.application).not.toBe(light.application);
  expect(dark.dialogBackground).toBe(light.dialogBackground);

  for (const id of ids) {
    expect(dark[id]).toBe(light[id]);
  }

  // The key chip and the description read as two distinct rules, not one colour measured twice.
  expect(light.keys).not.toBe(light.description);
});

test('both dialogs’ action buttons follow the theme, matching the already-proven Word count and Save named revision Close/Cancel buttons', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const feedbackDark = await probeTheme(page, FEEDBACK_DIALOG_MARKUP, 'dark', [
    'cancel-button',
  ] as const);
  const feedbackLight = await probeTheme(page, FEEDBACK_DIALOG_MARKUP, '', [
    'cancel-button',
  ] as const);
  const shortcutsDark = await probeTheme(page, KEYBOARD_SHORTCUTS_DIALOG_MARKUP, 'dark', [
    'close-button',
  ] as const);
  const shortcutsLight = await probeTheme(page, KEYBOARD_SHORTCUTS_DIALOG_MARKUP, '', [
    'close-button',
  ] as const);

  // `.dialog-actions button`'s own background (`--surface-03`) follows the theme, so its inherited
  // text colour must too -- matching, not matching the light theme, is correct here. Getting this
  // backwards is the exact regression `progress/menus-slice-2.md` records: forcing the light
  // theme's colour onto this button measured 1.489:1 in the dark theme, down from 8.4:1.
  expect(feedbackDark['cancel-button']).not.toBe(feedbackLight['cancel-button']);
  expect(shortcutsDark['close-button']).not.toBe(shortcutsLight['close-button']);
});
