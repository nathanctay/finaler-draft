import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../../api.js';
import {
  clearQueryCache,
  entitlementSnapshot,
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

  it('signs out from the account menu, clears the cache, and returns to /sign-in', async () => {
    const user = userEvent.setup();
    render(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/sign-out',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await vi.waitFor(() => expect(clearQueryCache).toHaveBeenCalled());
    expect(routeState.navigate).toHaveBeenCalledWith({ to: '/sign-in' });
  });

  it('reaches the Deleted page only through the account menu, never a bare link on the writing desk', async () => {
    const user = userEvent.setup();
    render(<ProjectsPage />);
    expect(screen.queryByRole('link', { name: /deleted/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Deleted items' }));
    expect(routeState.navigate).toHaveBeenCalledWith({ to: '/deleted' });
  });

  it('reaches the Manage Subscription page from the account menu -- one entry regardless of tier', async () => {
    const user = userEvent.setup();
    render(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    // No tier-conditional labelling or behaviour left in this menu (see the component's own
    // comment for why): the destination page itself decides what a free, paid, or lapsed account
    // sees, so the menu item is a single, always-present link.
    await user.click(screen.getByRole('menuitem', { name: 'Manage Subscription' }));
    expect(routeState.navigate).toHaveBeenCalledWith({ to: '/billing/subscription' });
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

  it('shows Delete only for a project the viewer owns, since deleteProject is owner-only server-side', () => {
    routeState.query = {
      data: [
        { id: projectId, role: 'owner', title: 'Owned' },
        { id: `${projectId}-editor`, role: 'editor', title: 'Edited elsewhere' },
        { id: `${projectId}-reviewer`, role: 'reviewer', title: 'Reviewed elsewhere' },
      ],
      isError: false,
      isLoading: false,
    };
    render(<ProjectsPage />);
    expect(screen.getByRole('button', { name: 'Project actions for Owned' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Project actions for Edited elsewhere' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Project actions for Reviewed elsewhere' }),
    ).not.toBeInTheDocument();
    // The rows themselves -- and the ability to open them -- are unaffected by role; only the
    // control for an action the viewer cannot perform is withheld.
    expect(screen.getByText('Edited elsewhere')).toBeVisible();
    expect(screen.getByText('Reviewed elsewhere')).toBeVisible();
  });

  describe('the lapse-chooser banner', () => {
    const projectsData = [{ id: projectId, role: 'owner', title: 'Feature' }];
    const screenplayA = '317e84fe-704d-40b4-aeea-aec01f628931';
    const screenplayB = 'ef16e524-c280-48cf-9091-20e57dbf817f';

    function setEntitlement(entitlementData: unknown) {
      routeState.queries[JSON.stringify(['projects'])] = {
        data: projectsData,
        isError: false,
        isLoading: false,
      };
      routeState.queries[JSON.stringify(['entitlement'])] = {
        data: entitlementData,
        isError: false,
        isLoading: false,
      };
    }

    it('stays silent for an active subscriber', () => {
      setEntitlement(entitlementSnapshot({ tier: 'paid' }));
      render(<ProjectsPage />);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('stays silent once a restricted account has chosen its editable screenplay', () => {
      setEntitlement(
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: screenplayA,
          candidateScreenplayIds: [screenplayA, screenplayB],
        }),
      );
      render(<ProjectsPage />);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('stays silent for a restricted account with nothing to choose among', () => {
      // A single candidate resolves on its own (entitlements.ts's `resolveEditableScreenplayId`)
      // without ever asking -- there is no choice to surface a banner about.
      setEntitlement(
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: null,
          candidateScreenplayIds: [screenplayA],
        }),
      );
      render(<ProjectsPage />);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('stays silent when the entitlement fetch itself errors -- advisory, not a gate, so it fails quiet rather than guessing', () => {
      routeState.queries[JSON.stringify(['projects'])] = {
        data: projectsData,
        isError: false,
        isLoading: false,
      };
      routeState.queries[JSON.stringify(['entitlement'])] = {
        data: undefined,
        isError: true,
        isLoading: false,
      };
      render(<ProjectsPage />);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('explains the situation, with no screenplay title and no default, when several screenplays are candidates and none is chosen', () => {
      setEntitlement(
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: null,
          candidateScreenplayIds: [screenplayA, screenplayB],
        }),
      );
      render(<ProjectsPage />);
      const banner = screen.getByRole('status');
      expect(banner).toHaveTextContent(/subscription has ended/i);
      expect(banner).toHaveTextContent(/make this one editable/i);
      // No title list and no default pick: plan.md forbids the system choosing on the writer's
      // behalf, and the owner's own design is that the choice happens from inside a screenplay,
      // not from a list of titles picked here.
      expect(screen.queryByText(screenplayA)).not.toBeInTheDocument();
      expect(banner.querySelector('a, button')).toBeNull();
    });
  });
});
