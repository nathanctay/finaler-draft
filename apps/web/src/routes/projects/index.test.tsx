import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

describe('projects page', () => {
  beforeEach(resetRouteHarness);

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
