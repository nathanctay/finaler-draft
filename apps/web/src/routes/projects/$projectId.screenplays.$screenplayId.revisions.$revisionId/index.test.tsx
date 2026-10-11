import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../../../api.js';
import {
  entitlementSnapshot,
  fakeJsonResponse,
  fetchMock,
  invalidateQueries,
  projectId,
  resetRouteHarness,
  revisionId,
  routeState,
  screenplayId,
} from '../../../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../../../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../../test/routeHarness.js')).reactRouterMock(importOriginal),
);
vi.mock('../../../App.js', async () =>
  (await import('../../../test/routeHarness.js')).editorModuleMock(),
);

const { Route } = await import('./index.js');
const RevisionPreviewPage = Route.options.component!;

const revisionDetail = {
  id: revisionId,
  kind: 'named' as const,
  label: 'Draft 2',
  authoredBy: 'actor-1',
  createdAt: '2026-08-06T15:04:00.000Z',
  previewMetadata: { sceneCount: 3, blockCount: 40 },
  screenplayId,
  screenplay: {
    annotations: [],
    blocks: [],
    id: revisionId,
    schemaVersion: 1,
    title: 'A Working Draft, Revision 2',
    titlePages: [],
  },
};

const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

describe('revision preview page', () => {
  beforeEach(resetRouteHarness);

  it('redirects a signed-out visitor to /sign-in instead of rendering, the same guard every other protected route uses', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  it('rejects malformed identifiers before the page consumes them', () => {
    const parse = Route.options.params?.parse as
      | ((params: { projectId: string; revisionId: string; screenplayId: string }) => unknown)
      | undefined;
    expect(parse).toBeDefined();
    expect(parse?.({ projectId, revisionId, screenplayId })).toEqual({
      projectId,
      revisionId,
      screenplayId,
    });
    expect(() => parse?.({ projectId, revisionId: 'bad-id', screenplayId })).toThrow();
  });

  it('shows a loading state, then an unavailable state', () => {
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<RevisionPreviewPage />);
    expect(screen.getByText('Opening revision…')).toBeVisible();

    routeState.query = { data: undefined, isError: true, isLoading: false };
    rerender(<RevisionPreviewPage />);
    expect(screen.getByText('This revision is unavailable.')).toBeVisible();
  });

  it('renders the editor with historicalRevision set, carrying the revision’s own screenplay -- and never onOpenRevisionHistory', async () => {
    routeState.query = { data: revisionDetail, isError: false, isLoading: false };
    render(<RevisionPreviewPage />);

    const editor = await screen.findByTestId('editor-instance');
    expect(editor).toHaveTextContent('A Working Draft, Revision 2');
    expect(screen.getByTestId('historical-revision')).toHaveTextContent('Draft 2');
    // History is never offered from inside history -- the route passes no
    // `onOpenRevisionHistory` at all.
    expect(screen.queryByRole('button', { name: 'Revision history…' })).not.toBeInTheDocument();
  });

  /**
   * The banner's way back, and the destination is the point of the test, not the label: it goes to
   * this route's parent -- the revision history -- not to the live editor it used to go to. The
   * writer's path out is viewer → revisions → editor, with the history page's own "Back to
   * screenplay" link as the last step, so the live document is still two clicks away rather than
   * unreachable. See `HistoricalRevisionInfo.onBackToRevisions` in App.tsx.
   */
  it('sends the banner’s way back to the revision history, not to the live editor', async () => {
    routeState.query = { data: revisionDetail, isError: false, isLoading: false };
    render(<RevisionPreviewPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Back to revisions' }));

    expect(routeState.navigate).toHaveBeenCalledWith({
      params: { projectId, screenplayId },
      to: '/projects/$projectId/screenplays/$screenplayId/revisions',
    });
  });

  it('labels an automatic revision by its kind, not a blank label', async () => {
    routeState.query = {
      data: { ...revisionDetail, kind: 'idle_session', label: null },
      isError: false,
      isLoading: false,
    };
    render(<RevisionPreviewPage />);
    expect(await screen.findByTestId('historical-revision')).toHaveTextContent(
      'Autosave — idle session',
    );
  });
});

/**
 * Collaboration slice 5's step 1: "an authorized owner/editor previews a screenplay-aware diff and
 * confirms the target revision." This route owns three of the four parts -- whether the restore is
 * offered at all, the `expectedEpoch` the confirmation carries, and what happens to the cache
 * afterwards -- and the dialog (`restoreRevisionDialog.tsx`, its own suite) owns the fourth.
 *
 * These tests use the *real* dialog, not a stub: the one thing a stub could not prove is that the
 * route and the dialog agree about the request id, which is the whole of the idempotency mechanism.
 */
describe('revision preview page: restore as current', () => {
  const liveScreenplay = {
    id: screenplayId,
    projectId,
    currentEpoch: 4,
    title: 'A Working Draft',
    screenplay: {
      annotations: [],
      blocks: [],
      id: screenplayId,
      schemaVersion: 1,
      title: 'A Working Draft',
      titlePages: [],
    },
  };

  function setQueries(
    entitlement: unknown = entitlementSnapshot(),
    screenplay: unknown = liveScreenplay,
  ) {
    routeState.queries[JSON.stringify(['revision', screenplayId, revisionId])] = {
      data: revisionDetail,
      isError: false,
      isLoading: false,
    };
    routeState.queries[JSON.stringify(['screenplay', screenplayId])] = {
      data: screenplay,
      isError: false,
      isLoading: false,
    };
    routeState.queries[JSON.stringify(['entitlement'])] = {
      data: entitlement,
      isError: false,
      isLoading: false,
    };
  }

  beforeEach(resetRouteHarness);

  it('offers the restore only when entitlement confirms this account may edit this screenplay', async () => {
    setQueries(entitlementSnapshot({ tier: 'paid' }));
    const paid = render(<RevisionPreviewPage />);
    expect(
      await screen.findByRole('button', { name: 'Restore this revision…' }),
    ).toBeInTheDocument();
    paid.unmount();

    // A restricted-tier account whose one editable screenplay is a different one: the server would
    // answer 402 anyway, so offering the button would be a dead end.
    setQueries(
      entitlementSnapshot({
        tier: 'restricted',
        editableScreenplayId: '00000000-0000-4000-8000-0000000000ff',
      }),
    );
    const outsideSlot = render(<RevisionPreviewPage />);
    await screen.findByTestId('editor-instance');
    expect(screen.queryByRole('button', { name: 'Restore this revision…' })).toBeNull();
    outsideSlot.unmount();

    // Restricted, but this *is* their editable screenplay -- offered.
    setQueries(entitlementSnapshot({ tier: 'restricted', editableScreenplayId: screenplayId }));
    render(<RevisionPreviewPage />);
    expect(
      await screen.findByRole('button', { name: 'Restore this revision…' }),
    ).toBeInTheDocument();
  });

  it('offers nothing when the entitlement lookup itself failed, rather than guessing', async () => {
    setQueries(entitlementSnapshot());
    routeState.queries[JSON.stringify(['entitlement'])] = {
      data: undefined,
      isError: true,
      isLoading: false,
    };
    render(<RevisionPreviewPage />);
    await screen.findByTestId('editor-instance');
    expect(screen.queryByRole('button', { name: 'Restore this revision…' })).toBeNull();
  });

  /**
   * The request the confirmation actually sends, and the two things about it that matter most:
   * `expectedEpoch` is the *live* screenplay's epoch (not the revision's, and not a guess), and
   * `restoreRequestId` is a uuid generated by the dialog, which is what makes a retry idempotent.
   */
  it('sends the live screenplay’s epoch and the dialog’s request id, then refreshes both caches and returns to the live document', async () => {
    setQueries();
    fetchMock.mockImplementation(async (path: unknown, init?: { method?: string }) => {
      if (
        path === `/api/screenplays/${screenplayId}/revisions/${revisionId}/restore` &&
        init?.method === 'POST'
      ) {
        return fakeJsonResponse({
          epoch: 5,
          previousEpoch: 4,
          restoreRevisionId: '7f7f7f7f-7777-4777-8777-777777777777',
          canonicalHash: 'a'.repeat(64),
          previousHeadRevisionId: null,
          created: true,
        });
      }
      return fakeJsonResponse({});
    });

    render(<RevisionPreviewPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restore this revision…' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore as current' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([path, init]) =>
          path === `/api/screenplays/${screenplayId}/revisions/${revisionId}/restore` &&
          (init as { method?: string } | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as { body: string }).body) as {
        expectedEpoch: number;
        restoreRequestId: string;
      };
      expect(body.expectedEpoch).toBe(4);
      expect(body.restoreRequestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    // Both invalidations matter: `['screenplay', id]` is cached with `staleTime: Infinity`, so
    // without it the live route would reopen the pre-restore snapshot -- including the epoch the
    // restore just retired.
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['screenplay', screenplayId] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['revisions', screenplayId] });
      expect(routeState.navigate).toHaveBeenCalledWith({
        params: { projectId, screenplayId },
        to: '/projects/$projectId/screenplays/$screenplayId',
      });
    });
  });

  /**
   * The failure path, and the reason the request id is generated once when the dialog opens rather
   * than per click: a refused confirmation leaves the dialog open with the server's own explanation,
   * and a retry must carry the identical key so the server can recognise it as the same intent.
   */
  it('keeps the dialog open with the server’s own explanation when the restore is refused, and retries with the same request id', async () => {
    setQueries();
    let attempts = 0;
    fetchMock.mockImplementation(async (path: unknown, init?: { method?: string }) => {
      if (
        path === `/api/screenplays/${screenplayId}/revisions/${revisionId}/restore` &&
        init?.method === 'POST'
      ) {
        attempts += 1;
        return fakeJsonResponse(
          {
            error: 'This screenplay has already moved on to a newer version. Reload and try again.',
          },
          { ok: false, status: 409 },
        );
      }
      return fakeJsonResponse({});
    });

    render(<RevisionPreviewPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restore this revision…' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore as current' }));

    expect(
      await screen.findByText(
        'This screenplay has already moved on to a newer version. Reload and try again.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(routeState.navigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Restore as current' }));
    await waitFor(() => expect(attempts).toBe(2));
    const keys = fetchMock.mock.calls
      .filter(
        ([path, init]) =>
          path === `/api/screenplays/${screenplayId}/revisions/${revisionId}/restore` &&
          (init as { method?: string } | undefined)?.method === 'POST',
      )
      .map(([, init]) => JSON.parse((init as { body: string }).body).restoreRequestId as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('closes on Cancel without sending anything', async () => {
    setQueries();
    render(<RevisionPreviewPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restore this revision…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      fetchMock.mock.calls.some(([path]) =>
        String(path).endsWith(`/revisions/${revisionId}/restore`),
      ),
    ).toBe(false);
  });
});
