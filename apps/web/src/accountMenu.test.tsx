import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearQueryCache,
  fakeJsonResponse,
  fetchMock,
  resetRouteHarness,
  routeState,
} from './test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('./test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('./test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { AccountMenu } = await import('./accountMenu.js');

/**
 * The account menu's one definition, exercised directly rather than through any of the five
 * screens that mount it -- see `accountMenu.tsx`'s own comment for why it is a component the bar
 * receives rather than one it builds, and `progress/app-bar-navigation.md` for the full decision.
 * `routes/projects/index.test.tsx` used to carry this exact behaviour (sign-out, Deleted items,
 * Manage Subscription) as its own copy; it now only proves the writing desk mounts this
 * component, so the two suites cannot drift the way three-or-five hand-rolled menus would have.
 */
describe('account menu', () => {
  beforeEach(resetRouteHarness);

  it('signs out, clears the whole query cache, and returns to /sign-in', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
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

  it('surfaces feedback when sign-out fails, without pretending it succeeded', async () => {
    // Drives a real rejection through `api.signOut` (a 500 from the mocked `fetch`), not the
    // harness's shared `routeState.mutationError` flag -- this component now tracks its own
    // failure locally (`accountMenu.tsx`'s own comment on why), specifically so that an unrelated
    // mutation elsewhere on the same screen failing can never make this message appear for a
    // sign-out that was never even attempted.
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path) =>
      path === '/api/auth/sign-out'
        ? ({ headers: new Headers(), json: async () => ({}), ok: false, status: 500 } as Response)
        : fakeJsonResponse({}),
    );
    render(<AccountMenu />);
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign out failed');
    expect(routeState.navigate).not.toHaveBeenCalledWith({ to: '/sign-in' });
  });

  it('does not report a sign-out failure caused by an unrelated mutation elsewhere on the page', () => {
    // The exact cross-contamination this component's own comment names: the harness's shared
    // `routeState.mutationError`/`mutationErrorValue` flag is set by *any* rejected mutation
    // anywhere the mock is used, including one this component never ran. Pre-seeding it and
    // rendering with no interaction at all is the regression case -- the old `signOut.isError`
    // read would have shown this message for a sign-out nobody asked for.
    routeState.mutationError = true;
    render(<AccountMenu />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reaches the Manage account page from the account menu', async () => {
    // Collapsed from three destination-specific entries to this one, `progress/manage-account-
    // page.md`: Deleted items, Manage Subscription, and Delete account are all tabs under
    // `/account` now (routes/account.tsx), reached by its own left-side navigation rather than a
    // second choice made here.
    const user = userEvent.setup();
    render(<AccountMenu />);
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Manage account' }));
    expect(routeState.navigate).toHaveBeenCalledWith({ to: '/account' });
  });

  it('offers exactly two entries -- Manage account and Sign out, not the old four', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Manage account',
      'Sign out',
    ]);
  });
});
