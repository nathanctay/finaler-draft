import { expect, test, type Locator, type Page } from '@playwright/test';
import { PRESENCE_TYPING_GLOW_MS } from '@finaler-draft/screenplay-editor';
import { requireCourierPrime } from './requireCourierPrime.js';
import { signIn, verifyEmail } from './testMail.js';

/**
 * The two-client browser proof slice 2's brief requires: a real remote cursor, rendered by a real
 * `HocuspocusProvider`/`Awareness` pair over a real socket, in a real browser -- and, the point of
 * this file, a real geometry measurement proving it displaces nothing. `measurePage` below is
 * copied verbatim from `page-rendering-persistence.spec.ts` (not imported -- that file's own
 * top-of-file comment explains why a real-editor spec copies rather than shares its flow helpers),
 * and is the established precedent this file follows rather than reinvents: the seam caret, the
 * page-break widgets, and SmartType's ghost/list overlays were each proven safe this same way
 * before being trusted, per that file's own module comment on why an "it looks fine" was wrong
 * four separate times in this codebase's history.
 *
 * Runs under `playwright.persistence.config.ts`, not the plain `test:system` gate, for the same
 * reason `page-rendering-persistence.spec.ts` and `persistence.spec.ts` do: it needs a real signed-
 * in writer, a real screenplay, and -- the thing this file adds -- a second real signed-in session
 * on the *same* account in a second browser context, all of which require the real API and a real,
 * disposable database this config's `webServer`s provide. It does not warrant a separate Playwright
 * config of its own: presence needs no different server settings than the persistence suite already
 * runs with (awareness is not affected by `FINALER_SYSTEM_TEST`'s shortened debounce -- that setting
 * only changes `onStoreDocument`'s timing, and awareness never reaches `onStoreDocument` at all --
 * see `presence never reaches the database` in `apps/collab/src/collaboration.integration.test.ts`),
 * so a second full stack (a second built web bundle, a second API, a second collab server) would
 * duplicate this config's own `webServer`s for no isolation benefit.
 *
 * Two browser *contexts*, one *account*: the brief asks for two real browser contexts on one
 * screenplay, not two different named collaborators -- this codebase has no user-facing way to add
 * a second real account to a project (see progress/collaboration-slice-2.md), and the property this
 * file measures (does a remote caret move a line) does not depend on the two sessions belonging to
 * different people. Signing the same account in twice, in two independent contexts, is exactly what
 * the owner's own manual verification did for the analogous check in
 * progress/collaboration-slice-1.md ("opened a second tab on the identical URL, same signed-in
 * session") -- the automated version of that same proof.
 *
 * Two tests, not one, after a real-browser check found the first version of this file incomplete
 * in two connected ways (progress/collaboration-slice-2.md's follow-up section has the full
 * account): the geometry check alone (`measurePage`) proves a caret does not displace anything,
 * but says nothing about whether it is actually *visible* -- an element with a zero-area painted
 * region satisfies "displaces nothing" perfectly. `measureCaretPaint` below closes that gap, and
 * both tests use it. The second test covers the other shape a real-browser check surfaced: a peer
 * already connected and positioned *before* the second context ever joins, rather than only a peer
 * who moves after both are already open.
 *
 * A third gap, found the same way, one round later: "painted" and "painted in the right place"
 * are also two different claims. `measureCaretPlacement` below closes that one -- see its own
 * comment for the mechanism (a padding-induced 3px rightward shift) and `styles.css`'s own comment
 * on `.remote-cursor-caret` for the fix.
 *
 * A fourth: the third test in this file closes the gap between "the label appears on activity"
 * and "the label *stops* appearing once activity is no longer recent" -- a real, live check found
 * it permanently stuck on, once lit, for a peer's entire connection. See
 * `packages/screenplay-editor/src/presence.ts`'s own `createGlowController` comment for the
 * confirmed mechanism (y-prosemirror's `Decoration.widget` key reuse means the element is never
 * rebuilt again, so nothing that relies on a rebuild -- what an earlier version of this codebase
 * tried -- can ever take the attribute away).
 *
 * Four rounds, four distinct gaps in the same claim ("this caret is real") -- exists, then
 * visible, then correctly placed, then correctly *timed* -- each found only by measuring a real
 * browser, never by re-reading the CSS or the JS in isolation.
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
  await page.getByLabel('New project title').fill('Presence project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Presence project' }).click();
  await page.getByLabel('New screenplay title').fill('Presence script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  return { canvas, email, password };
}

/** Signs the same account in on a second, independent context and opens the identical screenplay
 * URL -- the second real collaborative session this file's whole premise depends on. */
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
 * Copied verbatim from `page-rendering-persistence.spec.ts`'s own `measurePage` -- see that
 * file's own doc comment for exactly what each field is for and why the three whole-page fields
 * (`scriptBodyHeight`, `scrollHeight`, `scrollWidth`) are what caught a real, otherwise-invisible
 * defect (a `position: static` overlay) before this file existed to catch the analogous one for a
 * remote cursor.
 */
function measurePage(page: Page) {
  return page.evaluate(() => {
    const pageEl = document.querySelector('.page');
    const region = document.querySelector('.editor-region');
    if (!pageEl || !region) {
      throw new Error('Missing .page or .editor-region element.');
    }
    const pageRect = pageEl.getBoundingClientRect();
    const blocks = Array.from(document.querySelectorAll('[data-screenplay-block]')).map((block) => {
      const rect = block.getBoundingClientRect();
      const textNode = block.firstChild;
      const lines: number[][] = [];
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, textNode.textContent?.length ?? 0);
        for (const lineRect of Array.from(range.getClientRects())) {
          lines.push([
            lineRect.left - pageRect.left,
            lineRect.top - pageRect.top,
            lineRect.width,
            lineRect.height,
          ]);
        }
      }
      return {
        id: block.getAttribute('data-block-id'),
        top: rect.top - pageRect.top,
        height: rect.height,
        lines,
      };
    });
    const scriptBody = pageEl.querySelector('.script-body');
    if (!scriptBody) {
      throw new Error('Missing .script-body element.');
    }
    return {
      blocks,
      spacerBottoms: Array.from(document.querySelectorAll('.page-break-spacer')).map(
        (spacer) => spacer.getBoundingClientRect().bottom - pageRect.top,
      ),
      pageHeight: pageRect.height,
      scriptBodyHeight: scriptBody.getBoundingClientRect().height,
      scrollHeight: region.scrollHeight,
      scrollWidth: region.scrollWidth,
    };
  });
}

/**
 * What the previous version of this file never checked, and should have: not merely that
 * `.remote-cursor-caret` exists and sits at the right place (`measurePage` above proves the
 * *sibling* geometry is undisturbed by it), but that the caret itself actually paints something.
 * An element with a zero-area painted region satisfies "exists" and "displaces nothing" equally
 * well whether or not anyone could ever see it -- which is exactly how this file's own geometry
 * test passed while the caret was, in a real browser, fully invisible (see `styles.css`'s
 * `.remote-cursor-caret` rule and its own comment on the `box-sizing` defect this measures
 * against).
 *
 * `contentWidthPx` is computed as `rect.width - paddingLeft - paddingRight`, deliberately *not*
 * read off `getComputedStyle(...).width` -- confirmed directly to matter, not assumed: under
 * `box-sizing: border-box` (this app's own global default, `* { box-sizing: border-box; }`),
 * `getComputedStyle().width` reports the *border-box* width, which the CSS box-sizing spec
 * requires the engine to grow to fit the padding when the declared width is smaller than it (the
 * exact mechanism of the original defect) -- so it reads as non-zero (6px, all padding) even when
 * the actual painted content box (what `background-clip: content-box` paints) is zero. A first
 * version of this helper read `getComputedStyle().width` directly and passed against the very
 * `box-sizing: border-box` mutation it was meant to catch, for exactly this reason -- the
 * assertion existed but could not fail, so it was not testing anything, and was rewritten to this
 * box-sizing-independent form once that was caught. `getBoundingClientRect().width` (the border
 * box, in every box-sizing model) minus the computed padding is the content width regardless of
 * which `box-sizing` is in effect, which is what makes this version actually sensitive to the
 * defect it exists to catch.
 */
function measureCaretPaint(page: Page) {
  return page.evaluate(() => {
    const caret = document.querySelector('.remote-cursor-caret');
    if (!caret) return undefined;
    const rect = caret.getBoundingClientRect();
    const style = getComputedStyle(caret);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    return {
      contentWidthPx: rect.width - paddingLeft - paddingRight,
      rectWidth: rect.width,
      rectHeight: rect.height,
      backgroundColor: style.backgroundColor,
    };
  });
}

/**
 * Exists because "painted" and "painted in the right place" are two different claims, and a real
 * browser check found this suite proved only the first one: `.remote-cursor-caret`'s
 * `padding-inline` (added for a wider hover target -- see that rule's own comment) shifted the
 * *painted* content stripe `padding-inline`'s own width to the right of the wrapper's anchor
 * position, while the wrapper itself stayed exactly on it. Measured directly in a real browser
 * (two contexts, not reasoned about): the delta was exactly 3px, matching the padding value
 * exactly -- confirming the mechanism before it was fixed with a compensating `margin-left` on the
 * caret (`styles.css`'s own comment on that rule has the full arithmetic).
 *
 * The "anchor" this compares against is a collapsed `Range` at the very end of the block's own
 * text node -- the same "end of text, widget appended after rather than splitting" position both
 * tests in this file already anchor the remote caret at (see the first test's own comment on why
 * mid-line and block-start positions are deliberately avoided). `caret.closest(
 * '[data-screenplay-block]')` finds the block the *currently rendered* caret belongs to, so this
 * one helper works unchanged whether the caret is at the end of the first block or the second.
 */
function measureCaretPlacement(page: Page) {
  return page.evaluate(() => {
    const caret = document.querySelector('.remote-cursor-caret');
    if (!caret) return undefined;
    const block = caret.closest('[data-screenplay-block]');
    if (!block) return undefined;
    let textNode: ChildNode | null = block.firstChild;
    while (textNode && textNode.nodeType !== Node.TEXT_NODE) textNode = textNode.nextSibling;
    if (!textNode) return undefined;
    const length = textNode.textContent?.length ?? 0;
    const range = document.createRange();
    range.setStart(textNode, length);
    range.setEnd(textNode, length);
    const anchorRect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    const caretRect = caret.getBoundingClientRect();
    const paddingLeft = parseFloat(getComputedStyle(caret).paddingLeft) || 0;
    return { deltaLeftPx: caretRect.left + paddingLeft - anchorRect.left };
  });
}

/**
 * How far the painted caret may sit from its anchor and still count as "in the right place". The
 * manuscript grid is 10 characters per inch (`NOMINAL_CHARACTERS_PER_INCH`,
 * `@finaler-draft/screenplay/pageFormat`), a 9.6px cell at 96dpi -- the defect this guards against
 * was a 3px shift, already enough to land the caret over the *following* character rather than
 * between the two it belongs between ("covering the i"). 1px is under a ninth of that cell,
 * comfortably tighter than the "a third of a character is not worth tolerating" bar this
 * assertion is held to, while still wide enough for ordinary sub-pixel layout rounding between two
 * independently measured rects (a DOM `Range` and an `Element`) -- live measurement after the fix
 * read an exact 0px delta at two different anchor positions, so this tolerance is slack purely for
 * measurement noise, not a hedge against the fix being approximate.
 */
const CARET_PLACEMENT_TOLERANCE_PX = 1;

const FIRST_LINE = 'A short first line.';
const SEEDED_LINE = 'A long enough action line for a remote caret to move between its two ends.';

test.describe('presence: two real browser contexts, real remote cursor', () => {
  test('context B sees context A’s caret move, and every block position in B is unchanged before and after', async ({
    page: pageA,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { canvas: canvasA, email, password } = await createAndOpenScreenplay(pageA);
    await expect(pageA.getByText(/^Synced/)).toBeVisible();

    // Two blocks, seeded from context A before context B ever opens, so B's very first render
    // already has real text to place a caret inside -- a freshly created screenplay's default
    // content is not this file's concern, and seeding it here keeps the property under test (a
    // caret moving moves nothing else) isolated from the unrelated, already-covered property that
    // ordinary typing changes geometry as expected (`page-rendering-persistence.spec.ts`).
    //
    // The caret is moved between the *end* of each block's own text, never into the middle of
    // one: `insertText` leaves the caret at the end of what it typed, and a `Decoration.widget`
    // there is appended after the block's one text node rather than splitting it, so
    // `measurePage`'s own `block.firstChild` text-node capture (copied verbatim above) still sees
    // the whole line intact. A mid-line (or block-start) position was deliberately not chosen:
    // confirmed directly, it splits that one text node into two DOM siblings around the widget,
    // which `measurePage`'s firstChild-only capture was never written to handle -- comparing a
    // full-line rect against a split partial-line rect fails for a reason that has nothing to do
    // with the widget actually displacing anything. Two blocks, not one, is what lets this file
    // prove a genuine *move* (not merely an appearance) while keeping the caret at a safe,
    // unsplit position throughout.
    await canvasA.click();
    await pageA.keyboard.insertText(FIRST_LINE);
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.insertText(SEEDED_LINE);

    const screenplayUrl = pageA.url();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      const { canvas: canvasB } = await openScreenplayAsSecondSession(
        pageB,
        email,
        password,
        screenplayUrl,
      );
      await expect(canvasB).toContainText(SEEDED_LINE);
      await requireCourierPrime(pageB);

      // Steady state already includes A's caret at the end of the second block (B synced after A
      // finished typing) -- waited for explicitly so the "before" snapshot below is not taken
      // mid-render.
      const remoteCaret = pageB.locator('.remote-cursor');
      await expect(remoteCaret).toBeAttached();
      await expect(pageB.locator('.remote-cursor-label')).toHaveText('Writer');
      const secondBlockBox = await remoteCaret.boundingBox();
      if (!secondBlockBox) throw new Error('Expected the remote caret to have a bounding box.');

      // Not merely attached and correctly placed -- actually painted. See `measureCaretPaint`'s
      // own comment for why "exists, in the right place" is not the same claim as "visible", and
      // why this file's earlier version passed without it.
      const paintSteady = await measureCaretPaint(pageB);
      if (!paintSteady) throw new Error('Expected .remote-cursor-caret to exist.');
      expect(paintSteady.contentWidthPx).toBeGreaterThan(0);
      expect(paintSteady.rectHeight).toBeGreaterThan(0);
      expect(paintSteady.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(paintSteady.backgroundColor).not.toBe('transparent');

      // Not merely painted -- painted in the right place. See `measureCaretPlacement`'s own
      // comment for the defect this guards: a padding-induced 3px rightward shift that put the
      // painted stripe over the following character instead of between the two it belongs
      // between.
      const placementSteady = await measureCaretPlacement(pageB);
      if (!placementSteady) throw new Error('Expected a measurable caret placement.');
      expect(Math.abs(placementSteady.deltaLeftPx)).toBeLessThanOrEqual(
        CARET_PLACEMENT_TOLERANCE_PX,
      );

      const before = await measurePage(pageB);
      expect(before.blocks.length).toBe(2);

      // No typing from here on in context A -- only a caret move, so any geometry change B
      // observes next can only be attributed to the remote cursor moving, not to co-edited text.
      // A click, not a key navigation: confirmed directly in this exact harness that a bare
      // `Home`/`End` keypress dispatched over CDP has no effect on the contenteditable selection
      // here (a quirk of synthetic key dispatch in this environment -- seamCaret.ts's own
      // `HORIZONTAL_SEAM_KEYS` handler never calls `preventDefault`, so there is nothing in this
      // codebase's own code to blame). A click past the end of a short single-line block's own
      // text, anywhere on that line, snaps to the nearest text boundary -- the end of that block's
      // content -- which is exactly the safe, unsplit position this move needs to land on.
      await pageA.bringToFront();
      const firstBlock = canvasA.locator('[data-screenplay-block]').first();
      const firstBlockBox = await firstBlock.boundingBox();
      if (!firstBlockBox) throw new Error('Expected the first block to have a bounding box.');
      await pageA.mouse.click(
        firstBlockBox.x + firstBlockBox.width - 4,
        firstBlockBox.y + firstBlockBox.height / 2,
      );

      // Confirms the move actually reached B -- not a fixed sleep, but a real readback proving the
      // caret rendered on a genuinely different line, not merely that the same DOM node from
      // before is still attached.
      await expect
        .poll(async () => (await remoteCaret.boundingBox())?.y)
        .toBeLessThan(secondBlockBox.y);
      await expect(pageB.locator('.remote-cursor-label')).toHaveText('Writer');

      const paintAfterMove = await measureCaretPaint(pageB);
      if (!paintAfterMove)
        throw new Error('Expected .remote-cursor-caret to still exist after the move.');
      expect(paintAfterMove.contentWidthPx).toBeGreaterThan(0);
      expect(paintAfterMove.rectHeight).toBeGreaterThan(0);
      expect(paintAfterMove.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(paintAfterMove.backgroundColor).not.toBe('transparent');

      const placementAfterMove = await measureCaretPlacement(pageB);
      if (!placementAfterMove)
        throw new Error('Expected a measurable caret placement after the move.');
      expect(Math.abs(placementAfterMove.deltaLeftPx)).toBeLessThanOrEqual(
        CARET_PLACEMENT_TOLERANCE_PX,
      );

      const after = await measurePage(pageB);
      expect(after).toEqual(before);
    } finally {
      await contextB.close();
    }
  });

  test('a peer who is already connected and positioned -- and has since gone idle -- is visible the instant I join, with no further activity from them required', async ({
    page: pageA,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { canvas: canvasA, email, password } = await createAndOpenScreenplay(pageA);
    await expect(pageA.getByText(/^Synced/)).toBeVisible();

    // A is fully positioned, and then goes idle past its own typing-glow window, entirely before
    // B ever opens the document -- the exact shape that, investigated live (two real browser
    // contexts, `getBoundingClientRect`/`getComputedStyle` measured directly, not reasoned about)
    // turned out to have no separate delivery defect of its own: a newly connecting client already
    // receives the document's current awareness snapshot immediately on connect (confirmed
    // directly against the installed `@hocuspocus/server`/`@hocuspocus/provider` -- see
    // progress/collaboration-slice-2.md's follow-up section). What this test actually guards
    // against is the failure mode that *looked* like a missing peer: the caret existing, correctly
    // positioned, and correctly *not* showing its name label (idle, past the glow window) while
    // painting nothing at all -- indistinguishable, to a writer, from "not there".
    await canvasA.click();
    await pageA.keyboard.insertText(FIRST_LINE);
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.insertText(SEEDED_LINE);
    await pageA.waitForTimeout(PRESENCE_TYPING_GLOW_MS + 500);

    const screenplayUrl = pageA.url();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      const { canvas: canvasB } = await openScreenplayAsSecondSession(
        pageB,
        email,
        password,
        screenplayUrl,
      );
      await expect(canvasB).toContainText(SEEDED_LINE);

      // No `expect.poll`, no extra wait beyond what `openScreenplayAsSecondSession`'s own `Synced`
      // check already performed -- the point is that this is true the instant the document is
      // usable, not eventually true after some settling period this test would otherwise paper
      // over.
      const remoteCaret = pageB.locator('.remote-cursor');
      await expect(remoteCaret).toBeAttached();

      // Correctly hidden because idle, not never-rendered: the wrapper carries no
      // `data-remote-cursor-active` (A has been idle well past `PRESENCE_TYPING_GLOW_MS`), so the
      // name label is not shown unprompted -- exactly right, and the reason this test does not
      // assert the label is visible here. What it does assert is that the *caret* -- which does
      // not depend on the glow state at all -- paints regardless.
      await expect(remoteCaret).not.toHaveAttribute('data-remote-cursor-active', 'true');

      const paint = await measureCaretPaint(pageB);
      if (!paint) throw new Error('Expected .remote-cursor-caret to exist.');
      expect(paint.contentWidthPx).toBeGreaterThan(0);
      expect(paint.rectHeight).toBeGreaterThan(0);
      expect(paint.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(paint.backgroundColor).not.toBe('transparent');

      const placement = await measureCaretPlacement(pageB);
      if (!placement) throw new Error('Expected a measurable caret placement.');
      expect(Math.abs(placement.deltaLeftPx)).toBeLessThanOrEqual(CARET_PLACEMENT_TOLERANCE_PX);
    } finally {
      await contextB.close();
    }
  });

  test('a peer’s name label, shown unprompted while they type, disappears on its own once the glow window passes -- with no further activity from them', async ({
    page: pageA,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { canvas: canvasA, email, password } = await createAndOpenScreenplay(pageA);
    await expect(pageA.getByText(/^Synced/)).toBeVisible();

    const screenplayUrl = pageA.url();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      const { canvas: canvasB } = await openScreenplayAsSecondSession(
        pageB,
        email,
        password,
        screenplayUrl,
      );

      // A types *after* B has already joined and synced, so B observes the glow turn on live,
      // exactly the shape that was found permanently stuck: a widget built while its peer is
      // recently active. See `packages/screenplay-editor/src/presence.ts`'s own
      // `createGlowController` comment for the confirmed mechanism (y-prosemirror's own
      // `Decoration.widget` key reuse means this element, once built, is never rebuilt again for
      // the life of the connection -- so nothing that depends on a rebuild can ever take the
      // attribute away, which is exactly what an earlier version of this module tried and why it
      // stayed lit).
      await canvasA.click();
      await pageA.keyboard.insertText(SEEDED_LINE);
      await expect(canvasB).toContainText(SEEDED_LINE);

      const remoteCaret = pageB.locator('.remote-cursor');
      await expect(remoteCaret).toHaveAttribute('data-remote-cursor-active', 'true');
      await expect(pageB.locator('.remote-cursor-label')).toHaveText('Writer');

      // No further keystrokes from A anywhere below -- only real time passing while B keeps
      // watching the *same* element the whole way through.
      await pageB.waitForTimeout(PRESENCE_TYPING_GLOW_MS + 500);

      await expect(remoteCaret).not.toHaveAttribute('data-remote-cursor-active', 'true');
      // Still there, still painted, still correctly placed -- only the unprompted label reveal is
      // gone. `:hover` (not exercised by this headless assertion, but true by construction: the
      // CSS rule this attribute's absence turns off is entirely independent of the `:hover`
      // selector beside it) remains the writer's way to find out who this still is.
      const paint = await measureCaretPaint(pageB);
      if (!paint)
        throw new Error('Expected .remote-cursor-caret to still exist after the glow expires.');
      expect(paint.contentWidthPx).toBeGreaterThan(0);
    } finally {
      await contextB.close();
    }
  });

  /**
   * The owner's own report, made precise: "when another user's cursor is clicked on, it should
   * move your cursor there as if you had clicked on the spot without any other cursor there." Not
   * "somewhere reasonable" -- the *same* position a plain click at those exact coordinates would
   * have produced. Proven here by clicking the literal same pixel twice: once with nothing drawn
   * over it (the control), once with A's own remote-cursor widget sitting exactly on it (the
   * click-through case) -- see `packages/screenplay-editor/src/presence.ts`'s own
   * `forwardRemoteCursorClick` comment for why `view.posAtCoords` makes this equal by construction,
   * not by luck.
   *
   * Reads the resulting position through the real, native DOM `Selection` ProseMirror keeps in sync
   * with its own document selection (`view.updateState`'s own `selectionToDOM`) -- no debug hook
   * added to the app for this, and no risk of a false pass from typing-then-undoing a marker
   * character, since nothing is ever typed at all.
   */
  test('clicking exactly on a remote cursor places the local caret at the same position a plain click at those coordinates would -- click-through equivalence, not merely "somewhere reasonable"', async ({
    page: pageA,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { canvas: canvasA, email, password } = await createAndOpenScreenplay(pageA);
    await expect(pageA.getByText(/^Synced/)).toBeVisible();

    await canvasA.click();
    await pageA.keyboard.insertText(FIRST_LINE);
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.insertText(SEEDED_LINE);

    const screenplayUrl = pageA.url();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      const { canvas: canvasB } = await openScreenplayAsSecondSession(
        pageB,
        email,
        password,
        screenplayUrl,
      );
      await expect(canvasB).toContainText(SEEDED_LINE);
      // Required before any coordinate-dependent click in this file (see the first test's own
      // `requireCourierPrime` call): without it, text can still be mid-swap from a fallback font
      // to Courier Prime when a bounding box is read, so a click computed from that box can land
      // somewhere the page has since reflowed away from -- confirmed directly, not assumed: a
      // first version of this test, without this call, read back the *footer's* own status text
      // instead of the manuscript, because the page was still reflowing under the fallback font
      // when the click coordinates were captured.
      await requireCourierPrime(pageB);
      // A's own remote caret, as B sees it, starts at the end of the *second* block -- A's own
      // last edit -- nowhere near the first block, so the control click below lands on ordinary
      // text with no widget anywhere near it.
      await expect(pageB.locator('.remote-cursor')).toBeAttached();

      const readSelection = (page: Page) =>
        page.evaluate(() => {
          const selection = window.getSelection();
          return {
            text: selection?.anchorNode?.textContent ?? null,
            offset: selection?.anchorOffset ?? null,
          };
        });

      /**
       * The precise pixel at the very end of `block`'s own text -- a collapsed `Range`'s own
       * rendered rect, the identical anchor `measureCaretPlacement` (this file, above) and
       * `titlepage-cursors-persistence.spec.ts`'s own `endOfFieldPoint` both read. Deliberately
       * *not* "click anywhere past the end of the line, it snaps" (the technique the first test in
       * this file uses to move a caret): that technique tolerates any x on the line because it
       * only needs the *resulting position* to be right, but this test additionally needs the
       * *remote-cursor widget itself* to land within a few pixels of the point it clicks a second
       * time -- and the widget renders at the real end-of-text column, not at the block element's
       * own right edge (action blocks span the full text column, far wider than a short line's own
       * glyphs). A first version of this test used the wider, click-anywhere technique and its own
       * click-through assertion never converged, for exactly this reason, confirmed directly: the
       * chosen pixel and the widget's own rendered position were never within reach of each other
       * at all.
       */
      function endOfBlockPoint(block: Locator): Promise<{ x: number; y: number }> {
        return block.evaluate((element) => {
          const textNode = element.firstChild;
          if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
            throw new Error('Block has no text node.');
          }
          const length = textNode.textContent?.length ?? 0;
          const range = document.createRange();
          range.setStart(textNode, length);
          range.setEnd(textNode, length);
          const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
          return { x: rect.left + 1, y: rect.top + rect.height / 2 };
        });
      }

      const firstBlockB = canvasB.locator('[data-screenplay-block]').first();
      // `toContainText(SEEDED_LINE)` above only proves the *second* block's own text arrived --
      // under real contention (this suite's own full parallel run, `CARET_CONVERGENCE_TIMEOUT_MS`'s
      // comment documents the identical concern for a different poll in this codebase) the two
      // blocks' own DOM commits were observed to land a beat apart, and `endOfBlockPoint` below
      // reads `firstChild` synchronously with no wait of its own -- so this waits for the *first*
      // block's own text specifically, the one this test is about to measure and click.
      await expect(firstBlockB).toHaveText(FIRST_LINE);
      // B never typed or clicked into the canvas the way A did while composing this content, so
      // nothing has scrolled B's own view to bring the manuscript body into frame yet -- B's
      // initial scroll position shows the title page above it. Confirmed directly, not assumed: a
      // version of this test without this call read back the *footer's* own status text instead
      // of the manuscript, because the raw pixel coordinates this test computes next landed below
      // B's actual visible viewport. `scrollIntoViewIfNeeded` is what A's own earlier typing did
      // implicitly (a caret landing somewhere always scrolls it into view) and B needs done
      // explicitly, having never moved a caret here at all.
      await firstBlockB.scrollIntoViewIfNeeded();
      const clickPoint = await endOfBlockPoint(firstBlockB);

      // Control: B clicks that exact pixel while nothing is drawn over it.
      await pageB.mouse.click(clickPoint.x, clickPoint.y);
      const control = await readSelection(pageB);
      expect(control).toEqual({ text: FIRST_LINE, offset: FIRST_LINE.length });

      // A now moves its own caret to the identical end-of-text position -- read from A's own page
      // the same way -- so B's remote-cursor widget comes to sit exactly where B just clicked.
      await pageA.bringToFront();
      const firstBlockA = canvasA.locator('[data-screenplay-block]').first();
      const clickPointA = await endOfBlockPoint(firstBlockA);
      await pageA.mouse.click(clickPointA.x, clickPointA.y);

      const remoteCaret = pageB.locator('.remote-cursor-caret');
      await expect(remoteCaret).toBeAttached();
      // Confirms the widget actually reached the same pixel B is about to click again --
      // otherwise this test would not be exercising click-through at all, only coincidence.
      await expect
        .poll(async () => {
          const box = await remoteCaret.boundingBox();
          if (!box) return false;
          return (
            box.x <= clickPoint.x &&
            clickPoint.x <= box.x + box.width &&
            box.y <= clickPoint.y &&
            clickPoint.y <= box.y + box.height
          );
        })
        .toBe(true);

      // The proof: the identical pixel, clicked again, now with A's remote-cursor widget sitting
      // exactly on it.
      await pageB.mouse.click(clickPoint.x, clickPoint.y);
      await expect.poll(() => readSelection(pageB)).toEqual(control);
    } finally {
      await contextB.close();
    }
  });

  /**
   * The regression this fix is most likely to cause, named directly in the brief: making the caret
   * hit-testable again (rather than `pointer-events: none`, which would have made click-through
   * trivial at the cost of silently breaking this) must not have cost the hover reveal slice 2
   * shipped. Isolated from the typing-glow reveal (`data-remote-cursor-active`, already covered by
   * this file's other tests) by waiting the glow window out first, so the *only* thing that can be
   * revealing the label by the time this test hovers is a real `:hover` match.
   */
  test('hovering a remote cursor’s caret still reveals the writer’s name, after the click-through fix', async ({
    page: pageA,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { canvas: canvasA, email, password } = await createAndOpenScreenplay(pageA);
    await expect(pageA.getByText(/^Synced/)).toBeVisible();

    await canvasA.click();
    await pageA.keyboard.insertText(SEEDED_LINE);
    await pageA.waitForTimeout(PRESENCE_TYPING_GLOW_MS + 500);

    const screenplayUrl = pageA.url();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      const { canvas: canvasB } = await openScreenplayAsSecondSession(
        pageB,
        email,
        password,
        screenplayUrl,
      );
      await expect(canvasB).toContainText(SEEDED_LINE);

      const remoteCaret = pageB.locator('.remote-cursor-caret');
      await expect(remoteCaret).toBeAttached();
      await expect(pageB.locator('.remote-cursor')).not.toHaveAttribute(
        'data-remote-cursor-active',
        'true',
      );
      await expect(pageB.locator('.remote-cursor-label')).toHaveCSS('opacity', '0');

      await remoteCaret.hover();
      await expect(pageB.locator('.remote-cursor-label')).toHaveCSS('opacity', '1');
      await expect(pageB.locator('.remote-cursor-label')).toHaveText('Writer');
    } finally {
      await contextB.close();
    }
  });
});
