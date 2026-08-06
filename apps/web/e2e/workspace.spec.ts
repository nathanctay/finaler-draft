import { expect, test } from '@playwright/test';

test('writer can work with the production workspace shell', async ({ page }) => {
  await page.goto('/');
  const healthResponse = await page.request.get('/api/health');
  await expect(healthResponse).toBeOK();
  await expect(healthResponse.json()).resolves.toEqual({ status: 'ok' });
  await expect(page.getByText('Finaler Draft')).toBeVisible();
  await page.getByRole('button', { name: 'Toggle navigator' }).click();
  await expect(page.getByRole('complementary', { name: 'Navigator' })).toBeHidden();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByLabel('Zoom level')).toHaveText('110%');
});
