import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../api.js';
import { resetRouteHarness, routeState } from '../test/routeHarness.js';

vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../test/routeHarness.js')).reactRouterMock(importOriginal),
);

/**
 * The Manage account page's shared layout (`routes/account.tsx`, `progress/manage-account-page.
 * md`) -- the one place `ApplicationTitlebar`, `AccountMenu`, and the left-side tab navigation
 * are exercised, now that none of the three tabs (`account/index.tsx`, `account.subscription.
 * tsx`, `account.deleted.tsx`) renders any of that itself. Each tab's own content and mutations
 * are that tab's own test file; this file is deliberately silent about what is inside `<Outlet
 * />` (the harness's mock renders a fixed placeholder, not a real tab) for exactly that reason.
 */
const { Route } = await import('./account.js');
const AccountLayout = Route.options.component!;
const sessionUser: SessionUser = {
  createdAt: '2026-01-01T00:00:00.000Z',
  email: 'writer@example.com',
  emailVerified: true,
  id: 'writer-1',
  name: 'Writer',
};

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

/**
 * `AccountMenu` (mounted by `AccountLayout`) calls `useQueryClient()` for its sign-out mutation --
 * a real provider, not the router mock, since `@tanstack/react-query` itself is not mocked in
 * this file.
 */
function renderLayout() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountLayout />
    </QueryClientProvider>,
  );
}

describe('/account layout', () => {
  beforeEach(resetRouteHarness);

  it('redirects a signed-out visitor to /sign-in instead of rendering, the same guard every other protected route uses', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('/account beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  it('renders one titlebar, with the account menu and a plain brand link back to the dashboard', () => {
    renderLayout();
    expect(document.querySelector('.document-title')).toHaveTextContent('Manage account');
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Finaler Draft/i })).toHaveAttribute(
      'href',
      '/projects',
    );
  });

  it('renders all three tabs as real links, and the content pane', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: 'Account info' })).toHaveAttribute('href', '/account');
    expect(screen.getByRole('link', { name: 'Manage Subscription' })).toHaveAttribute(
      'href',
      '/account/subscription',
    );
    expect(screen.getByRole('link', { name: 'Deleted items' })).toHaveAttribute(
      'href',
      '/account/deleted',
    );
    expect(screen.getByText('Outlet')).toBeVisible();
  });

  it('marks exactly the tab matching the current path as current, for a tab other than the index', () => {
    routeState.pathname = '/account/deleted';
    renderLayout();
    const current = screen.getByRole('link', { name: 'Deleted items' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Account info' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Manage Subscription' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks the index tab as current on /account itself, not every tab', () => {
    routeState.pathname = '/account';
    renderLayout();
    expect(screen.getByRole('link', { name: 'Account info' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Deleted items' })).not.toHaveAttribute('aria-current');
  });
});
