import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMock,
  projectId,
  resetRouteHarness,
  screenplayId,
} from '../../../test/routeHarness.js';

// Real @tanstack/react-query, mocked router -- see the identical setup and rationale in
// routes/projects/index.delete.test.tsx.
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./index.js');
const ProjectPage = Route.options.component!;

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { json: async () => body, ok, status } as unknown as Response;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectPage />
    </QueryClientProvider>,
  );
  return { queryClient };
}

describe('project screenplay list: delete and undo', () => {
  let deleted: boolean;

  beforeEach(() => {
    resetRouteHarness();
    deleted = false;
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === `/api/projects/${projectId}/screenplays` && method === 'GET') {
        return jsonResponse(
          deleted
            ? []
            : [
                {
                  id: screenplayId,
                  title: 'Draft',
                  updatedAt: '2026-01-01T00:00:00Z',
                  version: 1,
                },
              ],
        );
      }
      if (url === `/api/screenplays/${screenplayId}` && method === 'DELETE') {
        deleted = true;
        return jsonResponse({ id: screenplayId });
      }
      if (url === `/api/screenplays/${screenplayId}/restore` && method === 'POST') {
        deleted = false;
        return jsonResponse({ id: screenplayId, title: 'Draft' });
      }
      return jsonResponse([]);
    });
  });

  it('deletes a screenplay, replaces the row with an announced Undo affordance with no stale link or menu, and Undo restores it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Draft');

    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Draft' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    await screen.findByText('Draft — Deleted');
    expect(screen.getByRole('status')).toHaveTextContent('Draft — Deleted');
    expect(screen.queryByRole('link', { name: 'Draft' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Screenplay actions for Draft' }),
    ).not.toBeInTheDocument();
    // Focus-loss guard: the menuitem that was focused when Delete was activated unmounts when
    // the menu closes, and the row's own trigger unmounts when it is replaced by this affordance
    // -- without deliberate focus management, focus would fall out of the workflow entirely.
    const undoButton = screen.getByRole('button', { name: 'Undo delete of Draft' });
    expect(undoButton).toHaveFocus();

    await user.click(undoButton);
    await waitFor(() => expect(screen.queryByText('Draft — Deleted')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Draft' })).toBeVisible();
  });

  it('survives an unrelated background refetch that drops the row from the live query', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByText('Draft');

    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Draft' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await screen.findByText('Draft — Deleted');

    await act(() => queryClient.invalidateQueries({ queryKey: ['screenplays', projectId] }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Draft — Deleted')).toBeVisible();
  });

  it('surfaces a delete failure without touching the row', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === `/api/projects/${projectId}/screenplays` && method === 'GET') {
        return jsonResponse([
          { id: screenplayId, title: 'Draft', updatedAt: '2026-01-01T00:00:00Z', version: 1 },
        ]);
      }
      if (url === `/api/screenplays/${screenplayId}` && method === 'DELETE') {
        return jsonResponse({ error: 'nope' }, false, 403);
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Draft');

    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Draft' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Delete failed');
    expect(screen.getByRole('link', { name: 'Draft' })).toBeVisible();
  });
});
