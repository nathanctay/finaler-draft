import { expect, test, type Locator, type Page } from '@playwright/test';
import { paginateScreenplay, type AuthoredLine, type LayoutResult } from '@finaler-draft/layout';
import type { ScreenplayBlock } from '@finaler-draft/screenplay';
import {
  LINES_PER_INCH,
  MARGIN_TOP_IN,
  PAGE_HEIGHT_IN,
} from '@finaler-draft/screenplay/pageFormat';
import { PAGE_GAP_IN, pageStackMinHeightIn } from '../src/pagination.js';
import { requireCourierPrime } from './requireCourierPrime.js';
import { signIn, verifyEmail } from './testMail.js';

/**
 * The real-editor replacement for the synthetic multi-page fixture this spec used to build (see
 * progress/page-rendering.md's entry on why: a hand-built `.page`/`.script-body` never runs
 * ProseMirror and never sits inside the real flex `.editor-region`, so it could not have caught
 * either of the two rendering defects this slice fixed -- one was a flex cross-size bug in the
 * real container, the other was ProseMirror inserting a real DOM node the fixture never produced).
 *
 * This drives the actual application: sign up, create a project and screenplay, type into the
 * real editor, and measure the real DOM -- the flow `persistence.spec.ts` already exercises for
 * the same reason (the authenticated editor route requires both a real session and a real
 * screenplay to fetch, so a disposable per-run database is the only way to reach it). It therefore
 * needs the same database as `persistence.spec.ts` and runs under `playwright.persistence.config.ts`
 * (see that file's `testMatch` and `playwright.config.ts`'s `testIgnore`), not the plain
 * `test:system` gate.
 *
 * The four narrower CSS-property checks that remain in `page-rendering.spec.ts` (space-before
 * suppression, the continuous/discrete background toggle, (MORE)/CONT'D indent+weight+
 * non-editability, and the page-number position formula) stay there, unmodified: they each assert
 * one declared CSS rule against the real class name on a minimal synthetic node, in the same style
 * `page-geometry.spec.ts` already uses, and neither historical defect (the flex bug; the
 * ProseMirror-separator bug) could have hidden behind them -- they don't reconstruct cross-page
 * arithmetic or drive real ProseMirror the way the fixture this file replaces did.
 */

const TOLERANCE_IN = 0.01;
const PAGE_PITCH_IN = PAGE_HEIGHT_IN + PAGE_GAP_IN;

/** `'x'.repeat(budget * (n - 1) + 1)` hard-splits into exactly `n` lines at the given budget. */
function linesOfLength(budget: number, n: number): string {
  return 'x'.repeat(budget * (n - 1) + 1);
}

const ACTION_BUDGET = 60;

/**
 * Four action blocks sized (by construction, verified against the real `paginateScreenplay`
 * below, never assumed) to produce both anchor shapes `computePageBreaks` handles: block 0 fills
 * page 1 exactly (a clean break AFTER the block -- the between-block case defect 2 actually hit),
 * while blocks 1 and 2 each overflow their own page by 5 lines (a break INSIDE the block -- the
 * mid-block continuation case, whose safety was asserted by reasoning rather than measured in a
 * real browser until now). Block 3 is short, so the last page is deliberately partial (requirement
 * 3's truncated-background case).
 */
function fourPageMixedAnchorFixture(): ScreenplayBlock[] {
  return [
    { id: 'block-0', type: 'action', text: linesOfLength(ACTION_BUDGET, 55) },
    { id: 'block-1', type: 'action', text: linesOfLength(ACTION_BUDGET, 60) },
    { id: 'block-2', type: 'action', text: linesOfLength(ACTION_BUDGET, 55) },
    { id: 'block-3', type: 'action', text: linesOfLength(ACTION_BUDGET, 20) },
  ];
}

/**
 * Copied from `persistence.spec.ts` (its own comment explains why this is the only route to a
 * real signed-in writer with a real screenplay open in the real editor) rather than shared, per
 * the scope's own instruction to copy that flow. `verifyEmail`/`signIn` (testMail.ts) are shared,
 * not part of that instruction: they are test-mailbox plumbing, not the user-facing flow the
 * instruction was about, and duplicating a fetch-and-follow-a-link helper across every spec file
 * that needs it would just be copy-paste with no readability benefit.
 */
async function createAndOpenScreenplay(page: Page): Promise<{ canvas: Locator }> {
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
  await page.getByLabel('New project title').fill('Page rendering project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Page rendering project' }).click();
  await page.getByLabel('New screenplay title').fill('Multi-page script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  return { canvas };
}

/**
 * The last non-blank line of `page.lines`, mirroring the private `lastAuthoredLine` helper in
 * `apps/web/src/pagination.ts` -- duplicated rather than imported because it is not exported (it
 * is an internal step of `computePageBreaks`, which itself needs a live ProseMirror `doc` this
 * Node-side test never builds). The two are the same one-line scan; keeping it here is what lets
 * this test determine, from the model alone, which anchor shape a given break used.
 */
function lastAuthoredLine(lines: LayoutResult['pages'][number]['lines']): AuthoredLine | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.kind === 'authored') return line;
    if (line?.kind === 'blank') return undefined;
  }
  return undefined;
}

type BreakAnchor = { readonly blockId: string; readonly endsBlock: boolean };

/**
 * For the break between `layout.pages[pageIndex]` and the next page: which block its last
 * authored line belongs to, and whether that line ends the block. This is the exact condition
 * `computePageBreaks` branches on (`endsBlock` in pagination.ts) to decide whether the widget
 * anchors after the block (a DOM sibling) or inside it (a DOM descendant) -- the anchor choice
 * defect 2 got wrong for the "after" case. `block.text.length` stands in for the live
 * `block.content.size` pagination.ts reads off a real ProseMirror node: for a plain text-only
 * block (everything in this fixture) they are the same quantity by definition -- both count UTF-16
 * code units of the same string -- so this is a faithful mirror of the real check, not a
 * reconstruction of different arithmetic.
 */
function breakAnchorFor(
  page: LayoutResult['pages'][number],
  blocksById: ReadonlyMap<string, ScreenplayBlock>,
): BreakAnchor {
  const last = lastAuthoredLine(page.lines);
  if (!last) {
    throw new Error('Page has no authored content to anchor a break at.');
  }
  const block = blocksById.get(last.blockId);
  if (!block || !('text' in block)) {
    throw new Error(`Fixture is missing text block ${last.blockId}.`);
  }
  return { blockId: last.blockId, endsBlock: last.endOffset >= block.text.length };
}

/** The (pageIndex, lineIndex) of `blockId`'s first authored line -- the line with `startOffset === 0`, i.e. where the block actually starts, which exists on exactly one page for every block. */
function blockOrigin(
  layout: LayoutResult,
  blockId: string,
): { pageIndex: number; lineIndex: number } {
  for (let pageIndex = 0; pageIndex < layout.pages.length; pageIndex += 1) {
    const lines = layout.pages[pageIndex]?.lines ?? [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line?.kind === 'authored' && line.blockId === blockId && line.startOffset === 0) {
        return { pageIndex, lineIndex };
      }
    }
  }
  throw new Error(`Block ${blockId} never starts fresh anywhere in the layout.`);
}

/** Expected top, in inches from `.page`'s own top, of a position `lineIndex` rows into the page at `pageIndex` (both 0-based) -- the same spacer arithmetic `pagination.ts` builds, applied generally rather than only to a page's first line. */
function expectedTopIn(pageIndex: number, lineIndex: number): number {
  return pageIndex * PAGE_PITCH_IN + MARGIN_TOP_IN + lineIndex / LINES_PER_INCH;
}

test.describe('page rendering: real editor, real DOM', () => {
  test('every block lands where the model predicts, every break anchors as the model says, and the last partial page still paints in full', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { canvas } = await createAndOpenScreenplay(page);
    await requireCourierPrime(page);

    const blocks = fourPageMixedAnchorFixture();
    await canvas.click();
    // A brand-new screenplay's document is never truly empty: App.tsx seeds it with one empty
    // `action` block up front (`editorContent`'s fallback for `initialContent.content.length ===
    // 0`) so there is always somewhere to place the cursor. Typing straight into it is therefore
    // correct; pressing Enter first would split that single empty block into two, leaving a
    // stray empty block ahead of block 0 that silently shifts every line in the fixture below.
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!block || !('text' in block)) continue;
      await page.keyboard.insertText(block.text);
      if (index < blocks.length - 1) {
        await page.keyboard.press('Enter');
      }
    }

    const savedUpdate = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().includes('/api/screenplays/') &&
        response.status() === 200,
    );
    await savedUpdate;

    // Read the real canonical document back through the real API -- the only way to know the
    // real block ids (the editor generates them; this test never authors one), and therefore the
    // only way to compute what the model actually predicts for this exact document.
    const screenplayId = /\/screenplays\/([0-9a-f-]+)/u.exec(page.url())?.[1];
    if (!screenplayId) {
      throw new Error(`Could not find a screenplay id in ${page.url()}.`);
    }
    const persisted = await page.request.get(`/api/screenplays/${screenplayId}`);
    expect(persisted.ok()).toBe(true);
    const { screenplay } = (await persisted.json()) as {
      screenplay: { blocks: ScreenplayBlock[] };
    };
    const blocksById = new Map(screenplay.blocks.map((block) => [block.id, block]));

    const layout = paginateScreenplay(screenplay.blocks);
    expect(layout.pages.length).toBeGreaterThanOrEqual(4);
    // Sanity on the fixture actually producing both anchor shapes, against the real model output
    // (not assumed) -- see fourPageMixedAnchorFixture's doc comment.
    const anchors = layout.pages
      .slice(0, -1)
      .map((pageEntry) => breakAnchorFor(pageEntry, blocksById));
    expect(anchors.some((anchor) => anchor.endsBlock)).toBe(true);
    expect(anchors.some((anchor) => !anchor.endsBlock)).toBe(true);

    const measured = await page.evaluate(
      ({ blockIds, breakCount }: { blockIds: string[]; breakCount: number }) => {
        const pageEl = document.querySelector('.page');
        if (!pageEl) throw new Error('Missing .page element.');
        const pageRect = pageEl.getBoundingClientRect();

        const blockTops = blockIds.map((id) => {
          const el = document.querySelector(`[data-block-id="${id}"]`);
          if (!el) throw new Error(`Missing block element for ${id}.`);
          return (el.getBoundingClientRect().top - pageRect.top) / 96;
        });

        const widgets = Array.from(document.querySelectorAll('.page-break-widget'));
        if (widgets.length !== breakCount) {
          throw new Error(`Expected ${breakCount} page-break widgets, found ${widgets.length}.`);
        }
        const widgetInfo = widgets.map((widget) => {
          const enclosingBlock = widget.closest('[data-screenplay-block]');
          const spacer = widget.querySelector('.page-break-spacer');
          if (!spacer) throw new Error('Widget is missing its .page-break-spacer.');
          const spacerRect = spacer.getBoundingClientRect();
          return {
            enclosingBlockId: enclosingBlock?.getAttribute('data-block-id') ?? undefined,
            spacerBottomIn: (spacerRect.bottom - pageRect.top) / 96,
          };
        });

        return { blockTops, heightIn: pageRect.height / 96, widgetInfo };
      },
      { blockIds: screenplay.blocks.map((block) => block.id), breakCount: layout.pages.length - 1 },
    );

    // Every block's real top matches where the model says its first authored line sits --
    // requirement 2's "every block", not only page-top blocks.
    screenplay.blocks.forEach((block, index) => {
      const { pageIndex, lineIndex } = blockOrigin(layout, block.id);
      const expected = expectedTopIn(pageIndex, lineIndex);
      const actual = measured.blockTops[index];
      expect(actual).toBeDefined();
      expect(Math.abs((actual ?? 0) - expected)).toBeLessThan(TOLERANCE_IN);
    });

    // Every break's widget anchors exactly where the model says it should: a DOM sibling of the
    // blocks (not a descendant of any of them) when the break falls between two blocks, and a
    // descendant of the specific block it splits when the break falls inside one. This is the
    // corrected, model-driven form of the assertion that would have caught defect 2 -- a hardcoded
    // "never a descendant" would itself be wrong the moment a mid-block break exists, which is
    // exactly why block-1 and block-2's overflow onto the next page is in this fixture.
    anchors.forEach((anchor, index) => {
      const info = measured.widgetInfo[index];
      expect(info).toBeDefined();
      if (anchor.endsBlock) {
        expect(info?.enclosingBlockId).toBeUndefined();
      } else {
        expect(info?.enclosingBlockId).toBe(anchor.blockId);
      }
      // The spacer's own bottom edge is, by construction (pagination.ts's buildPageBreakWidget),
      // exactly the incoming page's physical top -- true whether the break is between blocks or
      // inside one. Checking it here proves the mid-block anchor case reserves the same correct
      // amount of space defect 2 broke for the between-block case, not merely that the widget
      // nests in the right DOM parent.
      const incomingPageIndex = index + 1;
      const expectedSpacerBottomIn = incomingPageIndex * PAGE_PITCH_IN + MARGIN_TOP_IN;
      expect(Math.abs((info?.spacerBottomIn ?? 0) - expectedSpacerBottomIn)).toBeLessThan(
        TOLERANCE_IN,
      );
    });

    // Requirement 3: .page's real rendered height covers every page in full, including the
    // deliberately partial last one, not just as far as the last line of content reaches.
    const expectedMinHeightIn = pageStackMinHeightIn(layout.pages.length);
    expect(measured.heightIn).toBeGreaterThanOrEqual(expectedMinHeightIn - TOLERANCE_IN);
  });

  /**
   * Regression test for the defect fixed in this scope (progress/page-rendering.md): typing
   * reflowed text immediately (ProseMirror updates the live document on every keystroke,
   * unthrottled), but the break widget's spacer height was still the value computed *before* the
   * edit -- stale for the length of whatever delay stood between an edit and the next pagination
   * recompute. For the length of that delay, a page's frame absorbed the wrong remainder and
   * visibly jumped by one line (16px, one row on the six-lines-per-inch grid), snapping back once
   * the recompute finally landed. The fix (paginationExtension.ts) replaced a 300ms debounce with
   * a requestAnimationFrame-coalesced recompute specifically so that window closes before the
   * browser's next paint rather than up to 300ms later -- this test is what proves that from
   * outside the browser's own frame timing, not just from the Node-side latency numbers.
   *
   * By construction of the rendering technique (see pagination.ts's module comment and the
   * "Measured" note in progress/page-rendering.md): every page occupies exactly `PAGE_HEIGHT_IN`
   * of flow, so a page's absolute top -- and therefore its `.page-break-number`'s offset from
   * `.page`'s own top -- is invariant under any edit that does not change the break count, no
   * matter how the content above it reflows. That invariant is exactly what a stale spacer height
   * violates transiently and what this test asserts holds continuously.
   */
  test('a page frame does not move when an earlier edit reflows content across its break', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { canvas } = await createAndOpenScreenplay(page);
    await requireCourierPrime(page);

    const blocks = fourPageMixedAnchorFixture();
    await canvas.click();
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!block || !('text' in block)) continue;
      await page.keyboard.insertText(block.text);
      if (index < blocks.length - 1) {
        await page.keyboard.press('Enter');
      }
    }

    const initialSave = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().includes('/api/screenplays/') &&
        response.status() === 200,
    );
    await initialSave;

    const readFirstBreakNumberOffsetIn = () =>
      page.evaluate(() => {
        const pageEl = document.querySelector('.page');
        const numberEl = document.querySelector('.page-break-number');
        if (!pageEl || !numberEl) {
          throw new Error('Missing .page or .page-break-number element.');
        }
        return (numberEl.getBoundingClientRect().top - pageEl.getBoundingClientRect().top) / 96;
      });

    /**
     * A completed save does not mean layout has settled. Autosave and pagination are independent —
     * the save is debounced on its own timer, while pagination is coalesced to an animation frame —
     * so `await initialSave` says nothing about whether the break has reached its final position.
     * Reading the baseline straight after the PUT captured a still-converging value roughly one run
     * in four, and both assertions below then compared against a number that was never correct.
     * Polling until the offset stops moving removes the assumption instead of padding a timeout.
     */
    const readSettledBreakOffsetIn = async () => {
      let previous = await readFirstBreakNumberOffsetIn();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await page.waitForTimeout(50);
        const current = await readFirstBreakNumberOffsetIn();
        if (Math.abs(current - previous) < TOLERANCE_IN) {
          return current;
        }
        previous = current;
      }
      throw new Error('The page-break offset never stopped changing.');
    };

    const baselineOffsetIn = await readSettledBreakOffsetIn();

    // Place the caret at offset 0 of the first block through the selection API directly.
    // Clicking the block and pressing Home does NOT move the caret here: the click does not
    // reposition the selection the seeding loop left at the end of the document, so the Enter
    // below lands after the last block instead of before the first one. That makes this test
    // vacuous -- an edit after the final block cannot move the first page break, so the
    // assertions hold no matter what the renderer does. Verified by reintroducing the 300ms
    // debounce this scope removed: the test still passed. The precondition assertion after the
    // edit exists so that failure mode can never return silently.
    await page.evaluate(() => {
      const block = document.querySelector('[data-screenplay-block]');
      if (!block) {
        throw new Error('No screenplay block found to place the caret in.');
      }
      const range = document.createRange();
      range.setStart(block.firstChild ?? block, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    // The edit: one Enter at position 0 splits off a new, empty leading block, adding exactly one
    // grid line ahead of all of this fixture's original content -- the same shape as the owner's
    // original repro ("placing the cursor at the start of block 0 and typing one line's worth").
    // Every block after it, including every page break, shifts down by one line in raw document
    // flow; whether the *rendered* break position moves with it is exactly what is under test.
    await page.keyboard.press('Enter');

    // "Shortly after": read back as soon as the edit round-trip returns, with no additional wait.
    // Precondition: splitting at offset 0 leaves an empty leading block. If the caret was not
    // where this test needs it, this fails loudly rather than letting the assertions below pass
    // for the wrong reason.
    const leadingBlockText = await page.evaluate(
      () => document.querySelector('[data-screenplay-block]')?.textContent ?? null,
    );
    expect(leadingBlockText).toBe('');

    /**
     * Read after one animation frame, not immediately. Pagination is coalesced to the next frame,
     * so between the edit landing in the DOM and the recompute running there is a window in which
     * the break legitimately sits at its pre-edit position. A Playwright round-trip takes a few
     * milliseconds and a frame takes eight to sixteen, so an immediate read wins that race often
     * enough to fail roughly two runs in three — reading a state that is intermediate and correct,
     * not a defect. The guarantee the design actually makes is about paint: nothing is ever
     * rendered in the wrong place.
     *
     * Waiting exactly two frames is deliberate rather than polling until stable. It is long enough
     * that the coalesced recompute has certainly run, and short enough that the regression this
     * assertion exists to catch still fails loudly: the 300 ms debounce it replaced is roughly
     * twenty frames, so a stale spacer is still caught with an enormous margin.
     */
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const immediateOffsetIn = await readFirstBreakNumberOffsetIn();
    expect(Math.abs(immediateOffsetIn - baselineOffsetIn)).toBeLessThan(TOLERANCE_IN);

    // "After things settle": let the offset stop moving, then re-check. It must still equal the
    // baseline -- this rules out a coincidentally-correct read on the first sample.
    const settledOffsetIn = await readSettledBreakOffsetIn();
    expect(Math.abs(settledOffsetIn - baselineOffsetIn)).toBeLessThan(TOLERANCE_IN);
  });
  /**
   * Scene numbers render as a widget decoration inside each numbered scene heading, carrying the
   * number out into both margins (plan.md's "Locked scripts"). A widget puts real DOM inside the
   * editable subtree, which a `::before`/`::after` overlay never did -- so unlike the previous
   * implementation, this one *could* perturb the line grid if its positioning were wrong or its
   * anchor were placed between blocks rather than inside the heading's own textblock.
   *
   * The character grid is normative and must not move for a display-only setting, so this test
   * measures every block's painted position with numbering off, turns it on through the real
   * dialog, and requires every block to be exactly where it was. Nothing else in the suite covers
   * the app with `sceneNumbersEnabled` on: the other tests in this file all run at the default
   * settings, so a grid shift introduced by numbering would otherwise ship unnoticed.
   */
  test('turning scene numbers on paints both margins without moving a single block', async ({
    page,
  }) => {
    const { canvas } = await createAndOpenScreenplay(page);
    await requireCourierPrime(page);
    await canvas.click();

    // A new screenplay's first block is `action`, not a scene heading, so the element has to be
    // set explicitly before typing -- otherwise this fixture contains no scene at all and the
    // assertions below would pass vacuously against zero rendered numbers.
    await page.getByLabel('Active screenplay element').selectOption({ label: 'Scene Heading' });
    // The heading fills its full 60-character budget deliberately. A short heading would absorb
    // two extra characters without wrapping, so this test would pass even if the numbers rendered
    // in the text flow instead of the margins -- exactly the regression it exists to catch. At the
    // budget, any in-flow content wraps the heading and pushes every block below it down a line.
    const heading = 'INT. APARTMENT KITCHEN - CONTINUOUS - THE MORNING AFTER IT'.padEnd(60, 'X');
    expect(heading).toHaveLength(60);
    const lines = [
      heading,
      'Mara counts the money twice.',
      'She does not like the answer either time.',
      'The radiator knocks once and gives up.',
    ];
    for (let index = 0; index < lines.length; index += 1) {
      await page.keyboard.insertText(lines[index] ?? '');
      if (index < lines.length - 1) {
        await page.keyboard.press('Enter');
      }
    }
    await page.waitForTimeout(400);

    const readBlockTops = async (): Promise<number[]> =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-screenplay-block]')).map(
          (block) => block.getBoundingClientRect().top,
        ),
      );

    const before = await readBlockTops();
    expect(before.length).toBe(lines.length);
    // The fixture really does contain a scene to number.
    expect(
      await page
        .locator("[data-screenplay-block][data-screenplay-element='scene_heading']")
        .count(),
    ).toBe(1);
    expect(await page.locator('.scene-number').count()).toBe(0);

    await page.locator('.menu-file .overflow-menu-trigger').click();
    await page.getByRole('menuitem', { name: 'Document settings…' }).click();
    await page.getByRole('checkbox', { name: 'Number scenes' }).check();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Precondition: numbering actually took effect. Without this the equality below could pass
    // simply because nothing rendered at all.
    const sceneNumber = page.locator('.scene-number').first();
    await expect(sceneNumber).toHaveAttribute('data-scene-number', '1');
    await expect(sceneNumber.locator('.scene-number-left')).toHaveText('1');
    await expect(sceneNumber.locator('.scene-number-right')).toHaveText('1');

    // Both copies sit outside the heading's own text column -- one to its left, one to its right.
    const margins = await page.evaluate(() => {
      const heading = document.querySelector('[data-screenplay-block]');
      const left = document.querySelector('.scene-number-left');
      const right = document.querySelector('.scene-number-right');
      if (!heading || !left || !right) return undefined;
      const headingBox = heading.getBoundingClientRect();
      return {
        headingLeft: headingBox.left,
        headingRight: headingBox.right,
        leftRight: left.getBoundingClientRect().right,
        rightLeft: right.getBoundingClientRect().left,
      };
    });
    expect(margins).toBeDefined();
    expect(margins!.leftRight).toBeLessThanOrEqual(margins!.headingLeft);
    expect(margins!.rightLeft).toBeGreaterThanOrEqual(margins!.headingRight);

    const after = await readBlockTops();
    expect(after).toEqual(before);
  });

  test("a page frame stays put when an edit changes a short page's fill without moving a block", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await createAndOpenScreenplay(page);
    await requireCourierPrime(page);

    // A speech that cannot fit at the foot of page 1 moves to page 2 whole, leaving page 1 short.
    // That is the case this test exists for: page 1's unused remainder is large, so the break's
    // spacer height genuinely changes whenever page 1's fill changes, even though no block crosses
    // the boundary. When page 1 is full instead, the remainder barely moves and the defect below
    // is invisible -- which is why the other page-frame test in this file did not catch it.
    const screenplayId = /screenplays\/([0-9a-f-]+)/.exec(page.url())?.[1];
    expect(screenplayId).toBeTruthy();
    const existing = (await (
      await page.request.get(`/api/screenplays/${screenplayId}`)
    ).json()) as {
      version: number;
      screenplay: Record<string, unknown>;
    };
    const seeded = [
      ...Array.from({ length: 26 }, (_, index) => ({
        id: crypto.randomUUID(),
        type: 'action',
        text: `Action line ${index} of the first page.`,
      })),
      { id: crypto.randomUUID(), type: 'character', text: 'ADA' },
      { id: crypto.randomUUID(), type: 'dialogue', text: 'y'.repeat(35 * 3 + 1) },
    ];
    // `page.request` is Playwright's own API client, not the browser page, so it sends no `Origin`
    // header of its own -- and the API now refuses unsafe methods that arrive without one (CSRF
    // hardening, `app.ts`'s origin guard: safe methods may omit it, unsafe ones may not). A real
    // browser always sends it on a PUT, so setting it here makes this seeding request behave like
    // the application it stands in for, rather than relaxing the rule to accommodate a test client.
    const seedResponse = await page.request.put(`/api/screenplays/${screenplayId}`, {
      data: {
        expectedVersion: existing.version,
        screenplay: { ...existing.screenplay, blocks: seeded },
      },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(seedResponse.ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Screenplay editing canvas' })).toBeVisible();
    await expect(page.locator('.page-break-number')).toBeVisible();

    const readFrame = () =>
      page.evaluate(() => {
        const pageEl = document.querySelector('.page');
        const numberEl = document.querySelector('.page-break-number');
        const spacerEl = document.querySelector('.page-break-spacer');
        if (!pageEl || !numberEl || !spacerEl) {
          throw new Error('Missing .page, .page-break-number or .page-break-spacer.');
        }
        return {
          numberOffsetIn:
            (numberEl.getBoundingClientRect().top - pageEl.getBoundingClientRect().top) / 96,
          spacerHeightPx: Math.round(spacerEl.getBoundingClientRect().height),
        };
      });

    const baseline = await readFrame();

    // Split the last action block on page 1 mid-text. Page 1 has room, so nothing re-flows across
    // the break -- but page 1's fill grows by a blank line plus a text line, so the spacer must
    // shrink by exactly that much for page 2's frame to stay where it is.
    await page.evaluate(() => {
      const target = document.querySelectorAll('[data-screenplay-block]')[25];
      const textNode = target?.firstChild;
      if (!textNode) {
        throw new Error('Expected a text node in the last action block of page 1.');
      }
      const range = document.createRange();
      range.setStart(textNode, 8);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const afterSplit = await readFrame();

    // Precondition: the spacer must actually have been recomputed. Without this the offset
    // assertions could pass simply because the edit never took effect.
    expect(afterSplit.spacerHeightPx).not.toBe(baseline.spacerHeightPx);
    expect(Math.abs(afterSplit.numberOffsetIn - baseline.numberOffsetIn)).toBeLessThan(
      TOLERANCE_IN,
    );

    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    const afterRejoin = await readFrame();
    expect(afterRejoin.spacerHeightPx).toBe(baseline.spacerHeightPx);
    expect(Math.abs(afterRejoin.numberOffsetIn - baseline.numberOffsetIn)).toBeLessThan(
      TOLERANCE_IN,
    );
  });

  /**
   * SmartType's inline ghost completion (apps/web/src/smartTypeGhost.ts) draws real text inside a
   * real text block while the writer types. Text rendered inline in a text block changes where
   * that line wraps, which shifts every line after it and decouples the DOM from the paginated
   * model -- the defect class fixed twice already (PRs #16 and #19, and the scene-number widget
   * test above exists for the same reason). A ghost is a fresh way to reintroduce it, so this
   * measures rather than reasons: the same document, painted three times -- with no ghost, with a
   * ghost showing, and after Escape dismisses it -- must produce byte-identical geometry.
   *
   * The fixture is built so that an in-flow ghost could not possibly go unnoticed. The heading is
   * 55 of its 60 characters, and the completion on offer is six more -- so if the ghost took part
   * in flow, the heading would wrap to a second line, every block below it would drop by one
   * 16 px row, and the page break would move with them. What is compared is therefore not just
   * block tops but the client rectangle of every rendered line of text in the document: same
   * count, same position, same width, exactly.
   *
   * The canonical screenplay is read back through the real API *while the ghost is on screen*,
   * which is the other half of the constraint: the ghost is a decoration, so what a save, a
   * reload, and every export see must be the writer's own 55 characters and nothing more.
   *
   * SmartType's optional candidate list (stage 3, `smartTypeList.tsx`) is then opened over the
   * same caret and measured against the same baseline. It is a `position: fixed` panel rendered
   * outside `.page` entirely, which ought to make it incapable of moving anything -- but that is
   * a claim about a stylesheet, and this file exists because claims about stylesheets have been
   * wrong here twice. It is measured, not assumed.
   */
  test('a ghost completion, and the list opened over it, move no line, no page, and nothing in the canonical screenplay', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { canvas } = await createAndOpenScreenplay(page);
    await requireCourierPrime(page);
    await canvas.click();

    // An earlier scene authors the time of day `LATE NIGHT`, which is what the heading under test
    // completes against. Two properties of this exact pair are what the fixture is for, and
    // neither is incidental:
    //
    //  - 55 typed characters plus a six-character completion is 61, one past the 60 the scene
    //    heading's line holds (scene headings share action's budget), so an in-flow ghost would
    //    wrap the heading, add a line, and push every block and page break below it down a row;
    //  - the completion begins with a space, so a ghost that resolved its width against the room
    //    left on the line -- rather than staying on one line -- would break into a narrow column
    //    at that space. That failure moves nothing, so only the ghost's own rectangle count can
    //    see it, which is why it is asserted separately below.
    const EARLIER_SCENE = 'EXT. PIER - LATE NIGHT';
    const HEADING = 'INT. THE OLD HARBOUR ROAD BOARDING HOUSE KITCHEN - LATE';
    const GHOST = ' NIGHT';
    expect(HEADING.length + GHOST.length).toBeGreaterThan(ACTION_BUDGET);
    expect(HEADING.length).toBeLessThanOrEqual(ACTION_BUDGET);

    await page.getByLabel('Active screenplay element').selectOption({ label: 'Scene Heading' });
    await page.keyboard.insertText(EARLIER_SCENE);
    await page.keyboard.press('Enter');
    await page.getByLabel('Active screenplay element').selectOption({ label: 'Scene Heading' });
    await page.keyboard.insertText(HEADING);
    // Two full-width action blocks after the heading: enough to break the page, so a heading that
    // grew by one line would move a page frame as well as the blocks under it.
    for (const filler of [linesOfLength(ACTION_BUDGET, 40), linesOfLength(ACTION_BUDGET, 40)]) {
      await page.keyboard.press('Enter');
      await page.keyboard.insertText(filler);
    }

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().includes('/api/screenplays/') &&
        response.status() === 200,
    );
    await saved;
    await page.waitForTimeout(400);

    /**
     * Everything the page paints, measured from `.page`'s own top so the editor's scroll position
     * cancels out: every block's box, every rendered line of text (one client rectangle per line,
     * taken over the block's own text node, which the ghost is never part of), every page break's
     * spacer, the page's height, and the scroll width of the region around it -- an absolutely
     * positioned ghost that overflowed its line would show up there and nowhere else.
     */
    const measure = () =>
      page.evaluate(() => {
        const pageEl = document.querySelector('.page');
        const region = document.querySelector('.editor-region');
        if (!pageEl || !region) {
          throw new Error('Missing .page or .editor-region element.');
        }
        const pageRect = pageEl.getBoundingClientRect();
        const blocks = Array.from(document.querySelectorAll('[data-screenplay-block]')).map(
          (block) => {
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
          },
        );
        return {
          blocks,
          spacerBottoms: Array.from(document.querySelectorAll('.page-break-spacer')).map(
            (spacer) => spacer.getBoundingClientRect().bottom - pageRect.top,
          ),
          pageHeight: pageRect.height,
          scrollWidth: region.scrollWidth,
        };
      });

    const withoutGhost = await measure();
    expect(await page.locator('.smarttype-ghost').count()).toBe(0);
    expect(withoutGhost.spacerBottoms.length).toBeGreaterThanOrEqual(1);
    // The heading really is one line, so a second one would be unmistakable.
    expect(withoutGhost.blocks[1]?.lines.length).toBe(1);

    // Put the caret at the end of the heading, which is the only place this completion is offered
    // (the ghost never appears mid-text). Done through the selection API for the reason the test
    // above documents: a click does not reliably move the caret off the end of the document.
    await page.evaluate(() => {
      const heading = document.querySelectorAll('[data-screenplay-block]')[1];
      const textNode = heading?.firstChild;
      if (!textNode) {
        throw new Error('The scene heading has no text to place a caret in.');
      }
      const range = document.createRange();
      range.setStart(textNode, textNode.textContent?.length ?? 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    // Precondition: the ghost is genuinely on screen, showing the exact remainder -- read as raw
    // `textContent` rather than through `toHaveText`, which normalises away the leading space this
    // completion begins with. Without this the equality below would pass most convincingly when
    // the feature did nothing at all.
    const ghost = page.locator('.smarttype-ghost');
    await expect(ghost).toBeAttached();
    expect(await ghost.evaluate((element) => element.textContent)).toBe(GHOST);
    // ...on exactly one line. See the fixture's own comment: a ghost that wrapped at its leading
    // space would still move nothing, so this is the only assertion that can see it.
    expect(await ghost.evaluate((element) => element.getClientRects().length)).toBe(1);
    const withGhost = await measure();

    // The constraint: a ghost showing changes nothing about the painted page.
    expect(withGhost).toEqual(withoutGhost);

    // ...and nothing about the canonical screenplay either -- read back through the real API,
    // with the ghost still on screen.
    const screenplayId = /\/screenplays\/([0-9a-f-]+)/u.exec(page.url())?.[1];
    if (!screenplayId) {
      throw new Error(`Could not find a screenplay id in ${page.url()}.`);
    }
    const persisted = await page.request.get(`/api/screenplays/${screenplayId}`);
    expect(persisted.ok()).toBe(true);
    const { screenplay } = (await persisted.json()) as {
      screenplay: { blocks: ScreenplayBlock[] };
    };
    const persistedHeading = screenplay.blocks[1];
    expect(persistedHeading && 'text' in persistedHeading ? persistedHeading.text : undefined).toBe(
      HEADING,
    );
    expect(await ghost.evaluate((element) => element.textContent)).toBe(GHOST);

    /**
     * The optional candidate list (apps/web/src/smartTypeList.tsx), opened over the same caret.
     *
     * Its claim to being out of the manuscript is stronger than the ghost's -- it is a
     * `position: fixed` panel rendered at the application root, so it is not in `.page`'s box tree
     * at all -- but "it floats" is an argument, not a measurement, and floating boxes still take
     * part in layout in the ways that matter here if anything about that is wrong: a panel that
     * ended up in the flow of `.script-body`, or one that widened `.editor-region`'s scrollable
     * area, would move lines exactly the way an in-flow ghost does. So the list is held to the
     * identical standard: the whole page, measured with the list open, against the baseline
     * measured with nothing showing at all.
     *
     * The panel is checked to be genuinely painted first. An equality against a baseline is most
     * easily satisfied by a list that is not there, so its box is required to be real and to sit
     * where a list belongs -- under the completion it offers alternatives to.
     *
     * REMOVING THE LIST: everything from here to the `// Escape dismisses it` comment below goes
     * with it, along with the two mentions of the list in this test's name and doc comment. That
     * layer is otherwise a self-contained delete (see `smartTypeList.tsx`'s own header for the full
     * checklist); this test is the one place outside it that breaks if it is missed, and it breaks
     * on a listbox that will never appear rather than on anything that names the layer.
     */
    await page.keyboard.press('ArrowDown');
    const listbox = page.getByRole('listbox', { name: 'SmartType completions' });
    await expect(listbox).toBeVisible();
    // Two candidates, and their order is the vocabulary's: `LATE NIGHT` was authored in the scene
    // above, `LATER` is one of `deriveVocabulary`'s seeded times and has never been authored.
    await expect(listbox.getByRole('option')).toHaveText(['LATE NIGHT', 'LATER']);

    const listBox = await listbox.boundingBox();
    const ghostBox = await ghost.boundingBox();
    if (!listBox || !ghostBox) {
      throw new Error('The list or the ghost is not being painted.');
    }
    expect(listBox.width).toBeGreaterThan(0);
    expect(listBox.height).toBeGreaterThan(0);
    expect(listBox.y).toBeGreaterThanOrEqual(ghostBox.y + ghostBox.height);
    expect(Math.abs(listBox.x - ghostBox.x)).toBeLessThan(2);

    // The constraint, for the list this time.
    expect(await measure()).toEqual(withoutGhost);

    // The manuscript (`canvas`, from `createAndOpenScreenplay` above) is still a textbox --
    // `combobox` has no `aria-multiline` -- paired with the popup for as long as the popup exists,
    // and publishing the selected option rather than moving focus into the list, which would cost
    // the writer their caret.
    await expect(canvas).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas).toHaveAttribute('aria-controls', 'smarttype-list');
    await expect(canvas).toHaveAttribute('aria-activedescendant', 'smarttype-option-0');

    // Moving the selection moves the ghost with it, so the two never disagree about what Tab would
    // insert -- and a longer ghost, drawn further past the right edge of a line that is already
    // one character short of full, still moves nothing.
    await page.keyboard.press('ArrowDown');
    await expect(canvas).toHaveAttribute('aria-activedescendant', 'smarttype-option-1');
    await expect(listbox.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    expect(await ghost.evaluate((element) => element.textContent)).toBe('R');
    expect(await measure()).toEqual(withoutGhost);

    // Escape closes the list and leaves the ghost standing, back on its own top-ranked candidate.
    // The second Escape, below, is the one that dismisses the ghost.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    await expect(listbox).toHaveCount(0);
    await expect(canvas).not.toHaveAttribute('aria-expanded', 'true');
    await expect(ghost).toBeAttached();
    expect(await ghost.evaluate((element) => element.textContent)).toBe(GHOST);
    expect(await measure()).toEqual(withoutGhost);

    // Escape dismisses it, and dismissing it moves nothing either.
    await page.keyboard.press('Escape');
    await expect(page.locator('.smarttype-ghost')).toHaveCount(0);
    expect(await measure()).toEqual(withoutGhost);

    // The other half of the contract, through a real keystroke rather than a dispatched keymap
    // call: typing again brings the completion back (Escape dismisses until the writer types, not
    // for good), Tab accepts it into the document for real, and the accepted text -- not the ghost
    // -- is what the API is holding afterwards.
    const accepted = `${HEADING}${GHOST}`;
    await page.keyboard.type(' ');
    await expect(ghost).toHaveText(GHOST.slice(1));
    const acceptSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().includes('/api/screenplays/') &&
        response.status() === 200,
    );
    await page.keyboard.press('Tab');
    await expect(page.locator('.smarttype-ghost')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.querySelectorAll('[data-screenplay-block]')[1]?.textContent ?? '',
      ),
    ).toBe(accepted);

    await acceptSaved;
    const afterAccept = await page.request.get(`/api/screenplays/${screenplayId}`);
    expect(afterAccept.ok()).toBe(true);
    const { screenplay: acceptedScreenplay } = (await afterAccept.json()) as {
      screenplay: { blocks: ScreenplayBlock[] };
    };
    const acceptedHeading = acceptedScreenplay.blocks[1];
    expect(acceptedHeading && 'text' in acceptedHeading ? acceptedHeading.text : undefined).toBe(
      accepted,
    );
  });
});
