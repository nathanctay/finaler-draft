import { expect, test } from '@playwright/test';

/**
 * Geometry, in a real browser, for the File menu's "Download" submenu flyout
 * (`components/OverflowMenu.tsx`'s `submenuItems`, styled in `styles.css`).
 *
 * This exists because the submenu's position cannot be asserted anywhere else. `OverflowMenu`'s
 * own unit tests run in jsdom, which performs no layout at all -- every `getBoundingClientRect` is
 * zero -- so a flyout that renders exactly on top of the menu it belongs to passes all 39 of them.
 * That is not hypothetical: it is the defect this spec was written for. `.overflow-menu-submenu`
 * set `left: 100%`, but `.menu-file .overflow-menu-list` (two classes, specificity 0-2-0) set
 * `left: 0` and beat it (one class, 0-1-0) for exactly the element that carries both classes, so
 * inside the File menu -- the only place a submenu is actually used -- the flyout covered its own
 * parent menu.
 *
 * Asserted as a relationship between two measured boxes rather than as a pixel offset or a
 * computed `left` string: "to the side of, and not overlapping" is the requirement, and it stays
 * true if the gap or the anchoring is retuned. A test pinning `left: 100%` would have passed in
 * the broken state too, since that declaration was present and simply losing the cascade.
 *
 * Follows `text-contrast.spec.ts`'s harness: load a page so the real stylesheet applies, inject
 * the exact markup the component renders, and measure. The markup below is a faithful copy of
 * `OverflowMenu`'s submenu-open branch (`.menu-file` wrapper, `.overflow-menu-list` parent, an
 * `.overflow-menu-submenu-group` row, and the `.overflow-menu-list.overflow-menu-submenu` flyout),
 * not an approximation of it -- the specificity bug lives in the class combination, so getting the
 * classes and nesting right is the entire point.
 */
const MENU_MARKUP = `
<main class="application">
  <div class="menubar">
    <div class="menu-file">
      <button type="button">File</button>
      <div class="overflow-menu-list" id="parent" role="menu">
        <button role="menuitem" type="button">Document settings…</button>
        <button role="menuitem" type="button">Save named revision…</button>
        <div class="overflow-menu-submenu-group">
          <button
            aria-expanded="true"
            aria-haspopup="menu"
            class="overflow-menu-submenu-trigger"
            id="trigger"
            role="menuitem"
            type="button"
          >Download <span aria-hidden="true" class="overflow-menu-disclosure">›</span></button>
          <div class="overflow-menu-list overflow-menu-submenu" id="flyout" role="menu">
            <button role="menuitem" type="button">FDX…</button>
            <button role="menuitem" type="button">DOCX…</button>
            <button role="menuitem" type="button">PDF…</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</main>`;

test('the Download submenu opens to the side of the File menu, not on top of it', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const boxes = await page.evaluate((markup) => {
    document.body.innerHTML = markup;
    const rect = (id: string) => {
      const { left, right, top, width } = document
        .querySelector<HTMLElement>(`#${id}`)!
        .getBoundingClientRect();
      return { left, right, top, width };
    };
    return { parent: rect('parent'), flyout: rect('flyout'), trigger: rect('trigger') };
  }, MENU_MARKUP);

  // Both boxes must actually have been laid out, or every comparison below is vacuously true.
  // This is the guard that makes the spec meaningful rather than a tautology on zero-sized rects.
  expect(boxes.parent.width).toBeGreaterThan(0);
  expect(boxes.flyout.width).toBeGreaterThan(0);

  // The requirement: the flyout begins at or after the parent menu's right edge, so the two never
  // overlap horizontally. In the broken state the flyout's left sat at the parent's left.
  expect(boxes.flyout.left).toBeGreaterThanOrEqual(boxes.parent.right);

  // And it is genuinely beside the row that opened it rather than pushed below the whole menu:
  // the flyout's top tracks the trigger row's top, which is what `top: -5px` within the group's
  // positioning context buys. 24px of tolerance covers the list's own padding and the deliberate
  // small upward offset without pinning either.
  expect(Math.abs(boxes.flyout.top - boxes.trigger.top)).toBeLessThan(24);
});
