import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeJsonResponse,
  fetchMock,
  projectId,
  resetRouteHarness,
  routeState,
  screenplayId,
} from '../../../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../../../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../../test/routeHarness.js')).reactRouterMock(importOriginal),
);
// jsdom does not implement real navigation (see externalRedirect.ts's own comment) -- mocked so
// the Upgrade dialog's Stripe redirect, reached from the limit prompt below, does not hit jsdom's
// "Not implemented: navigation" console error.
vi.mock('../../../externalRedirect.js', () => ({ redirectToExternalUrl: vi.fn() }));

const { Route } = await import('./index.js');
const { redirectToExternalUrl } = await import('../../../externalRedirect.js');
const ProjectPage = Route.options.component!;

const FREE_TIER_LIMIT_MESSAGE =
  'Free tier limit reached: only one editable screenplay is allowed. Choose an existing one to keep editing, or upgrade to create another.';

describe('project page', () => {
  beforeEach(() => {
    resetRouteHarness();
    vi.mocked(redirectToExternalUrl).mockClear();
  });

  it('lists and creates screenplays for a project', async () => {
    const user = userEvent.setup();
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<ProjectPage />);
    expect(screen.getByText('Loading scripts…')).toBeVisible();
    routeState.query = {
      data: [{ id: screenplayId, title: 'Draft' }],
      isError: false,
      isLoading: false,
    };
    rerender(<ProjectPage />);
    expect(screen.getByText('Draft')).toBeVisible();
    await user.clear(screen.getByLabelText('New screenplay title'));
    await user.type(screen.getByLabelText('New screenplay title'), 'Second Draft');
    fireEvent.submit(screen.getByRole('button', { name: 'New screenplay' }).closest('form')!);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${projectId}/screenplays`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await vi.waitFor(() =>
      expect(routeState.navigate).toHaveBeenCalledWith({
        to: '/projects/$projectId/screenplays/$screenplayId',
        params: { projectId, screenplayId },
      }),
    );
  });

  it('shows an upgrade prompt, not a bare error, when the free-tier limit is hit -- and lets the writer start checkout from it', async () => {
    const user = userEvent.setup();
    routeState.query = { data: [], isError: false, isLoading: false };
    fetchMock.mockImplementation(async (path, init) => {
      if (path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST') {
        return fakeJsonResponse({ error: FREE_TIER_LIMIT_MESSAGE }, { ok: false, status: 402 });
      }
      if (path === '/api/billing/checkout-session' && init?.method === 'POST') {
        return fakeJsonResponse({ url: 'https://checkout.stripe.test/test-session' });
      }
      return fakeJsonResponse({});
    });
    const { rerender } = render(<ProjectPage />);

    fireEvent.submit(screen.getByRole('button', { name: 'New screenplay' }).closest('form')!);

    // The harness's `useMutation` mock (routeHarness.tsx) records a failed mutation's error on a
    // shared external slot rather than driving a React state update of its own -- so, unlike real
    // react-query, nothing here re-renders the component on its own once the rejected promise
    // settles. Waiting for the slot to be populated and then re-rendering is the same two-step
    // this file's sibling test already uses whenever the mocked state changes after the initial
    // render.
    await vi.waitFor(() => expect(routeState.mutationErrorValue).toBeDefined());
    rerender(<ProjectPage />);

    // Says what happened -- the server's own explanation, not a generic "something went wrong" --
    // and offers the upgrade, matching the task's own requirement for this prompt.
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(FREE_TIER_LIMIT_MESSAGE);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
    // Lazy-loaded (routes/projects/$projectId/index.tsx's own comment explains why), so it
    // appears only after the dynamic import resolves -- `findByRole`, not a synchronous
    // `getByRole`.
    expect(
      await screen.findByRole('dialog', { name: 'Upgrade to Finaler Draft Pro' }),
    ).toBeVisible();
    // The dialog carries the same explanation forward, so the writer isn't asked to re-read a
    // blank dialog after already being told what happened.
    expect(screen.getAllByText(FREE_TIER_LIMIT_MESSAGE).some((node) => node.tagName === 'P')).toBe(
      true,
    );

    await user.click(screen.getByRole('button', { name: 'Upgrade monthly' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/billing/checkout-session',
        expect.objectContaining({ body: JSON.stringify({ plan: 'monthly' }), method: 'POST' }),
      ),
    );
    await vi.waitFor(() =>
      expect(redirectToExternalUrl).toHaveBeenCalledWith(
        'https://checkout.stripe.test/test-session',
      ),
    );
  });
});

describe('Import FDX control', () => {
  // A minimal, genuinely valid Final Draft document (no title page, so the title must fall back
  // to the filename) -- enough to exercise the real `@finaler-draft/fdx` package end to end, not
  // a mock of it.
  const VALID_FDX =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<FinalDraft DocumentType="Script" Template="No" Version="6">\n' +
    '  <Content>\n' +
    '    <Paragraph Alignment="Left" LeftIndent="1.50" Type="Action" ' +
    'id="7a396a1c-6463-46ff-b6ae-c6c6e9a74eb0"><Text>Body.</Text></Paragraph>\n' +
    '  </Content>\n' +
    '</FinalDraft>\n';

  // jsdom's own `File`/`Blob` implementation does not implement `.text()` (confirmed: calling it
  // throws "file.text is not a function" even though Node's global `Blob` does) -- this control's
  // `mutationFn` calls `file.text()` exactly as a real browser's `File` supports, so the test
  // double needs that method restored directly rather than working around a real API this
  // control genuinely depends on.
  function fdxFile(contents: string, name = 'My Script.fdx'): File {
    const file = new File([contents], name, { type: 'application/xml' });
    Object.defineProperty(file, 'text', { value: async () => contents });
    return file;
  }

  /**
   * Passes the owner-approved confirmation step. A successful parse no longer creates anything on
   * its own -- it opens `FdxImportConfirmDialog`, and `api.createScreenplay` is reachable only
   * through its "Import anyway" button -- so every test that asserts creation has to come through
   * here. That is the point of the step, so this is deliberately not abstracted away into the
   * upload helper: a test that forgets it should fail, because a writer who cancels creates
   * nothing.
   */
  /**
   * An FDX file with something worth reporting -- one skipped `Outline 1` paragraph -- so the
   * confirmation dialog actually opens. Needed because a *clean* import no longer opens it at all
   * (see "a clean import creates the screenplay directly" below), so a test about the dialog has
   * to hand it a reason to exist.
   */
  const FDX_WITH_SOMETHING_TO_REPORT =
    '<FinalDraft Version="6"><Content>' +
    '<Paragraph Type="Action"><Text>Body.</Text></Paragraph>' +
    '<Paragraph Type="Outline 1"><Text>A beat</Text></Paragraph>' +
    '</Content></FinalDraft>';

  async function confirmImport(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole('button', { name: 'Import anyway' }));
  }

  function fileInput(): HTMLInputElement {
    return document.querySelector('input[type="file"]')!;
  }

  beforeEach(() => {
    resetRouteHarness();
    routeState.query = { data: [], isError: false, isLoading: false };
  });

  it('imports a valid FDX file, deriving the title from the filename when the file has no title page', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      if (path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST') {
        return fakeJsonResponse({ id: screenplayId });
      }
      return fakeJsonResponse({});
    });
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(VALID_FDX, 'My Script.fdx'));

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${projectId}/screenplays`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = fetchMock.mock.calls.find(
      ([path, init]) =>
        path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST',
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string) as {
      title: string;
      screenplay: { title: string; blocks: unknown[] };
    };
    // The file has no title page, so the title page's own missing title cannot supply this --
    // the filename, extension stripped, is the only thing left to derive a title from.
    expect(body.title).toBe('My Script');
    expect(body.screenplay.title).toBe('My Script');
    expect(body.screenplay.blocks).toHaveLength(1);

    await vi.waitFor(() =>
      expect(routeState.navigate).toHaveBeenCalledWith({
        to: '/projects/$projectId/screenplays/$screenplayId',
        params: { projectId, screenplayId },
      }),
    );
  });

  it('shows a specific, actionable error -- not a bare failure -- when the file is not a valid FDX document, and never calls create', async () => {
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.upload(
      fileInput(),
      fdxFile('this is just plain text, not a Final Draft file', 'garbage.fdx'),
    );

    expect(
      await screen.findByText(
        'That file is not a readable Final Draft document. Choose a .fdx file exported from Final Draft.',
      ),
    ).toBeVisible();
    // Scoped to the create-screenplay POST specifically, not "this path at all" -- the page's own
    // `scripts` query already GETs this exact path to list existing screenplays, which must
    // still happen normally and would otherwise make a bare `not.toHaveBeenCalledWith(path,
    // anything())` fail for an unrelated reason.
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/projects/${projectId}/screenplays`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows the upgrade prompt, not a bare error, when importing hits the free-tier limit', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      if (path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST') {
        return fakeJsonResponse({ error: FREE_TIER_LIMIT_MESSAGE }, { ok: false, status: 402 });
      }
      return fakeJsonResponse({});
    });
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(VALID_FDX));

    // `getAllByText`, not `getByText`: this harness's mocked `useMutation` (routeHarness.tsx)
    // writes every rejected mutation's error into one shared `routeState.mutationErrorValue`
    // slot regardless of which `useMutation` call rejected, so `importFdx`'s 402 here also makes
    // the unrelated `create` mutation's own `limitError`-derived banner render a second, harness-
    // only duplicate -- real react-query scopes each mutation's `.error` independently, so this
    // never happens in production. At least one banner carrying the server's real message, with
    // at least one working upgrade button, is what this test is actually proving.
    expect((await screen.findAllByText(FREE_TIER_LIMIT_MESSAGE)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: 'Upgrade to Pro' }).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('rejects a DOCTYPE-bearing file with the doctype-specific message, proving the security guard is reachable from this control', async () => {
    const user = userEvent.setup();
    const hostile =
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<FinalDraft Version="6"><Content/></FinalDraft>';
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(hostile, 'hostile.fdx'));

    expect(
      await screen.findByText(
        'That file contains document-type declarations this product does not accept. Re-export it from Final Draft and try again.',
      ),
    ).toBeVisible();
    // Scoped to the create-screenplay POST specifically, not "this path at all" -- the page's own
    // `scripts` query already GETs this exact path to list existing screenplays, which must
    // still happen normally and would otherwise make a bare `not.toHaveBeenCalledWith(path,
    // anything())` fail for an unrelated reason.
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/projects/${projectId}/screenplays`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('derives the title from the title page when the file has one, rather than the filename', async () => {
    const user = userEvent.setup();
    const withTitlePage =
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
      '<FinalDraft Version="6">\n' +
      '  <Content><Paragraph Type="Action"><Text>Body.</Text></Paragraph></Content>\n' +
      '  <TitlePage><Content>\n' +
      Array.from(
        { length: 16 },
        () =>
          '    <Paragraph Alignment="Left" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" ' +
          'OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph"/>\n',
      ).join('') +
      '    <Paragraph Alignment="Left" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" ' +
      'OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph"/>\n' +
      '    <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" ' +
      'OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph">' +
      '<Text Style="Underline+AllCaps">A Real Title</Text></Paragraph>\n' +
      '  </Content></TitlePage>\n' +
      '</FinalDraft>\n';
    fetchMock.mockImplementation(async (path, init) => {
      if (path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST') {
        return fakeJsonResponse({ id: screenplayId });
      }
      return fakeJsonResponse({});
    });
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(withTitlePage, 'ignored-filename.fdx'));

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${projectId}/screenplays`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = fetchMock.mock.calls.find(
      ([path, init]) =>
        path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST',
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string) as { title: string };
    expect(body.title).toBe('A Real Title');
  });

  it.each([
    ['<SomethingElse/>', 'That file is XML, but not a Final Draft (.fdx) document.'],
    [
      `<FinalDraft Version="6"><Content>${'a'.repeat(10_000_001)}</Content></FinalDraft>`,
      'That file is far larger than any real screenplay and was not imported.',
    ],
    [
      // A non-`<Paragraph>` element inside `<Content>` -- `'unmapped_content'`, not the more
      // specific `'unknown_types'` an unrecognised `Type` attribute now produces (Task 2, see
      // `progress/fdx-import.md`; that path has its own dedicated describe block below, since it
      // opens a resolution dialog rather than producing a flat message). An invented `Type` used
      // to stand here and no longer can -- it is exactly the case this route now resolves rather
      // than refuses.
      '<FinalDraft Version="6"><Content><SomethingOtherThanAParagraph/></Content></FinalDraft>',
      'That script contains content this product cannot represent yet, so nothing was imported -- importing it partially would risk losing part of the script silently.',
    ],
    [
      '<FinalDraft Version="6"><Content/></FinalDraft>',
      'That file did not contain any screenplay content to import.',
    ],
  ])('maps FdxImportError code to a specific message for %#', async (contents, expectedMessage) => {
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(contents, 'test.fdx'));

    expect(await screen.findByText(expectedMessage)).toBeVisible();
  });

  it('creates nothing when the writer cancels the confirmation', async () => {
    // Deliberately a file with something to report: a clean one never opens the dialog, so there
    // would be nothing to cancel.
    // The whole point of the confirmation step. Asserted as "no POST was ever made", not as "the
    // dialog closed": the property the owner asked for is that cancelling leaves no screenplay
    // behind, and that is about the API call, not the interface state.
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(FDX_WITH_SOMETHING_TO_REPORT));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/projects/${projectId}/screenplays`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a clean import creates the screenplay directly, with no confirmation dialog at all', async () => {
    // The owner's objection: "even though there are no issues, it gave me the 'Import anyway'
    // modal. We only need to do that if there are issues." A file with nothing skipped, a readable
    // title page and an editable result has nothing to confirm, so the dialog must never mount --
    // asserted as "no dialog exists" plus "the create request happened anyway", because either one
    // alone would also pass if the import had silently done nothing.
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      if (path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST') {
        return fakeJsonResponse({ id: screenplayId });
      }
      return fakeJsonResponse({});
    });
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(VALID_FDX, 'Clean Script.fdx'));

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${projectId}/screenplays`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import anyway' })).not.toBeInTheDocument();
  });

  it('lists every skipped element type with its count before anything is created', async () => {
    // `Outline 1` and `Note` are on the skip allowlist, so they no longer refuse the import --
    // they are reported here instead. Two of one type and one of another, so the test proves the
    // tally counts rather than merely listing names.
    const withSkipped =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>Body.</Text></Paragraph>' +
      '<Paragraph Type="Outline 1"><Text>Beat one</Text></Paragraph>' +
      '<Paragraph Type="Outline 1"><Text>Beat two</Text></Paragraph>' +
      '<Paragraph Type="Note"><Text>Check this</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(withSkipped, 'With Outline.fdx'));

    expect(
      await screen.findByText('Left behind, with no equivalent in this product:'),
    ).toBeVisible();
    expect(screen.getByText('2 Outline 1')).toBeVisible();
    expect(screen.getByText('1 Note')).toBeVisible();
    // Only the one Action paragraph became a block; the three skipped ones did not.
    expect(screen.getByText('Imported 1 block.')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/projects/${projectId}/screenplays`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('Task 2: warns, naming the title page specifically, when it could not be decoded -- and still imports the body when confirmed', async () => {
    // Before this pass, this exact document threw `'unmapped_content'` and refused the whole
    // import -- the title page's `<SomethingElse/>` is not a "Title Paragraph", so
    // `decodeTitlePageContent` cannot decode it, and that used to be fatal for the entire file
    // even though the one body paragraph is perfectly mappable. See
    // `progress/fdx-import.md`'s Task 2 (this pass): the title page is now reported, not fatal,
    // and the body still imports in full.
    const unreadableTitlePage =
      '<FinalDraft Version="6"><Content><Paragraph Type="Action"><Text>Body.</Text></Paragraph></Content>' +
      '<TitlePage><Content><SomethingElse/></Content></TitlePage></FinalDraft>';
    fetchMock.mockImplementation(async (path, init) => {
      if (path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST') {
        return fakeJsonResponse({ id: screenplayId });
      }
      return fakeJsonResponse({});
    });
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(unreadableTitlePage, 'Unreadable Title.fdx'));

    // Specific (names the title page) and actionable (says the body imported in full) -- not the
    // old generic "content this product cannot represent" sentence, which this case no longer
    // reaches at all.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/title page/iu);
    expect(alert).toHaveTextContent(/imported in full/iu);
    expect(
      screen.queryByText(
        'That script contains content this product cannot represent yet, so nothing was imported -- importing it partially would risk losing part of the script silently.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Imported 1 block.')).toBeVisible();

    await confirmImport(user);

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${projectId}/screenplays`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = fetchMock.mock.calls.find(
      ([path, init]) =>
        path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST',
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string) as {
      title: string;
      screenplay: { title: string; blocks: unknown[]; titlePages: unknown[] };
    };
    // The title page could not be decoded at all, so nothing is fabricated for it: `titlePages`
    // is empty, and the organizational title falls back to the filename exactly as it would for
    // a file with no title page at all.
    expect(body.title).toBe('Unreadable Title');
    expect(body.screenplay.titlePages).toEqual([]);
    expect(body.screenplay.blocks).toHaveLength(1);
  });

  it('cancelling an import whose title page could not be read creates nothing', async () => {
    // The structural "cancelling creates no screenplay" guarantee (progress/fdx-import.md's
    // confirmation-step note) applies identically whether or not a title-page warning is showing
    // -- `onCancel` only clears `pendingImport`, regardless of which warnings it was carrying.
    const unreadableTitlePage =
      '<FinalDraft Version="6"><Content><Paragraph Type="Action"><Text>Body.</Text></Paragraph></Content>' +
      '<TitlePage><Content><SomethingElse/></Content></TitlePage></FinalDraft>';
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(unreadableTitlePage, 'Unreadable Title.fdx'));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/projects/${projectId}/screenplays`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('warns that the import will open read-only before the writer commits to it', async () => {
    // A genuine `dual_dialogue` file, in the shape this package's own exporter writes (an outer
    // untyped `<Paragraph>` wrapping `<DualDialogue>` with the left column's blocks then the
    // right's). `editorContentFromScreenplay` throws for `dual_dialogue`, so the route's
    // `opensReadOnly` probe -- which calls that real function rather than restating its condition
    // -- must surface the warning here. Without this test the route's claim to compute the flag
    // from the editor's own behavior is unverified.
    const dualDialogue =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph><DualDialogue>' +
      '<Paragraph Type="Character"><Text>ANNA</Text></Paragraph>' +
      '<Paragraph Type="Dialogue"><Text>Left.</Text></Paragraph>' +
      '<Paragraph Type="Character"><Text>BRIAN</Text></Paragraph>' +
      '<Paragraph Type="Dialogue"><Text>Right.</Text></Paragraph>' +
      '</DualDialogue></Paragraph>' +
      '</Content></FinalDraft>';
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(dualDialogue, 'Dual.fdx'));

    expect(await screen.findByText(/will open read-only/u)).toBeVisible();
  });

  it('Task 3: the "Import FDX…" entry lives in the split-button\'s menu, reached via the arrow, and clicking it opens the real file picker', async () => {
    // The standalone "Import FDX…" button is gone (progress/fdx-import.md's Task 3) -- this is
    // now a menu item behind the split-button's arrow, which carries its own accessible name
    // distinct from "New screenplay" and opens no form submission at all.
    const user = userEvent.setup();
    render(<ProjectPage />);

    expect(screen.queryByRole('button', { name: 'Import FDX…' })).not.toBeInTheDocument();
    const arrow = screen.getByRole('button', { name: 'Import a screenplay' });
    expect(arrow).toHaveAttribute('aria-haspopup', 'menu');
    expect(arrow).toHaveAttribute('aria-expanded', 'false');

    const clickSpy = vi.spyOn(fileInput(), 'click');
    await user.click(arrow);
    await user.click(screen.getByRole('menuitem', { name: 'Import FDX…' }));

    expect(clickSpy).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // Pressing the arrow and its menu item never submitted the create-screenplay form.
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/projects/${projectId}/screenplays`,
      expect.objectContaining({ method: 'POST' }),
    );
    clickSpy.mockRestore();
  });

  it('does nothing when the file picker is dismissed with no file chosen', async () => {
    render(<ProjectPage />);
    fireEvent.change(fileInput(), { target: { files: [] } });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/projects/${projectId}/screenplays`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a generic message rather than crashing when createScreenplay rejects with a non-Error value', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => {
      // Simulates a raw network failure that never produced a real Error instance, proving the
      // `onError` handler's fallback path (not merely the common `instanceof Error` path).
      throw 'connection dropped';
    });
    render(<ProjectPage />);

    await user.upload(fileInput(), fdxFile(VALID_FDX));

    expect(await screen.findByText('That file could not be imported.')).toBeVisible();
  });

  it('rethrows an error from the FDX package that is not an FdxImportError, rather than masking it with the generic message', async () => {
    vi.resetModules();
    vi.doMock('@finaler-draft/fdx', () => ({
      fdxToScreenplay: () => {
        throw new TypeError('unexpected internal failure');
      },
      FdxImportError: class extends Error {},
      // The route destructures this alongside FdxImportError even on this failure path (it
      // checks `instanceof FdxUnknownTypesError` before falling back to the generic translation
      // below) -- vitest's module mock validates every destructured binding exists on the mock,
      // so this must be present even though this specific test never throws it.
      FdxUnknownTypesError: class extends Error {},
    }));
    vi.doMock('@tanstack/react-query', async () =>
      (await import('../../../test/routeHarness.js')).reactQueryMock(),
    );
    vi.doMock('@tanstack/react-router', async (importOriginal) =>
      (await import('../../../test/routeHarness.js')).reactRouterMock(importOriginal),
    );
    const { Route: FreshRoute } = await import('./index.js');
    const FreshProjectPage = FreshRoute.options.component!;
    const user = userEvent.setup();
    render(<FreshProjectPage />);

    await user.upload(fileInput(), fdxFile(VALID_FDX));

    expect(await screen.findByText('unexpected internal failure')).toBeVisible();
    vi.doUnmock('@finaler-draft/fdx');
    vi.doUnmock('@tanstack/react-query');
    vi.doUnmock('@tanstack/react-router');
    vi.resetModules();
  });

  describe('Task 2: unrecognized FDX element types open a resolution dialog instead of a flat refusal', () => {
    // Two distinct unrecognised types, so every assertion below can tell "all of them" apart from
    // "merely the first one" -- the entire point of gathering every unknown type in one pass
    // (`@finaler-draft/fdx`'s `FdxUnknownTypesError`) rather than discovering them one failed
    // attempt at a time.
    const TWO_UNKNOWN_TYPES =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>Kept.</Text></Paragraph>' +
      '<Paragraph Type="Weird Heading" Number="4A"><Text>INT. OFFICE</Text></Paragraph>' +
      '<Paragraph Type="Weird Note"><Text>Director note.</Text></Paragraph>' +
      '</Content></FinalDraft>';

    it('names every unrecognized type, with its count and an excerpt, before anything is created', async () => {
      const user = userEvent.setup();
      render(<ProjectPage />);

      await user.upload(fileInput(), fdxFile(TWO_UNKNOWN_TYPES, 'Weird.fdx'));

      expect(await screen.findByText('Weird Heading')).toBeVisible();
      expect(screen.getByText('Weird Note')).toBeVisible();
      expect(screen.getByText(/INT\. OFFICE/u)).toBeVisible();
      expect(screen.getByText(/Director note\./u)).toBeVisible();
      // No confirmation dialog yet -- the writer has not resolved anything, so nothing beyond the
      // resolution step itself has happened.
      expect(screen.queryByText(/Imported \d/u)).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith(
        `/api/projects/${projectId}/screenplays`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('creates nothing when the writer cancels the resolution dialog -- it never reaches the confirmation step', async () => {
      const user = userEvent.setup();
      render(<ProjectPage />);

      await user.upload(fileInput(), fdxFile(TWO_UNKNOWN_TYPES, 'Weird.fdx'));
      await screen.findByText('Weird Heading');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith(
        `/api/projects/${projectId}/screenplays`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('flows into the existing confirmation dialog once every type is resolved, and the resolved content reaches the created screenplay', async () => {
      const user = userEvent.setup();
      fetchMock.mockImplementation(async (path, init) => {
        if (path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST') {
          return fakeJsonResponse({ id: screenplayId });
        }
        return fakeJsonResponse({});
      });
      render(<ProjectPage />);

      await user.upload(fileInput(), fdxFile(TWO_UNKNOWN_TYPES, 'Weird.fdx'));
      await screen.findByText('Weird Heading');

      // "Weird Heading" is mapped to a scene heading; "Weird Note" is skipped.
      await user.selectOptions(
        screen.getByLabelText('Action for "Weird Heading"'),
        'map:scene_heading',
      );
      await user.selectOptions(screen.getByLabelText('Action for "Weird Note"'), 'skip');
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      // The *existing* confirmation dialog, not a second competing one: block count (Action +
      // the mapped Scene Heading) and the skipped tally for the type the writer chose to leave
      // out.
      expect(await screen.findByText('Imported 2 blocks.')).toBeVisible();
      expect(screen.getByText('1 Weird Note')).toBeVisible();
      expect(screen.queryByText('Weird Heading')).not.toBeInTheDocument();

      await confirmImport(user);

      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/projects/${projectId}/screenplays`,
          expect.objectContaining({ method: 'POST' }),
        ),
      );
      const call = fetchMock.mock.calls.find(
        ([path, init]) =>
          path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST',
      )!;
      const body = JSON.parse((call[1] as RequestInit).body as string) as {
        screenplay: {
          blocks: { id: string; type: string; text?: string; sceneNumber?: string }[];
        };
      };
      const blocksWithoutIds = body.screenplay.blocks.map((block) => ({
        type: block.type,
        text: block.text,
        sceneNumber: block.sceneNumber,
      }));
      expect(blocksWithoutIds).toEqual([
        { type: 'action', text: 'Kept.', sceneNumber: undefined },
        { type: 'scene_heading', text: 'INT. OFFICE', sceneNumber: '4A' },
      ]);
    });
  });
});
