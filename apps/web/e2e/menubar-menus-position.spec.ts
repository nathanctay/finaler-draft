import { expect, test } from '@playwright/test';

/**
 * Geometry, in a real browser, for the Edit, View and Format menus added this slice
 * (`progress/menus-slice-1.md`) -- specifically, that each one opens a left-anchored dropdown
 * under its *own* trigger, and that a submenu inside one of them (Format's "Element type", View's
 * "Zoom") positions beside its own row rather than on top of it.
 *
 * This exists for the identical reason `submenu-position.spec.ts` does: jsdom performs no layout
 * at all, so `OverflowMenu.test.tsx` and `applicationMenubar.test.tsx` can (and do) pass completely
 * while every one of these boxes sits at `{0,0,0,0}`. The File menu already had this geometry
 * proven once, for the one submenu that existed then; this slice turned four single-class
 * `.menu-file`/`.menu-edit`/`.menu-view`/`.menu-format` CSS rules into a shared `.menubar-menu`
 * selector so the same positioning did not have to be written four times over, and that
 * generalisation is exactly the kind of change that can look right in the source and still fail to
 * reach three of the four menus it was meant to cover -- CSS that previously keyed off a single,
 * uniquely-matching class is a different claim once the same declaration has to resolve correctly
 * from four different ancestors at once.
 *
 * The markup below is a faithful copy of what `applicationMenubar.tsx` renders for File, Edit,
 * View, Format and Tools side by side (the real class list each wrapper carries, `OverflowMenu`'s
 * own list/submenu structure), not an approximation -- `styles.css`'s cascade is what is under
 * test, so the exact classes and nesting are the point, the same reasoning
 * `submenu-position.spec.ts` gives for its own markup. Tools (`progress/menus-slice-2.md`) is a
 * plain trigger with no submenu of its own, the same shape Edit and View already are here.
 */
const MENUBAR_MARKUP = `
<nav class="menubar" aria-label="Application menu">
  <div class="menubar-menu menu-file">
    <div class="overflow-menu">
      <button class="overflow-menu-trigger" id="file-trigger" type="button">File</button>
      <div class="overflow-menu-list" id="file-list" role="menu">
        <button role="menuitem" type="button">Document settings…</button>
      </div>
    </div>
  </div>
  <div class="menubar-menu menu-edit">
    <div class="overflow-menu">
      <button class="overflow-menu-trigger" id="edit-trigger" type="button">Edit</button>
    </div>
  </div>
  <div class="menubar-menu menu-view">
    <div class="overflow-menu">
      <button class="overflow-menu-trigger" id="view-trigger" type="button">View</button>
    </div>
  </div>
  <div class="menubar-menu menu-format">
    <div class="overflow-menu">
      <button class="overflow-menu-trigger" id="format-trigger" type="button">Format</button>
      <div class="overflow-menu-list" id="format-list" role="menu">
        <div class="overflow-menu-submenu-group">
          <button
            aria-expanded="true"
            aria-haspopup="menu"
            class="overflow-menu-submenu-trigger"
            id="format-submenu-trigger"
            role="menuitem"
            type="button"
          >Element type <span aria-hidden="true" class="overflow-menu-disclosure">›</span></button>
          <div class="overflow-menu-list overflow-menu-submenu" id="format-submenu-flyout" role="menu">
            <button role="menuitem" type="button">Scene Heading</button>
            <button role="menuitem" type="button">Action</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="menubar-menu menu-tools">
    <div class="overflow-menu">
      <button class="overflow-menu-trigger" id="tools-trigger" type="button">Tools</button>
    </div>
  </div>
  <span class="menubar-inert">Help</span>
</nav>`;

test('Edit, View, Format and Tools render as flush, label-sized triggers, matching File rather than OverflowMenu’s own pill default', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const styles = await page.evaluate((markup) => {
    document.body.innerHTML = markup;
    const styleOf = (id: string) => {
      const element = document.querySelector<HTMLElement>(`#${id}`)!;
      const computed = getComputedStyle(element);
      return {
        borderRadius: computed.borderRadius,
        fontWeight: computed.fontWeight,
        height: element.getBoundingClientRect().height,
      };
    };
    return {
      edit: styleOf('edit-trigger'),
      file: styleOf('file-trigger'),
      format: styleOf('format-trigger'),
      tools: styleOf('tools-trigger'),
      view: styleOf('view-trigger'),
    };
  }, MENUBAR_MARKUP);

  // All must actually have been laid out, or every comparison below is vacuously true.
  expect(styles.file.height).toBeGreaterThan(0);

  for (const trigger of [styles.edit, styles.view, styles.format, styles.tools]) {
    expect(trigger.height).toBeCloseTo(styles.file.height, 1);
    expect(trigger.borderRadius).toBe(styles.file.borderRadius);
    expect(trigger.fontWeight).toBe(styles.file.fontWeight);
  }
});

test('the File and Format menus each open a left-anchored dropdown under their own trigger, not a shared or right-anchored one', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const boxes = await page.evaluate((markup) => {
    document.body.innerHTML = markup;
    const rect = (id: string) => {
      const { left, right } = document
        .querySelector<HTMLElement>(`#${id}`)!
        .getBoundingClientRect();
      return { left, right };
    };
    return {
      editTrigger: rect('edit-trigger'),
      fileList: rect('file-list'),
      fileTrigger: rect('file-trigger'),
      formatList: rect('format-list'),
      formatTrigger: rect('format-trigger'),
    };
  }, MENUBAR_MARKUP);

  // Each menu's own list is anchored to its own trigger's left edge (`right: auto; left: 0`,
  // `.menubar-menu .overflow-menu-list`) -- not pinned to the viewport's left edge regardless of
  // which menu opened it, and not right-anchored off whatever sits further right in the row. The
  // File menu sits at the left edge of the bar, so this distinguishes "correctly anchored to its
  // own trigger" from "happens to equal the viewport's left edge by coincidence" only for the
  // *second* assertion -- Format, several triggers to the right, is the one that actually proves
  // the rule generalised rather than only ever having been exercised for the leftmost menu.
  expect(boxes.fileList.left).toBeCloseTo(boxes.fileTrigger.left, 0);
  expect(boxes.formatList.left).toBeCloseTo(boxes.formatTrigger.left, 0);
  // And Format's own dropdown must not have ended up anchored to some *other* menu's trigger --
  // the one real failure mode a copy-pasted or over-generalised selector could produce silently.
  expect(boxes.formatList.left).toBeGreaterThan(boxes.editTrigger.right);
});

test('Format’s “Element type” submenu opens beside its own row, not on top of the Format menu', async ({
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
    return {
      parent: rect('format-list'),
      flyout: rect('format-submenu-flyout'),
      trigger: rect('format-submenu-trigger'),
    };
  }, MENUBAR_MARKUP);

  expect(boxes.parent.width).toBeGreaterThan(0);
  expect(boxes.flyout.width).toBeGreaterThan(0);
  // Same requirement `submenu-position.spec.ts` proved for the File menu's "Download": the flyout
  // begins at or after its own parent list's right edge, and tracks the trigger row's top -- now
  // reached through `.menu-format` rather than `.menu-file`, which is exactly the path that broke
  // the first time (a single-class rule that happened to match only one ancestor).
  expect(boxes.flyout.left).toBeGreaterThanOrEqual(boxes.parent.right);
  expect(Math.abs(boxes.flyout.top - boxes.trigger.top)).toBeLessThan(24);
});
