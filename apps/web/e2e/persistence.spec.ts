import { expect, test } from '@playwright/test';

test('a writer can create, autosave, and reload a private screenplay', async ({ page }) => {
  const token = crypto.randomUUID();
  const email = `writer-${token}@example.test`;
  const password = `test-${token}-safe-password`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Writer');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
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
