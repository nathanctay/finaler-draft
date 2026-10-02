import { expect, test, type Page } from '@playwright/test';
import { PERSISTED_POLL_TIMEOUT_MS } from './persistedPollTimeout.js';
import { signIn, verifyEmail } from './testMail.js';

/**
 * Collaboration slice 4a's real-browser proof: historical preview is read-only and does not
 * disturb the live document. Real signup, a real Hocuspocus-backed editor, a real named revision
 * created through the actual File menu action, and a real navigation into that revision's own
 * preview route -- the same reasoning `offline-persistence.spec.ts`'s own top-of-file comment
 * gives for why this class of claim needs a genuine browser and a genuine database rather than a
 * jsdom simulation: `App.historicalRevision.test.tsx` (apps/web/src) already proves the mechanism
 * in isolation (no `HocuspocusProvider` is ever constructed), but only a real running `apps/collab`
 * and a real live document can prove the second half of the claim -- that opening and "typing
 * into" a historical preview leaves the actual live document, still open in another tab, entirely
 * unaffected.
 */
async function createAndOpenScreenplay(page: Page): Promise<void> {
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
  await page.getByLabel('New project title').fill('Revision history project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Revision history project' }).click();
  await page.getByLabel('New screenplay title').fill('Revision history script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  await expect(page.getByRole('textbox', { name: 'Screenplay editing canvas' })).toBeVisible();
}

function screenplayIdFromUrl(page: Page): string {
  const screenplayId = /\/screenplays\/([0-9a-f-]+)/u.exec(page.url())?.[1];
  if (!screenplayId) throw new Error(`Could not find a screenplay id in ${page.url()}.`);
  return screenplayId;
}

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

test('historical preview renders a named revision read-only, and leaves the live document completely untouched', async ({
  page,
}) => {
  test.setTimeout(90_000);
  page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.stack ?? err.message}`));
  await createAndOpenScreenplay(page);
  const screenplayId = screenplayIdFromUrl(page);
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });

  await canvas.click();
  await page.keyboard.type('Original live content.');
  await waitForPersistedText(page, screenplayId, 'Original live content.');

  // Save a named revision through the real File menu action, not a direct API call -- this
  // exercises the exact path a writer would use.
  await page.getByRole('button', { name: 'File menu' }).click();
  await page.getByRole('menuitem', { name: 'Save named revision…' }).click();
  const namedDialog = page.getByRole('dialog', { name: 'Save named revision' });
  await expect(namedDialog).toBeVisible();
  await namedDialog.getByRole('textbox', { name: 'Revision label' }).fill('First milestone');
  await namedDialog.getByRole('button', { name: 'Save' }).click();
  await expect(namedDialog).toBeHidden();

  // A further live edit *after* the revision was captured -- this is what proves the preview
  // below is showing the captured snapshot, not merely "whatever the live document says right
  // now." Closing the dialog returns focus to the File menu trigger, not the canvas (the same
  // convention every File-menu dialog in this app already follows), so the canvas needs a real
  // click before typing into it again.
  await canvas.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Written after the milestone.');
  await waitForPersistedText(page, screenplayId, 'Written after the milestone.');

  // Open revision history and the named revision's own preview.
  await page.getByRole('button', { name: 'File menu' }).click();
  await page.getByRole('menuitem', { name: 'Revision history…' }).click();
  await expect(page.getByRole('heading', { name: 'Revision history' })).toBeVisible();
  await page.getByRole('link', { name: /First milestone/ }).click();

  const previewCanvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(previewCanvas).toBeVisible();

  // The captured snapshot -- content present, and the later live edit genuinely absent.
  await expect(previewCanvas).toContainText('Original live content.');
  await expect(previewCanvas).not.toContainText('Written after the milestone.');

  // Unmistakably distinct from the live editor, and read-only by every observable measure.
  await expect(page.getByText(/Historical revision\./)).toBeVisible();
  await expect(page.getByText(/First milestone/)).toBeVisible();
  await expect(previewCanvas).not.toHaveAttribute('contenteditable', 'true');
  await expect(page.getByRole('button', { name: 'Undo local change' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo local change' })).toBeDisabled();
  await page.getByRole('button', { name: 'File menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Document settings…' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Save named revision…' })).toBeDisabled();
  // History is never offered from inside history.
  await expect(page.getByRole('menuitem', { name: 'Revision history…' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A real attempted keystroke into the read-only canvas changes nothing.
  await previewCanvas.click();
  await page.keyboard.type('ATTEMPTED EDIT');
  await expect(previewCanvas).not.toContainText('ATTEMPTED EDIT');
  await expect(previewCanvas).toContainText('Original live content.');

  // The live document, fetched independently, was never touched by any of the above.
  const liveResponse = await page.request.get(`/api/screenplays/${screenplayId}`);
  expect(liveResponse.ok()).toBe(true);
  const { screenplay: liveScreenplay } = (await liveResponse.json()) as {
    screenplay: { blocks: ReadonlyArray<{ text?: string }> };
  };
  expect(
    liveScreenplay.blocks.some((block) => block.text?.includes('Written after the milestone.')),
  ).toBe(true);
  expect(liveScreenplay.blocks.some((block) => block.text?.includes('ATTEMPTED EDIT'))).toBe(false);
});
