import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A real signed-in writer with a real screenplay open in the real editor -- this is the only
 * route to that state, since `/projects/$projectId/screenplays/$screenplayId` requires both a
 * session and a screenplay to actually fetch, and this suite is the one place a disposable
 * database is available to provide both (see playwright.persistence.config.ts).
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
  await expect(page.getByRole('heading', { name: 'Your writing desk' })).toBeVisible();
  await page.getByLabel('New project title').fill('Persistence project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Persistence project' }).click();
  await page.getByLabel('New screenplay title').fill('Saved script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  return { canvas };
}

test('the real editor renders .script-body as the first in-flow child of .page, and the first line at exactly 1.0in', async ({
  page,
}) => {
  // This is the test the lead asked for: not a hand-built approximation of what .page contains,
  // but the actual component, actually rendered, after an actual sign-up and an actual screenplay
  // fetched from an actual database. A previous version of this slice's geometry proofs built
  // `.page > .script-body` directly by hand and never caught that the real App.tsx rendered
  // `.page-number`, `.script-title`, and `.script-meta` ahead of `.script-body` -- displacing the
  // real manuscript by nearly 2in below where every spacer assumed it started, while every
  // hand-built fixture kept measuring a structure that did not exist. See
  // progress/page-rendering.md's 2026-08-09 entry.
  const { canvas } = await createAndOpenScreenplay(page);
  await expect(canvas.locator('[data-screenplay-block]').first()).toBeVisible();

  const measured = await page.evaluate(() => {
    const pageEl = document.querySelector('.page');
    if (!pageEl) {
      throw new Error('Missing .page element.');
    }
    const scriptBody = pageEl.querySelector(':scope > .script-body');
    if (!scriptBody) {
      throw new Error('.script-body is not a direct child of .page.');
    }

    // Guard (requirement 4): .page must have no IN-FLOW child before .script-body. .page-number
    // is the one intentional exception -- it is position: absolute and contributes nothing to
    // flow. Any other element here, at any computed position, means something now displaces the
    // manuscript the way .script-title/.script-meta used to.
    const precedingInFlow: string[] = [];
    let sibling = pageEl.firstElementChild;
    while (sibling && sibling !== scriptBody) {
      const isPageNumber = sibling.classList.contains('page-number');
      const position = getComputedStyle(sibling).position;
      if (!(isPageNumber && (position === 'absolute' || position === 'fixed'))) {
        precedingInFlow.push(`${sibling.className} (position: ${position})`);
      }
      sibling = sibling.nextElementSibling;
    }

    const pageRect = pageEl.getBoundingClientRect();
    const firstBlock = scriptBody.querySelector('[data-screenplay-block]');
    const firstLineTopIn = firstBlock
      ? (firstBlock.getBoundingClientRect().top - pageRect.top) / 96
      : undefined;

    return { precedingInFlow, firstLineTopIn };
  });

  expect(measured.precedingInFlow).toEqual([]);
  expect(measured.firstLineTopIn).toBeDefined();
  expect(Math.abs((measured.firstLineTopIn ?? 0) - 1.0)).toBeLessThan(0.01);
});

test('a writer can create, autosave, and reload a private screenplay', async ({ page }) => {
  const token = crypto.randomUUID();
  const email = `writer-${token}@example.test`;
  const password = `test-${token}-safe-password`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Writer');
  await page.getByLabel('Email').fill(email);
  // Exact matching keeps this from also resolving the "Confirm password" field.
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your writing desk' })).toBeVisible();
  await page.getByLabel('New project title').fill('Persistence project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Persistence project' }).click();
  await page.getByLabel('New screenplay title').fill('Saved script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  await canvas.click();
  await page.keyboard.press('Enter');
  const savedUpdate = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/api/screenplays/') &&
      response.status() === 200,
  );
  await page.keyboard.type('A saved first line');
  await savedUpdate;
  await expect(page.getByText('Saved · validated locally')).toBeVisible();
  await page.reload();
  await expect(canvas).toContainText('A saved first line');
  let conflictingPutCount = 0;
  await page.route('**/api/screenplays/*', async (route) => {
    if (route.request().method() === 'PUT') {
      conflictingPutCount += 1;
      await route.fulfill({
        body: JSON.stringify({ error: 'stale' }),
        contentType: 'application/json',
        status: 409,
      });
      return;
    }
    await route.continue();
  });
  await canvas.click();
  const conflictingUpdate = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/api/screenplays/') &&
      response.status() === 409,
  );
  await page.keyboard.type(' local conflict text');
  await conflictingUpdate;
  await expect(page.getByText(/Save conflict/)).toBeVisible();
  await expect(canvas).toContainText('local conflict text');
  await page.keyboard.type(' remains local');
  await page.waitForTimeout(800);
  await expect(canvas).toContainText('remains local');
  expect(conflictingPutCount).toBe(1);
});
