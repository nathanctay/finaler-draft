import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../api.js';
import { fetchMock, resetRouteHarness } from '../test/routeHarness.js';

vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../test/routeHarness.js')).reactRouterMock(importOriginal),
);

// `./account_.delete.js`, not `./account.delete.js`: the trailing underscore on the `account`
// segment is TanStack Router's own "non-nested route" escape (confirmed against the installed
// `@tanstack/router-generator`'s `hasParentRoute`/`removeUnderscores`), which keeps this route out
// of the new Manage account layout (`routes/account.tsx`, progress/manage-account-page.md) while
// its resolved path stays the unchanged `/account/delete` -- see that layout's own module comment
// for why this page, unlike the three tabs, must not be nested under it. The filename is the only
// thing that changed here; the component, its behaviour, and every assertion below are untouched.
const { Route } = await import('./account_.delete.js');
const DeleteAccountPage = Route.options.component!;
const sessionUser: SessionUser = {
  createdAt: '2026-01-01T00:00:00.000Z',
  email: 'writer@example.com',
  emailVerified: true,
  id: 'writer-1',
  name: 'Writer',
};
const sharedProjectId = 'e3e6a7f0-7a0a-4b3e-9b8a-0a1b2c3d4e5f';
const soleProjectId = '9c6a2b1e-4f3d-4a2b-8c1d-2e3f4a5b6c7d';

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
      <DeleteAccountPage />
    </QueryClientProvider>,
  );
}

/** Reads the parsed JSON body of the *most recent* `/api/account/delete` call `fetchMock` has
 * recorded -- the race test below makes two calls with two different bodies, and the second is
 * the one each of its assertions cares about -- failing loudly (rather than returning
 * `undefined`) if the endpoint was never called at all, since several tests below exist
 * specifically to prove it was *not* called. */
function deleteAccountRequestBody(): { deleteOwnedProjectsWithCollaborators: boolean } {
  const calls = fetchMock.mock.calls.filter(
    ([path, init]) =>
      path === '/api/account/delete' && (init as RequestInit | undefined)?.method === 'POST',
  );
  const last = calls.at(-1);
  if (!last) throw new Error('POST /api/account/delete was never called.');
  return JSON.parse((last[1] as RequestInit).body as string);
}

function deleteAccountCallCount(): number {
  return fetchMock.mock.calls.filter(
    ([path, init]) =>
      path === '/api/account/delete' && (init as RequestInit | undefined)?.method === 'POST',
  ).length;
}

describe('account deletion page', () => {
  beforeEach(resetRouteHarness);

  it('redirects a signed-out visitor to /sign-in instead of rendering, the same guard every other protected route uses', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('account.delete beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  describe('no owned project has another member', () => {
    function mockNoCollaborators() {
      fetchMock.mockImplementation(async (path, init) => {
        const url = String(path);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/api/account/owned-projects-with-collaborators' && method === 'GET') {
          return jsonResponse({ projects: [] });
        }
        if (url === '/api/account/delete' && method === 'POST') {
          return jsonResponse({ outcome: 'deleted' });
        }
        return jsonResponse({});
      });
    }

    it('offers a single "Delete account" button, never "Delete anyway", once the precheck resolves empty', async () => {
      mockNoCollaborators();
      renderPage();
      expect(screen.getByText('Checking your projects for other collaborators…')).toBeVisible();
      await screen.findByRole('button', { name: 'Delete account' });
      expect(screen.queryByRole('button', { name: 'Delete anyway' })).not.toBeInTheDocument();
    });

    it('offers a "Don’t delete" way back to the account settings, and calls nothing', async () => {
      // This page *is* a confirmation step -- a writer arrives by pressing "Delete account" on the
      // Account info tab -- and it shipped with the destructive button as its only control, so
      // changing your mind meant reaching for the browser's back button. The owner's own report:
      // "we don't have a 'dont delete' button. Just 'delete account'/'delete anyway'."
      mockNoCollaborators();
      renderPage();
      const destructive = await screen.findByRole('button', { name: 'Delete account' });
      const escape = screen.getByRole('link', { name: /Don.t delete/ });
      expect(escape).toHaveAttribute('href', '/account');
      // Ordered destructive-first, escape second -- the owner's explicit direction, and this
      // product's own retro-desktop idiom (the Windows OK/Cancel order, not the macOS reverse).
      // Compared by document position rather than by index, so this still holds if the row gains a
      // third control. The order is asserted at all because it shipped the other way round once:
      // an untested ordering is one nobody notices flipping.
      const escapeComesAfter = Boolean(
        destructive.compareDocumentPosition(escape) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(escapeComesAfter).toBe(true);
      expect(deleteAccountCallCount()).toBe(0);
    });

    it('does not call the delete endpoint merely by opening the confirmation dialog', async () => {
      // The whole defect class this area has to avoid: a confirmation dialog that can be bypassed,
      // or whose mere appearance already did the destructive thing. Opening the dialog must not be
      // indistinguishable from confirming it.
      mockNoCollaborators();
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete account' }));
      await screen.findByRole('heading', { name: 'Delete your account?' });
      expect(deleteAccountCallCount()).toBe(0);
    });

    it('calls the delete endpoint with the override flag unset only after the dialog is confirmed, and shows the terminal state on success', async () => {
      mockNoCollaborators();
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete account' }));
      await screen.findByRole('heading', { name: 'Delete your account?' });
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete account' }),
      );
      await waitFor(() => expect(deleteAccountCallCount()).toBe(1));
      expect(deleteAccountRequestBody()).toEqual({ deleteOwnedProjectsWithCollaborators: false });
      await screen.findByRole('heading', { name: 'Your account has been deleted' });
      // The terminal state renders no chrome that could issue another authenticated request.
      expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
    });

    it('cancelling the dialog never calls the delete endpoint', async () => {
      mockNoCollaborators();
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete account' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(
        screen.queryByRole('heading', { name: 'Delete your account?' }),
      ).not.toBeInTheDocument();
      expect(deleteAccountCallCount()).toBe(0);
    });

    it('closes on Escape without calling the delete endpoint', async () => {
      mockNoCollaborators();
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete account' }));
      await screen.findByRole('dialog');
      await user.keyboard('{Escape}');
      expect(
        screen.queryByRole('heading', { name: 'Delete your account?' }),
      ).not.toBeInTheDocument();
      expect(deleteAccountCallCount()).toBe(0);
    });

    it("shows a generic, honestly-worded failure (not a claim the account is half-deleted) when the request fails for a reason other than the server's own 502 message", async () => {
      fetchMock.mockImplementation(async (path, init) => {
        const url = String(path);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/api/account/owned-projects-with-collaborators' && method === 'GET') {
          return jsonResponse({ projects: [] });
        }
        if (url === '/api/account/delete' && method === 'POST') {
          throw new TypeError('Failed to fetch');
        }
        return jsonResponse({});
      });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete account' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Your account could not be deleted. Nothing was changed -- try again.',
      );
      expect(screen.getByRole('heading', { name: 'Delete your account?' })).toBeVisible();
    });

    it('shows the 502 Stripe-cancellation failure as retryable, inside the still-open dialog, and does not show the terminal state', async () => {
      fetchMock.mockImplementation(async (path, init) => {
        const url = String(path);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/api/account/owned-projects-with-collaborators' && method === 'GET') {
          return jsonResponse({ projects: [] });
        }
        if (url === '/api/account/delete' && method === 'POST') {
          return jsonResponse(
            { error: 'Could not cancel the subscription. Try again shortly.' },
            false,
            502,
          );
        }
        return jsonResponse({});
      });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete account' }));
      let dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not cancel the subscription. Try again shortly.',
      );
      // Retryable and non-destructive: the dialog is still open (not closed, not replaced by the
      // terminal state), and the writer can press the same button again.
      dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: 'Delete your account?' })).toBeVisible();
      expect(
        screen.queryByRole('heading', { name: 'Your account has been deleted' }),
      ).not.toBeInTheDocument();
    });

    it('a retry after the 502 can still succeed, with the same flag, and only one call per click', async () => {
      let attempts = 0;
      fetchMock.mockImplementation(async (path, init) => {
        const url = String(path);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/api/account/owned-projects-with-collaborators' && method === 'GET') {
          return jsonResponse({ projects: [] });
        }
        if (url === '/api/account/delete' && method === 'POST') {
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse(
              { error: 'Could not cancel the subscription. Try again shortly.' },
              false,
              502,
            );
          }
          return jsonResponse({ outcome: 'deleted' });
        }
        return jsonResponse({});
      });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete account' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
      await screen.findByRole('alert');
      await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
      await screen.findByRole('heading', { name: 'Your account has been deleted' });
      expect(attempts).toBe(2);
    });
  });

  describe('at least one owned project has another member', () => {
    function mockCollaboratorProjects() {
      fetchMock.mockImplementation(async (path, init) => {
        const url = String(path);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/api/account/owned-projects-with-collaborators' && method === 'GET') {
          return jsonResponse({ projects: [{ id: sharedProjectId, title: 'Shared Feature' }] });
        }
        if (url === '/api/account/delete' && method === 'POST') {
          return jsonResponse({ outcome: 'deleted' });
        }
        return jsonResponse({});
      });
    }

    it('lists the project and offers "Delete anyway" rather than "Delete account"', async () => {
      mockCollaboratorProjects();
      renderPage();
      await screen.findByText('Shared Feature');
      expect(screen.queryByRole('button', { name: 'Delete account' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete anyway' })).toBeVisible();
      // A button, not a link: sharing is managed in a dialog over this page rather than by
      // navigating away. The owner's report of the earlier behaviour: "I don't want to just be
      // sent back to the home page."
      expect(screen.getByRole('button', { name: 'Manage sharing…' })).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Manage sharing…' })).not.toBeInTheDocument();
    });

    it('opens the sharing dialog over the page, naming that project, without leaving the deletion flow', async () => {
      mockCollaboratorProjects();
      const user = userEvent.setup();
      renderPage();

      // Non-vacuity: no dialog before the click, or the assertion after it proves nothing.
      await screen.findByText('Shared Feature');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Manage sharing…' }));

      const dialog = await screen.findByRole('dialog');
      // For *this* project: the title is what tells a writer which one they are handing over.
      expect(dialog).toHaveTextContent('Shared Feature');
      // ...and the deletion flow is still underneath, not navigated away from.
      expect(screen.getByRole('button', { name: 'Delete anyway' })).toBeInTheDocument();
    });

    it('does not call the delete endpoint merely by opening the override dialog', async () => {
      mockCollaboratorProjects();
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete anyway' }));
      await screen.findByRole('heading', { name: 'Delete anyway?' });
      expect(deleteAccountCallCount()).toBe(0);
    });

    it('names the collaborator consequence explicitly in the second confirmation', async () => {
      mockCollaboratorProjects();
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete anyway' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('other collaborators');
      expect(dialog).toHaveTextContent('every collaborator too, not just you');
      expect(dialog).toHaveTextContent('Shared Feature');
    });

    it('calls the delete endpoint with the override flag set only after the second confirmation', async () => {
      mockCollaboratorProjects();
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete anyway' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete anyway' }));
      await waitFor(() => expect(deleteAccountCallCount()).toBe(1));
      expect(deleteAccountRequestBody()).toEqual({ deleteOwnedProjectsWithCollaborators: true });
      await screen.findByRole('heading', { name: 'Your account has been deleted' });
    });

    it('surfaces the 502 as retryable inside the override dialog too, not just the plain one', async () => {
      fetchMock.mockImplementation(async (path, init) => {
        const url = String(path);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/api/account/owned-projects-with-collaborators' && method === 'GET') {
          return jsonResponse({ projects: [{ id: sharedProjectId, title: 'Shared Feature' }] });
        }
        if (url === '/api/account/delete' && method === 'POST') {
          return jsonResponse(
            { error: 'Could not cancel the subscription. Try again shortly.' },
            false,
            502,
          );
        }
        return jsonResponse({});
      });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete anyway' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete anyway' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not cancel the subscription. Try again shortly.',
      );
      expect(screen.getByRole('heading', { name: 'Delete anyway?' })).toBeVisible();
      expect(
        screen.queryByRole('heading', { name: 'Your account has been deleted' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('the precheck races a membership change', () => {
    it('reports collaborators only once the server refuses, even though the on-mount precheck came back empty, and still requires an explicit "Delete anyway" click', async () => {
      // The backend's own documented race (`accountDeletion.ts`): a collaborator can be added
      // between this page's GET and the writer's click. The first attempt here is refused despite
      // an empty precheck, and the override must still be a fresh, explicit click -- never implied
      // by the refusal alone.
      let deleteCalls = 0;
      fetchMock.mockImplementation(async (path, init) => {
        const url = String(path);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/api/account/owned-projects-with-collaborators' && method === 'GET') {
          return jsonResponse({ projects: [] });
        }
        if (url === '/api/account/delete' && method === 'POST') {
          deleteCalls += 1;
          if (deleteCalls === 1) {
            return jsonResponse({
              outcome: 'owned-projects-have-collaborators',
              projects: [{ id: soleProjectId, title: 'Raced Project' }],
            });
          }
          return jsonResponse({ outcome: 'deleted' });
        }
        return jsonResponse({});
      });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Delete account' }));
      let dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));

      // The plain dialog is gone, replaced by the override dialog naming the project the server
      // just reported -- not the terminal state, and not a second, silent attempt.
      await screen.findByRole('heading', { name: 'Delete anyway?' });
      expect(
        screen.queryByRole('heading', { name: 'Delete your account?' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Your account has been deleted' }),
      ).not.toBeInTheDocument();
      dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Raced Project');
      expect(deleteCalls).toBe(1);

      await user.click(within(dialog).getByRole('button', { name: 'Delete anyway' }));
      await waitFor(() => expect(deleteCalls).toBe(2));
      expect(deleteAccountRequestBody()).toEqual({ deleteOwnedProjectsWithCollaborators: true });
      await screen.findByRole('heading', { name: 'Your account has been deleted' });
    });
  });

  it('falls back to the plain "Delete account" button, with a notice, if the precheck itself fails', async () => {
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/api/account/owned-projects-with-collaborators' && method === 'GET') {
        return jsonResponse({ error: 'nope' }, false, 500);
      }
      return jsonResponse({});
    });
    renderPage();
    await screen.findByRole('button', { name: 'Delete account' });
    expect(screen.getByText(/could not check which of your projects/i)).toBeVisible();
  });
});
