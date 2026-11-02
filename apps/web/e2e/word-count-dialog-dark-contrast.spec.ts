import { expect, test } from '@playwright/test';

/**
 * The Word count dialog (`progress/menus-slice-2.md`) must stay readable in the dark theme, for
 * the identical reason `menubar-menu-dark-contrast.spec.ts` exists: this app has already shipped
 * one real defect of exactly this shape (an open menubar dropdown unreadable in dark mode) because
 * the slice that introduced it tested markup with no `.dark` ancestor at all, so every colour it
 * resolved was the light theme's -- the suite was green and the bug was plainly visible. This spec
 * renders the dialog's actual markup wrapped in the real `.application.dark` ancestor `App.tsx`
 * puts it inside (`ApplicationShell`'s `outOfFlow` slot, a direct child of `<main
 * class="application dark">` -- not a descendant of `.menubar` at all, so the menubar's own fix is
 * not automatically this dialog's fix).
 *
 * `.dialog` itself is one of the surfaces that deliberately stays white in both themes (`--surface-
 * 01`, never redefined by `.dark`), and every text rule *inside* it that this file wrote explicitly
 * sets its own colour (`--text-09`/`--text-13` for the two stat columns) rather than inheriting --
 * neither token is redefined by `.dark` either, so those two needed no extra handling. The one
 * place this app's own `.dialog` idiom does *not* set an explicit colour is `.dialog-actions
 * button` (`color: inherit`) -- and `.dialog` itself sets no `color` of its own, so that inherited
 * value comes from the dialog's real ancestor chain: `.application.dark`'s own `color:
 * var(--dark-text-01)` (near-white), the same "later rule on a tied-specificity selector wins"
 * mechanism that produced the menubar defect, just one level of inheritance away from a `color:
 * inherit` instead of reaching through a descendant selector. This spec is what proves whether
 * that reaches the Close button the same way `.dark .menubar button`'s `color: inherit` reached the
 * menubar's own dropdown.
 */
const DIALOG_MARKUP = `
  <div class="dialog-overlay">
    <div aria-modal="true" class="dialog word-count-dialog" role="dialog">
      <h2 id="heading">Word count</h2>
      <dl class="word-count-stats">
        <div class="word-count-stat">
          <dt id="words-label">Words</dt>
          <dd id="words-value">345</dd>
        </div>
        <div class="word-count-stat">
          <dt id="characters-label">Characters</dt>
          <dd id="characters-value">1820</dd>
        </div>
        <div class="word-count-stat">
          <dt id="pages-label">Pages</dt>
          <dd id="pages-value">3</dd>
        </div>
      </dl>
      <div class="dialog-actions">
        <button id="close-button" type="button">Close</button>
      </div>
    </div>
  </div>`;

test('the Word count dialog keeps its light-theme surface and text colours inside the dark shell', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const measured = await page.evaluate((markup) => {
    const probe = (shellClass: string) => {
      document.body.innerHTML = `<main class="application ${shellClass}">${markup}</main>`;
      const colorOf = (id: string) =>
        getComputedStyle(document.querySelector<HTMLElement>(`#${id}`)!).color;
      return {
        application: getComputedStyle(document.querySelector<HTMLElement>('.application')!).color,
        charactersValue: colorOf('characters-value'),
        closeButton: colorOf('close-button'),
        dialog: getComputedStyle(document.querySelector<HTMLElement>('.dialog')!).backgroundColor,
        heading: colorOf('heading'),
        pagesValue: colorOf('pages-value'),
        wordsLabel: colorOf('words-label'),
        wordsValue: colorOf('words-value'),
      };
    };
    return { dark: probe('dark'), light: probe('') };
  }, DIALOG_MARKUP);

  /*
   * The probe must actually be resolving two different themes, or every equality below passes for
   * the wrong reason -- `.application`'s own text colour is the property `.dark` is supposed to
   * change, so it is the proof the switch took hold at all.
   */
  expect(measured.dark.application).not.toBe(measured.light.application);

  // `.dialog` is a "stays white" surface in both themes -- its own background must not follow
  // `.application` into the dark theme.
  expect(measured.dark.dialog).toBe(measured.light.dialog);

  /*
   * ...and every text colour that sits *directly on that white surface* must therefore read
   * identically in both themes: the heading and both stat columns all paint onto the dialog itself.
   */
  expect(measured.dark.heading).toBe(measured.light.heading);
  expect(measured.dark.wordsLabel).toBe(measured.light.wordsLabel);
  expect(measured.dark.wordsValue).toBe(measured.light.wordsValue);
  expect(measured.dark.charactersValue).toBe(measured.light.charactersValue);
  expect(measured.dark.pagesValue).toBe(measured.light.pagesValue);

  /*
   * The Close button is deliberately NOT held to that rule, and getting this backwards caused a
   * real regression: `.dialog-actions button` sets `background: var(--surface-03)`, which is one of
   * the tokens `.dark` redefines, so the button's own background goes dark even though the dialog
   * behind it stays white. Its `color: inherit` following the theme is therefore correct -- the
   * requirement is that the text contrasts with *its own* background, not that it matches the light
   * theme. Asserting the light-island property here instead produced near-black on `rgb(52, 66, 75)`
   * at 1.5:1, down from 8.4:1.
   *
   * The ratio itself is covered systematically in `text-contrast.spec.ts`, which measures each
   * target against its own resolved background in both themes; what this asserts is the direction
   * the colour moves, which is what was wrong.
   */
  expect(measured.dark.closeButton).not.toBe(measured.light.closeButton);

  // A value column reads as more prominent than a label column in both themes alike (`--text-13`
  // bold against `--text-09`) -- proof the two tokens are actually distinct, not that this probe
  // merely measured the same colour twice under two different ids.
  expect(measured.light.wordsLabel).not.toBe(measured.light.wordsValue);
});
