import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatCollabDocumentName } from '@finaler-draft/config';
import { PERSISTED_POLL_TIMEOUT_MS } from './persistedPollTimeout.js';
import { signIn, verifyEmail } from './testMail.js';

/**
 * The real-browser proof for this slice's browser-offline half
 * (progress/collaboration-offline-durable.md): a writer who loses their connection keeps editing,
 * that work is durably written to this browser's own IndexedDB (`y-indexeddb`, `App.tsx`'s
 * `collab` useMemo) as it happens rather than living only in memory, and reconnecting catches the
 * server up with nothing lost.
 *
 * Simulates offline via `context.setOffline(true)` -- a real network-level cut, not a mocked
 * event. Chromium's CDP-level network emulation does not immediately sever an already-open
 * WebSocket (confirmed directly: the status line stays `Synced` for some time after `setOffline`)
 * -- it stops the connection from receiving anything further, and `@hocuspocus/provider`'s own
 * installed source shows its dead-connection watchdog (`messageReconnectTimeout`, defaulting to
 * 30 000ms, checked every `messageReconnectTimeout / 10`) is what eventually notices the silence
 * and forces the reconnect attempt that then fails and reports `'offline'`. This is a real
 * property of the production client, not a test artifact, so the wait below is sized to it rather
 * than shortened.
 *
 * **A known, honestly-scoped limitation, not silently worked around**: this test never reloads
 * the page *while offline*. `$projectId.screenplays.$screenplayId.tsx`'s route loader fetches the
 * screenplay via a plain `useQuery` with no offline fallback -- a reload with no network reachable
 * fails that fetch and never mounts the Yjs-backed editor at all, so there is currently no route
 * by which a *cold* page load can recover purely from this browser's local IndexedDB copy. What
 * this slice's `y-indexeddb` integration *does* provide, and what this test proves directly: an
 * *already-open* editing session keeps accepting input through a live connection drop, persists
 * that work to IndexedDB as it happens (inspected directly below, not inferred), and -- once back
 * online -- a fresh page load (this test reloads only *after* restoring the network, standing in
 * for a writer refreshing a stuck tab) recovers the offline edit from IndexedDB immediately and
 * converges with the server with nothing lost. Making a *cold* reload work while still offline is
 * a real, separate enhancement (persisting the initial screenplay fetch itself, or falling back to
 * the IndexedDB copy when it fails) that this slice does not implement -- flagged here rather than
 * quietly left unproven.
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
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
  await verifyEmail(page, email);
  await signIn(page, email, password);
  await expect(page.getByRole('heading', { name: 'Your writing desk' })).toBeVisible();
  await page.getByLabel('New project title').fill('Offline project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Offline project' }).click();
  await page.getByLabel('New screenplay title').fill('Offline script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  return { canvas };
}

function screenplayIdFromUrl(page: Page): string {
  const screenplayId = /\/screenplays\/([0-9a-f-]+)/u.exec(page.url())?.[1];
  if (!screenplayId) {
    throw new Error(`Could not find a screenplay id in ${page.url()}.`);
  }
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

test('an edit made during a real connection drop is persisted to this browser’s own IndexedDB as it happens, and reaches the server once reconnected', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const { canvas } = await createAndOpenScreenplay(page);
  const screenplayId = screenplayIdFromUrl(page);

  await canvas.click();
  await page.keyboard.type('Written while online.');
  await waitForPersistedText(page, screenplayId, 'Written while online.');

  // A real network-level cut, not a mock. See this file's own top-of-file comment for why the
  // status line does not flip immediately -- `@hocuspocus/provider`'s own 30-second dead-connection
  // watchdog is what eventually notices and reports it.
  await context.setOffline(true);
  await expect(page.locator('.status-center').filter({ hasText: /^Offline/ })).toBeVisible({
    timeout: 40_000,
  });

  await page.keyboard.press('Enter');
  await page.keyboard.type('Written while offline.');
  await expect(canvas).toContainText('Written while offline.');

  // Direct proof of local persistence, not an inference from later behaviour: `y-indexeddb`
  // writes to a database named after the screenplay id (`App.tsx`'s `collab` useMemo). Polled,
  // not asserted immediately -- `IndexeddbPersistence`'s own writes are debounced internally
  // (confirmed by reading the installed source: a `_storeTimeout` before each flush to disk), so
  // there is a real, small delay between the keystroke above and the write actually landing.
  await expect
    .poll(
      async () => {
        const hasContent = await page.evaluate(
          async (name) => {
            const databases = await indexedDB.databases();
            if (!databases.some((entry) => entry.name === name)) return false;
            // The bare screenplay id must *not* be a database: collaboration slice 5 keys one store
            // per (screenplay, epoch) precisely so a retired epoch's offline work can never be
            // merged into a restored document, and this is what would catch a regression back to
            // keying by screenplay alone.
            if (databases.some((entry) => entry.name === name.split(':')[0])) return false;
            return await new Promise<boolean>((resolve) => {
              const request = indexedDB.open(name);
              request.onerror = () => resolve(false);
              request.onsuccess = () => {
                const db = request.result;
                const storeNames = Array.from(db.objectStoreNames);
                if (storeNames.length === 0) {
                  db.close();
                  resolve(false);
                  return;
                }
                const tx = db.transaction(storeNames, 'readonly');
                let anyRows = false;
                let pending = storeNames.length;
                for (const storeName of storeNames) {
                  const countRequest = tx.objectStore(storeName).count();
                  countRequest.onsuccess = () => {
                    if (countRequest.result > 0) anyRows = true;
                    pending -= 1;
                    if (pending === 0) {
                      db.close();
                      resolve(anyRows);
                    }
                  };
                }
              };
            });
            // Composed with the real helper rather than restating `<id>:<epoch>` here. A freshly
            // created screenplay is at epoch 0; this test never restores.
          },
          formatCollabDocumentName(screenplayId, 0),
        );
        return hasContent;
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // Reconnect. Network restored *before* the reload (not after) deliberately: the already-open
  // `HocuspocusProviderWebsocket` this tab has been retrying on had its reconnect backoff growing
  // for the whole offline stretch above (installed source: `delay: 1000`, `factor: 2`,
  // `maxDelay: 30000`, unlimited attempts), and waiting out however long that specific, already
  // battered connection object takes to notice the network is back is not the property this test
  // is actually about. A reload opens a *fresh* `HocuspocusProvider` with a clean connection
  // attempt -- ordinary, fast, and exactly what a real writer would do if a stuck tab looked
  // wrong. What matters, and what this proves: the reload's freshly-constructed `Y.Doc` is seeded
  // from this browser's own IndexedDB copy (confirmed above to hold the offline edit) before the
  // server is ever involved, so the offline edit is visible immediately, and the fresh connection
  // then converges with the server with nothing lost in either direction.
  await context.setOffline(false);
  await page.reload();
  const canvasAfterReload = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvasAfterReload).toBeVisible();
  await expect(canvasAfterReload).toContainText('Written while offline.');
  await expect(canvasAfterReload).toContainText('Written while online.');
  await expect(page.locator('.status-center').filter({ hasText: /^Synced/ })).toBeVisible();
  await waitForPersistedText(page, screenplayId, 'Written while offline.');
  await waitForPersistedText(page, screenplayId, 'Written while online.');
});
