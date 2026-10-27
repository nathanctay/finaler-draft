import { expect, test } from '@playwright/test';

/**
 * The resting appearance of the editor title bar's inline rename trigger
 * (`applicationShell.tsx`'s `.document-title-rename`, styled in `styles.css`).
 *
 * This exists because the defect it guards shipped once. The trigger is a real `<button>` -- the
 * right element for focusability, keyboard activation and an accessible name -- but a button also
 * carries the user agent's own background, border and padding, and this project's stylesheet
 * resets only `font` and `cursor` on buttons. With no rule of its own the title rendered as a
 * white box whenever it was merely *displayed*, which the owner reported: "I don't like that its
 * always in a white box now. When editing the title, this is fine, but when its just displayed, I
 * like how it was before."
 *
 * No unit test could have caught that. jsdom resolves no stylesheet, so `getComputedStyle` there
 * reports nothing a rule set, and a button that looks like a box is indistinguishable from one
 * that looks like text. Measuring it needs a real browser, which is the same reason
 * `text-contrast.spec.ts` and `submenu-position.spec.ts` exist.
 *
 * Asserted against the plain `<span>` the trigger sits beside rather than against hardcoded
 * values: the requirement is "indistinguishable from the surrounding text", and a test pinning
 * `rgba(0, 0, 0, 0)` would still pass if the surrounding text's own treatment changed underneath
 * it. The markup is a faithful copy of what the component renders in its non-editing, owner state.
 */
const TITLEBAR_MARKUP = `
<main class="application">
  <header class="titlebar">
    <div class="document-title">
      <button class="document-title-rename" id="trigger" type="button">Hollow Heart</button>
      <span class="title-type" id="plain">Screenplay</span>
    </div>
  </header>
</main>`;

test('the title reads as plain text until it is being edited', async ({ page }) => {
  await page.goto('/sign-in');
  const measured = await page.evaluate((markup) => {
    document.body.innerHTML = markup;
    const read = (id: string) => {
      const style = getComputedStyle(document.querySelector<HTMLElement>(`#${id}`)!);
      return {
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        borderLeftWidth: style.borderLeftWidth,
        fontWeight: style.fontWeight,
        cursor: style.cursor,
        userSelect: style.userSelect,
      };
    };

    // The hit-area half, probed the way the owner actually clicked: a few pixels past the final
    // glyph, vertically centred on the text. `elementFromPoint` answers the only question that
    // matters -- which element would receive that click.
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const textRange = document.createRange();
    textRange.selectNodeContents(trigger);
    const textRect = textRange.getBoundingClientRect();
    const probe = document.elementFromPoint(textRect.right + 4, textRect.top + textRect.height / 2);

    // And the layout half, measured against this very element with the hit-area padding and its
    // cancelling margin switched off, rather than against any fixed number. A literal number
    // cannot express this: `getBoundingClientRect` returns the border box, which legitimately
    // grows with the padding, and the gap to the next element also contains an inter-element
    // space whose width depends on the font. Comparing the label's position with and without the
    // rule isolates exactly one question -- did widening the target move anything.
    const plain = document.querySelector<HTMLElement>('#plain')!;
    const labelLeftWithPadding = plain.getBoundingClientRect().left;
    trigger.style.padding = '0';
    trigger.style.margin = '0';
    const labelLeftWithout = plain.getBoundingClientRect().left;
    trigger.style.removeProperty('padding');
    trigger.style.removeProperty('margin');

    return {
      trigger: read('trigger'),
      plain: read('plain'),
      probeIsTrigger: probe === trigger,
      probeTag: probe?.className ?? '(none)',
      labelShift: labelLeftWithPadding - labelLeftWithout,
      paddedWidth: trigger.getBoundingClientRect().width,
      textWidth: textRect.width,
    };
  }, TITLEBAR_MARKUP);

  // No box of its own: nothing painted behind it and no border. Padding is deliberately *not*
  // asserted to be zero -- the first version of this test pinned that, which was wrong. With no
  // background and no border there is nothing for padding to make visible, so zero padding was
  // never part of looking like plain text; it only made the click target exactly as wide as the
  // glyphs, which is the defect the probe below now guards.
  expect(measured.trigger.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(measured.trigger.borderTopWidth).toBe('0px');
  expect(measured.trigger.borderLeftWidth).toBe('0px');

  // The owner's scenario: clicking just past the end of the name must reach the rename trigger,
  // not the type label beside it.
  expect(measured.probeIsTrigger, `that click landed on "${measured.probeTag}"`).toBe(true);

  // Widening the target moved nothing: the type label sits in the same place whether the hit-area
  // padding is applied or not, which is what the cancelling negative margin is for.
  expect(measured.labelShift).toBeCloseTo(0, 1);

  // And the target genuinely is wider than the glyphs -- otherwise `labelShift` would be 0 for the
  // trivial reason that there is no padding to cancel, and this whole case would pass against the
  // defect it exists to catch.
  expect(measured.paddedWidth).toBeGreaterThan(measured.textWidth + 8);

  // And it is painted on the same terms as the ordinary text beside it, rather than merely
  // happening to be transparent today.
  expect(measured.trigger.backgroundColor).toBe(measured.plain.backgroundColor);

  // The type label is a label, not document content: a double-click that lands on it while
  // reaching for the end of the title should do nothing, rather than highlighting the word.
  expect(measured.plain.userSelect).toBe('none');

  // A single click does nothing here, so the pointer cursor the global `button` rule sets would
  // promise an interaction that is not offered.
  expect(measured.trigger.cursor).toBe('text');

  // The title's own weight still comes from `.document-title`, inherited through `font: inherit`
  // rather than restated -- proving the reset did not also strip the typography.
  expect(measured.trigger.fontWeight).toBe('600');
});
