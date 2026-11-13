import { expect, test, type Locator, type Page } from '@playwright/test';
import { PERSISTED_POLL_TIMEOUT_MS } from './persistedPollTimeout.js';
import { signIn, verifyEmail } from './testMail.js';

/**
 * What jsdom cannot answer about find & replace (`findReplace.ts`/`findReplaceBar.tsx`,
 * `progress/find-and-replace.md`): whether `.find-match-current` is actually scrolled into view
 * (jsdom performs no layout at all, so there is nothing to measure), and whether pagination
 * genuinely recomputes after a replace that changes how a line wraps. Both need the real editor,
 * which needs a real session and a real screenplay to fetch -- the same reason
 * `persistence.spec.ts`/`page-rendering-persistence.spec.ts` live under
 * `playwright.persistence.config.ts` rather than the plain `test:system` gate; this file follows
 * their identical sign-up-then-open flow rather than sharing a helper module, matching how neither
 * of those two shares one with the other.
 *
 * The project/screenplay title deliberately avoids the words "find"/"replace"/"search" --
 * `ApplicationTitlebar`'s own rename button's accessible name embeds the document title
 * (`Rename "<title>"`), and an earlier version of this file named it "Find and replace script",
 * which made `getByRole('button', { name: 'Replace' })` match that rename button too (Playwright's
 * default name matching is substring, and "Rename "Find and replace script"" contains "replace").
 * Caught directly, not guarded against speculatively: that exact collision is what
 * `scripts/test-system-persistence.mjs` reported the first time this file ran for real.
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
  await page.getByLabel('New project title').fill('Menus slice 4 project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Menus slice 4 project' }).click();
  await page.getByLabel('New screenplay title').fill('Menus slice 4 draft');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  return { canvas };
}

/** The screenplay id `createAndOpenScreenplay` (above) always navigates to -- identical to
 * `persistence.spec.ts`'s own helper of the same name. */
function screenplayIdFromUrl(page: Page): string {
  const screenplayId = /\/screenplays\/([0-9a-f-]+)/u.exec(page.url())?.[1];
  if (!screenplayId) {
    throw new Error(`Could not find a screenplay id in ${page.url()}.`);
  }
  return screenplayId;
}

/** Polls the real, database-backed `GET /api/screenplays/:id` until some block's text contains
 * `expectedText` -- the identical technique `persistence.spec.ts`'s own `waitForPersistedText`
 * uses, for the identical reason: proof a replace reached Postgres through the real Yjs sync
 * path, not merely that this tab's own editor state changed. */
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

test('Mod-f opens the bar and highlights every real match, reporting the count', async ({
  page,
}) => {
  const { canvas } = await createAndOpenScreenplay(page);
  await canvas.click();
  await page.keyboard.type('MARKER one and MARKER two and MARKER three');

  await page.keyboard.press('ControlOrMeta+KeyF');
  await expect(page.getByRole('search', { name: 'Find and replace' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Find' }).fill('MARKER');

  await expect(page.locator('.find-match')).toHaveCount(3);
  await expect(page.locator('.find-match-current')).toHaveCount(1);
  await expect(page.getByText('1 of 3')).toBeVisible();
});

/**
 * The real-browser half of "Next/Previous scrolls the current match into view" -- the brief's own
 * requirement, and one jsdom cannot prove at all (no layout, no scroll position). Follows
 * `persistence.spec.ts`'s own "Select all selects the whole document visibly..." test for
 * `.editor-region` being the real scroller (never `document.scrollingElement`, which that file's
 * own comment records as a vacuous reading that passed even with its own fix removed).
 *
 * The baseline is *not* scroll position zero -- a fresh screenplay seeds a real title page
 * (`App.tsx`'s `titlePageState`), which occupies real vertical space above the body in `.pages`,
 * so finding the very first body match already requires scrolling down past it. Measured
 * directly rather than assumed: an earlier version of this test asserted `scrollTop === 0` right
 * after the first find and failed with `663`/`1219` (depending on content length) every time --
 * not a bug in the scroll-into-view behaviour, a wrong assumption in the test, confirmed by
 * reading back which element `.find-match-current` actually was (the correct, topmost one) and
 * where it painted (well inside the viewport, at whatever scroll position put it there). What
 * this test actually proves instead: scrolling to the *second* match (far below the first) moves
 * the scroll position further than scrolling to the first already did, and the current match is
 * genuinely inside the viewport after each move -- the two things scroll-into-view promises.
 */
test('Find next scrolls the current match into view', async ({ page }) => {
  const { canvas } = await createAndOpenScreenplay(page);
  await canvas.click();
  await page.keyboard.type('MARKER at the top');
  for (let line = 0; line < 40; line += 1) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Filler line ${String(line)}`);
  }
  await page.keyboard.press('Enter');
  await page.keyboard.type('MARKER at the bottom');

  const scrollTopOf = () =>
    page.evaluate(() => document.querySelector('.editor-region')!.scrollTop);
  const overflow = await page.evaluate(() => {
    const region = document.querySelector('.editor-region')!;
    return region.scrollHeight - region.clientHeight;
  });
  expect(overflow).toBeGreaterThan(200);

  await page.keyboard.press('ControlOrMeta+KeyF');
  await page.getByRole('textbox', { name: 'Find' }).fill('MARKER');
  await expect(page.getByText('1 of 2')).toBeVisible();
  await expect(page.locator('.find-match-current')).toBeInViewport();
  const scrollAfterFirstMatch = await scrollTopOf();

  await page.getByRole('button', { name: 'Next match' }).click();
  await expect(page.getByText('2 of 2')).toBeVisible();
  // The second marker sits roughly 40 lines below the first -- scrolling to it must move the
  // viewport further down than scrolling to the first match already did, not merely "somewhere".
  await expect.poll(scrollTopOf).toBeGreaterThan(scrollAfterFirstMatch);
  await expect(page.locator('.find-match-current')).toBeInViewport();
});

test('Replace reaches the real editor and the real database', async ({ page }) => {
  const { canvas } = await createAndOpenScreenplay(page);
  const screenplayId = screenplayIdFromUrl(page);
  await canvas.click();
  await page.keyboard.type('A cat sat on the mat.');

  await page.keyboard.press('ControlOrMeta+KeyF');
  await page.getByRole('textbox', { name: 'Find' }).fill('cat');
  await page.getByRole('textbox', { name: 'Replace with' }).fill('dog');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();

  await expect(canvas).toContainText('A dog sat on the mat.');
  await waitForPersistedText(page, screenplayId, 'A dog sat on the mat.');
});

/**
 * Pagination must recompute after a replace -- the brief's own requirement. Measured through the
 * one place page count is already shown on screen (Tools > Word count's "Pages" stat,
 * `wordCountDialog.tsx`) rather than reaching into the pagination plugin's internal state, the same
 * discipline every other geometry-adjacent persistence spec in this suite follows: assert what a
 * writer can actually see, not an implementation detail standing in for it.
 *
 * The exact line count below (20, not a rounder or larger number) was measured directly against
 * this real build rather than computed from `pageFormat.ts`'s constants in the abstract: this
 * screenplay schema applies its own blank-line-before convention between action blocks
 * (`BLANK_LINES_BEFORE.action`), which this comment's own earlier arithmetic (lines per page ÷
 * lines per inch) did not account for and so underestimated how many one-character lines already
 * fill a page -- 30 of them turned out to already be two pages, not one, which would have made
 * the "before" assertion below fail for a reason having nothing to do with find & replace. 20 was
 * confirmed, directly against this build, to still be one page; see "Known limitations" in
 * `progress/find-and-replace.md` for why this figure is pinned by measurement rather than derived.
 */
test('Replace all recomputes pagination -- the page count is not stale afterward', async ({
  page,
}) => {
  const { canvas } = await createAndOpenScreenplay(page);
  await canvas.click();
  await page.keyboard.type('X');
  for (let line = 0; line < 19; line += 1) {
    await page.keyboard.press('Enter');
    await page.keyboard.type('X');
  }

  async function pagesShown(): Promise<string | null> {
    await page.getByRole('button', { name: 'Tools menu' }).click();
    await page.getByRole('menuitem', { name: 'Word count…' }).click();
    const value = await page
      .getByRole('dialog', { name: 'Word count' })
      .locator('dd')
      .nth(2)
      .textContent();
    // `exact: true`: "Close" is a substring of the find bar's own "Close find and replace"
    // button, and Playwright's default name matching is substring, not exact -- harmless here
    // since the two are never on screen together in this test, but stated as a guard against that
    // changing later rather than relied on by coincidence.
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    return value;
  }

  const before = await pagesShown();
  expect(before).toBe('1');

  // Closing the Word count dialog leaves focus on its own Close button, not back in the editor --
  // without this click, `Mod-f` has no editable region to reach and the bar never opens (measured
  // directly: the very first version of this test timed out waiting for the Find field for
  // exactly this reason).
  await canvas.click();
  await page.keyboard.press('ControlOrMeta+KeyF');
  await page.getByRole('textbox', { name: 'Find' }).fill('X');
  // 78 characters -- longer than an action line's own 60-character width (`pageFormat.ts`'s
  // `action.characters`), so every one of the 20 lines this replaces now wraps onto two physical
  // lines instead of one, pushing the document onto a second page purely by changing how a line
  // wraps -- not by adding or removing a single block.
  await page
    .getByRole('textbox', { name: 'Replace with' })
    .fill('a much longer word that wraps the line very differently than a single X did');
  await page.getByRole('button', { name: 'Replace all' }).click();
  await page.getByRole('button', { name: 'Close find and replace' }).click();

  await expect.poll(pagesShown).not.toBe('1');
});
