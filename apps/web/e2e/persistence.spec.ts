import { expect, test, type Locator, type Page } from '@playwright/test';
import { signIn, verifyEmail } from './testMail.js';

/**
 * A real signed-in writer with a real screenplay open in the real editor -- this is the only
 * route to that state, since `/projects/$projectId/screenplays/$screenplayId` requires both a
 * session and a screenplay to actually fetch, and this suite is the one place a disposable
 * database is available to provide both (see playwright.persistence.config.ts).
 *
 * Sign-up alone no longer reaches a signed-in workspace: `requireEmailVerification` (auth.ts)
 * means Better Auth skips auto-sign-in for a freshly created, unverified account. `verifyEmail`
 * and `signIn` (testMail.ts) are the real verification-then-sign-in path that now stands between
 * "Create account" and "Your writing desk".
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
  await page.getByLabel('New project title').fill('Persistence project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Persistence project' }).click();
  await page.getByLabel('New screenplay title').fill('Saved script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  return { canvas };
}

test('the real editor renders .script-body as the first in-flow child of .page, and the first line at exactly 1.0in', async ({
  page,
}) => {
  // This is the test the lead asked for: not a hand-built approximation of what .page contains,
  // but the actual component, actually rendered, after an actual sign-up and an actual screenplay
  // fetched from an actual database. A previous version of this slice's geometry proofs built
  // `.page > .script-body` directly by hand and never caught that the real App.tsx rendered
  // `.page-number`, `.script-title`, and `.script-meta` ahead of `.script-body` -- displacing the
  // real manuscript by nearly 2in below where every spacer assumed it started, while every
  // hand-built fixture kept measuring a structure that did not exist. See
  // progress/page-rendering.md's 2026-08-09 entry.
  const { canvas } = await createAndOpenScreenplay(page);
  await expect(canvas.locator('[data-screenplay-block]').first()).toBeVisible();

  const measured = await page.evaluate(() => {
    const pageEl = document.querySelector('.page');
    if (!pageEl) {
      throw new Error('Missing .page element.');
    }
    const scriptBody = pageEl.querySelector(':scope > .script-body');
    if (!scriptBody) {
      throw new Error('.script-body is not a direct child of .page.');
    }

    // Guard (requirement 4): .page must have no IN-FLOW child before .script-body. .page-number
    // is the one intentional exception -- it is position: absolute and contributes nothing to
    // flow. Any other element here, at any computed position, means something now displaces the
    // manuscript the way .script-title/.script-meta used to.
    const precedingInFlow: string[] = [];
    let sibling = pageEl.firstElementChild;
    while (sibling && sibling !== scriptBody) {
      const isPageNumber = sibling.classList.contains('page-number');
      const position = getComputedStyle(sibling).position;
      if (!(isPageNumber && (position === 'absolute' || position === 'fixed'))) {
        precedingInFlow.push(`${sibling.className} (position: ${position})`);
      }
      sibling = sibling.nextElementSibling;
    }

    const pageRect = pageEl.getBoundingClientRect();
    const firstBlock = scriptBody.querySelector('[data-screenplay-block]');
    const firstLineTopIn = firstBlock
      ? (firstBlock.getBoundingClientRect().top - pageRect.top) / 96
      : undefined;

    return { precedingInFlow, firstLineTopIn };
  });

  expect(measured.precedingInFlow).toEqual([]);
  expect(measured.firstLineTopIn).toBeDefined();
  expect(Math.abs((measured.firstLineTopIn ?? 0) - 1.0)).toBeLessThan(0.01);
});

// A sibling regression to the one the previous test guards against: `.panel-tabs > span`
// (styles.css) stopped matching the Navigator's Scenes/Characters tabs the moment they became
// real `<button role="tab">` controls, and nothing caught it -- every existing test asserted
// behaviour (aria-selected, click-to-switch) and roles, never that a CSS rule still bound to the
// real markup. A `<button>` carries browser-default chrome a `<span>` never had (a raised border,
// a filled background), so an unmatched selector does not just do nothing -- it lets that default
// chrome show through, which is exactly what the owner reported ("the large font and bezel...
// looks like something from Windows 97"). Only a real browser computes this cascade at all
// (jsdom-based unit tests do not apply the real stylesheet), so this has to live here.
test('the Navigator tab buttons render as flat controls, not the browser default button chrome', async ({
  page,
}) => {
  await createAndOpenScreenplay(page);
  const scenesTab = page.getByRole('tab', { name: 'Scenes' });
  await expect(scenesTab).toBeVisible();

  const style = await scenesTab.evaluate((element) => {
    const computed = getComputedStyle(element);
    // Top/left/right, not the shorthand `borderWidth`: the design deliberately keeps a
    // `border-bottom: 2px solid transparent` on every tab (reserved space for the underline
    // `.selected` paints, so gaining it never shifts layout), which is real, intentional
    // border-width on one side -- checking the shorthand would make this assertion fail on the
    // correct, fixed styling as readily as on the regression. The browser's own default button
    // bezel is uniform on all four sides, so a clean top edge alone already proves it is gone.
    return {
      borderTopWidth: computed.borderTopWidth,
      backgroundColor: computed.backgroundColor,
    };
  });

  expect(style.borderTopWidth).toBe('0px');
  expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
});

test('a writer can create, autosave, and reload a private screenplay', async ({ page }) => {
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
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
  await verifyEmail(page, email);
  await signIn(page, email, password);
  await expect(page.getByRole('heading', { name: 'Your writing desk' })).toBeVisible();
  await page.getByLabel('New project title').fill('Persistence project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Persistence project' }).click();
  await page.getByLabel('New screenplay title').fill('Saved script');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  const canvas = page.getByRole('textbox', { name: 'Screenplay editing canvas' });
  await expect(canvas).toBeVisible();
  await canvas.click();
  // Typed straight into the block a brand-new screenplay already has: App.tsx seeds the document
  // with one empty `action` block (`editorContent`'s fallback for an empty canonical screenplay)
  // so there is always somewhere to put the caret. An Enter first would not add a block a writer
  // wants -- it would open the element menu (elementMenu.tsx), because Enter at an empty block
  // offers the element types rather than stacking a second empty one.
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

/**
 * `progress/paste-sanitization.md`: pasting used to make the screenplay stop saving, with almost
 * nothing to tell the writer. This is the required real-browser proof -- jsdom cannot parse HTML
 * or drive a real clipboard the way a browser does, and `screenplayEditor.test.ts`'s unit tests
 * (which use `EditorView.pasteHTML`/`pasteText` and a real `serializeForClipboard` round trip,
 * but still inside jsdom) are the mechanism, not the property the owner actually lost. The
 * property is this: the edit reaches the server. A green "projection is valid" assertion proves
 * the mechanism; only a completed `PUT` proves the save the owner lost actually happens again.
 *
 * Both tests below wait for that `PUT` explicitly and assert the real rendered "Saved" text
 * against no-name constants, the same discipline `save-conflict-recovery.md` used for its own
 * conflict-message test -- a test that only checked `projection.valid` in isolation would pass
 * even if some *other* guard downstream (the pagination plugin, the export menu) still treated a
 * sanitized-but-differently-broken document as invalid, which is exactly the kind of vacuous
 * green this suite exists to rule out.
 */
test('pasting foreign HTML keeps the screenplay valid and saving, instead of failing closed silently', async ({
  page,
}) => {
  const { canvas } = await createAndOpenScreenplay(page);
  // The async Clipboard API (`navigator.clipboard.write` below) needs this; the OS-level
  // Ctrl+C/Ctrl+V a later test in this file uses does not.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await canvas.click();
  // Straight into the seeded empty block, for the reason the first test in this file spells out.
  await page.keyboard.type('INT. HOUSE - DAY');
  await page.keyboard.press('Enter');

  // Representative of the `lipsum.com` paste from the bug report: a heading, a link, and bold
  // inline formatting -- none of which this schema's `screenplayBlock` can represent -- ahead of
  // plain paragraph text. Before this fix, `ScreenplayDocument`'s content expression rejected
  // whatever node ProseMirror's default parsing produced for the `<h1>`/`<a>` here as an
  // "Unsupported local editor node", the exact issue text the owner reported.
  const foreignHtml =
    '<h1>Scene notes</h1>' +
    '<p>Lorem ipsum <strong>dolor sit</strong> amet, consectetur ' +
    '<a href="https://example.test/lipsum">adipiscing</a> elit.</p>' +
    '<p>A second foreign paragraph, with no markup at all.</p>';
  await page.evaluate(async (html) => {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob(['Scene notes\nLorem ipsum dolor sit amet.'], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
  }, foreignHtml);

  const savedAfterPaste = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/api/screenplays/') &&
      response.status() === 200,
  );
  await page.keyboard.press('ControlOrMeta+KeyV');
  await savedAfterPaste;

  await expect(page.getByText(/^Saved · validated locally/)).toBeVisible();
  await expect(page.getByText(/Draft needs attention/)).toHaveCount(0);
  await expect(page.getByText(/Not saving/)).toHaveCount(0);
  await expect(canvas).toContainText('Scene notes');
  await expect(canvas).toContainText('Lorem ipsum dolor sit amet, consectetur adipiscing elit.');
});

test('pasting content copied from this editor back into the same document regenerates ids and keeps saving', async ({
  page,
}) => {
  const { canvas } = await createAndOpenScreenplay(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await canvas.click();
  // Straight into the seeded empty block, for the reason the first test in this file spells out --
  // which is also what makes this exactly the three-block copy the assertions below describe.
  await page.keyboard.type('INT. HOUSE - DAY');
  await page.keyboard.press('Enter');
  await page.keyboard.type('MARA enters the room.');
  const firstSavedUpdate = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/api/screenplays/') &&
      response.status() === 200,
  );
  await page.keyboard.press('Enter');
  await page.keyboard.type('CUT TO:');
  await firstSavedUpdate;
  await expect(page.getByText(/^Saved · validated locally/)).toBeVisible();

  // The owner's literal report: "copying from our own page and pasting produced 'Stable id ...
  // must be globally unique'". Select-all-and-copy is the simplest real action that reproduces
  // it -- every block currently in the document, each carrying the same `data-block-id`s already
  // present in the document it is about to be pasted back into.
  //
  // The copy itself has to be genuine -- this listener captures the real `clipboardData` a real
  // 'copy' event carries, which is `ScreenplayBlockNode`'s real `renderHTML` output run through
  // `EditorView.serializeForClipboard` (`prosemirror-view`'s real copy handler, registered on
  // `view.dom` when the editor mounts, fires and calls `event.clipboardData.setData(...)` before
  // this bubble-phase `document` listener sees the same event) -- not HTML this test authors by
  // hand. What is NOT genuine, deliberately: getting that HTML onto the clipboard the *paste*
  // reads from. The first version of this test used a real OS-level Ctrl+C/Ctrl+V round trip
  // (`navigator.clipboard.write` was reserved for the sibling "foreign HTML" test above) and was
  // flaky under this suite's runner -- observed directly, more than once, as the paste landing
  // with the document completely unchanged, because the browser's native copy handler writes to
  // the real OS pasteboard asynchronously and a same-tick Ctrl+V does not reliably wait for it.
  // Writing the captured HTML through the async Clipboard API instead (below, the same mechanism
  // the "foreign HTML" test already uses, and the one this suite has confirmed to be reliable) is
  // synchronous from this test's point of view, so the subsequent Ctrl+V has no race to lose.
  const copiedHtml = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener(
          'copy',
          (event) => resolve(event.clipboardData?.getData('text/html') ?? ''),
          { once: true },
        );
      }),
  );
  await page.keyboard.press('ControlOrMeta+KeyA');
  await page.keyboard.press('ControlOrMeta+KeyC');
  const html = await copiedHtml;
  expect(html).toContain('MARA enters the room.');
  expect(html).toContain('CUT TO:');
  // Reload before pasting, instead of collapsing the still-active select-all in place.
  //
  // That collapse is what made this test flaky for its whole life, and the cause is subtler than
  // it looks. ProseMirror keeps its own selection in editor state and syncs it from the DOM
  // asynchronously, on `selectionchange`. So after `ArrowRight` the *DOM* selection is already a
  // collapsed caret while ProseMirror's state can still hold the `AllSelection` -- and a paste
  // inside that window replaces the whole document with a copy of itself. That produces the same
  // block count with every id regenerated, which reads exactly like "the paste never happened",
  // while a save still fires because new ids are a genuine change. Captured from a failing run:
  // four blocks before, four after, all four ids different, DOM selection collapsed throughout.
  //
  // Waiting on `window.getSelection().isCollapsed` cannot fix this -- that is the very signal
  // that lies. Reloading removes the question: the editor remounts with fresh state and no
  // selection to inherit, so no stale `AllSelection` can exist. The screenplay was already saved
  // above, so this reloads the same persisted document.
  await page.reload();
  await expect(canvas).toBeVisible();
  await expect(canvas.getByText('MARA enters the room.')).toHaveCount(1);

  const savedAfterPaste = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/api/screenplays/') &&
      response.status() === 200,
  );

  // Dispatched directly rather than written to the OS clipboard and pressed Ctrl+V. `html` above
  // is what a real copy really produced, and a dispatched `paste` event still runs ProseMirror's
  // own `parseFromClipboard` and `transformPasted`, including `ScreenplayPasteSanitizer` -- which
  // is the thing under test. What it removes is the OS pasteboard, which is not this product's
  // code and whose asynchrony was a second, independent source of flakiness here.
  await page.evaluate((clipboardHtml) => {
    const editorDom = document.querySelector('.ProseMirror');
    if (!editorDom) throw new Error('No ProseMirror editor found to paste into.');
    const transfer = new DataTransfer();
    transfer.setData('text/html', clipboardHtml);
    editorDom.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  }, html);
  await savedAfterPaste;

  await expect(page.getByText(/^Saved · validated locally/)).toBeVisible();
  await expect(page.getByText(/Draft needs attention/)).toHaveCount(0);
  await expect(page.getByText(/Not saving/)).toHaveCount(0);

  // Not a fixed block count: the paste landed at the end of "CUT TO:", inside its text, so the
  // copied slice's own open edges merge into that block the same way any ProseMirror editor
  // merges an open paste edge into its insertion point (screenplayEditor.ts's own ruling, and
  // out of scope to redefine here) -- the exact resulting shape is not this test's concern. What
  // must hold regardless of that shape is the actual regression: "MARA enters the room." was the
  // fully-closed *interior* block of the three-block copy, both of its edges closed by
  // construction (only a copy's first and last siblings can be open), so it always survives the
  // paste as a genuine new block rather than merging into anything -- proof this landed as real
  // content, not proof of nothing having been pasted at all. Two real DOM nodes now carry that
  // text, and, decisively, two *different* stable ids: before this fix the second one would have
  // carried the same id as the first, which `packages/screenplay`'s schema rejects as a duplicate
  // and is the literal defect this whole scope exists to fix.
  const pastedBlocks = canvas.getByText('MARA enters the room.');
  await expect(pastedBlocks).toHaveCount(2);
  const [originalId, pastedId] = await pastedBlocks.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-block-id')),
  );
  expect(originalId).toBeTruthy();
  expect(pastedId).toBeTruthy();
  expect(pastedId).not.toBe(originalId);

  await page.reload();
  await expect(page.getByText(/^Saved · validated locally/)).toBeVisible();
  await expect(canvas.getByText('MARA enters the room.')).toHaveCount(2);
});

test('a writer can delete a screenplay from its overflow menu and undo the deletion inline, against the real API and database', async ({
  page,
}) => {
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
  await page.getByLabel('New project title').fill('Delete-undo project');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('link', { name: 'Delete-undo project' }).click();
  await page.getByLabel('New screenplay title').fill('Delete-undo screenplay');
  await page.getByRole('button', { name: 'New screenplay' }).click();
  await expect(page.getByRole('textbox', { name: 'Screenplay editing canvas' })).toBeVisible();
  // The editor shell (App.tsx) has no "Projects" breadcrumb -- that link lives only on the
  // project's screenplay list (routes/projects/$projectId/index.tsx) -- so returning to it means
  // navigating back through the push the "New screenplay" creation performed, not clicking a link
  // that does not exist on this page.
  await page.goBack();
  await expect(page.getByRole('link', { name: 'Delete-undo screenplay' })).toBeVisible();

  await page.getByRole('button', { name: 'Screenplay actions for Delete-undo screenplay' }).click();
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes('/api/screenplays/') &&
      response.status() === 200,
  );
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await deleteResponse;
  await expect(page.getByText('Delete-undo screenplay — Deleted')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Delete-undo screenplay' })).toHaveCount(0);

  const restoreResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/restore') &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: 'Undo' }).click();
  await restoreResponse;
  await expect(page.getByText('Delete-undo screenplay — Deleted')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Delete-undo screenplay' })).toBeVisible();
});

test('a writer can delete a project and restore it from the Deleted page -- reachable only through the account menu -- against the real API and database', async ({
  page,
}) => {
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
  await page.getByLabel('New project title').fill('Delete-restore project');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('link', { name: 'Delete-restore project' })).toBeVisible();

  await page.getByRole('button', { name: 'Project actions for Delete-restore project' }).click();
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes('/api/projects/') &&
      response.status() === 200,
  );
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await deleteResponse;
  await expect(page.getByText('Delete-restore project — Deleted')).toBeVisible();

  // Undo is not the only route back -- a full reload (the Undo affordance is gone) proves the
  // project is genuinely absent from the writing desk, then the Deleted page, reached only
  // through the account menu, is what restores it. This exercises the restore path Undo never
  // does: a fresh GET /api/deleted followed by POST /api/projects/:id/restore.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Delete-restore project' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Deleted items' }).click();
  await expect(page).toHaveURL('/deleted');
  await expect(page.getByText('Delete-restore project')).toBeVisible();

  const restoreResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/restore') &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: 'Restore' }).click();
  await restoreResponse;
  await expect(page.getByText('No deleted projects.')).toBeVisible();

  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page).toHaveURL('/projects');
  await expect(page.getByRole('link', { name: 'Delete-restore project' })).toBeVisible();
});
