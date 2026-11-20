import type Stripe from 'stripe';
import type {
  ProcessOutcome,
  SubscriptionStatus,
  SubscriptionStore,
} from './stripeSubscriptions.js';

// Stripe's own `Subscription.Status` type is an open union (it includes `OtherString`, an
// SDK-wide forward-compatibility escape hatch for values Stripe adds after this SDK version was
// published) -- so it is not statically assignable to our closed `SubscriptionStatus`, which the
// `subscription_status` Postgres enum requires be closed. Thrown, not silently coerced or
// dropped: an unrecognized status is a signal this schema is now out of date with Stripe's API,
// and finding out via a loud failure (the event fails, Stripe retries, this shows up in logs) is
// far preferable to a subscription's status quietly going stale forever.
const KNOWN_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
];

function toKnownStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  if ((KNOWN_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) {
    return status as SubscriptionStatus;
  }
  throw new Error(`Received an unrecognized Stripe subscription status: "${status}"`);
}

/**
 * Translates a verified Stripe event into a `SubscriptionStore` write. Signature verification
 * has already happened by the time this function runs (see app.ts's webhook route registration).
 *
 * BIL-1 and BIL-2 (audit/02-billing-and-entitlements.md): this function used to derive state
 * straight from the event payload, guarded by comparing `event.created` against the row's
 * `last_event_created_at`. Both defects traced back to that one design choice -- `created` has
 * one-second resolution, so same-second events raced each other and whichever lost was discarded
 * *and* marked processed (gone for good), and invoice events wrote a guessed `status` that didn't
 * come from the subscription at all. Stripe's own guidance for both
 * (https://docs.stripe.com/webhooks "Event ordering";
 * https://docs.stripe.com/billing/subscriptions/webhooks) is the same fix: treat the event as a
 * signal that something changed, retrieve the subscription from Stripe, and trust only what comes
 * back. `projectSubscription` below is that retrieval, shared by every event type that names a
 * subscription -- a `customer.subscription.*` event's own payload is no more trusted than an
 * `invoice.*` event's guess was; this function reads a subscription id (never a status, price, or
 * period) out of either payload and then reads everything else from the live API response. Once
 * every write comes from the same retrieved object, delivery order stops mattering: whichever
 * retrieval happens to run last against Stripe is, by definition, the current state, regardless
 * of which event triggered it or in what order Stripe delivered several events for the same
 * subscription.
 *
 * A retrieval can fail (network error, Stripe outage, a transient 5xx). That failure is allowed
 * to propagate out of this function uncaught -- app.ts's webhook route does not catch it, so it
 * reaches Fastify's error handler and comes back as a 500. Stripe retries a non-2xx response, and
 * `SubscriptionStore.recordSubscriptionEvent` is never called when retrieval throws, so
 * `stripe_processed_events` gains no row for an event that was never applied. That is the
 * deliberate trade for not rebuilding BIL-1 in a new place: a failed retrieval must look, to
 * Stripe, exactly like this endpoint was never reached at all.
 *
 * Handled types, per plan.md's minimum list:
 *   - customer.subscription.created / .updated / .deleted: all three route through the same
 *     retrieval and upsert -- the subscription's own current `status` already reflects "canceled"
 *     by the time a `.deleted` event's retrieval runs.
 *   - invoice.paid / invoice.payment_failed: no longer write `status` from which event type
 *     arrived. Both are now just a second trigger for the identical retrieval and upsert a
 *     subscription event would cause, keyed by the invoice event's own `id` for dedup.
 * Every other event type is acknowledged (plan.md: "Return 2xx quickly for events you do not
 * handle; do not error on unknown types") without inspecting its payload.
 *
 * Field locations below are current for API version 2026-07-29.dahlia specifically, not for
 * Stripe's API in general -- both moved during this project's lifetime and would silently read
 * `undefined` under an older SDK:
 *   - `Subscription.current_period_end`/`current_period_start` no longer exist on the
 *     subscription itself; they live on each subscription item
 *     (`subscription.items.data[n].current_period_end`). This project only ever creates
 *     single-item subscriptions (plan.md: "Model one Stripe Product per plan tier"), so the
 *     first item is authoritative.
 *   - `Invoice.subscription` no longer exists; the subscription id is at
 *     `invoice.parent.subscription_details.subscription`.
 */
export async function dispatchStripeEvent(
  store: SubscriptionStore,
  client: Pick<Stripe, 'subscriptions'>,
  event: Stripe.Event,
): Promise<ProcessOutcome> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Only the id is read from the payload here -- see this function's module comment for why
      // every other field comes from `projectSubscription`'s own retrieval instead.
      const subscriptionId = (event.data.object as Stripe.Subscription).id;
      return projectSubscription(store, client, event, subscriptionId);
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeSubscriptionId = readInvoiceSubscriptionId(invoice);
      if (!stripeSubscriptionId) {
        // A one-off invoice not tied to a subscription -- out of scope for this projection.
        return store.recordIgnoredEvent(event.id, event.type);
      }
      return projectSubscription(store, client, event, stripeSubscriptionId);
    }
    default:
      return store.recordIgnoredEvent(event.id, event.type);
  }
}

/**
 * Retrieves `stripeSubscriptionId` from Stripe and upserts the store with exactly what comes
 * back, keyed by `event.id`/`event.type` for dedup. This is the one place that calls
 * `client.subscriptions.retrieve` -- both branches of `dispatchStripeEvent` above fall into it, so
 * a `customer.subscription.*` event and an `invoice.*` event for the same subscription write
 * identical state through an identical path.
 */
async function projectSubscription(
  store: SubscriptionStore,
  client: Pick<Stripe, 'subscriptions'>,
  event: Stripe.Event,
  stripeSubscriptionId: string,
): Promise<ProcessOutcome> {
  // Not wrapped in try/catch: a thrown error here is meant to propagate all the way out to
  // app.ts's webhook route and become a 500, per this function's module comment's
  // retrieval-failure policy.
  const subscription = await client.subscriptions.retrieve(stripeSubscriptionId);
  const item = subscription.items.data[0];
  if (!item) {
    // A subscription with no line items has no price and no billing period to project. Not
    // expected in normal operation (plan.md's model always attaches exactly one price to a
    // subscription); if it ever happens there is nothing usable to write.
    return store.recordIgnoredEvent(event.id, event.type);
  }
  return store.recordSubscriptionEvent({
    eventId: event.id,
    eventType: event.type,
    eventCreatedAt: unixSecondsToDate(event.created),
    userId: readUserId(subscription.metadata),
    stripeCustomerId: customerId(subscription.customer),
    stripeSubscriptionId: subscription.id,
    stripePriceId: item.price.id,
    status: toKnownStatus(subscription.status),
    currentPeriodEnd: unixSecondsToDate(item.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: subscription.canceled_at ? unixSecondsToDate(subscription.canceled_at) : null,
  });
}

function unixSecondsToDate(unixSeconds: number): Date {
  return new Date(unixSeconds * 1000);
}

function customerId(customer: Stripe.Subscription['customer']): string {
  return typeof customer === 'string' ? customer : customer.id;
}

function readUserId(metadata: Stripe.Metadata): string | null {
  const value = metadata.userId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const details = invoice.parent?.subscription_details;
  if (!details) return null;
  return typeof details.subscription === 'string' ? details.subscription : details.subscription.id;
}
