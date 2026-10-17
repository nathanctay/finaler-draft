import { expect, test, type Browser, type Page } from '@playwright/test';
import { signIn, verifyEmail } from './testMail.js';

/**
 * The screenplay-invitations slice's real-browser proof of the accept/decline flow.
 *
 * Two genuinely separate browser contexts and two real accounts, because that is the only way to
 * exercise the thing this slice exists for: an invitation written by one signed-in person and
 * answered by a different signed-in person, across the real HTTP surface, the real session cookies
 * and a real database. The unit-level suites already prove each half in isolation
 * (`sharingDialog.test.tsx` the dialog, `routes/projects/index.sharing.test.tsx` the dashboard
 * rows, `sharing.integration.test.ts` every store decision against a real database), so what is
 * left for a browser -- and only reachable there -- is that the two halves actually meet: the
 * owner's dialog really does create something the invitee's dashboard really does show, and
 * answering it really does change what the invitee can reach.
 *
 * Deliberately exercises *both* answers in one spec rather than two. Accept and decline share one
 * route and one set of caches, and the decline case's whole point is that it leaves no access --
 * which is only meaningful next to an accept that does.
 */
async function createAccount(
  page: Page,
  label: string,
): Promise<{ email: string; password: string }> {
  const token = crypto.randomUUID();
  const email = `${label}-${token}@example.test`;
  const password = `test-${token}-safe-password`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill(label === 'owner' ? 'The Owner' : 'The Invitee');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
  await verifyEmail(page, email);
  await signIn(page, email, password);
  await expect(page.getByRole('heading', { name: 'Your writing desk' })).toBeVisible();
  return { email, password };
}

/**
 * A project with one screenplay.
 *
 * One, not two: the free tier allows exactly one editable screenplay per account
 * (`EntitlementLimitError`), so a second `New screenplay` here is refused with a 402 -- which is
 * why no spec in this directory creates more than one. The sibling-screenplay negative therefore
 * cannot be set up through the interface on a free account, and it is not attempted here: it is
 * proven where it is enforced and where a sibling can actually be created, in
 * `apps/api/src/sharing.integration.test.ts` (every REST path, by id) and
 * `apps/collab/src/collaboration.integration.test.ts` (the socket). What this spec proves is the
 * thing only a browser can: two real accounts, two real sessions, and an invitation written in one
 * and answered in the other.
 */
async function createProjectWithScreenplay(page: Page): Promise<void> {
  await page.getByLabel('New project title').fill('Invitation project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Invitation project' }).click();
  await page.getByLabel('New screenplay title').fill('Shared script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  await expect(page.getByRole('textbox', { name: 'Screenplay editing canvas' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Screenplays' })).toBeVisible();
}

async function openContext(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test('an owner invites from the screenplay menu, and the invitee accepts from their own dashboard and reaches exactly that screenplay', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ownerPage = await openContext(browser);
  const inviteePage = await openContext(browser);

  const invitee = await createAccount(inviteePage, 'invitee');
  await createAccount(ownerPage, 'owner');
  await createProjectWithScreenplay(ownerPage);

  // The owner invites through the screenplay row's own three-dot menu -- the scope the owner asked
  // for specifically ("just the screenplay if thats all they want to share").
  await ownerPage.getByRole('button', { name: 'Screenplay actions for Shared script' }).click();
  await ownerPage.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = ownerPage.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('this screenplay only');
  await dialog.getByLabel('Invite by email address').fill(invitee.email);
  await dialog.getByLabel('Invited role').selectOption('editor');
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.getByRole('status')).toContainText('Invitation sent');
  // The invitation shows as outstanding on the inviter's side immediately.
  await expect(dialog).toContainText('Invited, not yet accepted');
  await dialog.getByRole('button', { name: 'Done' }).click();

  // The invitee's dashboard shows it, naming the screenplay rather than only the project.
  await inviteePage.goto('/projects');
  const banner = inviteePage.getByRole('status').filter({ hasText: 'invited you to' });
  await expect(banner).toContainText('The Owner');
  await expect(banner).toContainText('the screenplay “Shared script” in “Invitation project”');
  await expect(banner).toContainText('as an editor');

  // Before accepting, the invitation grants nothing. Asserted over the real HTTP surface rather
  // than through the interface, because "cannot reach it" is a property of the server, and a
  // missing link in a list could be a rendering accident rather than a refusal.
  const screenplaysBefore = await inviteePage.request.get('/api/shared-screenplays');
  expect(screenplaysBefore.ok()).toBe(true);
  expect(await screenplaysBefore.json()).toEqual([]);

  // The owner's project id, read before accepting so the assertions below can name the exact
  // route the invitee must not be offered.
  const ownerProjects = await ownerPage.request.get('/api/projects');
  expect(ownerProjects.ok()).toBe(true);
  const [project] = (await ownerProjects.json()) as Array<{ id: string }>;
  expect(project).toBeDefined();

  await banner.getByRole('button', { name: 'Accept' }).click();

  // The invitation is gone from the dashboard, and the screenplay has arrived under "Shared with
  // you" -- as a screenplay, never as a project the invitee is not a member of.
  await expect(inviteePage.getByText('SHARED WITH YOU')).toBeVisible();
  await expect(inviteePage.getByRole('link', { name: /Shared script/ })).toBeVisible();
  await expect(banner).toHaveCount(0);
  // Asserted on the href, not on an accessible name: the shared-screenplay row names its parent
  // project in its own role badge ("editor · in Invitation project"), and `getByRole`'s `name`
  // matches substrings, so a name-based assertion here would match that row and claim a link into
  // the project page exists when none does. The route is the thing that must be absent.
  await expect(inviteePage.locator(`a[href="/projects/${project!.id}"]`)).toHaveCount(0);

  // And it really opens: a real editor, bound to the real collaboration document.
  await inviteePage.getByRole('link', { name: /Shared script/ }).click();
  await expect(
    inviteePage.getByRole('textbox', { name: 'Screenplay editing canvas' }),
  ).toBeVisible();

  // Accepting a *screenplay*-scoped invitation granted exactly that -- not membership of the
  // project it lives in. Read over the real HTTP surface with the invitee's own session, because
  // the scope is enforced server-side and a missing row in a rendered list could be a rendering
  // accident rather than a refusal.
  const inviteeProjects = await inviteePage.request.get('/api/projects');
  expect(await inviteeProjects.json()).toEqual([]);
  // The project's own sharing view is not theirs to read either, even though they can reach one
  // screenplay inside it -- sharing is a project-level privilege (`sharing.ts`).
  const sharingForInvitee = await inviteePage.request.get(`/api/projects/${project!.id}/sharing`);
  expect(sharingForInvitee.status()).toBe(404);

  await ownerPage.context().close();
  await inviteePage.context().close();
});

test('declining removes the invitation and leaves no access at all', async ({ browser }) => {
  test.setTimeout(120_000);
  const ownerPage = await openContext(browser);
  const inviteePage = await openContext(browser);

  const invitee = await createAccount(inviteePage, 'decliner');
  await createAccount(ownerPage, 'owner');
  await createProjectWithScreenplay(ownerPage);

  // This one invites to the whole project, through the project row's three-dot menu -- the other
  // scope, and the other entry point, so the two specs between them cover both.
  await ownerPage.goto('/projects');
  await ownerPage.getByRole('button', { name: 'Project actions for Invitation project' }).click();
  await ownerPage.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = ownerPage.getByRole('dialog');
  await expect(dialog).toContainText('every screenplay in this project');
  await dialog.getByLabel('Invite by email address').fill(invitee.email);
  await dialog.getByLabel('Invited role').selectOption('reviewer');
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.getByRole('status')).toContainText('Invitation sent');
  await dialog.getByRole('button', { name: 'Done' }).click();

  await inviteePage.goto('/projects');
  const banner = inviteePage.getByRole('status').filter({ hasText: 'invited you to' });
  await expect(banner).toContainText('the project “Invitation project”');
  await expect(banner).toContainText('as a reviewer');
  await banner.getByRole('button', { name: 'Decline' }).click();

  // Gone from the dashboard, and nothing gained: no project, and nothing under "Shared with you".
  await expect(banner).toHaveCount(0);
  await expect(inviteePage.getByText('SHARED WITH YOU')).toHaveCount(0);
  const projects = await inviteePage.request.get('/api/projects');
  expect(await projects.json()).toEqual([]);
  const invitations = await inviteePage.request.get('/api/invitations');
  expect(await invitations.json()).toEqual([]);

  // And it stops being outstanding on the inviter's side too, rather than lingering as something
  // they are still waiting on.
  await ownerPage.getByRole('button', { name: 'Project actions for Invitation project' }).click();
  await ownerPage.getByRole('menuitem', { name: 'Share…' }).click();
  await expect(ownerPage.getByRole('dialog')).toBeVisible();
  await expect(ownerPage.getByRole('dialog')).not.toContainText('Invited, not yet accepted');

  await ownerPage.context().close();
  await inviteePage.context().close();
});

test('inviting an address with no account says so, and writes no invitation', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ownerPage = await openContext(browser);
  await createAccount(ownerPage, 'owner');
  await createProjectWithScreenplay(ownerPage);

  await ownerPage.goto('/projects');
  await ownerPage.getByRole('button', { name: 'Project actions for Invitation project' }).click();
  await ownerPage.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = ownerPage.getByRole('dialog');
  const unknown = `nobody-${crypto.randomUUID()}@example.test`;
  await dialog.getByLabel('Invite by email address').fill(unknown);
  await dialog.getByRole('button', { name: 'Invite' }).click();

  // The owner's explicit decision: say so, rather than conceal it behind a response identical to a
  // successful invite. The typed address stays in the field, since a typo is the likeliest cause.
  await expect(dialog.getByRole('status')).toContainText('No account found for that email address');
  await expect(dialog.getByLabel('Invite by email address')).toHaveValue(unknown);
  await expect(dialog).not.toContainText('Invited, not yet accepted');

  await ownerPage.context().close();
});
