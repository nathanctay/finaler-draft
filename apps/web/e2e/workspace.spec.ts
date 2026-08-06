import { expect, test } from '@playwright/test';

test('writer can work with the production workspace shell', async ({ page }) => {
  await page.goto('/');
  const healthResponse = await page.request.get('/api/health');
  await expect(healthResponse).toBeOK();
  await expect(healthResponse.json()).resolves.toEqual({ status: 'ok' });
  await expect(page.getByText('Finaler Draft')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Screenplay editing canvas' })).toBeVisible();
  const heading = page.locator('[data-block-id="2175a1b6-8d05-4e6e-bac7-e471e8df33a1"]');
  await expect
    .poll(() =>
      heading.evaluate((element) => {
        const label = getComputedStyle(element, '::before');
        return { left: label.left, top: label.top };
      }),
    )
    .toEqual({ left: '0px', top: '0px' });
  await page.getByRole('button', { name: /1\. INT\. APARTMENT/i }).click();
  await page.getByRole('combobox', { name: 'Active screenplay element' }).selectOption('shot');
  await expect(
    page.locator('[data-block-id="2175a1b6-8d05-4e6e-bac7-e471e8df33a1"]'),
  ).toHaveAttribute('data-screenplay-element', 'shot');
  await expect(page.getByText('1 scenes · local draft')).toBeVisible();
  const action = page.locator('[data-block-id="ba53c2dc-10a6-46d7-a409-9aabbff7cf5d"]');
  await action.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-screenplay-block]')).toHaveCount(8);
  await expect(page.getByText(/validated locally/i)).toBeVisible();
  await page.getByRole('button', { name: 'Toggle navigator' }).click();
  await expect(page.getByRole('complementary', { name: 'Navigator' })).toBeHidden();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByLabel('Zoom level')).toHaveText('110%');
});
