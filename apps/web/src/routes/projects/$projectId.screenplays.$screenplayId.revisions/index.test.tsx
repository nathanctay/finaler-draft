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
    expect(screen.getByRole('link', { name: /Automatic — idle session/ })).toHaveTextContent(
      '2 scenes, 30 blocks',
    );
  });

  it('links back to the live screenplay', () => {
    routeState.query = { data: [], isError: false, isLoading: false };
    render(<RevisionHistoryPage />);
    expect(screen.getByRole('link', { name: 'Back to screenplay' })).toHaveAttribute(
      'href',
      '/projects/$projectId/screenplays/$screenplayId',
    );
  });
});
