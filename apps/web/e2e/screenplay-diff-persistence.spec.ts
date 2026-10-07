import { expect, test, type Page } from '@playwright/test';
import { diffScreenplays, type Screenplay, type ScreenplayBlock } from '@finaler-draft/screenplay';
import {
  BODY_WIDTH_IN,
  DEFAULT_DOCUMENT_SETTINGS,
  ELEMENT_INDENTS,
  MARGIN_LEFT_IN,
  MEASURED_COURIER_PRIME_ADVANCE_EM,
  TYPE_SIZE_PT,
} from '@finaler-draft/screenplay/pageFormat';
import { PERSISTED_POLL_TIMEOUT_MS } from './persistedPollTimeout.js';
import { requireCourierPrime } from './requireCourierPrime.js';
import { signIn, verifyEmail } from './testMail.js';

/**
 * Collaboration slice 4b's real-browser proof: the screenplay-aware diff view renders a genuine
 * difference between a named revision and the screenplay's current live content, and never
 * disturbs the live document to do it. `packages/screenplay/src/diff.test.ts` already proves
 * `diffScreenplays` itself in isolation; `apps/api/src/revisions.integration.test.ts` already
 * proves the store and route against a real database. What only a real browser can prove is the
 * same claim `revision-history-persistence.spec.ts` makes for historical preview: that opening
 * this view, in a real signed-in session against a real Hocuspocus-backed document, renders real
 * differences and leaves the live document -- still open, still editable -- completely untouched.
 */
async function createAndOpenScreenplay(page: Page): Promise<void> {
  const token = crypto.randomUUID();
  const email = `writer-${token}@example.test`;
  const password = `test-${token}-safe-password`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Writer');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
  await verifyEmail(page, email);
  await signIn(page, email, password);
  await expect(page.getByRole('heading', { name: 'Your writing desk' })).toBeVisible();
  await page.getByLabel('New project title').fill('Diff project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Diff project' }).click();
  await page.getByLabel('New screenplay title').fill('Diff script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  await expect(page.getByRole('textbox', { name: 'Screenplay editing canvas' })).toBeVisible();
}

function screenplayIdFromUrl(page: Page): string {
  const screenplayId = /\/screenplays\/([0-9a-f-]+)/u.exec(page.url())?.[1];
  if (!screenplayId) throw new Error(`Could not find a screenplay id in ${page.url()}.`);
  return screenplayId;
}

async function waitForPersistedText(
  page: Page,
  screenplayId: string,
  expectedText: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/screenplays/${screenplayId}`);
        expect(response.ok()).toBe(true);
        const { screenplay } = (await response.json()) as {
          screenplay: { blocks: ReadonlyArray<{ text?: string }> };
        };
        return screenplay.blocks.some((block) => block.text?.includes(expectedText));
      },
      { timeout: PERSISTED_POLL_TIMEOUT_MS },
    )
    .toBe(true);
}

test('the diff view renders a real difference between a named revision and the live document, and never disturbs the live document', async ({
  page,
}) => {
  test.setTimeout(90_000);
  page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.stack ?? err.message}`));
  await createAndOpenScreenplay(page);
  const screenplayId = screenplayIdFromUrl(page);
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });

  await canvas.click();
  await page.keyboard.type('Original line before the milestone.');
  await waitForPersistedText(page, screenplayId, 'Original line before the milestone.');

  // Save a named revision through the real File menu action.
  await page.getByRole('button', { name: 'File menu' }).click();
  await page.getByRole('menuitem', { name: 'Save named revision…' }).click();
  const namedDialog = page.getByRole('dialog', { name: 'Save named revision' });
  await expect(namedDialog).toBeVisible();
  await namedDialog.getByRole('textbox', { name: 'Revision label' }).fill('Before the rewrite');
  await namedDialog.getByRole('button', { name: 'Save' }).click();
  await expect(namedDialog).toBeHidden();

  // A further live edit *after* the revision was captured -- this is the real difference the
  // diff view has to surface.
  await canvas.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Added after the milestone.');
  await waitForPersistedText(page, screenplayId, 'Added after the milestone.');

  // Open revision history. Automatic revisions (idle-session/structural-change) exist alongside
  // the named one, so every row carries its own "Compare to current" link -- scope to the named
  // revision's own row rather than the first match.
  await page.getByRole('button', { name: 'File menu' }).click();
  await page.getByRole('menuitem', { name: 'Revision history…' }).click();
  await expect(page.getByRole('heading', { name: 'Revision history' })).toBeVisible();
  const namedRow = page.getByRole('listitem').filter({ hasText: 'Before the rewrite' });
  await namedRow.getByRole('link', { name: 'Compare to current' }).click();

  await expect(page.getByRole('note')).toContainText('not a paginated script');

  // The real difference: a new line, added after the milestone, is marked as added *in the document*.
  const addedRow = page.locator('[data-diff-row="block"][data-diff-mark="added"]');
  await expect(addedRow).toContainText('Added after the milestone.');
  await expect(addedRow.locator('ins')).toHaveText('Added after the milestone.');
  // Its non-colour cue, in the real browser: the gutter glyph, and the announced label.
  await expect(addedRow.locator('.diff-gutter-glyph')).toHaveText('+');
  await expect(addedRow).toContainText('Added.');

  /*
   * The content common to both sides is *shown*, unmarked, in document order.
   *
   * This assertion is the exact inverse of the one it replaced. The view this spec was first written
   * against was a change report, and it asserted that unchanged content did not appear at all -- which
   * was true of that view and was precisely the owner's objection to it ("not something that is easily
   * readable by a person"): a reader could not see the script, only a list of fragments. The inline
   * view shows the screenplay, so unchanged content must be present, and must carry no mark.
   */
  const unchangedRow = page
    .locator('[data-diff-row="block"][data-diff-mark="unchanged"]')
    .filter({ hasText: 'Original line before the milestone.' });
  await expect(unchangedRow).toHaveCount(1);
  await expect(unchangedRow.locator('del, ins')).toHaveCount(0);

  // Structurally incapable of disturbing the live document: no editable screenplay canvas of any
  // kind exists on this page at all -- not a disabled one, an absent one.
  await expect(page.getByRole('textbox', { name: 'Screenplay editing canvas' })).toHaveCount(0);

  // The live document, fetched independently, still has the post-milestone edit untouched.
  const liveResponse = await page.request.get(`/api/screenplays/${screenplayId}`);
  expect(liveResponse.ok()).toBe(true);
  const { screenplay: liveScreenplay } = (await liveResponse.json()) as {
    screenplay: { blocks: ReadonlyArray<{ text?: string }> };
  };
  expect(
    liveScreenplay.blocks.some((block) => block.text?.includes('Added after the milestone.')),
  ).toBe(true);
});

/**
 * The redesign's two real-browser proofs, driven by a fixture served to the real route rather than by
 * typing into the editor.
 *
 * Why a fixture, and why it is still the real route: the shapes this has to cover include a **scene
 * relocated whole** with nothing inside it touched. There is no deterministic way to produce that by
 * typing -- it needs a selection cut and re-pasted across a scene boundary, which depends on clipboard
 * permissions and on paste preserving block ids, neither of which this spec should be asserting about.
 * Intercepting the one diff request instead leaves everything that matters under test real: the real
 * signed-in route (its `beforeLoad` session guard still runs against the real API), the real React
 * component, the real stylesheet, and real Chrome layout with the real Courier Prime webfont. The
 * server half of the same feature is covered by `apps/api/src/revisions.integration.test.ts` against a
 * real database, and by the live-document test above.
 */
/**
 * **The checkable definition of "it feels like part of the greater product."**
 *
 * The owner's objection to the previous pass, verbatim: "There is no toolbar, even if theres not much
 * in the toolbar that could actually be used here. Theres no scene/character navigator. Theres no
 * inspector. It still just feels like a free floating thing, not like part of the greater product."
 * That is a judgement about chrome parity, and a judgement is exactly what a third pass on one view
 * cannot be left resting on. So this enumerates the chrome of whichever screen is open -- every
 * toolbar control by accessible name and element kind, every menubar child, every File item, both
 * panels' headings and affordances, and the status bar's own shape -- and the test below asserts the
 * two screens' enumerations are *equal*, with the only permitted differences being disabled state and
 * what the panels hold.
 *
 * `disabled` is read from the live DOM property, not from a class or an `aria-disabled` attribute: a
 * control styled to look unavailable while staying focusable and clickable is the exact defect the
 * owner's instruction rules out, and it would pass a class-based check.
 *
 * The File menu is opened and closed here, by real clicks, because its items only exist while it is
 * open. Escape closes it and returns focus to the trigger, which is `OverflowMenu`'s own contract.
 */
async function enumerateChrome(page: Page) {
  // The File menu's items, read while it is open. Real clicks, not evaluate: this is the same
  // interaction a writer performs, and the menu is unmounted when closed.
  await page.getByRole('button', { name: 'File menu' }).click();
  const fileItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((item) => ({
      disabled: item.disabled,
      name: item.textContent?.trim() ?? '',
    })),
  );
  await page.keyboard.press('Escape');
  // Asserted, not assumed: the rest of this enumeration reads the menubar's own children, and a menu
  // still open would be read as part of the File entry's text. (It used to be: a disabled first item
  // swallowed the opening focus move, which left Escape on the trigger with nothing listening. See
  // `OverflowMenu`'s `focusableItems`.)
  await expect(page.getByRole('menu')).toHaveCount(0);

  return {
    ...(await page.evaluate(() => {
      const application = document.querySelector<HTMLElement>('.application');
      if (!application) throw new Error('Missing .application.');

      /** The accessible name a screen reader would use for one of these controls: the explicit label
       * where there is one, the visible text otherwise. Every control enumerated here has one of the
       * two, which is itself part of the claim. */
      const nameOf = (element: Element): string =>
        element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';

      const controls = (root: Element) =>
        Array.from(root.querySelectorAll('button, select, output')).map((control) => ({
          // The real DOM property, which is `false` for a styled lookalike however grey it looks.
          disabled:
            'disabled' in control ? Boolean((control as HTMLButtonElement).disabled) : false,
          name: nameOf(control),
          tag: control.tagName,
        }));

      const optionsOf = (selector: string) =>
        Array.from(document.querySelectorAll<HTMLOptionElement>(`${selector} option`)).map(
          (option) => ({ disabled: option.disabled, value: option.value }),
        );

      const panel = (label: string) => {
        const element = application.querySelector<HTMLElement>(`.panel[aria-label="${label}"]`);
        if (!element) return null;
        return {
          closeButton: nameOf(element.querySelector('.panel-heading button')!),
          heading: element.querySelector('.panel-heading span')?.textContent ?? '',
          hasFooter: element.querySelector('.navigator-footer') !== null,
          sectionHeadings: Array.from(element.querySelectorAll('.inspector-section h2')).map(
            (h2) => h2.textContent ?? '',
          ),
          tabs: Array.from(element.querySelectorAll('[role="tab"]')).map((tab) => ({
            name: nameOf(tab),
            selected: tab.getAttribute('aria-selected'),
          })),
          width: element.getBoundingClientRect().width,
        };
      };

      const menubar = application.querySelector<HTMLElement>('.menubar');
      const toolbar = application.querySelector<HTMLElement>('.toolbar');
      const statusbar = application.querySelector<HTMLElement>('.statusbar');
      if (!menubar || !toolbar || !statusbar) {
        throw new Error('Missing .menubar, .toolbar or .statusbar inside .application.');
      }

      return {
        declaredRows: getComputedStyle(application)
          .gridTemplateRows.split(' ')
          .map((value) => parseFloat(value)),
        elementSelectOptions: optionsOf('.element-selector select'),
        inspector: panel('Inspector'),
        menubarChildren: Array.from(menubar.children).map((child) => ({
          className: child.className,
          tag: child.tagName,
          text: child.textContent?.trim() ?? '',
        })),
        menubarControls: controls(menubar),
        navigator: panel('Navigator'),
        rowHeights: {
          menubar: menubar.getBoundingClientRect().height,
          statusbar: statusbar.getBoundingClientRect().height,
          toolbar: toolbar.getBoundingClientRect().height,
        },
        statusbarChildren: Array.from(statusbar.children).map((child) => ({
          className: child.className,
          label: child.getAttribute('aria-label'),
          tag: child.tagName,
        })),
        toolbarControls: controls(toolbar),
        workspaceChildren: Array.from(
          application.querySelector<HTMLElement>('.workspace')!.children,
        ).map((child) => child.className),
        zoomPresetOptions: optionsOf('.zoom-level select'),
      };
    })),
    fileItems,
  };
}

const LONG_ACTION_LINE =
  'The clock above the console reads nine minutes past midnight and every lamp in the room is still burning.';

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function block(index: number, type: ScreenplayBlock['type'], text: string): ScreenplayBlock {
  return { id: uuidFor(index), type, text } as ScreenplayBlock;
}

function fixtureScreenplay(id: string, blocks: ScreenplayBlock[]): Screenplay {
  return {
    schemaVersion: 1,
    id,
    title: 'Diff script',
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    titlePages: [],
    annotations: [],
    blocks,
  };
}

/**
 * An edit, an addition, a deletion and a relocated scene, plus deliberate **control pairs**: the added
 * long action line and the removed short action line each have an unchanged twin carrying byte-identical
 * text. Those pairs are what make the grid measurement an equality rather than an estimate -- a marked
 * row and its unmarked twin must place every character at exactly the same coordinates.
 */
function inlineDiffFixture(screenplayId: string) {
  const older = fixtureScreenplay(screenplayId, [
    block(1, 'scene_heading', 'INT. CONTROL ROOM - NIGHT'),
    block(2, 'action', LONG_ACTION_LINE),
    block(4, 'action', 'A spare beat that will be cut.'),
    block(5, 'action', 'A spare beat that will be cut.'),
    block(6, 'character', 'ADA'),
    block(12, 'parenthetical', '(quietly)'),
    block(7, 'dialogue', 'I waited by the window until dawn and nobody came.'),
    block(13, 'transition', 'CUT TO:'),
    block(8, 'scene_heading', 'EXT. ROOFTOP - DAWN'),
    block(9, 'action', 'Wind lifts the tarp.'),
    block(10, 'scene_heading', 'INT. STAIRWELL - DAY'),
    block(11, 'action', 'Footsteps climb.'),
  ]);
  const newer = fixtureScreenplay(screenplayId, [
    block(1, 'scene_heading', 'INT. CONTROL ROOM - NIGHT'),
    block(2, 'action', LONG_ACTION_LINE),
    // Added: the same text as the unchanged line above it, different block.
    block(3, 'action', LONG_ACTION_LINE),
    // Block 4 is gone (removed); block 5, its identical twin, stays.
    block(5, 'action', 'A spare beat that will be cut.'),
    block(6, 'character', 'ADA'),
    block(12, 'parenthetical', '(quietly)'),
    // Changed: one word.
    block(7, 'dialogue', 'I waited by the doorway until dawn and nobody came.'),
    block(13, 'transition', 'CUT TO:'),
    block(10, 'scene_heading', 'INT. STAIRWELL - DAY'),
    block(11, 'action', 'Footsteps climb.'),
    // The rooftop scene, intact, relocated to the end.
    block(8, 'scene_heading', 'EXT. ROOFTOP - DAWN'),
    block(9, 'action', 'Wind lifts the tarp.'),
  ]);
  return {
    screenplayId,
    older: {
      id: uuidFor(900),
      kind: 'named' as const,
      label: 'Before the rewrite',
      createdAt: '2026-08-06T15:04:00.000Z',
    },
    newer: { id: 'current', kind: null, label: null, createdAt: null },
    diff: diffScreenplays(older, newer),
    olderScreenplay: older,
    newerScreenplay: newer,
  };
}

/**
 * The chrome, measured off whichever screen is open: the application grid, the title bar, the banner
 * row, the workspace and its scrolling region, and the status bar. Run against the real editor and
 * then against the real comparison view, it is what proves the owner's own requirement -- "I like the
 * UI we've built out for the editor, and don't want users thrust into some plain UI when looking at
 * the difference" -- rather than asserting it by looking at a screenshot.
 *
 * Both screens render `applicationShell.tsx`. What this measures is that they therefore *resolve* to
 * the same chrome in a real browser with the real stylesheet: the same title bar, the same banner
 * mechanics, the same workspace frame, the same status bar. Which rows each screen fills is
 * deliberately different (the comparison has no menubar and no toolbar, because it has nothing to
 * command or edit) and that difference is asserted directly, from the resolved track list, rather
 * than left implicit.
 *
 * `scrollRegion` is `.editor-region` on the editor and `.diff-manuscript-region` on the comparison:
 * two class names for the same structural role -- the single flex child of the workspace row, and
 * the only region on the screen that scrolls.
 */
async function measureChrome(page: Page) {
  return page.evaluate(() => {
    const application = document.querySelector<HTMLElement>('.application');
    if (!application) throw new Error('Missing .application.');
    const required = (selector: string) => {
      const element = application.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${selector} inside .application.`);
      return element;
    };
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, height: rect.height, top: rect.top };
    };
    const look = (element: HTMLElement, properties: string[]) =>
      Object.fromEntries(
        properties.map((property) => [
          property,
          getComputedStyle(element).getPropertyValue(property),
        ]),
      );

    const titlebar = required('.titlebar');
    const menubar = required('.menubar');
    const toolbar = required('.toolbar');
    const workspace = required('.workspace');
    const statusbar = required('.statusbar');
    const scrollRegion = required('.editor-region, .diff-manuscript-region');
    const banner = application.querySelector<HTMLElement>('.readonly-banner');

    return {
      applicationHeight: application.getBoundingClientRect().height,
      banner:
        banner === null
          ? null
          : {
              ...box(banner),
              className: banner.className,
              role: banner.getAttribute('role'),
            },
      declaredRows: getComputedStyle(application)
        .gridTemplateRows.split(' ')
        .map((value) => parseFloat(value)),
      documentScrollHeight: document.documentElement.scrollHeight,
      hasBannerRow: application.classList.contains('has-readonly-banner'),
      menubar: box(menubar),
      toolbar: box(toolbar),
      scrollRegion: {
        ...box(scrollRegion),
        clientHeight: scrollRegion.clientHeight,
        look: look(scrollRegion, ['background-color', 'overflow-y']),
        scrollHeight: scrollRegion.scrollHeight,
      },
      scrollRegionIsOnlyWorkspaceChild: workspace.children.length === 1,
      statusbar: {
        ...box(statusbar),
        look: look(statusbar, ['background-color', 'border-top', 'color', 'font-size']),
      },
      titlebar: {
        ...box(titlebar),
        accountBadge: required('.account-button').textContent,
        brandHref: required('.brand').getAttribute('href'),
        brandLabel: required('.brand').getAttribute('aria-label'),
        brandMark: required('.brand-mark').textContent,
        documentTitle: required('.document-title').textContent,
        look: look(titlebar, ['background-color', 'color', 'font-size', 'gap', 'padding']),
        titleType: required('.title-type').textContent,
      },
      viewportHeight: window.innerHeight,
      workspace: box(workspace),
    };
  });
}

/** The whole rendered comparison, measured off the real DOM: one entry per manuscript row, with its
 * layout box, its per-character grid cells, and the marks inside it. Ornaments (the gutter and the
 * visually-hidden label) are excluded from the text walk by their `data-diff-ornament` attribute --
 * both are out of flow, so a character they displaced would be a defect, not an expected offset. */
async function measureDiffGrid(page: Page) {
  return page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>('.page.diff-manuscript');
    if (!sheet) throw new Error('No .page.diff-manuscript found.');
    // CSS `zoom` scales what `getBoundingClientRect()` reports but not `offsetWidth`, so their ratio
    // is the applied scale -- the same property `page-rendering-persistence.spec.ts` relies on.
    const scale = sheet.getBoundingClientRect().width / sheet.offsetWidth;

    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-diff-row="block"]'));
    return {
      scale,
      rows: rows.map((row) => {
        const rect = row.getBoundingClientRect();
        const lineHeightPx = parseFloat(getComputedStyle(row).lineHeight);
        const textNodes: Text[] = [];
        const walk = (node: Node): void => {
          for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.ELEMENT_NODE) {
              if ((child as HTMLElement).dataset.diffOrnament !== undefined) continue;
              walk(child);
            } else if (child.nodeType === Node.TEXT_NODE) {
              textNodes.push(child as Text);
            }
          }
        };
        walk(row);
        const cells: { dx: number; dy: number }[] = [];
        for (const textNode of textNodes) {
          for (let index = 0; index < textNode.data.length; index++) {
            const range = document.createRange();
            range.setStart(textNode, index);
            range.setEnd(textNode, index + 1);
            const cellRect = range.getBoundingClientRect();
            if (cellRect.width === 0 && cellRect.height === 0) continue;
            cells.push({ dx: cellRect.left - rect.left, dy: cellRect.top - rect.top });
          }
        }
        return {
          element: row.getAttribute('data-screenplay-element'),
          mark: row.getAttribute('data-diff-mark'),
          blockId: row.getAttribute('data-diff-block-id'),
          text: textNodes.map((node) => node.data).join(''),
          offsetLeft: row.offsetLeft,
          offsetWidth: row.offsetWidth,
          offsetHeight: row.offsetHeight,
          lineHeightPx,
          cells,
        };
      }),
    };
  });
}

type DiffGrid = Awaited<ReturnType<typeof measureDiffGrid>>;

/** The CSS specification's fixed 96px per inch -- the same constant `zoom.ts`, `seamCaret.ts` and
 * `paginationExtension.ts` each state for themselves, for the reason `zoom.ts`'s own comment gives. */
const CSS_PX_PER_IN = 96;

/** `offsetLeft`/`offsetWidth` are integers; a specified length of 355.2px is reported as 355. One
 * rounding step, not a geometry tolerance. */
const OFFSET_ROUNDING_TOLERANCE_PX = 0.5;

/** The element's specified left edge and measure, in unscaled CSS pixels, derived from the page format
 * and document settings rather than written down here -- so this assertion fails if the diff view ever
 * stops reading the specification's own indents. */
function expectedBoxPx(element: string): { left: number; width: number } {
  if (element === 'transition') {
    // Right-aligned: its own offset is a `margin-right`, so its left edge is the body's own.
    return { left: MARGIN_LEFT_IN * CSS_PX_PER_IN, width: BODY_WIDTH_IN * CSS_PX_PER_IN };
  }
  const indent = ELEMENT_INDENTS[element as keyof typeof ELEMENT_INDENTS];
  const leftIn =
    element === 'character'
      ? DEFAULT_DOCUMENT_SETTINGS.characterIndentIn
      : element === 'parenthetical'
        ? DEFAULT_DOCUMENT_SETTINGS.parentheticalIndentIn
        : indent.leftIn!;
  const widthIn =
    element === 'parenthetical'
      ? DEFAULT_DOCUMENT_SETTINGS.parentheticalWidthIn
      : (indent.widthIn ?? BODY_WIDTH_IN - (leftIn - MARGIN_LEFT_IN));
  return { left: leftIn * CSS_PX_PER_IN, width: widthIn * CSS_PX_PER_IN };
}

/**
 * The character grid, asserted three ways against one measurement:
 *
 * 1. Every row's box is the element's specified indent and measure (unscaled: `offsetLeft`/
 *    `offsetWidth` are immune to CSS `zoom`), so no marker widened or shifted a line's box.
 * 2. Every character in every row -- including rows carrying interleaved `<del>`/`<ins>` marks -- sits
 *    at an exact whole multiple of one character cell from its row's left edge, and on an exact whole
 *    multiple of the line height. The cell width is calibrated from the rendered text itself at this
 *    zoom and then cross-checked against Courier Prime's own advance at the specified type size, so
 *    this is a measurement of the real grid rather than of an assumed one.
 * 3. A marked row and its byte-identical unmarked twin place every character at the same coordinates.
 */
function assertCharacterGrid(grid: DiffGrid, label: string): void {
  const { scale, rows } = grid;
  expect(rows.length, `${label}: rows rendered`).toBeGreaterThan(8);

  for (const row of rows) {
    if (row.element === null) continue;
    const expected = expectedBoxPx(row.element);
    // `offsetLeft`/`offsetWidth` are integer-rounded by the engine (the character indent is 355.2px,
    // reported as 355), so these compare within one rounding step rather than exactly. Sub-pixel
    // precision is not lost from the measurement overall: the per-character cell checks below read
    // `getBoundingClientRect()`, which is fractional.
    expect(
      Math.abs(row.offsetLeft - expected.left),
      `${label}: ${row.element} left edge (expected ${expected.left}, got ${row.offsetLeft})`,
    ).toBeLessThanOrEqual(OFFSET_ROUNDING_TOLERANCE_PX);
    expect(
      Math.abs(row.offsetWidth - expected.width),
      `${label}: ${row.element} measure (expected ${expected.width}, got ${row.offsetWidth})`,
    ).toBeLessThanOrEqual(OFFSET_ROUNDING_TOLERANCE_PX);
  }

  // Calibrate one cell from the first row that has at least two characters on its first line.
  const calibration = rows.find((row) => row.cells.length > 1);
  if (!calibration) throw new Error(`${label}: no row with measurable characters.`);
  const cellWidth = calibration.cells[1]!.dx - calibration.cells[0]!.dx;
  // The rendered pitch is Courier Prime's own at the specified 12pt (a 16px em), scaled by the zoom in
  // effect. A fallback typeface or hinted whole-pixel advances would fail here.
  expect(cellWidth, `${label}: rendered character cell`).toBeCloseTo(
    MEASURED_COURIER_PRIME_ADVANCE_EM * (TYPE_SIZE_PT * (4 / 3)) * scale,
    1,
  );

  for (const row of rows) {
    const lineHeight = row.lineHeightPx * scale;
    const first = row.cells[0];
    for (const [index, cell] of row.cells.entries()) {
      const column = cell.dx / cellWidth;
      expect(
        Math.abs(column - Math.round(column)),
        `${label}: ${row.element} character ${index} off its column (dx ${cell.dx}, cell ${cellWidth})`,
      ).toBeLessThan(0.05);
      // Measured from the row's own first character, not from its box top. A character's client rect is
      // its ink box, and at the specification's `line-height: 1` Courier Prime's ascent and descent
      // together slightly exceed one em, so every character's ink sits about a pixel above the line box
      // -- a constant offset shared by every line in the row, and nothing to do with the grid. What the
      // grid requires is that successive lines sit exactly one line height apart, which is what this
      // measures.
      const line = (cell.dy - first!.dy) / lineHeight;
      expect(
        Math.abs(line - Math.round(line)),
        `${label}: ${row.element} character ${index} off its line (dy ${cell.dy}, first ${first!.dy}, line ${lineHeight})`,
      ).toBeLessThan(0.05);
    }
  }

  // Control pairs: identical text, one marked, one not.
  for (const [markedId, controlId] of [
    [uuidFor(3), uuidFor(2)],
    [uuidFor(4), uuidFor(5)],
  ]) {
    const marked = rows.find((row) => row.blockId === markedId);
    const control = rows.find((row) => row.blockId === controlId);
    expect(marked, `${label}: marked row ${markedId}`).toBeDefined();
    expect(control, `${label}: control row ${controlId}`).toBeDefined();
    if (!marked || !control) continue;
    expect(marked.text, `${label}: control pair text`).toBe(control.text);
    expect(marked.mark, `${label}: marked row carries a mark`).not.toBe('unchanged');
    expect(control.mark, `${label}: control row carries no mark`).toBe('unchanged');
    expect(marked.offsetLeft).toBe(control.offsetLeft);
    expect(marked.offsetWidth).toBe(control.offsetWidth);
    expect(marked.offsetHeight, `${label}: marked row line count`).toBe(control.offsetHeight);
    expect(marked.cells.length).toBe(control.cells.length);
    for (const [index, cell] of marked.cells.entries()) {
      const controlCell = control.cells[index]!;
      expect(
        cell.dx,
        `${label}: marked character ${index} horizontal position differs from its unmarked twin`,
      ).toBeCloseTo(controlCell.dx, 2);
      expect(
        cell.dy,
        `${label}: marked character ${index} vertical position differs from its unmarked twin`,
      ).toBeCloseTo(controlCell.dy, 2);
    }
  }
}

test('the inline diff reads as the document with changes marked in place, and displaces no character of the grid at either zoom', async ({
  page,
}) => {
  test.setTimeout(90_000);
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.stack ?? err.message}`));
  await createAndOpenScreenplay(page);
  const screenplayId = screenplayIdFromUrl(page);
  const projectId = /\/projects\/([0-9a-f-]+)/u.exec(page.url())?.[1];
  if (!projectId) throw new Error(`Could not find a project id in ${page.url()}.`);

  // The editor's chrome, measured while the real editor is still the open screen -- the baseline the
  // comparison's own chrome is held against below. Nothing here depends on the manuscript typeface
  // (the chrome is IBM Plex Sans and every chrome row is a declared grid track), so this does not
  // need `requireCourierPrime`; the sheet measurements further down do, and ask for it there.
  // One real keystroke before the editor's own chrome is read, so Undo is genuinely live there. With an
  // untouched document Undo is disabled on the editor too -- for an entirely unrelated reason -- and a
  // contrast between "disabled because there is nothing to undo" and "disabled because this screen
  // cannot edit anything" would prove nothing about the second.
  await page.getByRole('textbox', { name: 'Screenplay editing canvas' }).click();
  await page.keyboard.type('INT. CONTROL ROOM - NIGHT');
  await expect(page.getByRole('button', { name: 'Undo local change' })).toBeEnabled();

  const editorChrome = await measureChrome(page);
  const editorFrame = await enumerateChrome(page);

  const fixture = inlineDiffFixture(screenplayId);
  await page.route('**/api/screenplays/*/revisions/*/diff**', async (route) => {
    await route.fulfill({
      body: JSON.stringify(fixture),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto(
    `/projects/${projectId}/screenplays/${screenplayId}/revisions/${fixture.older.id}/diff`,
  );
  await expect(page.getByRole('note')).toContainText('not a paginated script');
  await requireCourierPrime(page);
  await expect(page.locator('[data-diff-row="block"]').first()).toBeVisible();

  // One continuous read, in document order, with each change marked where it happened.
  const reading = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-diff-row]')).map((row) => {
      const kind = row.getAttribute('data-diff-row');
      if (kind === 'scene-move') return `move-${row.getAttribute('data-diff-move-place')}`;
      const marked = Array.from(row.querySelectorAll('del, ins'))
        .map((mark) => `[${mark.tagName === 'DEL' ? '-' : '+'}${mark.textContent ?? ''}]`)
        .join('');
      return `${row.getAttribute('data-diff-mark')}${marked}`;
    }),
  );
  expect(reading).toEqual([
    'unchanged',
    'unchanged',
    // Removal before addition at the same position, the conventional unified-diff order within a hunk.
    'removed[-A spare beat that will be cut.]',
    `added[+${LONG_ACTION_LINE}]`,
    'unchanged',
    'unchanged',
    'unchanged',
    'changed[-window ][+doorway ]',
    'unchanged',
    'move-origin',
    'unchanged',
    'unchanged',
    'move-destination',
    'unchanged',
    'unchanged',
  ]);

  // The relocated scene is shown as moved at both ends, and nowhere as a deletion plus an insertion.
  const movedMarkers = page.locator('[data-diff-row="scene-move"]');
  await expect(movedMarkers).toHaveCount(2);
  await expect(movedMarkers.first()).toContainText('Scene moved from here: EXT. ROOFTOP - DAWN');
  await expect(movedMarkers.last()).toContainText('Scene moved to here: EXT. ROOFTOP - DAWN');
  const relocated = page
    .locator('[data-diff-block-id]')
    .filter({ hasText: 'Wind lifts the tarp.' });
  await expect(relocated.locator('del, ins')).toHaveCount(0);

  // The non-colour cues, as the real browser computes them.
  const cues = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      return getComputedStyle(element).textDecorationLine;
    };
    const gutter = (mark: string) =>
      document.querySelector<HTMLElement>(`[data-diff-mark="${mark}"] .diff-gutter-glyph`)
        ?.textContent ?? null;
    const gutterLeftOfText = () => {
      const row = document.querySelector<HTMLElement>('[data-diff-mark="added"]');
      const glyph = row?.querySelector<HTMLElement>('.diff-gutter');
      if (!row || !glyph) return null;
      return glyph.getBoundingClientRect().right <= row.getBoundingClientRect().left;
    };
    const background = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(
        getComputedStyle(element).backgroundColor,
      );
      return match ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) } : null;
    };
    return {
      del: read('.diff-manuscript del'),
      ins: read('.diff-manuscript ins'),
      delBackground: background('.diff-manuscript del'),
      insBackground: background('.diff-manuscript ins'),
      addedGlyph: gutter('added'),
      removedGlyph: gutter('removed'),
      changedGlyph: gutter('changed'),
      gutterLeftOfText: gutterLeftOfText(),
    };
  });
  expect(cues.del).toContain('line-through');
  expect(cues.ins).toContain('underline');

  // The two marks must not merely differ -- they must differ in *hue*, removed reading as red and
  // added as blue. Asserting only inequality would have passed the arrangement this replaced, where
  // removed was `--surface-12` (#c9d0d4) against added's #d9e9ef: two desaturated blue-greys a
  // measured dE 8.9 apart, technically different and, at a glance on a page where the two marks are
  // rarely adjacent, the same highlight. Channel dominance is the cheapest assertion that cannot be
  // satisfied by any two greys, and it fails immediately if the removed mark is ever folded back onto
  // a shared neutral token. Colour is still never the only cue -- the strikethrough, the gutter glyph
  // and the visually-hidden word are each asserted above and below.
  const { delBackground, insBackground } = cues;
  if (!delBackground || !insBackground)
    throw new Error('Expected both marks to paint a background.');
  expect(delBackground.r).toBeGreaterThan(delBackground.b);
  expect(insBackground.b).toBeGreaterThan(insBackground.r);
  expect(cues.addedGlyph).toBe('+');
  expect(cues.removedGlyph).toBe('-');
  expect(cues.changedGlyph).toBe('~');
  expect(cues.gutterLeftOfText).toBe(true);

  // It is visibly a comparison, not a paginated script: the caveat says so, and no page boundary or
  // page number is drawn, because this view cannot compute a truthful one.
  await expect(page.getByRole('note')).toContainText('not a paginated script');
  await expect(page.locator('.page-number')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.page.diff-manuscript')!).backgroundImage,
    ),
  ).toBe('none');

  // And nothing here can write to the document.
  await expect(page.getByRole('textbox', { name: 'Screenplay editing canvas' })).toHaveCount(0);

  /**
   * **One application, two screens.** The chrome the comparison resolves to in this real browser is
   * the editor's chrome, not a second one that resembles it.
   */
  const comparisonChrome = await measureChrome(page);
  const comparisonFrame = await enumerateChrome(page);

  // 1. The same title bar. Same box, same resolved look, same identity, same way out -- and the same
  //    document named, with only the kind of view differing.
  expect(comparisonChrome.titlebar.height).toBeCloseTo(editorChrome.titlebar.height, 1);
  expect(comparisonChrome.titlebar.top).toBeCloseTo(editorChrome.titlebar.top, 1);
  expect(comparisonChrome.titlebar.look).toEqual(editorChrome.titlebar.look);
  expect(comparisonChrome.titlebar.brandHref).toBe(editorChrome.titlebar.brandHref);
  expect(comparisonChrome.titlebar.brandLabel).toBe(editorChrome.titlebar.brandLabel);
  expect(comparisonChrome.titlebar.brandMark).toBe(editorChrome.titlebar.brandMark);
  expect(comparisonChrome.titlebar.accountBadge).toBe(editorChrome.titlebar.accountBadge);
  expect(editorChrome.titlebar.titleType).toBe('Screenplay');
  expect(comparisonChrome.titlebar.titleType).toBe('Comparison');
  expect(comparisonChrome.titlebar.documentTitle).toBe('Diff script Comparison');
  expect(editorChrome.titlebar.documentTitle).toContain('Diff script');

  // 2. The same banner mechanics as the editor's read-only banners: the editor's own
  //    `.readonly-banner` class, the shell's `auto` row opened for it, and that row sized to the
  //    banner's own height -- not a fixed row borrowed from a neighbour, which is the exact
  //    production defect `.application`'s comment in styles.css records.
  expect(editorChrome.hasBannerRow).toBe(false);
  expect(editorChrome.banner).toBeNull();
  expect(editorChrome.declaredRows[2]).toBe(0);
  expect(comparisonChrome.hasBannerRow).toBe(true);
  expect(comparisonChrome.banner?.className).toContain('readonly-banner');
  expect(comparisonChrome.banner?.role).toBe('status');
  expect(comparisonChrome.banner?.height).toBeGreaterThan(0);
  expect(comparisonChrome.declaredRows[2]).toBeCloseTo(comparisonChrome.banner!.height, 1);
  // Exactly where the editor's own banner row sits in the same track list: below the menubar, above
  // the toolbar. (It is no longer directly below the title bar -- the comparison now fills the menubar
  // row too, which is this pass's whole point.)
  expect(comparisonChrome.banner?.top).toBeCloseTo(comparisonChrome.menubar.bottom, 1);
  expect(comparisonChrome.toolbar.top).toBeCloseTo(comparisonChrome.banner!.bottom, 1);
  expect(comparisonChrome.workspace.top).toBeCloseTo(comparisonChrome.toolbar.bottom, 1);
  // And the whole stack still tiles the viewport on both screens, with the status bar's bottom edge as
  // the fold -- the number the displaced-row defect `.application`'s comment records got wrong by 490px.
  for (const chrome of [editorChrome, comparisonChrome]) {
    expect(chrome.titlebar.top).toBeCloseTo(0, 1);
    expect(chrome.menubar.top).toBeCloseTo(chrome.titlebar.bottom, 1);
    expect(chrome.workspace.top).toBeCloseTo(chrome.toolbar.bottom, 1);
    expect(chrome.statusbar.top).toBeCloseTo(chrome.workspace.bottom, 1);
    expect(chrome.statusbar.bottom).toBeCloseTo(chrome.viewportHeight, 0);
  }
  // The editor has no banner, so its toolbar follows its menubar directly.
  expect(editorChrome.toolbar.top).toBeCloseTo(editorChrome.menubar.bottom, 1);

  // 3. The rows each screen actually fills, stated from the resolved track list. Both are the same
  //    six-track grid, and -- this pass's decision, overriding the previous one -- the comparison now
  //    fills every row the editor does, menubar and toolbar included. Only the banner row differs,
  //    because only the comparison has a banner to put in it.
  expect(editorChrome.declaredRows).toHaveLength(6);
  expect(comparisonChrome.declaredRows).toHaveLength(6);
  for (const row of [0, 1, 3, 5]) {
    expect(comparisonChrome.declaredRows[row]).toBeCloseTo(editorChrome.declaredRows[row]!, 1);
  }
  expect(comparisonChrome.declaredRows[1]).toBeCloseTo(31, 1);
  expect(comparisonChrome.declaredRows[3]).toBeCloseTo(47, 1);
  await expect(page.locator('.menubar')).toHaveCount(1);
  await expect(page.locator('.toolbar')).toHaveCount(1);

  // 4. The same workspace frame: the Navigator, the one scrolling region, and the Inspector, in that
  //    order, on both screens -- which is the structural half of what the owner was missing. The
  //    region itself fills the row, scrolls its own content, over the same canvas colour, and the
  //    outer document never scrolls on either screen.
  expect(comparisonChrome.scrollRegionIsOnlyWorkspaceChild).toBe(false);
  expect(comparisonFrame.workspaceChildren).toEqual([
    'panel navigator',
    'diff-manuscript-region',
    'panel inspector',
  ]);
  expect(editorFrame.workspaceChildren).toEqual([
    'panel navigator',
    'editor-region',
    'panel inspector',
  ]);
  expect(comparisonChrome.scrollRegion.look).toEqual(editorChrome.scrollRegion.look);
  expect(comparisonChrome.scrollRegion.height).toBeCloseTo(comparisonChrome.workspace.height, 1);
  expect(comparisonChrome.scrollRegion.scrollHeight).toBeGreaterThan(
    comparisonChrome.scrollRegion.clientHeight,
  );
  expect(comparisonChrome.applicationHeight).toBeCloseTo(comparisonChrome.viewportHeight, 0);
  expect(comparisonChrome.documentScrollHeight).toBeLessThanOrEqual(
    comparisonChrome.viewportHeight,
  );
  expect(editorChrome.documentScrollHeight).toBeLessThanOrEqual(editorChrome.viewportHeight);

  // 5. The same status bar, filled rather than omitted -- and the status bar's bottom edge is still
  //    the fold on both screens, which is the number the displaced-row defect got wrong.
  expect(comparisonChrome.statusbar.height).toBeCloseTo(editorChrome.statusbar.height, 1);
  expect(comparisonChrome.statusbar.look).toEqual(editorChrome.statusbar.look);
  expect(comparisonChrome.statusbar.top).toBeCloseTo(comparisonChrome.workspace.bottom, 1);
  expect(comparisonChrome.statusbar.bottom).toBeCloseTo(comparisonChrome.viewportHeight, 0);
  expect(editorChrome.statusbar.bottom).toBeCloseTo(editorChrome.viewportHeight, 0);
  // What it carries is the one report an unpaginated comparison is entitled to make: this
  // comparison's own change counts, exactly and only. Nothing about pagination -- a page count is
  // the figure a view that shows removed lines in place cannot state truthfully, and it is the
  // figure the editor's own bar neighbours, so its absence here is deliberate rather than
  // incidental (see the route's `statusbar` comment). "1 scene moved" is a change, not a count of
  // the document's scenes.
  const statusText = await page.locator('.statusbar .diff-summary').innerText();
  expect(statusText).toBe('1 line added, 1 line removed, 1 line changed, 1 scene moved');
  expect(await page.locator('.statusbar').innerText()).not.toMatch(/page/iu);
  // And the bar's left-hand slot carries the Navigator's selected scene, exactly as the editor's does.
  await expect(page.locator('.statusbar [aria-label="Active scene"]')).toHaveText(
    'INT. CONTROL ROOM - NIGHT',
  );

  /**
   * 6. **The frame, enumerated on both screens and asserted equal.** This is the assertion the owner's
   *    "it still just feels like a free floating thing, not like part of the greater product" reduces
   *    to, and the reason this pass does not rest on a judgement: the toolbar's control set, the
   *    menubar's children, the File menu's items, both panels' headings and affordances, and the
   *    status bar's shape are read off each screen (`enumerateChrome`) and compared. The only
   *    differences permitted are disabled state and what the panels hold -- each of which is then
   *    stated exactly, rather than left as an unchecked remainder.
   */

  // The toolbar: the same controls, in the same order, of the same element kind, under the same
  // accessible names. Spelled out as a literal as well as compared, so a silent rename or reordering
  // on both screens at once is still visible here.
  expect(editorFrame.toolbarControls.map((control) => control.name)).toEqual([
    'Undo local change',
    'Redo local change',
    'Active screenplay element',
    'Zoom out',
    'Zoom level',
    'Zoom preset',
    'Zoom in',
    'Toggle element labels',
    'Toggle continuous scroll',
    'Toggle navigator',
    'Toggle inspector',
  ]);
  expect(comparisonFrame.toolbarControls.map((control) => [control.tag, control.name])).toEqual(
    editorFrame.toolbarControls.map((control) => [control.tag, control.name]),
  );

  // The one permitted difference, stated exactly: which of those controls is really disabled. Read
  // from the DOM `disabled` property, so a control merely styled to look unavailable counts as live
  // here and this assertion fails.
  expect(
    editorFrame.toolbarControls
      .filter((control) => control.disabled)
      .map((control) => control.name),
  ).toEqual([
    // Nothing has been undone yet, so there is nothing to redo. An honest, unrelated disabled state --
    // and evidence that the shared component reports its caller's state rather than a fixed set.
    'Redo local change',
  ]);
  expect(
    comparisonFrame.toolbarControls
      .filter((control) => control.disabled)
      .map((control) => control.name),
  ).toEqual([
    'Undo local change',
    'Redo local change',
    'Active screenplay element',
    'Toggle element labels',
    'Toggle continuous scroll',
  ]);

  // The zoom preset list is identical on both screens -- one authority (`zoomPresets.ts`), not two --
  // and the two fit modes are the only options the comparison disables, because they are the only ones
  // that need a measured available area it has no recompute lifecycle for.
  expect(comparisonFrame.zoomPresetOptions.map((option) => option.value)).toEqual(
    editorFrame.zoomPresetOptions.map((option) => option.value),
  );
  expect(editorFrame.zoomPresetOptions.filter((option) => option.disabled)).toEqual([]);
  expect(
    comparisonFrame.zoomPresetOptions
      .filter((option) => option.disabled)
      .map((option) => option.value),
  ).toEqual(['fit-width', 'fit-page']);

  // The element selector's own options are the one inventory that legitimately differs, and this says
  // so rather than leaving it unstated: a comparison has no caret, so it has no active element, and a
  // greyed-out "Scene Heading" would read as the current one. The control is the same control, in the
  // same place, under the same name -- asserted above -- and it offers one disabled placeholder
  // instead of seven unreachable choices behind a permanently disabled select.
  expect(editorFrame.elementSelectOptions.length).toBeGreaterThan(1);
  expect(editorFrame.elementSelectOptions.every((option) => !option.disabled)).toBe(true);
  expect(comparisonFrame.elementSelectOptions).toEqual([{ disabled: true, value: '' }]);

  // The menubar: the same children in the same order -- the File menu, the five labels plan.md still
  // has to activate, the spacer, and the canvas toggle -- and the same controls by accessible name.
  expect(comparisonFrame.menubarChildren).toEqual(editorFrame.menubarChildren);
  expect(comparisonFrame.menubarControls.map((control) => control.name)).toEqual(
    editorFrame.menubarControls.map((control) => control.name),
  );
  expect(editorFrame.menubarControls.filter((control) => control.disabled)).toEqual([]);
  expect(comparisonFrame.menubarControls.filter((control) => control.disabled)).toEqual([]);

  // The File menu: the same item set, with the comparison disabling every one that has no meaning on a
  // comparison of two stored snapshots and leaving the one that does.
  expect(comparisonFrame.fileItems.map((item) => item.name)).toEqual(
    editorFrame.fileItems.map((item) => item.name),
  );
  expect(editorFrame.fileItems.filter((item) => item.disabled)).toEqual([]);
  expect(
    comparisonFrame.fileItems.filter((item) => item.disabled).map((item) => item.name),
  ).toEqual([
    'Document settings…',
    'Save named revision…',
    'Download FDX…',
    'Download DOCX…',
    'Download PDF…',
  ]);

  // Both panels, open by default on both screens, at the same width, with the same heading, the same
  // close affordance, and -- in the Navigator -- the same two tabs with the same one selected.
  expect(comparisonFrame.navigator?.heading).toBe(editorFrame.navigator?.heading);
  expect(comparisonFrame.navigator?.closeButton).toBe(editorFrame.navigator?.closeButton);
  expect(comparisonFrame.navigator?.tabs).toEqual(editorFrame.navigator?.tabs);
  expect(comparisonFrame.navigator?.hasFooter).toBe(editorFrame.navigator?.hasFooter);
  expect(comparisonFrame.navigator?.width).toBeCloseTo(editorFrame.navigator!.width, 1);
  expect(comparisonFrame.inspector?.heading).toBe(editorFrame.inspector?.heading);
  expect(comparisonFrame.inspector?.closeButton).toBe(editorFrame.inspector?.closeButton);
  expect(comparisonFrame.inspector?.width).toBeCloseTo(editorFrame.inspector!.width, 1);

  // What the panels *hold* is the other permitted difference, and it is content rather than chrome:
  // the editor's Inspector describes this document, the comparison's describes the comparison.
  expect(editorFrame.inspector?.sectionHeadings).toEqual(['Active element', 'Scope']);
  expect(comparisonFrame.inspector?.sectionHeadings).toEqual(['Comparing', 'Changes', 'Legend']);

  /*
   * The status bar: the same two slots, in the same order, with the same accessible label on the first --
   * the active scene the Navigator selected, then the centre report.
   *
   * The editor carries one slot the comparison does not, and this states it rather than leaving it as an
   * unchecked remainder: the presence indicator. A stored snapshot has no participants, and an empty or
   * invented presence area would be the one piece of chrome on this screen reporting something untrue.
   * It is the third and last permitted difference between the two frames, alongside disabled state and
   * panel contents.
   */
  expect(
    editorFrame.statusbarChildren.map((child) => [child.tag, child.className, child.label]),
  ).toEqual([
    ['SPAN', '', 'Active scene'],
    ['SPAN', 'status-center', null],
    ['SPAN', 'participant-indicator', 'Also here: Writer'],
  ]);
  expect(
    comparisonFrame.statusbarChildren.map((child) => [child.tag, child.className, child.label]),
  ).toEqual([
    ['SPAN', '', 'Active scene'],
    ['SPAN', 'status-center', null],
  ]);

  // And each chrome row renders at the same height on both screens.
  expect(comparisonFrame.rowHeights.menubar).toBeCloseTo(editorFrame.rowHeights.menubar, 1);
  expect(comparisonFrame.rowHeights.toolbar).toBeCloseTo(editorFrame.rowHeights.toolbar, 1);
  expect(comparisonFrame.rowHeights.statusbar).toBeCloseTo(editorFrame.rowHeights.statusbar, 1);

  // The grid, measured at the default zoom and at one non-default zoom.
  const atDefault = await measureDiffGrid(page);
  expect(atDefault.scale).toBeCloseTo(1, 3);
  assertCharacterGrid(atDefault, 'zoom 100%');

  // The toolbar's own zoom preset, the same control by the same accessible name the editor's own
  // zoom-mode test drives (`page-rendering-persistence.spec.ts`) -- not a one-off `<select>` in the
  // banner, which is what this view had before it had a toolbar.
  await page.getByLabel('Zoom preset').selectOption('50');
  await expect(page.getByLabel('Zoom level')).toHaveText('50%');
  await expect.poll(async () => (await measureDiffGrid(page)).scale).toBeCloseTo(0.5, 3);
  const atHalf = await measureDiffGrid(page);
  assertCharacterGrid(atHalf, 'zoom 50%');

  // Zoom is a visual scale only: the unscaled layout boxes are byte-identical across the two zooms,
  // which is the same invariant every other zoom mechanism in this app is held to.
  expect(atHalf.rows.map((row) => [row.offsetLeft, row.offsetWidth, row.offsetHeight])).toEqual(
    atDefault.rows.map((row) => [row.offsetLeft, row.offsetWidth, row.offsetHeight]),
  );
});
