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

  describe('loader', () => {
    /*
     * Tested because the crumb tests below feed `loaderData` in directly and so never exercise
     * this -- verified by mutation: replacing the loader's return with `{}` left every one of them
     * green. The loader is the half that can silently cost the trail its screenplay segment.
     */
    const loader = Route.options.loader as (opts: {
      context: { queryClient: { ensureQueryData: (options: unknown) => Promise<unknown> } };
      params: { projectId: string; screenplayId: string };
    }) => Promise<{ screenplayTitle: string | undefined }>;

    it('reads the title from the same ["screenplay", id] query the editor route already primes', async () => {
      // The shared key is the point: arriving here from the editor is a cache hit, not a refetch.
      const ensureQueryData = vi.fn().mockResolvedValue({ id: screenplayId, title: 'Act One' });
      const result = await loader({
        context: { queryClient: { ensureQueryData } },
        params: { projectId, screenplayId },
      });

      expect(ensureQueryData).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['screenplay', screenplayId] }),
      );
      expect(result).toEqual({ screenplayTitle: 'Act One' });
    });
  });

  describe('staticData.breadcrumb', () => {
    /*
     * The way back to the screenplay used to be a "Back to screenplay" link in this screen's own
     * hand-rolled header. The app-bar slice replaced that header with the shared titlebar, and the
     * way back became a *segment of the breadcrumb trail* rather than a second affordance saying
     * the same thing -- so this asserts the declaration, exactly as the project layout's own test
     * does for its two crumbs. `routeBreadcrumb.test.tsx` owns how a declaration becomes rendered
     * links; this file's job is only to prove this route declares the right one.
     *
     * `Projects` and the project's own title are deliberately absent here: they are inherited from
     * the `$projectId` pathless layout every project-scoped route nests under, and restating them
     * is the duplication that layout exists to prevent.
     */
    const crumbs = Route.options.staticData!.breadcrumb!;

    it('declares exactly one crumb -- the screenplay, not the ancestors it inherits', () => {
      expect(crumbs).toHaveLength(1);
    });

    it('points back at the live screenplay, labelled with its real title', () => {
      const context = {
        loaderData: { screenplayTitle: 'Act One' },
        params: { projectId, screenplayId },
      };
      expect(crumbs[0]!.label(context)).toBe('Act One');
      expect(crumbs[0]!.to(context)).toBe(`/projects/${projectId}/screenplays/${screenplayId}`);
    });

    it('omits the label rather than inventing one when the loader resolved no title', () => {
      // Same rule the project crumb follows: `undefined` drops the segment, never a placeholder.
      const context = { loaderData: {}, params: { projectId, screenplayId } };
      expect(crumbs[0]!.label(context)).toBeUndefined();
    });
  });
});
