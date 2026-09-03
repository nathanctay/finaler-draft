import Stripe from 'stripe';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { dispatchStripeEvent } from './stripeWebhook.js';
import type {
  InvoiceEventInput,
  ProcessOutcome,
  SubscriptionEventInput,
  SubscriptionProjection,
  SubscriptionStore,
} from './stripeSubscriptions.js';

// Obviously-fake test-only secrets, never anything resembling a real Stripe credential.
const TEST_WEBHOOK_SECRET = 'whsec_test_FAKE_signing_secret';

/**
 * A faithful in-memory re-implementation of `createPostgresSubscriptionStore`'s contract --
 * same dedupe-by-event-id, same "resolve userId from an existing customer row" fallback, same
 * out-of-order guard (an event's `eventCreatedAt` must be strictly newer to apply) -- without a
 * database. `stripeSubscriptions.integration.test.ts` proves the real SQL that implements this
 * same contract; this proves everything that talks to a `SubscriptionStore` (`dispatchStripeEvent`
 * and the webhook route below) uses it correctly.
 */
function createFakeSubscriptionStore(): SubscriptionStore {
  const processedEventIds = new Set<string>();
  const byUserId = new Map<string, SubscriptionProjection & { lastEventCreatedAt: Date }>();
  const userIdByCustomerId = new Map<string, string>();
  const userIdBySubscriptionId = new Map<string, string>();

  return {
    async recordSubscriptionEvent(input: SubscriptionEventInput): Promise<ProcessOutcome> {
      if (processedEventIds.has(input.eventId)) return 'duplicate';
      processedEventIds.add(input.eventId);
      const userId = input.userId ?? userIdByCustomerId.get(input.stripeCustomerId) ?? null;
      if (!userId) return 'unresolved';
      const existing = byUserId.get(userId);
      if (existing && existing.lastEventCreatedAt >= input.eventCreatedAt) return 'stale';
      byUserId.set(userId, {
        userId,
        stripeCustomerId: input.stripeCustomerId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripePriceId: input.stripePriceId,
        status: input.status,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        canceledAt: input.canceledAt,
        lastEventCreatedAt: input.eventCreatedAt,
      });
      userIdByCustomerId.set(input.stripeCustomerId, userId);
      userIdBySubscriptionId.set(input.stripeSubscriptionId, userId);
      return 'applied';
    },
    async recordInvoiceEvent(input: InvoiceEventInput): Promise<ProcessOutcome> {
      if (processedEventIds.has(input.eventId)) return 'duplicate';
      processedEventIds.add(input.eventId);
      const userId = userIdBySubscriptionId.get(input.stripeSubscriptionId);
      if (!userId) return 'ignored';
      const existing = byUserId.get(userId);
      if (!existing || existing.lastEventCreatedAt >= input.eventCreatedAt) return 'ignored';
      byUserId.set(userId, {
        ...existing,
        status: input.status,
        currentPeriodEnd: input.currentPeriodEnd ?? existing.currentPeriodEnd,
        lastEventCreatedAt: input.eventCreatedAt,
      });
      return 'applied';
    },
    async recordIgnoredEvent(eventId: string): Promise<ProcessOutcome> {
      if (processedEventIds.has(eventId)) return 'duplicate';
      processedEventIds.add(eventId);
      return 'ignored';
    },
    async getSubscriptionForUser(userId: string) {
      const row = byUserId.get(userId);
      if (!row) return undefined;
      return {
        userId: row.userId,
        stripeCustomerId: row.stripeCustomerId,
        stripeSubscriptionId: row.stripeSubscriptionId,
        stripePriceId: row.stripePriceId,
        status: row.status,
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        canceledAt: row.canceledAt,
      };
    },
  };
}

function fakeSubscriptionEvent(
  overrides: {
    id?: string;
    type?:
      | 'customer.subscription.created'
      | 'customer.subscription.updated'
      | 'customer.subscription.deleted';
    created?: number;
    subscriptionId?: string;
    customerId?: string;
    priceId?: string;
    status?: string;
    currentPeriodEnd?: number;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: number | null;
    metadata?: Record<string, string>;
    noItems?: boolean;
  } = {},
): Stripe.Event {
  const item = {
    id: 'si_fake',
    price: { id: overrides.priceId ?? 'price_fake_monthly' },
    current_period_end: overrides.currentPeriodEnd ?? 1_800_000_000,
  };
  return {
    id: overrides.id ?? 'evt_fake_subscription',
    type: overrides.type ?? 'customer.subscription.created',
    created: overrides.created ?? 1_700_000_000,
    data: {
      object: {
        id: overrides.subscriptionId ?? 'sub_fake',
        customer: overrides.customerId ?? 'cus_fake',
        status: overrides.status ?? 'active',
        cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
        canceled_at: overrides.canceledAt ?? null,
        metadata: overrides.metadata ?? {},
        items: { data: overrides.noItems ? [] : [item] },
      },
    },
  } as unknown as Stripe.Event;
}

function fakeInvoiceEvent(
  overrides: {
    id?: string;
    type?: 'invoice.paid' | 'invoice.payment_failed';
    created?: number;
    subscriptionId?: string | null;
    periodEnd?: number;
  } = {},
): Stripe.Event {
  return {
    id: overrides.id ?? 'evt_fake_invoice',
    type: overrides.type ?? 'invoice.paid',
    created: overrides.created ?? 1_700_000_000,
    data: {
      object: {
        id: 'in_fake',
        parent:
          overrides.subscriptionId === null
            ? null
            : { subscription_details: { subscription: overrides.subscriptionId ?? 'sub_fake' } },
        lines: {
          data:
            overrides.periodEnd === undefined
              ? []
              : [{ period: { start: 0, end: overrides.periodEnd } }],
        },
      },
    },
  } as unknown as Stripe.Event;
}

describe('dispatchStripeEvent', () => {
  it('projects customer.subscription.created from the first subscription item', async () => {
    const store = createFakeSubscriptionStore();
    const event = fakeSubscriptionEvent({
      customerId: 'cus_1',
      metadata: { userId: 'user-1' },
      status: 'active',
      priceId: 'price_monthly',
    });
    await expect(dispatchStripeEvent(store, event)).resolves.toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      userId: 'user-1',
      stripeCustomerId: 'cus_1',
      stripePriceId: 'price_monthly',
      status: 'active',
    });
  });

  it('projects customer.subscription.updated the same way as created', async () => {
    const store = createFakeSubscriptionStore();
    const event = fakeSubscriptionEvent({
      type: 'customer.subscription.updated',
      metadata: { userId: 'user-1' },
      status: 'past_due',
    });
    await expect(dispatchStripeEvent(store, event)).resolves.toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'past_due',
    });
  });

  it("projects customer.subscription.deleted using the subscription object's own canceled status", async () => {
    const store = createFakeSubscriptionStore();
    const event = fakeSubscriptionEvent({
      type: 'customer.subscription.deleted',
      metadata: { userId: 'user-1' },
      status: 'canceled',
      cancelAtPeriodEnd: false,
      canceledAt: 1_700_000_500,
    });
    await expect(dispatchStripeEvent(store, event)).resolves.toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'canceled',
      canceledAt: new Date(1_700_000_500 * 1000),
    });
  });

  it('reads userId from subscription.metadata.userId, not from any other field', async () => {
    const store = createFakeSubscriptionStore();
    const event = fakeSubscriptionEvent({ metadata: { userId: 'user-42', unrelated: 'ignored' } });
    await dispatchStripeEvent(store, event);
    await expect(store.getSubscriptionForUser('user-42')).resolves.toBeDefined();
  });

  it('leaves a subscription unresolved (not applied) when no userId can be found anywhere', async () => {
    const store = createFakeSubscriptionStore();
    const event = fakeSubscriptionEvent({ customerId: 'cus_orphan', metadata: {} });
    await expect(dispatchStripeEvent(store, event)).resolves.toBe('unresolved');
  });

  it('ignores a subscription event with no line items rather than writing a priceless row', async () => {
    const store = createFakeSubscriptionStore();
    const event = fakeSubscriptionEvent({ metadata: { userId: 'user-1' }, noItems: true });
    await expect(dispatchStripeEvent(store, event)).resolves.toBe('ignored');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toBeUndefined();
  });

  it('rejects an unrecognized subscription status rather than writing it or coercing it', async () => {
    const store = createFakeSubscriptionStore();
    const event = fakeSubscriptionEvent({
      metadata: { userId: 'user-1' },
      status: 'some_future_status_this_sdk_does_not_know_about',
    });
    await expect(dispatchStripeEvent(store, event)).rejects.toThrow(/unrecognized/i);
  });

  it('projects invoice.paid onto an existing subscription row as an active-status update', async () => {
    const store = createFakeSubscriptionStore();
    await dispatchStripeEvent(
      store,
      fakeSubscriptionEvent({
        created: 1_700_000_000,
        subscriptionId: 'sub_1',
        metadata: { userId: 'user-1' },
        status: 'past_due',
      }),
    );
    const outcome = await dispatchStripeEvent(
      store,
      fakeInvoiceEvent({
        id: 'evt_invoice_1',
        type: 'invoice.paid',
        created: 1_700_000_100,
        subscriptionId: 'sub_1',
        periodEnd: 1_800_500_000,
      }),
    );
    expect(outcome).toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'active',
      currentPeriodEnd: new Date(1_800_500_000 * 1000),
    });
  });

  it('projects invoice.payment_failed as a past_due update', async () => {
    const store = createFakeSubscriptionStore();
    await dispatchStripeEvent(
      store,
      fakeSubscriptionEvent({
        created: 1_700_000_000,
        subscriptionId: 'sub_1',
        metadata: { userId: 'user-1' },
        status: 'active',
      }),
    );
    const outcome = await dispatchStripeEvent(
      store,
      fakeInvoiceEvent({
        id: 'evt_invoice_2',
        type: 'invoice.payment_failed',
        created: 1_700_000_100,
        subscriptionId: 'sub_1',
      }),
    );
    expect(outcome).toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'past_due',
    });
  });

  it('ignores an invoice that is not tied to any subscription', async () => {
    const store = createFakeSubscriptionStore();
    const outcome = await dispatchStripeEvent(store, fakeInvoiceEvent({ subscriptionId: null }));
    expect(outcome).toBe('ignored');
  });

  it('acknowledges an unhandled event type without inspecting its payload', async () => {
    const store = createFakeSubscriptionStore();
    const event = {
      id: 'evt_customer_updated',
      type: 'customer.updated',
      created: 1_700_000_000,
      data: { object: {} },
    } as unknown as Stripe.Event;
    await expect(dispatchStripeEvent(store, event)).resolves.toBe('ignored');
  });
});

describe('POST /api/webhooks/stripe', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  async function buildWebhookApp(
    overrides: {
      ipAllowlist?: { isAllowed(ip: string): boolean };
    } = {},
  ) {
    const store = createFakeSubscriptionStore();
    const app = await buildApp({
      stripe: {
        // Real signature-verification logic (pure HMAC, no network/API key involved) rather
        // than a hand-rolled fake -- this is the one piece of this route that must be the real
        // thing for the tests to mean anything.
        client: { webhooks: Stripe.webhooks },
        webhookSecret: TEST_WEBHOOK_SECRET,
        store,
        ...(overrides.ipAllowlist ? { ipAllowlist: overrides.ipAllowlist } : {}),
      },
    });
    apps.push(app);
    return { app, store };
  }

  function sign(payload: string, timestamp?: number) {
    return Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: TEST_WEBHOOK_SECRET,
      ...(timestamp === undefined ? {} : { timestamp }),
    });
  }

  it('accepts a correctly signed payload, verifies it, and projects the subscription', async () => {
    const { app, store } = await buildWebhookApp();
    const payload = JSON.stringify({
      id: 'evt_ok_1',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'sub_ok_1',
          customer: 'cus_ok_1',
          status: 'active',
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: { userId: 'user-ok' },
          items: { data: [{ price: { id: 'price_ok' }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
      payload,
    });
    expect(response.statusCode).toBe(200);
    await expect(store.getSubscriptionForUser('user-ok')).resolves.toMatchObject({
      stripeCustomerId: 'cus_ok_1',
      status: 'active',
    });
  });

  it('rejects a request with no Stripe-Signature header at all', async () => {
    const { app } = await buildWebhookApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt_no_sig', type: 'customer.updated', created: 1, data: {} }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a payload whose signature does not match (wrong secret)', async () => {
    const { app, store } = await buildWebhookApp();
    const payload = JSON.stringify({
      id: 'evt_bad_sig',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'sub_x',
          customer: 'cus_x',
          status: 'active',
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: { userId: 'user-x' },
          items: { data: [{ price: { id: 'price_x' }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    const wrongSecretSignature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_test_FAKE_a_completely_different_secret',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': wrongSecretSignature },
      payload,
    });
    expect(response.statusCode).toBe(400);
    // Confirms the signature failure actually stopped processing, not just that the HTTP status
    // happens to be 400 for some unrelated reason.
    await expect(store.getSubscriptionForUser('user-x')).resolves.toBeUndefined();
  });

  // Regression coverage for a real finding: a stale `STRIPE_WEBHOOK_SECRET` (`stripe listen`
  // prints a fresh `whsec_` every session) produces exactly this rejection with no indication of
  // why from the outside. The log line's message text now names that as the likely cause -- this
  // proves the hint is actually there, and that it still never logs anything from the header or
  // payload that failed to verify (the whole reason the structured `err` field stays just the
  // error's name).
  it('logs an actionable hint about a possibly-stale signing secret, never the raw error, when a signature is rejected', async () => {
    const { app } = await buildWebhookApp();
    let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
    app.addHook('onRequest', async (request) => {
      warnSpy = vi.spyOn(request.log, 'warn');
    });
    const payload = JSON.stringify({
      id: 'evt_stale_secret',
      type: 'customer.subscription.created',
    });
    const wrongSecretSignature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_test_FAKE_a_completely_different_secret',
    });
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': wrongSecretSignature },
      payload,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'stripe_webhook_signature_rejected' }),
      expect.stringContaining('STRIPE_WEBHOOK_SECRET'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('stripe listen'),
    );
    // Never the raw payload or header the signature check failed against.
    const loggedMessage = warnSpy?.mock.calls[0]?.[1] as string;
    expect(loggedMessage).not.toContain('evt_stale_secret');
  });

  it('rejects a payload whose body was tampered with after signing', async () => {
    const { app, store } = await buildWebhookApp();
    const originalPayload = JSON.stringify({
      id: 'evt_tampered',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'sub_y',
          customer: 'cus_y',
          status: 'active',
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: { userId: 'user-y' },
          items: { data: [{ price: { id: 'price_y' }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    const signatureHeader = sign(originalPayload);
    const tamperedPayload = originalPayload.replace('user-y', 'user-attacker');
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signatureHeader },
      payload: tamperedPayload,
    });
    expect(response.statusCode).toBe(400);
    await expect(store.getSubscriptionForUser('user-attacker')).resolves.toBeUndefined();
  });

  it('rejects a correctly signed payload whose timestamp is outside the tolerance window', async () => {
    const { app, store } = await buildWebhookApp();
    const payload = JSON.stringify({
      id: 'evt_stale',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'sub_z',
          customer: 'cus_z',
          status: 'active',
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: { userId: 'user-z' },
          items: { data: [{ price: { id: 'price_z' }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    // constructEvent's default tolerance is 300 seconds (Webhooks.js's DEFAULT_TOLERANCE); 400
    // seconds old is a genuinely signed payload that must still be rejected as stale.
    const staleTimestamp = Math.floor(Date.now() / 1000) - 400;
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sign(payload, staleTimestamp),
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    await expect(store.getSubscriptionForUser('user-z')).resolves.toBeUndefined();
  });

  it('returns 200 for the same event.id delivered twice, applying the state change only once', async () => {
    const { app, store } = await buildWebhookApp();
    const firstPayload = JSON.stringify({
      id: 'evt_dup_1',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'sub_dup',
          customer: 'cus_dup',
          status: 'active',
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: { userId: 'user-dup' },
          items: { data: [{ price: { id: 'price_dup' }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    // Same event.id, different status -- standing in for "Stripe redelivered/retried what it
    // considers the same event." Trusting `event.id` alone (not the payload contents) for dedupe
    // is exactly the behaviour under test.
    const secondPayload = firstPayload.replace('"active"', '"past_due"');

    const first = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(firstPayload) },
      payload: firstPayload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(secondPayload) },
      payload: secondPayload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    await expect(store.getSubscriptionForUser('user-dup')).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('returns 200 for an event type this slice does not handle, without erroring', async () => {
    const { app } = await buildWebhookApp();
    const payload = JSON.stringify({
      id: 'evt_unhandled',
      type: 'customer.updated',
      created: 1_700_000_000,
      data: { object: { id: 'cus_unhandled' } },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
      payload,
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a request from an IP outside the configured allowlist before it can be projected', async () => {
    const { app, store } = await buildWebhookApp({ ipAllowlist: { isAllowed: () => false } });
    const payload = JSON.stringify({
      id: 'evt_ip_rejected',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'sub_ip',
          customer: 'cus_ip',
          status: 'active',
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: { userId: 'user-ip' },
          items: { data: [{ price: { id: 'price_ip' }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sign(payload),
        'x-real-ip': '203.0.113.9',
      },
      payload,
    });
    expect(response.statusCode).toBe(403);
    await expect(store.getSubscriptionForUser('user-ip')).resolves.toBeUndefined();
  });

  it('allows a request whose IP the allowlist accepts', async () => {
    const { app, store } = await buildWebhookApp({
      ipAllowlist: { isAllowed: (ip) => ip === '203.0.113.9' },
    });
    const payload = JSON.stringify({
      id: 'evt_ip_allowed',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'sub_ip2',
          customer: 'cus_ip2',
          status: 'active',
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: { userId: 'user-ip2' },
          items: { data: [{ price: { id: 'price_ip2' }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sign(payload),
        'x-real-ip': '203.0.113.9',
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    await expect(store.getSubscriptionForUser('user-ip2')).resolves.toBeDefined();
  });

  it('does not disable JSON parsing anywhere else: a sibling route on the same app still parses JSON normally', async () => {
    const { app } = await buildWebhookApp();
    // Registered directly on the top-level app instance (not inside the webhook's scoped child
    // context) -- this is the whole point of the test: the raw-body parser added for
    // `/api/webhooks/stripe` must not leak out and start handing every other route a Buffer
    // instead of a parsed object. Added before the first `.inject()` call below, since Fastify
    // finalizes routing on first use.
    app.post('/api/test/echo-json', async (request) => ({
      isPlainObject: typeof request.body === 'object' && !Buffer.isBuffer(request.body),
      body: request.body,
    }));

    const jsonResponse = await app.inject({
      method: 'POST',
      url: '/api/test/echo-json',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world' }),
    });
    expect(jsonResponse.statusCode).toBe(200);
    expect(jsonResponse.json()).toEqual({ isPlainObject: true, body: { hello: 'world' } });

    // And the webhook route, registered earlier in the same app instance, still gets its raw
    // Buffer and verifies correctly -- proving both behaviours coexist on one app.
    const webhookPayload = JSON.stringify({
      id: 'evt_scoping_proof',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'sub_scope',
          customer: 'cus_scope',
          status: 'active',
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: { userId: 'user-scope' },
          items: { data: [{ price: { id: 'price_scope' }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    const webhookResponse = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(webhookPayload) },
      payload: webhookPayload,
    });
    expect(webhookResponse.statusCode).toBe(200);
  });
});
