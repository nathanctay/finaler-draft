import { expect, test, type Locator, type Page } from '@playwright/test';
import { PERSISTED_POLL_TIMEOUT_MS } from './persistedPollTimeout.js';
import { signIn, verifyEmail } from './testMail.js';

/**
 * The real-browser proof for the defect `progress/collaboration-title-page.md` fixes: the title
 * page and document settings had no save path at all once slice 1 deleted the whole-document
 * `PUT`. Reuses `presence-persistence.spec.ts`'s own two-context pattern (one account, two
 * independent browser contexts on the identical screenplay URL) rather than inventing a new one --
 * that file's own top-of-file comment explains why "same account, two contexts" is exactly what
 * the brief this file also answers calls for, and there is no user-facing way to add a second real
 * account to a project (progress/collaboration-slice-2.md).
 *
 * Runs under `playwright.persistence.config.ts` for the same reason every other spec in that
 * config does: it needs a real signed-in writer, a real screenplay, a real `apps/collab` on the
 * real save path (`onStoreDocument`), and a second real signed-in session in a second context.
 */

async function createAndOpenScreenplay(
  page: Page,
  screenplayTitle: string,
): Promise<{ canvas: Locator; email: string; password: string }> {
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
  await page.getByLabel('New project title').fill('Title page project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Title page project' }).click();
  await page.getByLabel('New screenplay title').fill(screenplayTitle);
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  return { canvas, email, password };
}

/** Signs the same account in on a second, independent context and opens the identical screenplay
 * URL -- copied from `presence-persistence.spec.ts`'s own helper of the same name. */
async function openScreenplayAsSecondSession(
  page: Page,
  email: string,
  password: string,
  screenplayUrl: string,
): Promise<{ canvas: Locator }> {
  await page.goto('/');
  await signIn(page, email, password);
  await expect(page.getByRole('heading', { name: 'Your writing desk' })).toBeVisible();
  await page.goto(screenplayUrl);
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  await expect(page.getByText(/^Synced/)).toBeVisible();
  return { canvas };
}

/** The screenplay id `createAndOpenScreenplay` always navigates to. */
function screenplayIdFromUrl(page: Page): string {
  const screenplayId = /\/screenplays\/([0-9a-f-]+)/u.exec(page.url())?.[1];
  if (!screenplayId) {
    throw new Error(`Could not find a screenplay id in ${page.url()}.`);
  }
  return screenplayId;
}

/**
 * The title-page equivalent of `persistence.spec.ts`'s own `waitForPersistedText`: polls the real,
 * database-backed `GET /api/screenplays/:id` -- unchanged by this slice, since it still reads
 * `canonical_screenplay`, now kept current by `apps/collab`'s `createStore` projecting the title
 * page out of the Yjs document instead of passing an existing row's value through -- until the
 * title page's own `title` field matches. A direct proof the edit reached Postgres, not merely
 * that this tab's own socket reports "synced".
 */
async function waitForPersistedTitlePageTitle(
  page: Page,
  screenplayId: string,
  expectedTitle: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/screenplays/${screenplayId}`);
        expect(response.ok()).toBe(true);
        const { screenplay } = (await response.json()) as {
          screenplay: { titlePages: ReadonlyArray<{ title?: string }> };
        };
        return screenplay.titlePages[0]?.title;
      },
      { timeout: PERSISTED_POLL_TIMEOUT_MS },
    )
    .toBe(expectedTitle);
}

/** Selects all of a contentEditable title-page field's text and replaces it -- the real browser
 * interaction `titlePageEditor.tsx`'s "uncontrolled but synced" `TitlePageField` is built for. */
async function replaceFieldText(page: Page, field: Locator, next: string): Promise<void> {
  await field.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(next);
}

test.describe('title page and document settings: real save path, two real browser contexts', () => {
  test('context A edits the title page, context B sees it live, and it survives a reload', async ({
    page: pageA,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { email, password } = await createAndOpenScreenplay(pageA, 'Title Page Script');
    await expect(pageA.getByText(/^Synced/)).toBeVisible();
    const screenplayId = screenplayIdFromUrl(pageA);

    // A new screenplay is created with a real default title page
    // (`routes/projects/$projectId/index.tsx`'s `createDefaultTitlePage` call), so it is already
    // visible the moment the first collaborative sync lands -- this is the "no `document_yjs_state`
    // row yet" seeding path (`apps/collab/src/database.ts`'s `createFetch`), exercised for real.
    const titlePageA = pageA.getByRole('article', { name: 'Title page', exact: true });
    await expect(titlePageA).toBeVisible();
    const titleFieldA = pageA.getByRole('textbox', { name: 'Title page: title' });
    await expect(titleFieldA).toHaveText('Title Page Script');

    const screenplayUrl = pageA.url();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await openScreenplayAsSecondSession(pageB, email, password, screenplayUrl);
      const titleFieldB = pageB.getByRole('textbox', { name: 'Title page: title' });
      await expect(titleFieldB).toHaveText('Title Page Script');

      // The edit under test: context A changes the title-page title. Live sync, not a save-then-
      // reload -- this is the "no remote cursors, no sync between windows" half of the defect.
      await replaceFieldText(pageA, titleFieldA, 'A Retitled Screenplay');

      await expect(titleFieldB).toHaveText('A Retitled Screenplay');
      // The rest of the title page is untouched by this one-field edit -- the same "preserving the
      // rest of the title page exactly" property the deleted REST-era test named.
      await expect(pageB.getByRole('textbox', { name: 'Title page: written by' })).toHaveText(
        'written by',
      );

      // Persistence, not merely this tab's own live sync: the real database row itself now carries
      // the edit.
      await waitForPersistedTitlePageTitle(pageB, screenplayId, 'A Retitled Screenplay');

      // The other half of the defect: "changes do not survive a reload." A fresh navigation to the
      // same URL rebuilds `<App>` from scratch, including a brand-new `HocuspocusProvider` --
      // proving the edit is durable, not merely alive in an open socket's in-memory `Y.Doc`.
      await pageB.reload();
      await expect(pageB.getByRole('textbox', { name: 'Screenplay editing canvas' })).toBeVisible();
      await expect(pageB.getByText(/^Synced/)).toBeVisible();
      await expect(pageB.getByRole('textbox', { name: 'Title page: title' })).toHaveText(
        'A Retitled Screenplay',
      );
    } finally {
      await contextB.close();
    }
  });

  test('context A changes a document setting, context B sees it live, and it survives a reload', async ({
    page: pageA,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { email, password } = await createAndOpenScreenplay(pageA, 'Settings Script');
    await expect(pageA.getByText(/^Synced/)).toBeVisible();

    const screenplayUrl = pageA.url();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await openScreenplayAsSecondSession(pageB, email, password, screenplayUrl);

      // A opens the document-settings dialog and turns scene numbers on -- a setting that changes
      // page geometry (`updatePaginationDocumentSettings`), not merely a stored value, so this also
      // stands in for the "does documentSettings changing under a remote writer break repagination"
      // question this slice's own brief raises: this document keeps rendering normally throughout,
      // proving that a remote settings change repaginating this tab's own view does not break it.
      await pageA.getByRole('button', { name: 'File menu' }).click();
      await pageA.getByRole('menuitem', { name: 'Document settings…' }).click();
      const dialogA = pageA.getByRole('dialog', { name: 'Document settings' });
      await dialogA.getByRole('checkbox', { name: 'Number scenes' }).click();
      await pageA.keyboard.press('Escape');

      // B, who never opened the dialog, observes the setting arrive on its own -- read directly
      // out of *its own* dialog rather than off a rendering side effect (a scene-number widget
      // needs real scene-heading text to render at all, which a brand-new screenplay's seeded
      // empty block does not have; the checkbox's own checked state is the direct, unambiguous
      // read of what `documentSettingsFromYMap` resolved for this tab).
      await pageB.getByRole('button', { name: 'File menu' }).click();
      await pageB.getByRole('menuitem', { name: 'Document settings…' }).click();
      const dialogB = pageB.getByRole('dialog', { name: 'Document settings' });
      await expect(dialogB.getByRole('checkbox', { name: 'Number scenes' })).toBeChecked();
      await pageB.keyboard.press('Escape');

      await pageB.reload();
      await expect(pageB.getByRole('textbox', { name: 'Screenplay editing canvas' })).toBeVisible();
      await expect(pageB.getByText(/^Synced/)).toBeVisible();
      await pageB.getByRole('button', { name: 'File menu' }).click();
      await pageB.getByRole('menuitem', { name: 'Document settings…' }).click();
      await expect(
        pageB.getByRole('dialog', { name: 'Document settings' }).getByRole('checkbox', {
          name: 'Number scenes',
        }),
      ).toBeChecked();
    } finally {
      await contextB.close();
    }
  });
});
