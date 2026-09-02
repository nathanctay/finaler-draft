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
 * has already happened by the time this function runs (see app.ts's webhook route registration)
 * -- this function trusts `event` completely and is concerned only with which fields of which
 * event types the `subscriptions` projection cares about.
 *
 * plan.md: "Reconcile state from the event's subscription object rather than assuming ordered
 * arrival, and treat customer.subscription.* and invoice.* as the state source." Handled types,
 * per plan.md's minimum list:
 *   - customer.subscription.created / .updated / .deleted: the subscription's own `status`
 *     already reflects "canceled" on a `.deleted` event, so all three route through the same
 *     upsert.
 *   - invoice.paid / invoice.payment_failed: update the existing row's status (and, when the
 *     invoice carries one, its billing period) -- see `recordInvoiceEvent`'s doc comment on why
 *     this is update-only rather than upsert.
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
  event: Stripe.Event,
): Promise<ProcessOutcome> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const item = subscription.items.data[0];
      if (!item) {
        // A subscription with no line items has no price and no billing period to project.
        // Not expected in normal operation (plan.md's model always attaches exactly one price
        // to a subscription); if it ever happens there is nothing usable to write.
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
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeSubscriptionId = readInvoiceSubscriptionId(invoice);
      if (!stripeSubscriptionId) {
        // A one-off invoice not tied to a subscription -- out of scope for this projection.
        return store.recordIgnoredEvent(event.id, event.type);
      }
      const line = invoice.lines.data[0];
      return store.recordInvoiceEvent({
        eventId: event.id,
        eventType: event.type,
        eventCreatedAt: unixSecondsToDate(event.created),
        stripeSubscriptionId,
        status: event.type === 'invoice.paid' ? 'active' : 'past_due',
        currentPeriodEnd: line ? unixSecondsToDate(line.period.end) : null,
      });
    }
    default:
      return store.recordIgnoredEvent(event.id, event.type);
  }
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
