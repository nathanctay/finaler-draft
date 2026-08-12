import { expect, test } from '@playwright/test';

test('signed-in visitors are kept off /sign-in, and signing out reverses that', async ({
  page,
}) => {
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
  await expect(page).toHaveURL('/projects');

  // Sign in, reload the page, and land on /projects rather than /sign-in.
  await page.reload();
  await expect(page).toHaveURL('/projects');
  await expect(page.getByRole('heading', { name: 'Your writing desk' })).toBeVisible();

  // While signed in, navigating to /sign-in lands on /projects.
  await page.goto('/sign-in');
  await expect(page).toHaveURL('/projects');

  // Sign out via the account menu, then attempt /projects directly and land on /sign-in.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  await page.goto('/projects');
  await expect(page).toHaveURL('/sign-in');
});
