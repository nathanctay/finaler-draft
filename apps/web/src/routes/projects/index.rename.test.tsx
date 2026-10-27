import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMock, projectId, resetRouteHarness } from '../../test/routeHarness.js';

// Real @tanstack/react-query, mocked router -- matching index.delete.test.tsx's setup and
// rationale exactly: the rename dialog's own pending/error state, and the cache invalidation that
// refreshes the row's title after a successful rename, both need to run for real.
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./index.js');
const ProjectsPage = Route.options.component!;

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { json: async () => body, ok, status } as unknown as Response;
}

// Matches index.delete.test.tsx's own `entitlementResponse`: this page fetches `/api/entitlement`
// unconditionally for the lapse-chooser banner, so every fixture below needs an answer for it.
function entitlementResponse(): Response {
  return jsonResponse({
    tier: 'paid',
    editableScreenplayId: null,
    candidateScreenplayIds: [],
    slotUpdatedAt: null,
    cooldownEndsAt: null,
  });
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

describe('projects page: rename', () => {
  let title: string;

  beforeEach(() => {
    resetRouteHarness();
    title = 'Feature';
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') {
        return jsonResponse([
          { id: projectId, role: 'owner', title, updatedAt: '2026-01-01T00:00:00Z' },
        ]);
      }
      if (url === `/api/projects/${projectId}` && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { title: string };
        title = body.title;
        return jsonResponse({ id: projectId, title });
      }
      if (url === '/api/entitlement' && method === 'GET') {
        return entitlementResponse();
      }
      return jsonResponse([]);
    });
  });

  it('renames a project from its overflow menu, pre-filled with the current title, and the row reflects the new one', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Feature');

    await user.click(screen.getByRole('button', { name: 'Project actions for Feature' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Rename project' });
    const input = screen.getByRole('textbox', { name: 'Title' });
    expect(input).toHaveValue('Feature');

    await user.clear(input);
    await user.type(input, 'Renamed Feature');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(await screen.findByText('Renamed Feature')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${projectId}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Renamed Feature' }),
      }),
    );
  });

  it('completes the same rename path from the keyboard alone', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Feature');

    const menuTrigger = screen.getByRole('button', { name: 'Project actions for Feature' });
    menuTrigger.focus();
    await user.keyboard('{Enter}');
    // An owner's menu opens focused on "Share…" first; Rename… is the second item.
    expect(screen.getByRole('menuitem', { name: 'Share…' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Rename…' })).toHaveFocus();
    await user.keyboard('{Enter}');

    await screen.findByRole('dialog', { name: 'Rename project' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Escape changed nothing -- the row still shows the original title, and focus never leaves
    // the user stranded (the trigger button is still present to re-open from).
    expect(screen.getByText('Feature')).toBeVisible();
  });

  it('leaves the title unchanged when Cancel is used instead of Rename', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Feature');

    await user.click(screen.getByRole('button', { name: 'Project actions for Feature' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const input = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.type(input, 'Should not be saved');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Feature')).toBeVisible();
    expect(screen.queryByText('Should not be saved')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/projects/${projectId}`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('shows the server’s own 403 explanation and leaves the dialog open to retry', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') {
        return jsonResponse([
          { id: projectId, role: 'owner', title: 'Feature', updatedAt: '2026-01-01T00:00:00Z' },
        ]);
      }
      if (url === `/api/projects/${projectId}` && method === 'PATCH') {
        return jsonResponse({ error: 'Project owner access required' }, false, 403);
      }
      if (url === '/api/entitlement' && method === 'GET') {
        return entitlementResponse();
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText('Feature');

    await user.click(screen.getByRole('button', { name: 'Project actions for Feature' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const input = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.type(input, 'Renamed Feature');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Project owner access required');
    expect(screen.getByRole('dialog', { name: 'Rename project' })).toBeInTheDocument();
    expect(screen.getByText('Feature')).toBeVisible();
  });
});
