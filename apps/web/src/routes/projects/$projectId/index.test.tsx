import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

const { Route } = await import('./index.js');
const ProjectPage = Route.options.component!;

describe('project page', () => {
  beforeEach(resetRouteHarness);

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
});
