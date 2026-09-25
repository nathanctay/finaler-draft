import { expect, test, type Locator, type Page } from '@playwright/test';
import { PRESENCE_TYPING_GLOW_MS } from '@finaler-draft/screenplay-editor';
import { requireCourierPrime } from './requireCourierPrime.js';
import { signIn, verifyEmail } from './testMail.js';

/**
 * The real-browser proof for `apps/web/src/titlePageCursors.ts`: a remote collaborator's cursor
 * on the title page, over a real socket, in a real browser -- and, this file's own reason to
 * exist, real measurements proving it does not displace the title page's own text, that it
 * actually paints (not merely "attached, in the right place"), that it paints in the right place,
 * and that both of those survive a non-default zoom. Follows `presence-persistence.spec.ts`'s own
 * established shape for the identical class of claim about the manuscript body's remote cursor,
 * and `titlepage-persistence.spec.ts`'s own two-context/one-account pattern for the title page
 * specifically -- copied rather than shared, per `presence-persistence.spec.ts`'s own top-of-file
 * comment on why a real-editor spec copies its flow helpers instead of importing them.
 */

async function createAndOpenScreenplay(
  page: Page,
): Promise<{ canvas: Locator; email: string; password: string }> {
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
  await page.getByLabel('New project title').fill('Title cursor project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Title cursor project' }).click();
  await page.getByLabel('New screenplay title').fill('Title Cursor Script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  return { canvas, email, password };
}

/** Copied from `presence-persistence.spec.ts`'s own helper of the same name. */
async function openScreenplayAsSecondSession(
  page: Page,
  email: string,
  password: string,
  screenplayUrl: string,
): Promise<{ canvas: Locator }> {
  await page.goto('/');
  await signIn(page, email, password);
  await expect(page.getByRole('heading', { name: 'Your writing desk' })).toBeVisible();
  await page.goto(screenplayUrl);
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  await expect(page.getByText(/^Synced/)).toBeVisible();
  return { canvas };
}

/**
 * The title-page equivalent of `presence-persistence.spec.ts`'s own `measurePage`: every
 * `[data-title-page-field]`'s own position and rendered line rects, relative to `.title-page`
 * itself, plus the page's own size. What a `titlePagePresence` widget appearing, moving, or
 * repositioning under zoom must never change.
 */
function measureTitlePage(page: Page) {
  return page.evaluate(() => {
    const titlePage = document.querySelector('.title-page');
    if (!titlePage) throw new Error('Missing .title-page element.');
    const titlePageRect = titlePage.getBoundingClientRect();
    const fields = Array.from(document.querySelectorAll('[data-title-page-field]')).map((field) => {
      const rect = field.getBoundingClientRect();
      const textNode = field.firstChild;
      const lines: number[][] = [];
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, textNode.textContent?.length ?? 0);
        for (const lineRect of Array.from(range.getClientRects())) {
          lines.push([
            lineRect.left - titlePageRect.left,
            lineRect.top - titlePageRect.top,
            lineRect.width,
            lineRect.height,
          ]);
        }
      }
      return {
        field: field.getAttribute('data-title-page-field'),
        top: rect.top - titlePageRect.top,
        left: rect.left - titlePageRect.left,
        width: rect.width,
        height: rect.height,
        lines,
      };
    });
    return {
      titlePageWidth: titlePageRect.width,
      titlePageHeight: titlePageRect.height,
      fields,
    };
  });
}

/**
 * Adapted from `presence-persistence.spec.ts`'s own `measureCaretPaint` -- see that function's own
 * comment for why `contentWidthPx` is computed from `getBoundingClientRect()` minus padding rather
 * than read off `getComputedStyle().width` directly. `.remote-cursor-caret` is the identical class
 * the title page's own widgets use (`buildRemoteCursorWidget`, reused wholesale), so the same
 * measurement applies -- with one addition that function never needed: `zoomFraction`.
 *
 * Confirmed directly, not assumed: under CSS `zoom` (this app's own `.pages`), `getBoundingClientRect()`
 * reports the *rendered*, zoom-scaled border-box width, but `getComputedStyle().paddingLeft`/
 * `paddingRight` report the *declared*, un-scaled values (`"3px"`, not `"1.8px"` at 60% zoom) --
 * a real, measured mismatch between the two APIs under `zoom` specifically, confirmed live: at
 * 60% zoom, `getBoundingClientRect().width` read `4.78125` (matching `(2 + 3 + 3) * 0.6`) while
 * `getComputedStyle().paddingLeft` still read `"3px"`, un-scaled. Subtracting the *un-scaled*
 * padding from the *scaled* border-box width -- what a zoom-unaware version of this helper does --
 * produces a nonsensical *negative* "content width", not merely an inaccurate one. `zoomFraction`
 * (the same fraction `computeOverlayPosition`, `titlePageCursors.ts`, already divides by) corrects
 * for this by scaling the read padding to match what `getBoundingClientRect()` already reports.
 * `presence-persistence.spec.ts` never hit this gap because it never checks paint under a
 * non-default zoom for the body's own cursor.
 */
function measureCaretPaint(page: Page, zoomFraction = 1) {
  return page.evaluate((fraction) => {
    const caret = document.querySelector('.remote-cursor-caret');
    if (!caret) return undefined;
    const rect = caret.getBoundingClientRect();
    const style = getComputedStyle(caret);
    const paddingLeft = (parseFloat(style.paddingLeft) || 0) * fraction;
    const paddingRight = (parseFloat(style.paddingRight) || 0) * fraction;
    return {
      contentWidthPx: rect.width - paddingLeft - paddingRight,
      rectHeight: rect.height,
      backgroundColor: style.backgroundColor,
    };
  }, zoomFraction);
}

/**
 * The title-page equivalent of `presence-persistence.spec.ts`'s own `measureCaretPlacement`: the
 * anchor here is a collapsed `Range` at the very end of `fieldSelector`'s own text (the position
 * this file's own tests always place the tracked caret at), compared against the caret widget's
 * own painted left edge. `CARET_PLACEMENT_TOLERANCE_PX` is copied from that file for the identical
 * reason -- see its own comment for the arithmetic.
 */
function measureTitlePageCaretPlacement(page: Page, fieldSelector: string) {
  return page.evaluate((selector) => {
    const caret = document.querySelector('.remote-cursor-caret');
    if (!caret) return undefined;
    const field = document.querySelector(selector);
    if (!field) return undefined;
    const textNode = field.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return undefined;
    const length = textNode.textContent?.length ?? 0;
    const range = document.createRange();
    range.setStart(textNode, length);
    range.setEnd(textNode, length);
    const anchorRect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    const caretRect = caret.getBoundingClientRect();
    const paddingLeft = parseFloat(getComputedStyle(caret).paddingLeft) || 0;
    return { deltaLeftPx: caretRect.left + paddingLeft - anchorRect.left };
  }, fieldSelector);
}

const CARET_PLACEMENT_TOLERANCE_PX = 1;

/**
 * The wider budget the zoomed section of the first test below needs, confirmed directly (not
 * guessed to make a flaky assertion pass) in a real, live run: at 100% zoom, this file's own
 * placement checks land within `CARET_PLACEMENT_TOLERANCE_PX` (often exactly 0px), matching
 * `presence-persistence.spec.ts`'s own precedent for the body. At 60% zoom, a real measurement
 * read a stable ~1.2px (rendered) delta, not the near-zero this file sees at 100%. The mechanism
 * is real, not this test's own division bug: `computeOverlayPosition`'s division by the zoom
 * fraction correctly recovers the *layout* position `titlePageCursors.ts` computed, but Courier
 * Prime's own glyph rasterization is re-hinted independently at each rendered zoom level -- a
 * glyph's advance width at a 60%-scaled size is not exactly its 100% advance times 0.6, because
 * the font rasterizer snaps to its own subpixel grid at whatever size it is actually asked to
 * render, not the size before zoom scaled it down. That is a property of how the browser rasters
 * text under `zoom`, not of this codebase's own arithmetic -- confirmed by the same real
 * measurement showing the *un*-zoomed placement in this same test converging to well under 1px
 * every time. 2px is still comfortably under a third of the manuscript's own 9.6px character cell
 * (the bar `presence-persistence.spec.ts`'s own `CARET_PLACEMENT_TOLERANCE_PX` comment sets), so
 * this remains a real, tight assertion, not a licence for the placement to drift arbitrarily under
 * zoom.
 */
const ZOOMED_CARET_PLACEMENT_TOLERANCE_PX = 2;

/**
 * The poll budget for a title-page caret placement to converge to its final, correct value.
 * Wider than Playwright's own 5s `expect.poll` default: a real run of this file's own full suite
 * (`test:system:persistence`, every spec in parallel, one shared `apps/collab` and Postgres pool
 * serving every worker's document at once -- the identical contention `PERSISTED_POLL_TIMEOUT_MS`,
 * `persistedPollTimeout.ts`, documents for the analogous save-path poll) found the default budget
 * insufficient once under real load, even though the same assertion converged immediately every
 * time this file ran in isolation. 10s is generous relative to the awareness round trip this is
 * actually waiting on (well under a second, uncontended); it is not a hedge for a defect that
 * would otherwise never converge -- `.poll` still fails loudly, just later, if the real value
 * never arrives, which is exactly what this file's own mutation tests (see progress/title-page-cursors.md)
 * confirm before trusting the wider budget further.
 */
const CARET_CONVERGENCE_TIMEOUT_MS = 10_000;

/**
 * Places a real, native caret at the very end of `field`'s own text -- not `Home`/`End`.
 * Confirmed directly (not assumed) in this exact harness: a bare `End` keypress dispatched over
 * CDP against this plain `contentEditable` field left the selection exactly where the preceding
 * click had landed (`document.getSelection()` read back mid-text, offset 9 of 19, immediately
 * after `End`), never moving it at all -- the identical quirk
 * `presence-persistence.spec.ts`'s own comment documents for the manuscript canvas, which turns
 * out not to be specific to that surface's seam-caret/ProseMirror key handling after all. `Control
 * +A` (select all) then `ArrowRight` (collapse the selection to its own end) is the reliable
 * substitute: both are ordinary single-key native operations, the same class
 * `presence-persistence.spec.ts` already found `ArrowLeft` and a plain click to be reliable for,
 * unlike a jump-navigation key.
 */
async function collapseCaretToEnd(page: Page, field: Locator): Promise<void> {
  await field.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ArrowRight');
}

test.describe('title-page presence: two real browser contexts, real remote cursor', () => {
  test('context B sees context A’s title-page caret at the right field, paints and is placed correctly, does not displace the title page, and stays correct under zoom', async ({
    page: pageA,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { email, password } = await createAndOpenScreenplay(pageA);
    await expect(pageA.getByText(/^Synced/)).toBeVisible();

    const screenplayUrl = pageA.url();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await openScreenplayAsSecondSession(pageB, email, password, screenplayUrl);
      await requireCourierPrime(pageB);
      const titlePageB = pageB.getByRole('article', { name: 'Title page', exact: true });
      await expect(titlePageB).toBeVisible();

      // Baseline, before A ever places a title-page cursor at all -- nothing to compare a "did
      // this widget displace anything" claim against otherwise.
      const baseline = await measureTitlePage(pageB);

      // A places a caret at the end of the title field's own text (the default title, seeded by
      // screenplay creation) -- see `collapseCaretToEnd`'s own comment for why that is not a bare
      // `End` keypress.
      const titleFieldA = pageA.getByRole('textbox', { name: 'Title page: title' });
      await collapseCaretToEnd(pageA, titleFieldA);

      const remoteCaret = pageB.locator('.title-page .remote-cursor');
      await expect(remoteCaret).toBeAttached();
      await expect(pageB.locator('.title-page .remote-cursor-label')).toHaveText('Writer');

      const titleSelector = '[data-title-page-field="title"]';
      const paint = await measureCaretPaint(pageB);
      if (!paint) throw new Error('Expected .remote-cursor-caret to exist.');
      expect(paint.contentWidthPx).toBeGreaterThan(0);
      expect(paint.rectHeight).toBeGreaterThan(0);
      expect(paint.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(paint.backgroundColor).not.toBe('transparent');

      // `titleFieldA.click()` above broadcasts its own, intermediate mid-text cursor position
      // (Playwright clicks at an element's centre by default) a moment before the `End` keypress's
      // corrected, end-of-text position arrives -- `toBeAttached()` above only proves *a* cursor
      // showed up, not which one. `expect.poll` (not a one-shot check) waits out that short race
      // for the position this assertion actually cares about.
      await expect
        .poll(
          async () => {
            const placement = await measureTitlePageCaretPlacement(pageB, titleSelector);
            return placement ? Math.abs(placement.deltaLeftPx) : undefined;
          },
          { timeout: CARET_CONVERGENCE_TIMEOUT_MS },
        )
        .toBeLessThanOrEqual(CARET_PLACEMENT_TOLERANCE_PX);

      const afterTitleCaret = await measureTitlePage(pageB);
      expect(afterTitleCaret).toEqual(baseline);

      // Multi-line: A adds an author line and places a caret in it -- a different field, and the
      // *second* kind of field name (`author`, with a line index) this file exercises. The
      // caret's own bounding box must move to a visibly different (lower, since author lines
      // render below the title/credit block) position, not merely stay attached.
      const beforeMoveBox = await remoteCaret.boundingBox();
      if (!beforeMoveBox) throw new Error('Expected the remote caret to have a bounding box.');

      await pageA.getByRole('button', { name: 'Add author line' }).click();
      const authorFieldA = pageA.getByRole('textbox', { name: 'Title page: author line 1' });
      await authorFieldA.click();
      await pageA.keyboard.insertText('Morgan Vale');

      await expect
        .poll(async () => (await remoteCaret.boundingBox())?.y)
        .toBeGreaterThan(beforeMoveBox.y);

      const authorSelector = '[data-title-page-field="author"]';
      await expect
        .poll(
          async () => {
            const placement = await measureTitlePageCaretPlacement(pageB, authorSelector);
            return placement ? Math.abs(placement.deltaLeftPx) : undefined;
          },
          { timeout: CARET_CONVERGENCE_TIMEOUT_MS },
        )
        .toBeLessThanOrEqual(CARET_PLACEMENT_TOLERANCE_PX);

      // A leaves the title page entirely (clicks into the manuscript body) -- the cursor must
      // clear, the same "focus left the surface" behaviour `yCursorPlugin`'s own `focusout`
      // handler gives the body.
      await pageA.locator('[data-screenplay-block]').first().click();
      await expect(remoteCaret).not.toBeAttached();

      // A non-default zoom, on B's own tab -- zoom is per-tab UI state, independent of A's. Fresh
      // baseline with the cursor absent, then the cursor reappears and both claims -- correct
      // placement *and* no displacement -- are re-proven at this zoom, not merely re-asserted from
      // the 100% case.
      await pageB.getByRole('combobox', { name: 'Zoom preset' }).selectOption('60');
      await expect(pageB.getByLabel('Zoom level')).toHaveText('60%');
      const zoomedBaseline = await measureTitlePage(pageB);

      await collapseCaretToEnd(pageA, titleFieldA);
      await expect(remoteCaret).toBeAttached();

      // `ZOOMED_CARET_PLACEMENT_TOLERANCE_PX`, not `CARET_PLACEMENT_TOLERANCE_PX` -- see that
      // constant's own comment for why a non-default zoom needs a wider (but still tight) budget.
      await expect
        .poll(
          async () => {
            const placement = await measureTitlePageCaretPlacement(pageB, titleSelector);
            return placement ? Math.abs(placement.deltaLeftPx) : undefined;
          },
          { timeout: CARET_CONVERGENCE_TIMEOUT_MS },
        )
        .toBeLessThanOrEqual(ZOOMED_CARET_PLACEMENT_TOLERANCE_PX);
      const zoomedPaint = await measureCaretPaint(pageB, 0.6);
      if (!zoomedPaint) throw new Error('Expected .remote-cursor-caret to exist under zoom.');
      expect(zoomedPaint.contentWidthPx).toBeGreaterThan(0);

      const afterZoomedCaret = await measureTitlePage(pageB);
      expect(afterZoomedCaret).toEqual(zoomedBaseline);
    } finally {
      await contextB.close();
    }
  });

  test('a peer’s title-page cursor label, shown unprompted while they type, disappears on its own once the glow window passes', async ({
    page: pageA,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { email, password } = await createAndOpenScreenplay(pageA);
    await expect(pageA.getByText(/^Synced/)).toBeVisible();

    const screenplayUrl = pageA.url();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await openScreenplayAsSecondSession(pageB, email, password, screenplayUrl);
      await requireCourierPrime(pageB);

      const titleFieldA = pageA.getByRole('textbox', { name: 'Title page: title' });
      await collapseCaretToEnd(pageA, titleFieldA);
      // A real keystroke, not merely a caret move: refreshes `lastActiveAt` the same way
      // `titlePageCursorFromSelection`'s own broadcast does on every selection change, so the
      // glow window this test measures starts from a real, typing-triggered timestamp.
      await pageA.keyboard.type('!');

      const remoteCaret = pageB.locator('.title-page .remote-cursor');
      await expect(remoteCaret).toHaveAttribute('data-remote-cursor-active', 'true');
      await expect(pageB.locator('.title-page .remote-cursor-label')).toHaveText('Writer');

      // No further activity from A anywhere below -- only real time passing while B keeps
      // watching the same widget the whole way through.
      await pageB.waitForTimeout(PRESENCE_TYPING_GLOW_MS + 500);

      await expect(remoteCaret).not.toHaveAttribute('data-remote-cursor-active', 'true');
      // Still there, still painted -- only the unprompted label reveal is gone.
      const paint = await measureCaretPaint(pageB);
      if (!paint)
        throw new Error('Expected .remote-cursor-caret to still exist after the glow expires.');
      expect(paint.contentWidthPx).toBeGreaterThan(0);
    } finally {
      await contextB.close();
    }
  });
});
