import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../api.js';
import { fetchMock, resetRouteHarness, routeState } from '../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../test/routeHarness.js')).reactRouterMock(importOriginal),
);
vi.mock('../externalRedirect.js', () => ({ redirectToExternalUrl: vi.fn() }));

const { Route } = await import('./billing.subscription.js');
const { redirectToExternalUrl } = await import('../externalRedirect.js');
const ManageSubscriptionPage = Route.options.component!;
const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

const PLANS_DATA = {
  monthly: { amount: 500, currency: 'usd', interval: 'month' },
  annual: { amount: 5000, currency: 'usd', interval: 'year' },
};

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

function entitlement(tier: 'paid' | 'restricted') {
  return {
    tier,
    editableScreenplayId: null,
    candidateScreenplayIds: [],
    slotUpdatedAt: null,
    cooldownEndsAt: null,
  };
}

// `subscription` is the raw subscription object (or `null` for never-subscribed) -- this wraps it
// in the `{ subscription }` envelope `GET /api/billing/subscription` (and `api.billingSubscription`)
// actually return, so call sites read the same shape the real endpoint's own tests use.
function setQueries(
  entitlementData: unknown,
  subscription: unknown,
  plansData: unknown = PLANS_DATA,
) {
  routeState.queries[JSON.stringify(['entitlement'])] = {
    data: entitlementData,
    isError: false,
    isLoading: false,
  };
  routeState.queries[JSON.stringify(['billingSubscription'])] = {
    data: { subscription },
    isError: false,
    isLoading: false,
  };
  routeState.queries[JSON.stringify(['billingPlans'])] = {
    data: plansData,
    isError: false,
    isLoading: false,
  };
}

describe('Manage Subscription page', () => {
  beforeEach(() => {
    resetRouteHarness();
    vi.mocked(redirectToExternalUrl).mockClear();
  });

  it('redirects a signed-out visitor to /sign-in instead of rendering, the same guard every other protected route uses', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('billing.subscription beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  it('shows a loading state before entitlement or subscription has resolved', () => {
    routeState.queries[JSON.stringify(['entitlement'])] = {
      data: undefined,
      isError: false,
      isLoading: true,
    };
    routeState.queries[JSON.stringify(['billingSubscription'])] = {
      data: undefined,
      isError: false,
      isLoading: true,
    };
    render(<ManageSubscriptionPage />);
    expect(screen.getByText('Loading your subscription…')).toBeVisible();
  });

  describe('a writer who has never subscribed', () => {
    beforeEach(() => setQueries(entitlement('restricted'), null));

    it('badges Free as the current plan and offers Pro as an actionable card, defaulting the toggle to annual', () => {
      render(<ManageSubscriptionPage />);
      const annualRadio = screen.getByRole('radio', { name: /Annual/ });
      expect(annualRadio).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Monthly' })).not.toBeChecked();
      expect(screen.getByRole('heading', { name: 'Free' }).closest('section')).toHaveTextContent(
        'Current plan',
      );
      expect(screen.queryByRole('button', { name: /Switch to Free/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Upgrade to annual' })).toBeVisible();
    });

    it('shows the real annual price and the accurately-derived saving on the toggle', () => {
      render(<ManageSubscriptionPage />);
      expect(screen.getByText('$50.00')).toBeVisible();
      expect(screen.getByText(/Save \$10\.00 \(17%\) a year/)).toBeVisible();
    });

    it('switching the toggle to monthly updates the Pro card price and button label', async () => {
      const user = userEvent.setup();
      render(<ManageSubscriptionPage />);
      await user.click(screen.getByRole('radio', { name: 'Monthly' }));
      expect(screen.getByText('$5.00')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Upgrade to monthly' })).toBeVisible();
    });

    it('starts a Checkout Session for the selected interval and redirects -- never the Portal, since there is no Stripe customer yet', async () => {
      const user = userEvent.setup();
      render(<ManageSubscriptionPage />);
      await user.click(screen.getByRole('button', { name: 'Upgrade to annual' }));
      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/billing/checkout-session',
          expect.objectContaining({ body: JSON.stringify({ plan: 'annual' }), method: 'POST' }),
        ),
      );
      expect(fetchMock).not.toHaveBeenCalledWith('/api/billing/portal-session', expect.anything());
      await vi.waitFor(() =>
        expect(redirectToExternalUrl).toHaveBeenCalledWith(
          'https://checkout.stripe.test/test-session',
        ),
      );
    });
  });

  describe('an active monthly subscriber', () => {
    const monthlySubscription = {
      plan: 'monthly',
      status: 'active',
      currentPeriodEnd: '2026-10-01T12:00:00.000Z',
      cancelAtPeriodEnd: false,
      canceledAt: null,
    };

    beforeEach(() => setQueries(entitlement('paid'), monthlySubscription));

    it('defaults the toggle to their own interval and badges Pro as current, with status detail', () => {
      render(<ManageSubscriptionPage />);
      expect(screen.getByRole('radio', { name: 'Monthly' })).toBeChecked();
      const proCard = screen.getByRole('heading', { name: 'Pro' }).closest('section')!;
      expect(proCard).toHaveTextContent('Current plan');
      expect(proCard).toHaveTextContent('Active');
      expect(proCard).toHaveTextContent('Renews on October 1, 2026');
      expect(screen.queryByRole('button', { name: /Upgrade/ })).not.toBeInTheDocument();
    });

    it('offers Free as an actionable card, and its button opens the Portal, never a Checkout Session', async () => {
      const user = userEvent.setup();
      render(<ManageSubscriptionPage />);
      await user.click(screen.getByRole('button', { name: 'Switch to Free' }));
      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/billing/portal-session',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
      expect(fetchMock).not.toHaveBeenCalledWith(
        '/api/billing/checkout-session',
        expect.anything(),
      );
      await vi.waitFor(() =>
        expect(redirectToExternalUrl).toHaveBeenCalledWith(
          'https://billing.stripe.test/test-session',
        ),
      );
    });

    // The scenario the coordinator named directly: switching interval for an existing subscriber
    // must open the Portal, never start a fresh Checkout Session.
    it('switching the toggle to annual turns the Pro card into an action that opens the Portal, not a Checkout Session', async () => {
      const user = userEvent.setup();
      render(<ManageSubscriptionPage />);
      await user.click(screen.getByRole('radio', { name: /Annual/ }));

      const proCard = screen.getByRole('heading', { name: 'Pro' }).closest('section')!;
      expect(proCard).not.toHaveTextContent('Current plan');
      const switchButton = screen.getByRole('button', { name: 'Manage Subscription' });
      await user.click(switchButton);

      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/billing/portal-session',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
      expect(fetchMock).not.toHaveBeenCalledWith(
        '/api/billing/checkout-session',
        expect.anything(),
      );
    });
  });

  // Stripe's subscription `status` stays `'active'` right up until the paid period actually ends,
  // so `tier` alone can't tell "renewing" apart from "cancelled but still paid up" -- only
  // `cancelAtPeriodEnd` can. This is the third, distinct subscriber state (renewing and fully
  // lapsed are the other two, covered elsewhere in this file).
  describe('a subscriber who cancelled but is still inside their paid period', () => {
    const cancelledSubscription = {
      plan: 'annual',
      status: 'active',
      currentPeriodEnd: '2026-10-01T12:00:00.000Z',
      cancelAtPeriodEnd: true,
      canceledAt: null,
    };

    beforeEach(() => setQueries(entitlement('paid'), cancelledSubscription));

    it('reads "Active until", never "Renews on", and says outright that the plan has been cancelled', () => {
      render(<ManageSubscriptionPage />);
      const proCard = screen.getByRole('heading', { name: 'Pro' }).closest('section')!;
      // The state the task calls out by name: this must still read as "Current plan: Pro", not
      // silently fall back to Free just because cancellation is already in motion.
      expect(proCard).toHaveTextContent('Current plan');
      expect(proCard).toHaveTextContent('Active until October 1, 2026');
      expect(proCard).not.toHaveTextContent('Renews on');
      expect(proCard).toHaveTextContent(/cancelled/i);
    });

    it('offers a "Resume subscription" action instead of the bare "Current plan" badge a renewing subscriber gets', () => {
      render(<ManageSubscriptionPage />);
      expect(screen.queryByRole('button', { name: 'Manage Subscription' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Resume subscription' })).toBeVisible();
    });

    it('"Resume subscription" opens the Customer Portal, never a fresh Checkout Session', async () => {
      const user = userEvent.setup();
      render(<ManageSubscriptionPage />);
      await user.click(screen.getByRole('button', { name: 'Resume subscription' }));
      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/billing/portal-session',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
      expect(fetchMock).not.toHaveBeenCalledWith(
        '/api/billing/checkout-session',
        expect.anything(),
      );
      await vi.waitFor(() =>
        expect(redirectToExternalUrl).toHaveBeenCalledWith(
          'https://billing.stripe.test/test-session',
        ),
      );
    });
  });

  it('shows a fully lapsed subscriber as Free, with their previous plan kept as context on the Pro card', () => {
    setQueries(entitlement('restricted'), {
      plan: 'monthly',
      status: 'canceled',
      currentPeriodEnd: '2026-09-01T12:00:00.000Z',
      cancelAtPeriodEnd: false,
      canceledAt: '2026-08-19T12:00:00.000Z',
    });
    render(<ManageSubscriptionPage />);
    expect(screen.getByRole('heading', { name: 'Free' }).closest('section')).toHaveTextContent(
      'Current plan',
    );
    const proCard = screen.getByRole('heading', { name: 'Pro' }).closest('section')!;
    expect(proCard).not.toHaveTextContent('Current plan');
    expect(proCard).toHaveTextContent('Canceled on August 19, 2026');
    // Already a Stripe customer (even though lapsed) -- the Pro card's action must still be the
    // Portal, never a fresh Checkout Session.
    expect(screen.getByRole('button', { name: 'Manage Subscription' })).toBeVisible();
  });

  it('surfaces feedback when opening the Portal fails, without pretending it succeeded', () => {
    setQueries(entitlement('paid'), {
      plan: 'monthly',
      status: 'active',
      currentPeriodEnd: '2026-10-01T12:00:00.000Z',
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    routeState.mutationError = true;
    render(<ManageSubscriptionPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not open billing');
  });

  it('the interval toggle is a real, keyboard-operable radio group, not a styled div', () => {
    setQueries(entitlement('restricted'), null);
    render(<ManageSubscriptionPage />);
    expect(screen.getByRole('group', { name: 'Billing interval' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Monthly' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Annual/ })).toBeInTheDocument();
  });
});
