import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../../../api.js';
import {
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

const { Route } = await import('./index.js');
const RevisionHistoryPage = Route.options.component!;
const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

describe('revision history page', () => {
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
      | ((params: { projectId: string; screenplayId: string }) => unknown)
      | undefined;
    expect(parse).toBeDefined();
    expect(parse?.({ projectId, screenplayId })).toEqual({ projectId, screenplayId });
    expect(() => parse?.({ projectId, screenplayId: 'bad-id' })).toThrow();
  });

  it('shows a loading state, then an error state', () => {
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<RevisionHistoryPage />);
    expect(screen.getByText('Loading revision history…')).toBeVisible();

    routeState.query = { data: undefined, isError: true, isLoading: false };
    rerender(<RevisionHistoryPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Revision history could not be loaded.');
  });

  it('shows an empty state when the screenplay has no revisions yet', () => {
    routeState.query = { data: [], isError: false, isLoading: false };
    render(<RevisionHistoryPage />);
    expect(screen.getByText('No revisions yet.')).toBeVisible();
  });

  it('lists every revision, newest first as the store already ordered them, with a link into each preview', () => {
    routeState.query = {
      data: [
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
          kind: 'named',
          label: 'Draft 2',
          authoredBy: 'actor-1',
          createdAt: '2026-08-06T00:00:00.000Z',
          previewMetadata: { sceneCount: 3, blockCount: 40 },
        },
        {
          id: 'bbbbbbbb-0000-4000-8000-000000000002',
          kind: 'idle_session',
          label: null,
          authoredBy: null,
          createdAt: '2026-08-05T00:00:00.000Z',
          previewMetadata: { sceneCount: 2, blockCount: 30 },
        },
      ],
      isError: false,
      isLoading: false,
    };
    render(<RevisionHistoryPage />);

    const namedLink = screen.getByRole('link', { name: /Draft 2/ });
    expect(namedLink).toHaveTextContent('3 scenes, 40 blocks');
    expect(namedLink).toHaveAttribute(
      'href',
      '/projects/$projectId/screenplays/$screenplayId/revisions/$revisionId',
    );
    expect(screen.getByRole('link', { name: /Autosave — idle session/ })).toHaveTextContent(
      '2 scenes, 30 blocks',
    );
  });

  it('links each row into its own diff-against-current view, distinct from its preview link', () => {
    routeState.query = {
      data: [
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
          kind: 'named',
          label: 'Draft 2',
          authoredBy: 'actor-1',
          createdAt: '2026-08-06T00:00:00.000Z',
          previewMetadata: { sceneCount: 3, blockCount: 40 },
        },
      ],
      isError: false,
      isLoading: false,
    };
    render(<RevisionHistoryPage />);

    const diffLinks = screen.getAllByRole('link', { name: 'Compare to current' });
    expect(diffLinks).toHaveLength(1);
    expect(diffLinks[0]).toHaveAttribute(
      'href',
      '/projects/$projectId/screenplays/$screenplayId/revisions/$revisionId/diff',
    );
  });

  /*
   * This page declared a loader and a single screenplay crumb, both existing only to put
   * "Projects / project / screenplay" in front of its name. The owner judged that trail noise on a
   * view *of* a screenplay -- the same call already made for the editor and the comparison -- so
   * the trail, the crumb and the loader that fed it are all gone.
   *
   * What replaced the way back is an explicit control rather than a trail segment, which is the
   * part that matters: with no crumb and a brand pointing at the dashboard, this page would
   * otherwise have had no route back to the screenplay it belongs to.
   */
  it('declares no breadcrumb and no loader, and renders no trail', () => {
    expect(Route.options.staticData?.breadcrumb).toBeUndefined();
    expect(Route.options.loader).toBeUndefined();

    /*
     * `routeState.matches` is populated on purpose. The harness defaults it to `[]`, and with an
     * empty match stack `RouteBreadcrumb` renders nothing whether this route passes the prop or
     * not -- so the link assertion below is vacuous without a fixture, and re-adding the prop
     * passed this test until these matches existed. Verified by mutation both ways.
     *
     * These are the `$projectId` layout's real crumbs, which this route nests beneath and would
     * inherit if it rendered a trail at all.
     */
    routeState.matches = [
      {
        id: '/projects/$projectId',
        loaderData: { projectTitle: 'Hollow Heart' },
        params: { projectId },
        pathname: `/projects/${projectId}`,
        staticData: {
          breadcrumb: [
            { label: () => 'Projects', to: () => '/projects' },
            {
              label: (ctx: { loaderData: { projectTitle: string } }) => ctx.loaderData.projectTitle,
              to: (ctx: { params: { projectId: string } }) => `/projects/${ctx.params.projectId}`,
            },
          ],
        },
      },
      {
        id: '/projects/$projectId/screenplays/$screenplayId/revisions/',
        params: { projectId, screenplayId },
        pathname: `/projects/${projectId}/screenplays/${screenplayId}/revisions`,
        staticData: {},
      },
    ];

    routeState.query = { data: [], isError: false, isLoading: false };
    render(<RevisionHistoryPage />);
    expect(document.querySelectorAll('.breadcrumb-link')).toHaveLength(0);
  });

  it('offers an explicit way back to the screenplay, beside the heading', () => {
    routeState.query = { data: [], isError: false, isLoading: false };
    render(<RevisionHistoryPage />);

    const back = screen.getByRole('link', { name: 'Back to screenplay' });
    // The route *pattern*, not an interpolated path: `routeHarness`'s `Link` stand-in renders the
    // raw `to` prop and ignores `params`, which is the convention every other link assertion in
    // this file follows. What this pins is the destination route, which is the part that can regress.
    expect(back).toHaveAttribute('href', '/projects/$projectId/screenplays/$screenplayId');
    // Beside the heading, not elsewhere on the page: the owner asked for it inline with
    // "Revision history", so this pins the relationship rather than mere presence.
    expect(back.closest('.section-head')?.querySelector('h1')).toHaveTextContent(
      'Revision history',
    );
  });
});
