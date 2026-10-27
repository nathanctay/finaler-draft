import { render, screen, waitFor } from '@testing-library/react';
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
// routes/projects/index.rename.test.tsx and index.delete.test.tsx.
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

function screenplayListResponse(role: 'owner' | 'editor' | 'reviewer', title: string): Response {
  return jsonResponse([
    { id: screenplayId, title, updatedAt: '2026-01-01T00:00:00Z', version: 1, role },
  ]);
}

describe('project screenplay list: Rename… and Delete menu gating', () => {
  beforeEach(() => {
    resetRouteHarness();
  });

  it.each(['editor', 'reviewer'] as const)(
    'shows neither Rename… nor Delete to a screenplay %s, since both are owner-only server-side',
    async (role) => {
      const user = userEvent.setup();
      fetchMock.mockImplementation(async (path, init) => {
        const url = String(path);
        const method = init?.method ?? 'GET';
        if (url === `/api/projects/${projectId}/screenplays` && method === 'GET') {
          return screenplayListResponse(role, 'Draft');
        }
        return jsonResponse([]);
      });
      renderPage();
      await screen.findByText('Draft');

      if (role === 'editor') {
        // An editor can still share, so the menu itself exists -- just without Rename…/Delete.
        await user.click(screen.getByRole('button', { name: 'Screenplay actions for Draft' }));
        expect(screen.getByRole('menuitem', { name: 'Share…' })).toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Rename…' })).not.toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
      } else {
        // A reviewer can do none of the three things this menu could ever offer, so there is no
        // menu at all -- see index.sharing.test.tsx's own test for this same row.
        expect(
          screen.queryByRole('button', { name: 'Screenplay actions for Draft' }),
        ).not.toBeInTheDocument();
      }
    },
  );

  it('shows both Rename… and Delete to the owner', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === `/api/projects/${projectId}/screenplays` && method === 'GET') {
        return screenplayListResponse('owner', 'Draft');
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Draft');

    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Draft' }));
    expect(screen.getByRole('menuitem', { name: 'Rename…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });
});

describe('project screenplay list: rename flow', () => {
  let title: string;

  beforeEach(() => {
    resetRouteHarness();
    title = 'Draft';
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === `/api/projects/${projectId}/screenplays` && method === 'GET') {
        return screenplayListResponse('owner', title);
      }
      if (url === `/api/screenplays/${screenplayId}` && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { title: string };
        title = body.title;
        return jsonResponse({ id: screenplayId, title });
      }
      return jsonResponse([]);
    });
  });

  it('renames a screenplay from its overflow menu, pre-filled with the current title, and the row reflects the new one', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Draft');

    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Draft' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Rename screenplay' });
    const input = screen.getByRole('textbox', { name: 'Title' });
    expect(input).toHaveValue('Draft');

    await user.clear(input);
    await user.type(input, 'Final Draft');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(await screen.findByText('Final Draft')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/screenplays/${screenplayId}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Final Draft' }) }),
    );
  });

  it('rejects a blank title inline, before any request is sent', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Draft');

    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Draft' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const input = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.tab();

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a title.');
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/screenplays/${screenplayId}`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('leaves the title unchanged on Cancel', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Draft');

    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Draft' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const input = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.type(input, 'Should not be saved');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/screenplays/${screenplayId}`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('shows the server’s own 403 explanation and leaves the dialog open to retry', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === `/api/projects/${projectId}/screenplays` && method === 'GET') {
        return screenplayListResponse('owner', 'Draft');
      }
      if (url === `/api/screenplays/${screenplayId}` && method === 'PATCH') {
        return jsonResponse({ error: 'Screenplay owner access required' }, false, 403);
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Draft');

    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Draft' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const input = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.type(input, 'Final Draft');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Screenplay owner access required');
    expect(screen.getByRole('dialog', { name: 'Rename screenplay' })).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeVisible();
  });
});
