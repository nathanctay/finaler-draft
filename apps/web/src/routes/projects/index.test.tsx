import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../../api.js';
import {
  clearQueryCache,
  fetchMock,
  invalidateQueries,
  projectId,
  resetRouteHarness,
  routeState,
} from '../../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./index.js');
const ProjectsPage = Route.options.component!;
const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

describe('projects page', () => {
  beforeEach(resetRouteHarness);

  it('redirects a signed-out visitor to /sign-in instead of rendering', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('Projects beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  it('signs out, clears the cache, and returns to /sign-in', async () => {
    const user = userEvent.setup();
    render(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/sign-out',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await vi.waitFor(() => expect(clearQueryCache).toHaveBeenCalled());
    expect(routeState.navigate).toHaveBeenCalledWith({ to: '/sign-in' });
  });

  it('surfaces feedback when sign-out fails, without pretending it succeeded', () => {
    routeState.mutationError = true;
    render(<ProjectsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Sign out failed');
    expect(routeState.navigate).not.toHaveBeenCalled();
  });

  it('displays project loading, error, data, and creation states', async () => {
    const user = userEvent.setup();
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<ProjectsPage />);
    expect(screen.getByText('Loading projects…')).toBeVisible();
    routeState.query = { data: undefined, isError: true, isLoading: false };
    rerender(<ProjectsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    routeState.query = {
      data: [{ id: projectId, role: 'owner', title: 'Feature' }],
      isError: false,
      isLoading: false,
    };
    rerender(<ProjectsPage />);
    expect(screen.getByText('Feature')).toBeVisible();
    await user.type(screen.getByLabelText('New project title'), 'New Feature');
    fireEvent.submit(screen.getByRole('button', { name: 'New project' }).closest('form')!);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await vi.waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] }),
    );
  });
});
