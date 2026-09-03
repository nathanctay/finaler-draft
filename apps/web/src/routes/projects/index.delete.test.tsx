import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMock, projectId, resetRouteHarness } from '../../test/routeHarness.js';

// This file, unlike index.test.tsx, keeps the real @tanstack/react-query so delete, the local
// "Deleted — Undo" state, and restore-driven invalidation all run through genuine query/mutation
// state rather than the shared single-slot mock the sibling file uses. Only the router is
// replaced, exactly as elsewhere.
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./index.js');
const ProjectsPage = Route.options.component!;

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { json: async () => body, ok, status } as unknown as Response;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectsPage />
    </QueryClientProvider>,
  );
  return { queryClient };
}

describe('projects page: delete and undo', () => {
  let deleted: boolean;

  beforeEach(() => {
    resetRouteHarness();
    deleted = false;
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') {
        return jsonResponse(
          deleted
            ? []
            : [
                {
                  id: projectId,
                  role: 'owner',
                  title: 'Feature',
                  updatedAt: '2026-01-01T00:00:00Z',
                },
              ],
        );
      }
      if (url === `/api/projects/${projectId}` && method === 'DELETE') {
        deleted = true;
        return jsonResponse({ id: projectId });
      }
      if (url === `/api/projects/${projectId}/restore` && method === 'POST') {
        deleted = false;
        return jsonResponse({ id: projectId, title: 'Feature' });
      }
      return jsonResponse([]);
    });
  });

  it('deletes a project from its overflow menu, replaces the row with an announced Undo affordance with no stale link or menu, and Undo restores it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Feature');

    await user.click(screen.getByRole('button', { name: 'Project actions for Feature' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    await screen.findByText('Feature — Deleted');
    expect(screen.getByRole('status')).toHaveTextContent('Feature — Deleted');
    // Requirement from the lead's review: the undone row must expose no stale affordance -- no
    // link into the deleted project, and no overflow menu whose only action no longer applies.
    expect(screen.queryByRole('link', { name: /Feature/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Project actions for Feature' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo delete of Feature' }));
    await waitFor(() => expect(screen.queryByText('Feature — Deleted')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Feature/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Project actions for Feature' })).toBeInTheDocument();
  });

  it('completes the same delete-and-undo path from the keyboard alone', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Feature');

    const menuTrigger = screen.getByRole('button', { name: 'Project actions for Feature' });
    menuTrigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await user.keyboard('{Enter}');

    // Focus is not forced here: DeletedRow moves it to Undo on mount, and the point of a
    // keyboard-only test is to prove that happens for real rather than manufacturing the state
    // the assertion depends on.
    const undoButton = await screen.findByRole('button', { name: 'Undo delete of Feature' });
    expect(undoButton).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByText('Feature — Deleted')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Feature/ })).toBeVisible();
  });

  it('keeps the Undo affordance visible even if an unrelated background refetch drops the row from the live query', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByText('Feature');

    await user.click(screen.getByRole('button', { name: 'Project actions for Feature' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await screen.findByText('Feature — Deleted');

    // Simulate an incidental refetch (e.g. window focus regain) that the writer did not cause.
    // The delete already succeeded server-side, so the fresh GET genuinely omits the row -- the
    // Undo affordance must survive this via the orphaned-id path, not disappear along with it.
    await act(() => queryClient.invalidateQueries({ queryKey: ['projects'] }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Feature — Deleted')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Undo delete of Feature' }));
    await waitFor(() => expect(screen.queryByText('Feature — Deleted')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Feature/ })).toBeVisible();
  });

  it('surfaces a delete failure without touching the row, and a restore failure without dropping Undo', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') {
        return jsonResponse([
          { id: projectId, role: 'owner', title: 'Feature', updatedAt: '2026-01-01T00:00:00Z' },
        ]);
      }
      if (url === `/api/projects/${projectId}` && method === 'DELETE') {
        return jsonResponse({ error: 'nope' }, false, 403);
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Feature');

    await user.click(screen.getByRole('button', { name: 'Project actions for Feature' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Delete failed');
    expect(screen.getByRole('link', { name: /Feature/ })).toBeVisible();
    expect(screen.queryByText('Feature — Deleted')).not.toBeInTheDocument();
  });

  it('surfaces a restore failure while leaving the Undo affordance in place to retry', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') {
        return jsonResponse(
          deleted
            ? []
            : [
                {
                  id: projectId,
                  role: 'owner',
                  title: 'Feature',
                  updatedAt: '2026-01-01T00:00:00Z',
                },
              ],
        );
      }
      if (url === `/api/projects/${projectId}` && method === 'DELETE') {
        deleted = true;
        return jsonResponse({ id: projectId });
      }
      if (url === `/api/projects/${projectId}/restore` && method === 'POST') {
        return jsonResponse({ error: 'nope' }, false, 409);
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Feature');

    await user.click(screen.getByRole('button', { name: 'Project actions for Feature' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await screen.findByText('Feature — Deleted');

    await user.click(screen.getByRole('button', { name: 'Undo delete of Feature' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Restore failed');
    // Retry surface: the affordance itself is still there after a failed restore.
    expect(screen.getByRole('button', { name: 'Undo delete of Feature' })).toBeInTheDocument();
  });

  it('shows a pending state on Undo while the restore request is in flight', async () => {
    const user = userEvent.setup();
    let releaseRestore: (() => void) | undefined;
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') {
        return jsonResponse(
          deleted
            ? []
            : [
                {
                  id: projectId,
                  role: 'owner',
                  title: 'Feature',
                  updatedAt: '2026-01-01T00:00:00Z',
                },
              ],
        );
      }
      if (url === `/api/projects/${projectId}` && method === 'DELETE') {
        deleted = true;
        return jsonResponse({ id: projectId });
      }
      if (url === `/api/projects/${projectId}/restore` && method === 'POST') {
        await new Promise<void>((resolve) => {
          releaseRestore = resolve;
        });
        deleted = false;
        return jsonResponse({ id: projectId, title: 'Feature' });
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Feature');

    await user.click(screen.getByRole('button', { name: 'Project actions for Feature' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await screen.findByText('Feature — Deleted');

    await user.click(screen.getByRole('button', { name: 'Undo delete of Feature' }));
    // The accessible name (aria-label) stays fixed through the pending state -- only the visible
    // text changes to "Restoring…" -- so the button is still found by its stable name.
    const pendingButton = await screen.findByRole('button', { name: 'Undo delete of Feature' });
    expect(pendingButton).toHaveTextContent('Restoring…');
    expect(pendingButton).toBeDisabled();

    releaseRestore?.();
    await waitFor(() => expect(screen.queryByText('Feature — Deleted')).not.toBeInTheDocument());
  });

  it('opens the Deleted page via the account menu without ever routing through the writing desk list', () => {
    renderPage();
    expect(screen.queryByRole('link', { name: /deleted/i })).not.toBeInTheDocument();
  });

  // The account menu no longer fetches entitlement state at all (routes/projects/index.tsx's
  // "Manage Subscription" entry is a static link to routes/billing.subscription.tsx, which owns
  // that fetch itself) -- an earlier version of this slice deferred an entitlement fetch until
  // the menu was opened, to fix a real E2E regression an eager, unconditional fetch caused; that
  // deferral is now moot because the fetch was removed from this page entirely, not merely
  // delayed. This test proves the account menu makes no billing-related request of its own.
  it('never fetches entitlement or billing state from the account menu itself', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Feature');
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menuitem', { name: 'Manage Subscription' })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/entitlement', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith('/api/billing/subscription', expect.anything());
  });
});
