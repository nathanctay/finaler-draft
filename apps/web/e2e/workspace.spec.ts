import { expect, test } from '@playwright/test';

test('production shell serves the private workspace entry point', async ({ page }) => {
  await page.goto('/');
  const healthResponse = await page.request.get('/api/health');
  await expect(healthResponse).toBeOK();
  await expect(healthResponse.json()).resolves.toEqual({ status: 'ok' });
  await expect(page.getByText('Finaler Draft')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Return to the work.' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});
