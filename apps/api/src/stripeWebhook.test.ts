import Stripe from 'stripe';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { dispatchStripeEvent } from './stripeWebhook.js';
import type {
  ProcessOutcome,
  SubscriptionEventInput,
  SubscriptionProjection,
  SubscriptionStore,
} from './stripeSubscriptions.js';

// Obviously-fake test-only secrets, never anything resembling a real Stripe credential.
const TEST_WEBHOOK_SECRET = 'whsec_test_FAKE_signing_secret';

/**
 * A faithful in-memory re-implementation of `createPostgresSubscriptionStore`'s contract --
 * same dedupe-by-event-id, same "resolve userId from an existing projection row for the same
 * customer" fallback -- without a database. There is deliberately no ordering/staleness logic
 * left here (BIL-1): the real store dropped it, and a fake that still had it would let a
 * regression back into `dispatchStripeEvent` go unnoticed by every test in this file.
 * `stripeSubscriptions.integration.test.ts` proves the real SQL that implements this same
 * contract; this proves everything that talks to a `SubscriptionStore` (`dispatchStripeEvent` and
 * the webhook route below) uses it correctly.
 */
function createFakeSubscriptionStore(): SubscriptionStore {
  const processedEventIds = new Set<string>();
  const byUserId = new Map<string, SubscriptionProjection>();
  const userIdByCustomerId = new Map<string, string>();

  return {
    async recordSubscriptionEvent(input: SubscriptionEventInput): Promise<ProcessOutcome> {
      if (processedEventIds.has(input.eventId)) return 'duplicate';
      processedEventIds.add(input.eventId);
      const userId = input.userId ?? userIdByCustomerId.get(input.stripeCustomerId) ?? null;
      if (!userId) return 'unresolved';
      byUserId.set(userId, {
        userId,
        stripeCustomerId: input.stripeCustomerId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripePriceId: input.stripePriceId,
        status: input.status,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        canceledAt: input.canceledAt,
      });
      userIdByCustomerId.set(input.stripeCustomerId, userId);
      return 'applied';
    },
    async recordIgnoredEvent(eventId: string): Promise<ProcessOutcome> {
      if (processedEventIds.has(eventId)) return 'duplicate';
      processedEventIds.add(eventId);
      return 'ignored';
    },
    async getSubscriptionForUser(userId: string) {
      return byUserId.get(userId);
    },
  };
}

/**
 * The object `client.subscriptions.retrieve` resolves to -- Stripe's own current, authoritative
 * state of a subscription. This is deliberately a *different* builder from the event payload
 * builders below: the whole point of BIL-1/BIL-2 is that `dispatchStripeEvent` must read status,
 * price, period, and metadata from here, never from an event payload, and several tests below
 * construct a payload and a retrieved object that disagree on purpose to prove that.
 */
function fakeStripeSubscription(
  overrides: {
    id?: string;
    customerId?: string;
    priceId?: string;
    status?: string;
    currentPeriodEnd?: number;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: number | null;
    metadata?: Record<string, string>;
    noItems?: boolean;
  } = {},
): Stripe.Subscription {
  const item = {
    id: 'si_fake',
    price: { id: overrides.priceId ?? 'price_fake_monthly' },
    current_period_end: overrides.currentPeriodEnd ?? 1_800_000_000,
  };
  return {
    id: overrides.id ?? 'sub_fake',
    customer: overrides.customerId ?? 'cus_fake',
    status: overrides.status ?? 'active',
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    canceled_at: overrides.canceledAt ?? null,
    metadata: overrides.metadata ?? {},
    items: { data: overrides.noItems ? [] : [item] },
  } as unknown as Stripe.Subscription;
}

/**
 * A fake `Pick<Stripe, 'subscriptions'>`: `retrieve(id)` resolves whatever was registered for
 * `id`, or rejects with it when an `Error` was registered instead -- the one seam the
 * retrieval-failure tests below need. `calls` records every id actually retrieved, so a test can
 * assert an unhandled event type never triggers a Stripe call at all.
 */
function fakeStripeSubscriptionsClient(
  registry: Map<string, Stripe.Subscription | Error> = new Map(),
): { client: Pick<Stripe, 'subscriptions'>; calls: string[] } {
  const calls: string[] = [];
  const retrieve = vi.fn(async (id: string) => {
    calls.push(id);
    const result = registry.get(id);
    if (result === undefined) {
      throw new Error(`fakeStripeSubscriptionsClient: no fake subscription registered for ${id}`);
    }
    if (result instanceof Error) throw result;
    return result;
  });
  return { client: { subscriptions: { retrieve } } as never, calls };
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
    // Deliberately named to make it obvious at every call site that these payload fields are
    // bait: `dispatchStripeEvent` must never read them, only the retrieved object's own.
    payloadStatus?: string;
    payloadMetadata?: Record<string, string>;
  } = {},
): Stripe.Event {
  return {
    id: overrides.id ?? 'evt_fake_subscription',
    type: overrides.type ?? 'customer.subscription.created',
    created: overrides.created ?? 1_700_000_000,
    data: {
      object: {
        id: overrides.subscriptionId ?? 'sub_fake',
        status: overrides.payloadStatus ?? 'incomplete',
        metadata: overrides.payloadMetadata ?? {},
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
        lines: { data: [] },
      },
    },
  } as unknown as Stripe.Event;
}

describe('dispatchStripeEvent', () => {
  it('projects customer.subscription.created from the retrieved subscription, not the payload', async () => {
    const store = createFakeSubscriptionStore();
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_1',
          fakeStripeSubscription({
            id: 'sub_1',
            customerId: 'cus_1',
            metadata: { userId: 'user-1' },
            status: 'active',
            priceId: 'price_monthly',
          }),
        ],
      ]),
    );
    const event = fakeSubscriptionEvent({
      subscriptionId: 'sub_1',
      // The payload claims `incomplete` and carries no metadata at all -- both must be ignored.
      payloadStatus: 'incomplete',
      payloadMetadata: {},
    });
    await expect(dispatchStripeEvent(store, client, event)).resolves.toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      userId: 'user-1',
      stripeCustomerId: 'cus_1',
      stripePriceId: 'price_monthly',
      status: 'active',
    });
  });

  it('projects customer.subscription.updated the same way as created', async () => {
    const store = createFakeSubscriptionStore();
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_1',
          fakeStripeSubscription({
            id: 'sub_1',
            metadata: { userId: 'user-1' },
            status: 'past_due',
          }),
        ],
      ]),
    );
    const event = fakeSubscriptionEvent({
      type: 'customer.subscription.updated',
      subscriptionId: 'sub_1',
    });
    await expect(dispatchStripeEvent(store, client, event)).resolves.toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'past_due',
    });
  });

  it("projects customer.subscription.deleted using the retrieved subscription's own canceled status", async () => {
    const store = createFakeSubscriptionStore();
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_1',
          fakeStripeSubscription({
            id: 'sub_1',
            metadata: { userId: 'user-1' },
            status: 'canceled',
            canceledAt: 1_700_000_500,
          }),
        ],
      ]),
    );
    const event = fakeSubscriptionEvent({
      type: 'customer.subscription.deleted',
      subscriptionId: 'sub_1',
      // The payload disagrees with the retrieved object on purpose.
      payloadStatus: 'active',
    });
    await expect(dispatchStripeEvent(store, client, event)).resolves.toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'canceled',
      canceledAt: new Date(1_700_000_500 * 1000),
    });
  });

  it('reads userId from the retrieved subscription.metadata.userId, never the event payload', async () => {
    const store = createFakeSubscriptionStore();
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        ['sub_1', fakeStripeSubscription({ id: 'sub_1', metadata: { userId: 'user-42' } })],
      ]),
    );
    // The payload claims a different user entirely -- must be ignored.
    const event = fakeSubscriptionEvent({
      subscriptionId: 'sub_1',
      payloadMetadata: { userId: 'user-attacker' },
    });
    await dispatchStripeEvent(store, client, event);
    await expect(store.getSubscriptionForUser('user-42')).resolves.toBeDefined();
    await expect(store.getSubscriptionForUser('user-attacker')).resolves.toBeUndefined();
  });

  it('leaves a subscription unresolved (not applied) when no userId can be found anywhere', async () => {
    const store = createFakeSubscriptionStore();
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        ['sub_orphan', fakeStripeSubscription({ id: 'sub_orphan', customerId: 'cus_orphan' })],
      ]),
    );
    const event = fakeSubscriptionEvent({ subscriptionId: 'sub_orphan' });
    await expect(dispatchStripeEvent(store, client, event)).resolves.toBe('unresolved');
  });

  it('ignores a subscription event when the retrieved subscription has no line items', async () => {
    const store = createFakeSubscriptionStore();
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_1',
          fakeStripeSubscription({ id: 'sub_1', metadata: { userId: 'user-1' }, noItems: true }),
        ],
      ]),
    );
    const event = fakeSubscriptionEvent({ subscriptionId: 'sub_1' });
    await expect(dispatchStripeEvent(store, client, event)).resolves.toBe('ignored');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toBeUndefined();
  });

  it('rejects an unrecognized subscription status from the retrieved object rather than writing it', async () => {
    const store = createFakeSubscriptionStore();
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_1',
          fakeStripeSubscription({
            id: 'sub_1',
            metadata: { userId: 'user-1' },
            status: 'some_future_status_this_sdk_does_not_know_about',
          }),
        ],
      ]),
    );
    const event = fakeSubscriptionEvent({ subscriptionId: 'sub_1' });
    await expect(dispatchStripeEvent(store, client, event)).rejects.toThrow(/unrecognized/i);
  });

  it('ignores an invoice that is not tied to any subscription, without calling Stripe', async () => {
    const store = createFakeSubscriptionStore();
    const { client, calls } = fakeStripeSubscriptionsClient();
    const outcome = await dispatchStripeEvent(
      store,
      client,
      fakeInvoiceEvent({ subscriptionId: null }),
    );
    expect(outcome).toBe('ignored');
    expect(calls).toEqual([]);
  });

  it('acknowledges an unhandled event type without inspecting its payload or calling Stripe', async () => {
    const store = createFakeSubscriptionStore();
    const { client, calls } = fakeStripeSubscriptionsClient();
    const event = {
      id: 'evt_customer_updated',
      type: 'customer.updated',
      created: 1_700_000_000,
      data: { object: {} },
    } as unknown as Stripe.Event;
    await expect(dispatchStripeEvent(store, client, event)).resolves.toBe('ignored');
    expect(calls).toEqual([]);
  });

  // --- BIL-1: same-second events no longer race each other ------------------------------------

  it('BIL-1: two distinct events sharing the same event.created second both apply (no ordering guard)', async () => {
    const store = createFakeSubscriptionStore();
    const registry = new Map<string, Stripe.Subscription>([
      [
        'sub_1',
        fakeStripeSubscription({
          id: 'sub_1',
          metadata: { userId: 'user-1' },
          status: 'incomplete',
        }),
      ],
    ]);
    const { client } = fakeStripeSubscriptionsClient(registry);
    const sameSecond = 1_700_000_000;

    // customer.subscription.created, retrieved while Stripe's own state is still "incomplete".
    const first = await dispatchStripeEvent(
      store,
      client,
      fakeSubscriptionEvent({ id: 'evt_a', subscriptionId: 'sub_1', created: sameSecond }),
    );
    // Before the second event is dispatched, Stripe's own state has already moved on to
    // "active" (exactly what a real `customer.subscription.updated` generated moments later,
    // sharing the same one-second-resolution `created` timestamp, would reflect).
    registry.set(
      'sub_1',
      fakeStripeSubscription({ id: 'sub_1', metadata: { userId: 'user-1' }, status: 'active' }),
    );
    const second = await dispatchStripeEvent(
      store,
      client,
      fakeSubscriptionEvent({
        id: 'evt_b',
        type: 'customer.subscription.updated',
        subscriptionId: 'sub_1',
        created: sameSecond,
      }),
    );

    expect(first).toBe('applied');
    expect(second).toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('BIL-1: an event describing an earlier moment still applies even when dispatched after a later one', async () => {
    // The old out-of-order guard rejected this as `stale`. There is no replacement comparison --
    // whichever retrieval runs last wins, regardless of either event's own `created` value.
    const store = createFakeSubscriptionStore();
    const registry = new Map<string, Stripe.Subscription>([
      [
        'sub_1',
        fakeStripeSubscription({ id: 'sub_1', metadata: { userId: 'user-1' }, status: 'active' }),
      ],
    ]);
    const { client } = fakeStripeSubscriptionsClient(registry);

    await dispatchStripeEvent(
      store,
      client,
      fakeSubscriptionEvent({ id: 'evt_newer', subscriptionId: 'sub_1', created: 1_700_000_100 }),
    );
    registry.set(
      'sub_1',
      fakeStripeSubscription({ id: 'sub_1', metadata: { userId: 'user-1' }, status: 'past_due' }),
    );
    const outcome = await dispatchStripeEvent(
      store,
      client,
      fakeSubscriptionEvent({ id: 'evt_older', subscriptionId: 'sub_1', created: 1_700_000_000 }),
    );

    expect(outcome).toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'past_due',
    });
  });

  // --- BIL-2: invoice events stop guessing status -----------------------------------------------

  it('BIL-2: invoice.paid on a canceled subscription leaves the row canceled, not active', async () => {
    const store = createFakeSubscriptionStore();
    const registry = new Map<string, Stripe.Subscription>([
      [
        'sub_1',
        fakeStripeSubscription({
          id: 'sub_1',
          metadata: { userId: 'user-1' },
          status: 'canceled',
          canceledAt: 1_700_000_000,
        }),
      ],
    ]);
    const { client } = fakeStripeSubscriptionsClient(registry);
    // Simulates `customer.subscription.deleted` having already set the row to canceled.
    await dispatchStripeEvent(
      store,
      client,
      fakeSubscriptionEvent({
        id: 'evt_deleted',
        type: 'customer.subscription.deleted',
        subscriptionId: 'sub_1',
        created: 1_700_000_000,
      }),
    );

    // The customer pays the still-open invoice from the emailed hosted link. Stripe's
    // subscription is still canceled -- `invoice.paid` must not move it to active.
    const outcome = await dispatchStripeEvent(
      store,
      client,
      fakeInvoiceEvent({
        id: 'evt_invoice_paid',
        type: 'invoice.paid',
        subscriptionId: 'sub_1',
        created: 1_700_000_900,
      }),
    );

    expect(outcome).toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'canceled',
    });
  });

  it('invoice.payment_failed applies the retrieved status, not a hardcoded past_due', async () => {
    const store = createFakeSubscriptionStore();
    // Stripe may still report the subscription "active" on the very first failed attempt --
    // nothing in this slice should force `past_due` just because this event type arrived.
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_1',
          fakeStripeSubscription({ id: 'sub_1', metadata: { userId: 'user-1' }, status: 'active' }),
        ],
      ]),
    );
    const outcome = await dispatchStripeEvent(
      store,
      client,
      fakeInvoiceEvent({ type: 'invoice.payment_failed', subscriptionId: 'sub_1' }),
    );
    expect(outcome).toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('invoice.paid upserts a brand-new projection row when none exists yet for this subscription', async () => {
    // The old `recordInvoiceEvent` was update-only and left this `ignored` forever (BIL-2's
    // ordering-hole addendum). Routing invoice events through the same retrieval-and-upsert path
    // as subscription events fixes it as a side effect.
    const store = createFakeSubscriptionStore();
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_new',
          fakeStripeSubscription({
            id: 'sub_new',
            metadata: { userId: 'user-new' },
            status: 'active',
          }),
        ],
      ]),
    );
    const outcome = await dispatchStripeEvent(
      store,
      client,
      fakeInvoiceEvent({ type: 'invoice.paid', subscriptionId: 'sub_new' }),
    );
    expect(outcome).toBe('applied');
    await expect(store.getSubscriptionForUser('user-new')).resolves.toMatchObject({
      stripeSubscriptionId: 'sub_new',
      status: 'active',
    });
  });

  // --- Retrieval-failure policy -------------------------------------------------------------

  it('a failed retrieval rejects and never calls the store, so the event is not marked processed', async () => {
    const store = createFakeSubscriptionStore();
    const recordSpy = vi.spyOn(store, 'recordSubscriptionEvent');
    const { client } = fakeStripeSubscriptionsClient(
      new Map([['sub_1', new Error('simulated Stripe outage')]]),
    );
    const event = fakeSubscriptionEvent({ id: 'evt_retry', subscriptionId: 'sub_1' });

    await expect(dispatchStripeEvent(store, client, event)).rejects.toThrow(
      'simulated Stripe outage',
    );
    expect(recordSpy).not.toHaveBeenCalled();

    // The real proof, not just "the function never ran": Stripe's own retry of the identical
    // `event.id` must still be able to succeed -- it could not if the failed attempt had left a
    // row in the processed-events ledger.
    const { client: recoveredClient } = fakeStripeSubscriptionsClient(
      new Map([['sub_1', fakeStripeSubscription({ id: 'sub_1', metadata: { userId: 'user-1' } })]]),
    );
    await expect(dispatchStripeEvent(store, recoveredClient, event)).resolves.toBe('applied');
    await expect(store.getSubscriptionForUser('user-1')).resolves.toBeDefined();
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
      subscriptionsClient?: Pick<Stripe, 'subscriptions'>;
    } = {},
  ) {
    const store = createFakeSubscriptionStore();
    const app = await buildApp({
      stripe: {
        client: {
          // Real signature-verification logic (pure HMAC, no network/API key involved) rather
          // than a hand-rolled fake -- this is the one piece of this route that must be the real
          // thing for the tests to mean anything.
          webhooks: Stripe.webhooks,
          subscriptions:
            overrides.subscriptionsClient?.subscriptions ??
            fakeStripeSubscriptionsClient().client.subscriptions,
        },
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

  it('accepts a correctly signed payload, verifies it, retrieves the subscription, and projects it', async () => {
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_ok_1',
          fakeStripeSubscription({
            id: 'sub_ok_1',
            customerId: 'cus_ok_1',
            metadata: { userId: 'user-ok' },
            status: 'active',
            priceId: 'price_ok',
          }),
        ],
      ]),
    );
    const { app, store } = await buildWebhookApp({ subscriptionsClient: client });
    const payload = JSON.stringify({
      id: 'evt_ok_1',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: { object: { id: 'sub_ok_1' } },
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
      data: { object: { id: 'sub_x' } },
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
      data: { object: { id: 'sub_y' } },
    });
    const signatureHeader = sign(originalPayload);
    const tamperedPayload = originalPayload.replace('sub_y', 'sub_attacker');
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signatureHeader },
      payload: tamperedPayload,
    });
    expect(response.statusCode).toBe(400);
    await expect(store.getSubscriptionForUser('user-y')).resolves.toBeUndefined();
  });

  it('rejects a correctly signed payload whose timestamp is outside the tolerance window', async () => {
    const { app, store } = await buildWebhookApp();
    const payload = JSON.stringify({
      id: 'evt_stale',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: { object: { id: 'sub_z' } },
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
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_dup',
          fakeStripeSubscription({
            id: 'sub_dup',
            metadata: { userId: 'user-dup' },
            status: 'active',
          }),
        ],
      ]),
    );
    const { app, store } = await buildWebhookApp({ subscriptionsClient: client });
    const payload = JSON.stringify({
      id: 'evt_dup_1',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: { object: { id: 'sub_dup' } },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
      payload,
    });
    // Same event.id, re-delivered verbatim -- standing in for Stripe's own retry/redelivery.
    const second = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
      payload,
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

  // The retrieval-failure policy end to end: a transient Stripe API failure must surface as a
  // 500 (so Stripe retries) rather than a 200, and the retry must be able to succeed once Stripe
  // is reachable again -- proof that the failed attempt left no row in the processed-events
  // ledger blocking it.
  it('returns 500 when the retrieval fails, and a subsequent retry with the same event.id still applies', async () => {
    const failingClient = fakeStripeSubscriptionsClient(
      new Map([['sub_flaky', new Error('simulated Stripe outage')]]),
    ).client;
    const { app, store } = await buildWebhookApp({ subscriptionsClient: failingClient });
    const payload = JSON.stringify({
      id: 'evt_flaky_retry',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: { object: { id: 'sub_flaky' } },
    });

    const firstAttempt = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
      payload,
    });
    expect(firstAttempt.statusCode).toBe(500);
    await expect(store.getSubscriptionForUser('user-flaky')).resolves.toBeUndefined();

    // Stripe retries the identical event.id once the API is reachable again.
    const { app: retryApp, store: retryStore } = await buildWebhookApp({
      subscriptionsClient: fakeStripeSubscriptionsClient(
        new Map([
          [
            'sub_flaky',
            fakeStripeSubscription({
              id: 'sub_flaky',
              metadata: { userId: 'user-flaky' },
              status: 'active',
            }),
          ],
        ]),
      ).client,
    });
    const retryResponse = await retryApp.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
      payload,
    });
    expect(retryResponse.statusCode).toBe(200);
    await expect(retryStore.getSubscriptionForUser('user-flaky')).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('rejects a request from an IP outside the configured allowlist before it can be projected', async () => {
    const { app, store } = await buildWebhookApp({ ipAllowlist: { isAllowed: () => false } });
    const payload = JSON.stringify({
      id: 'evt_ip_rejected',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: { object: { id: 'sub_ip' } },
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
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_ip2',
          fakeStripeSubscription({
            id: 'sub_ip2',
            metadata: { userId: 'user-ip2' },
            status: 'active',
          }),
        ],
      ]),
    );
    const { app, store } = await buildWebhookApp({
      ipAllowlist: { isAllowed: (ip) => ip === '203.0.113.9' },
      subscriptionsClient: client,
    });
    const payload = JSON.stringify({
      id: 'evt_ip_allowed',
      type: 'customer.subscription.created',
      created: 1_700_000_000,
      data: { object: { id: 'sub_ip2' } },
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
    const { client } = fakeStripeSubscriptionsClient(
      new Map([
        [
          'sub_scope',
          fakeStripeSubscription({
            id: 'sub_scope',
            metadata: { userId: 'user-scope' },
            status: 'active',
          }),
        ],
      ]),
    );
    const { app } = await buildWebhookApp({ subscriptionsClient: client });
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
      data: { object: { id: 'sub_scope' } },
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
