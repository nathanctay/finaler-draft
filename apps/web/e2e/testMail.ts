import { expect, type Page } from '@playwright/test';

/**
 * Completes the real Better Auth email-verification exchange for `email`, using the test-only
 * mailbox endpoint (`GET /api/test/last-mail`, registered only under `FINALER_SYSTEM_TEST` --
 * see `testMail` in apps/api/src/app.ts and its wiring in server.ts). `requireEmailVerification`
 * (auth.ts) means sign-up no longer creates a session by itself, so every persistence spec that
 * used to go straight from "Create account" to a signed-in workspace needs this extra step now.
 *
 * This fetches the *actual* verification link the server generated for this address and follows
 * it for real (`page.goto`), the same request a browser makes when a writer clicks the email --
 * not a database shortcut (`UPDATE "user" SET email_verified = true ...`) that would leave
 * `requireEmailVerification` itself unexercised by every browser-driven suite. A regression in
 * the verification endpoint would still be caught here; a database shortcut would hide it.
 *
 * `page.request` is Playwright's own API client, not the browser page -- this is a GET, though,
 * so it needs no `Origin` header (`app.ts`'s origin guard only refuses unsafe methods that arrive
 * without one; see the seeding request in page-rendering-persistence.spec.ts for the PUT case
 * that does need one).
 */
export async function verifyEmail(page: Page, email: string): Promise<void> {
  const mail = await page.request.get(`/api/test/last-mail?to=${encodeURIComponent(email)}`);
  expect(mail.ok(), `No verification email was recorded for ${email}.`).toBe(true);
  const { text } = (await mail.json()) as { text: string };
  const link = text.match(/https?:\/\/\S+/)?.[0];
  expect(link, `No verification link found in the email sent to ${email}.`).toBeDefined();
  await page.goto(link!);
}

/**
 * Signs in through the real form after `verifyEmail` above has already completed verification --
 * sign-up alone no longer creates a session (`requireEmailVerification`, auth.ts), so this is now
 * the second half of reaching a signed-in workspace from a fresh account.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
