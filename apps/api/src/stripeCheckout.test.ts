import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCheckoutSessionParams,
  CHECKOUT_INTEGRATION_IDENTIFIER,
  createCheckoutSession,
  createPortalSession,
  fetchBillingPlans,
  type BillingPort,
} from './stripeCheckout.js';
import type { SubscriptionProjection, SubscriptionStore } from './stripeSubscriptions.js';

// Obviously-fake test-only values, never anything resembling a real Stripe credential.
const TEST_PRICE_ID_MONTHLY = 'price_test_FAKE_monthly';
const TEST_PRICE_ID_ANNUAL = 'price_test_FAKE_annual';
const TEST_CUSTOMER_ID = 'cus_test_FAKE_existing';

function subscriptionRow(overrides?: Partial<SubscriptionProjection>): SubscriptionProjection {
  return {
    userId: 'user-1',
    stripeCustomerId: TEST_CUSTOMER_ID,
    stripeSubscriptionId: 'sub_test_FAKE_1',
    stripePriceId: TEST_PRICE_ID_MONTHLY,
    status: 'active',
    currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    ...overrides,
  };
}

// Typed as standalone functions, and only then handed to `vi.fn`, so `.mock.calls[n][0]` infers
// the real parameter type without needing to name (and then never use) a parameter in the
// implementation body -- an unused named parameter here would otherwise trip
// `@typescript-eslint/no-unused-vars`, since it is this function's only parameter.
type CheckoutSessionsCreate = (
  params: Stripe.Checkout.SessionCreateParams,
) => Promise<{ id: string; url: string | null }>;
type BillingPortalSessionsCreate = (
  params: Stripe.BillingPortal.SessionCreateParams,
) => Promise<{ id: string; url: string }>;

type PricesRetrieve = (priceId: string) => Promise<{
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
}>;

function fakePriceRow(
  id: string,
  amount: number,
  currency = 'usd',
  interval = 'month',
): {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
} {
  return { id, unit_amount: amount, currency, recurring: { interval } };
}

function fakePort(row: SubscriptionProjection | undefined) {
  const createCheckoutSessionImpl: CheckoutSessionsCreate = async () => ({
    id: 'cs_test_FAKE_1',
    url: 'https://checkout.stripe.test/cs_test_FAKE_1',
  });
  const createPortalSessionImpl: BillingPortalSessionsCreate = async () => ({
    id: 'bps_test_FAKE_1',
    url: 'https://billing.stripe.test/bps_test_FAKE_1',
  });
  const pricesRetrieveImpl: PricesRetrieve = async (priceId) =>
    priceId === TEST_PRICE_ID_ANNUAL
      ? fakePriceRow(TEST_PRICE_ID_ANNUAL, 5000, 'usd', 'year')
      : fakePriceRow(TEST_PRICE_ID_MONTHLY, 500, 'usd', 'month');
  const checkoutCreate = vi.fn(createCheckoutSessionImpl);
  const portalCreate = vi.fn(createPortalSessionImpl);
  const pricesRetrieve = vi.fn(pricesRetrieveImpl);
  const getSubscriptionForUser = vi.fn(async () => row);
  const port: BillingPort = {
    client: {
      checkout: { sessions: { create: checkoutCreate } },
      billingPortal: { sessions: { create: portalCreate } },
      prices: { retrieve: pricesRetrieve },
    } as unknown as BillingPort['client'],
    store: { getSubscriptionForUser } as Pick<SubscriptionStore, 'getSubscriptionForUser'>,
    priceIds: { monthly: TEST_PRICE_ID_MONTHLY, annual: TEST_PRICE_ID_ANNUAL },
    appOrigin: 'https://app.example.test',
  };
  return { port, checkoutCreate, portalCreate, pricesRetrieve, getSubscriptionForUser };
}

describe('buildCheckoutSessionParams', () => {
  const baseInput = {
    userId: 'user-1',
    priceId: TEST_PRICE_ID_MONTHLY,
    existingCustomerId: undefined,
    successUrl: 'https://app.example.test/billing/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://app.example.test/billing/canceled',
    integrationIdentifier: 'finaler-draft-checkout-abcdefgh',
  };

  it('uses subscription mode', () => {
    expect(buildCheckoutSessionParams(baseInput).mode).toBe('subscription');
  });

  it('selects the price passed in, for either plan', () => {
    expect(buildCheckoutSessionParams(baseInput).line_items).toEqual([
      { price: TEST_PRICE_ID_MONTHLY, quantity: 1 },
    ]);
    expect(
      buildCheckoutSessionParams({ ...baseInput, priceId: TEST_PRICE_ID_ANNUAL }).line_items,
    ).toEqual([{ price: TEST_PRICE_ID_ANNUAL, quantity: 1 }]);
  });

  it('stamps metadata.userId on both the session and the subscription it creates', () => {
    const params = buildCheckoutSessionParams(baseInput);
    // This is the seam slice 1 flagged (progress/billing-webhook.md): the webhook can only
    // resolve a Stripe customer to a Better Auth user by reading `subscription.metadata.userId`,
    // since `customer.subscription.*` events never carry the Checkout Session's own metadata.
    expect(params.metadata).toEqual({ userId: 'user-1' });
    expect(params.subscription_data?.metadata).toEqual({ userId: 'user-1' });
  });

  it('enables automatic tax', () => {
    expect(buildCheckoutSessionParams(baseInput).automatic_tax).toEqual({ enabled: true });
  });

  it('carries the integration identifier passed in', () => {
    expect(buildCheckoutSessionParams(baseInput).integration_identifier).toBe(
      'finaler-draft-checkout-abcdefgh',
    );
  });

  it('never sets payment_method_types -- hardcoding it silently disables every other method', () => {
    const params = buildCheckoutSessionParams(baseInput);
    expect('payment_method_types' in params).toBe(false);
  });

  it('never sets trial_period_days -- there is no trial; the free tier is the trial', () => {
    const params = buildCheckoutSessionParams(baseInput);
    expect('trial_period_days' in (params.subscription_data ?? {})).toBe(false);
  });

  it('never sets customer_update -- an existing customer keeps its saved address by default', () => {
    const params = buildCheckoutSessionParams({
      ...baseInput,
      existingCustomerId: TEST_CUSTOMER_ID,
    });
    expect('customer_update' in params).toBe(false);
  });

  it('never forces billing_address_collection for a new customer', () => {
    expect('billing_address_collection' in buildCheckoutSessionParams(baseInput)).toBe(false);
  });

  it('omits customer for a brand-new customer, and sets it when reusing an existing one', () => {
    expect(buildCheckoutSessionParams(baseInput).customer).toBeUndefined();
    expect(
      buildCheckoutSessionParams({ ...baseInput, existingCustomerId: TEST_CUSTOMER_ID }).customer,
    ).toBe(TEST_CUSTOMER_ID);
  });

  it('passes success_url and cancel_url through exactly', () => {
    const params = buildCheckoutSessionParams(baseInput);
    expect(params.success_url).toBe(baseInput.successUrl);
    expect(params.cancel_url).toBe(baseInput.cancelUrl);
  });
});

describe('CHECKOUT_INTEGRATION_IDENTIFIER', () => {
  it('is a stable label with an 8-lowercase-letter random suffix', () => {
    expect(CHECKOUT_INTEGRATION_IDENTIFIER).toMatch(/^finaler-draft-checkout-[a-z]{8}$/);
  });
});

describe('createCheckoutSession', () => {
  it('creates a new customer (no customer param) when the user has never subscribed', async () => {
    const { port, checkoutCreate } = fakePort(undefined);
    await createCheckoutSession(port, 'user-1', 'monthly');
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    const params = checkoutCreate.mock.calls[0]![0];
    expect(params.customer).toBeUndefined();
    expect(params.metadata).toEqual({ userId: 'user-1' });
  });

  it('reuses the existing Stripe customer id from the subscriptions projection', async () => {
    const { port, checkoutCreate } = fakePort(subscriptionRow());
    await createCheckoutSession(port, 'user-1', 'monthly');
    const params = checkoutCreate.mock.calls[0]![0];
    expect(params.customer).toBe(TEST_CUSTOMER_ID);
  });

  it('prices the monthly and annual plans from the correct configured price id', async () => {
    const { port, checkoutCreate } = fakePort(undefined);
    await createCheckoutSession(port, 'user-1', 'monthly');
    await createCheckoutSession(port, 'user-1', 'annual');
    expect(checkoutCreate.mock.calls[0]![0].line_items).toEqual([
      { price: TEST_PRICE_ID_MONTHLY, quantity: 1 },
    ]);
    expect(checkoutCreate.mock.calls[1]![0].line_items).toEqual([
      { price: TEST_PRICE_ID_ANNUAL, quantity: 1 },
    ]);
  });

  it('carries the identical integration_identifier across separate sessions -- it is a stable label, not per-session', async () => {
    const { port, checkoutCreate } = fakePort(undefined);
    await createCheckoutSession(port, 'user-1', 'monthly');
    await createCheckoutSession(port, 'user-1', 'annual');
    expect(checkoutCreate.mock.calls[0]![0].integration_identifier).toBe(
      checkoutCreate.mock.calls[1]![0].integration_identifier,
    );
  });

  it('returns the Checkout Session url Stripe returned', async () => {
    const { port } = fakePort(undefined);
    await expect(createCheckoutSession(port, 'user-1', 'monthly')).resolves.toEqual({
      url: 'https://checkout.stripe.test/cs_test_FAKE_1',
    });
  });

  it('never writes to the subscription store -- creating a session must not itself grant anything', async () => {
    const { port, getSubscriptionForUser } = fakePort(undefined);
    await createCheckoutSession(port, 'user-1', 'monthly');
    // The store this module was handed exposes only `getSubscriptionForUser` (see `BillingPort`),
    // so there is no write method available to call in the first place -- this asserts the read
    // happened exactly once (the customer-id lookup) and nothing more.
    expect(getSubscriptionForUser).toHaveBeenCalledTimes(1);
    expect(getSubscriptionForUser).toHaveBeenCalledWith('user-1');
  });

  it('throws if Stripe returns no url', async () => {
    const { port, checkoutCreate } = fakePort(undefined);
    checkoutCreate.mockResolvedValueOnce({ id: 'cs_test_FAKE_2', url: null });
    await expect(createCheckoutSession(port, 'user-1', 'monthly')).rejects.toThrow(
      'Stripe did not return a Checkout Session URL.',
    );
  });
});

describe('createPortalSession', () => {
  it('reports no-customer for an account that has never subscribed, without calling Stripe', async () => {
    const { port, portalCreate } = fakePort(undefined);
    await expect(createPortalSession(port, 'user-1')).resolves.toEqual({ outcome: 'no-customer' });
    expect(portalCreate).not.toHaveBeenCalled();
  });

  it('creates a Portal session for the existing customer and returns its url', async () => {
    const { port, portalCreate } = fakePort(subscriptionRow());
    await expect(createPortalSession(port, 'user-1')).resolves.toEqual({
      outcome: 'created',
      url: 'https://billing.stripe.test/bps_test_FAKE_1',
    });
    expect(portalCreate).toHaveBeenCalledWith({
      customer: TEST_CUSTOMER_ID,
      return_url: 'https://app.example.test/projects',
    });
  });
});

describe('fetchBillingPlans', () => {
  it('fetches both configured prices and reports their real amounts, currency, and interval', async () => {
    const { port, pricesRetrieve } = fakePort(undefined);
    await expect(fetchBillingPlans(port)).resolves.toEqual({
      monthly: { amount: 500, currency: 'usd', interval: 'month' },
      annual: { amount: 5000, currency: 'usd', interval: 'year' },
    });
    expect(pricesRetrieve).toHaveBeenCalledWith(TEST_PRICE_ID_MONTHLY);
    expect(pricesRetrieve).toHaveBeenCalledWith(TEST_PRICE_ID_ANNUAL);
  });

  it('reports a null interval and zero amount rather than crashing on an unexpected price shape', async () => {
    const { port, pricesRetrieve } = fakePort(undefined);
    pricesRetrieve.mockImplementation(async () => ({
      id: 'price_test_FAKE_weird',
      unit_amount: null,
      currency: 'usd',
      recurring: null,
    }));
    await expect(fetchBillingPlans(port)).resolves.toEqual({
      monthly: { amount: 0, currency: 'usd', interval: null },
      annual: { amount: 0, currency: 'usd', interval: null },
    });
  });
});
