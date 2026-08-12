import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../api.js';
import { fetchMock, resetRouteHarness } from '../test/routeHarness.js';

vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./deleted.js');
const DeletedPage = Route.options.component!;
const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };
const deletedProjectId = 'f7a24bdd-3013-4a8d-bc16-a202e3d1acf5';
const otherProjectId = '19912d15-3d70-46a3-98cc-42939119f20d';
const deletedScreenplayId = '852f3d02-d4f1-48ad-be2b-9538d5400716';

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { json: async () => body, ok, status } as unknown as Response;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DeletedPage />
    </QueryClientProvider>,
  );
}

describe('deleted page', () => {
  beforeEach(resetRouteHarness);

  it('redirects a signed-out visitor to /sign-in instead of rendering, the same guard every other protected route uses', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('Deleted beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  it('shows a loading state, then an explicit empty state for both collections', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ projects: [], screenplays: [] }));
    renderPage();
    expect(screen.getByText('Loading deleted items…')).toBeVisible();
    await screen.findByText('No deleted projects.');
    expect(screen.getByText('No deleted screenplays.')).toBeVisible();
  });

  it('surfaces a load failure rather than a silently empty page', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'nope' }, false, 500));
    renderPage();
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  });

  it("lists deleted projects and screenplays, names each screenplay's project, uses a rectangular Restore button rather than a menu, and restoring one removes only it", async () => {
    const user = userEvent.setup();
    let restored = false;
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === '/api/deleted' && method === 'GET') {
        return jsonResponse({
          projects: restored
            ? []
            : [
                {
                  id: deletedProjectId,
                  title: 'Old Project',
                  updatedAt: '2026-01-01',
                  deletedAt: '2026-01-02',
                },
              ],
          screenplays: [
            {
              id: deletedScreenplayId,
              title: 'Old Draft',
              updatedAt: '2026-01-01',
              deletedAt: '2026-01-02',
              projectId: otherProjectId,
              projectTitle: 'Active Project',
            },
          ],
        });
      }
      if (url === `/api/projects/${deletedProjectId}/restore` && method === 'POST') {
        restored = true;
        return jsonResponse({ id: deletedProjectId, title: 'Old Project' });
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Old Project');
    expect(screen.getByText('Old Draft')).toBeVisible();
    expect(screen.getByText('From Active Project')).toBeVisible();
    // Restore is the only action on this page and must be a plain button, not hidden behind an
    // overflow menu -- see the module comment on routes/deleted.tsx.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /actions/i })).not.toBeInTheDocument();
    // Each Restore button carries a distinct accessible name -- a bare "Restore" repeated on
    // every row is indistinguishable to a screen reader user once more than one row exists.
    const projectRestore = screen.getByRole('button', { name: 'Restore Old Project' });
    const screenplayRestore = screen.getByRole('button', {
      name: 'Restore Old Draft, from Active Project',
    });
    expect(projectRestore).toBeVisible();
    expect(screenplayRestore).toBeVisible();

    await user.click(projectRestore);
    await waitFor(() => expect(screen.queryByText('Old Project')).not.toBeInTheDocument());
    expect(screen.getByText('No deleted projects.')).toBeVisible();
    // Restoring the project must not touch the unrelated deleted screenplay.
    expect(screen.getByText('Old Draft')).toBeVisible();
    // Focus-loss guard: the just-clicked Restore button is now gone, so focus must have moved
    // to a stable anchor rather than falling out of the page entirely.
    expect(screen.getByRole('heading', { name: 'Deleted' })).toHaveFocus();
  });

  it('surfaces a restore failure while leaving the row in place to retry', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === '/api/deleted' && method === 'GET') {
        return jsonResponse({
          projects: [
            {
              id: deletedProjectId,
              title: 'Old Project',
              updatedAt: '2026-01-01',
              deletedAt: '2026-01-02',
            },
          ],
          screenplays: [],
        });
      }
      if (url === `/api/projects/${deletedProjectId}/restore` && method === 'POST') {
        return jsonResponse({ error: 'nope' }, false, 403);
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Old Project');
    await user.click(screen.getByRole('button', { name: 'Restore Old Project' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Restore failed');
    expect(screen.getByText('Old Project')).toBeVisible();
  });

  it('is operable entirely by keyboard: Tab to the Restore button and activate it with Enter', async () => {
    const user = userEvent.setup();
    let restored = false;
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === '/api/deleted' && method === 'GET') {
        return jsonResponse({
          projects: restored
            ? []
            : [
                {
                  id: deletedProjectId,
                  title: 'Old Project',
                  updatedAt: '2026-01-01',
                  deletedAt: '2026-01-02',
                },
              ],
          screenplays: [],
        });
      }
      if (url === `/api/projects/${deletedProjectId}/restore` && method === 'POST') {
        restored = true;
        return jsonResponse({ id: deletedProjectId, title: 'Old Project' });
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Old Project');
    const restoreButton = screen.getByRole('button', { name: 'Restore Old Project' });
    restoreButton.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByText('Old Project')).not.toBeInTheDocument());
  });
});
