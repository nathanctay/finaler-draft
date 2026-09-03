import { randomInt } from 'node:crypto';
import type Stripe from 'stripe';
import type { SubscriptionStore } from './stripeSubscriptions.js';

export type BillingPlan = 'monthly' | 'annual';

/**
 * Dependencies both `createCheckoutSession` and `createPortalSession` need. `client` is typed
 * down to just the two resources this module calls -- the same narrowing convention `app.ts`'s
 * `StripeWebhookPort` already uses for `client.webhooks` (`Pick<Stripe, 'webhooks'>`), for the
 * identical testing reason: a test can supply a bare object with
 * `checkout.sessions.create`/`billingPortal.sessions.create` stubs instead of a full, real,
 * API-key-bearing `Stripe` instance.
 */
export interface BillingPort {
  client: Pick<Stripe, 'checkout' | 'billingPortal' | 'prices'>;
  store: Pick<SubscriptionStore, 'getSubscriptionForUser'>;
  priceIds: { monthly: string; annual: string };
  /**
   * The public origin `success_url`/`cancel_url`/Portal `return_url` are built against.
   * `server.ts` resolves this the same way `auth.ts`'s `trustedOrigins` and `apps/web/src/api.ts`'s
   * `appUrl` already do: `CLIENT_ORIGIN` in local development, where the SPA (:5173) and the API
   * (:3001) are different origins, or `BETTER_AUTH_URL` otherwise, since the same process serves
   * both in every deployed environment.
   */
  appOrigin: string;
}

const LOWERCASE_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function randomLetters(length: number): string {
  let letters = '';
  for (let index = 0; index < length; index += 1) {
    letters += LOWERCASE_LETTERS[randomInt(LOWERCASE_LETTERS.length)];
  }
  return letters;
}

/**
 * Stripe's `integration_identifier` (this slice's brief: "a stable label ... with a suffix of 8
 * random letters, for comparing checkout flows in the Dashboard"). Computed once, at module load
 * -- deliberately not once per session. "Stable" is the point: every Checkout Session this
 * process ever creates carries the identical value, which is what lets the Dashboard group and
 * compare this integration's sessions as a single flow. A fresh random suffix on every session
 * would defeat that (nothing would group together); the random suffix exists only so a
 * descriptive label like "finaler-draft-checkout" cannot collide with another Stripe user's
 * integration that happened to choose the same descriptive name.
 */
export const CHECKOUT_INTEGRATION_IDENTIFIER = `finaler-draft-checkout-${randomLetters(8)}`;

/**
 * Pure parameter construction, kept apart from the network call so unit tests can assert on the
 * exact object handed to Stripe without mocking a client -- see `stripeCheckout.test.ts`'s
 * mode/price/metadata/automatic_tax/integration_identifier assertions and, just as important, its
 * assertions that `payment_method_types` and `trial_period_days` are *absent* from the built
 * object, not merely falsy.
 *
 * Deliberately never sets `payment_method_types`: plan.md and this slice's brief are both explicit
 * that omitting it enables Stripe's Dashboard-configured dynamic payment methods, while hardcoding
 * `['card']` silently disables every other method and costs conversion -- the single most repeated
 * warning in Stripe's own current guidance. Deliberately never sets `trial_period_days` either:
 * this slice's brief is equally explicit that there is no trial, because the free tier (one fully
 * editable screenplay, see `entitlements.ts`) is the trial by design.
 *
 * `metadata.userId` is set both at the top level (on the Checkout Session itself) and inside
 * `subscription_data.metadata` (copied onto the Subscription object Checkout creates). This is
 * deliberate, not redundant: `progress/billing-webhook.md` records the seam this slice closes --
 * the webhook can only resolve a Stripe customer to a Better Auth user by reading
 * `subscription.metadata.userId`, the field on the *Subscription*, since `customer.subscription.*`
 * events never carry the originating Checkout Session's own metadata. Setting it on the Session
 * too costs nothing and is independently useful (a Checkout Session and its own events are then
 * also traceable to a user, e.g. for support lookups, without waiting for the subscription to
 * exist).
 *
 * `customer_update` is deliberately never set. This slice's brief lays out the choice explicitly:
 * for an existing customer, Checkout uses the address already on file unless `customer_update: {
 * address: 'auto' }` is set *and* Checkout is made to collect a fresh one. There is no product
 * reason here to prefer a freshly-typed address over the one already on record, so the simpler
 * default -- use what's saved -- is kept. For a brand-new customer, `billing_address_collection`
 * is likewise left unset (Checkout's own `auto` default) rather than forced to `'required'`: tax
 * calculation gets whatever address it needs without adding friction to a first checkout.
 */
export function buildCheckoutSessionParams(input: {
  userId: string;
  priceId: string;
  existingCustomerId: string | undefined;
  successUrl: string;
  cancelUrl: string;
  integrationIdentifier: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    mode: 'subscription',
    line_items: [{ price: input.priceId, quantity: 1 }],
    automatic_tax: { enabled: true },
    integration_identifier: input.integrationIdentifier,
    metadata: { userId: input.userId },
    subscription_data: { metadata: { userId: input.userId } },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    ...(input.existingCustomerId ? { customer: input.existingCustomerId } : {}),
  };
}

/**
 * Creates a Checkout Session for `userId`. Reuses an existing Stripe customer id from the
 * `subscriptions` projection when one is already on record -- a lapsed or canceled account
 * resubscribing, most commonly -- rather than letting Stripe mint a duplicate customer on every
 * checkout, per this slice's brief. A user with no subscription row at all (never subscribed)
 * gets no `customer` param, so Stripe creates a fresh customer and Checkout collects whatever it
 * needs directly from them.
 *
 * Deliberately does not, and must not, write anything to `store` or any other persistence: this
 * is the seam plan.md calls out by name -- "the Checkout success redirect is not proof of
 * payment" -- so creating a session (which is all a client reaching `/billing/success` on its own
 * has necessarily caused) can never itself grant entitlement. Only `stripeWebhook.ts`'s
 * `dispatchStripeEvent`, processing a signature-verified event, ever writes the `subscriptions`
 * table.
 */
export async function createCheckoutSession(
  port: BillingPort,
  userId: string,
  plan: BillingPlan,
): Promise<{ url: string }> {
  const existing = await port.store.getSubscriptionForUser(userId);
  const priceId = plan === 'monthly' ? port.priceIds.monthly : port.priceIds.annual;
  const params = buildCheckoutSessionParams({
    userId,
    priceId,
    existingCustomerId: existing?.stripeCustomerId,
    successUrl: `${port.appOrigin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${port.appOrigin}/billing/canceled`,
    integrationIdentifier: CHECKOUT_INTEGRATION_IDENTIFIER,
  });
  const session = await port.client.checkout.sessions.create(params);
  if (!session.url) {
    // Not expected in normal operation -- Stripe returns a hosted-page URL for every
    // `mode: 'subscription'` session this function builds (no `ui_mode: 'embedded_page'` or
    // `'elements'`, the only cases where the API contract allows a null `url`). Thrown rather than
    // silently returning an unusable empty string: app.ts's route has no sensible fallback either.
    throw new Error('Stripe did not return a Checkout Session URL.');
  }
  return { url: session.url };
}

export type PortalSessionResult = { outcome: 'created'; url: string } | { outcome: 'no-customer' };

/**
 * The Customer Portal session for managing an existing subscription. plan.md: "Do not hand-build
 * subscription management UI; the Portal replaces a large amount of surface we would otherwise
 * own and test." `'no-customer'` covers the account that has never subscribed -- there is nothing
 * to manage yet -- and the caller (app.ts) reports that as 404 rather than asking Stripe for a
 * Portal session against a customer id that does not exist.
 */
export async function createPortalSession(
  port: BillingPort,
  userId: string,
): Promise<PortalSessionResult> {
  const existing = await port.store.getSubscriptionForUser(userId);
  if (!existing) return { outcome: 'no-customer' };
  const session = await port.client.billingPortal.sessions.create({
    customer: existing.stripeCustomerId,
    return_url: `${port.appOrigin}/projects`,
  });
  return { outcome: 'created', url: session.url };
}

export interface PlanPrice {
  /** The unit price in the smallest unit of `currency` (e.g. cents for USD), matching Stripe's
   * own `unit_amount` convention exactly -- never converted to a float here, so no rounding error
   * can creep in before the client formats it for display. */
  amount: number;
  currency: string;
  /** `null` for a price with no `recurring` object (not expected for either configured plan
   * price, but the type is honest about what Stripe actually allows rather than asserting it
   * away). */
  interval: string | null;
}

function describePlanPrice(price: Stripe.Price): PlanPrice {
  return {
    amount: price.unit_amount ?? 0,
    currency: price.currency,
    interval: price.recurring?.interval ?? null,
  };
}

/**
 * Real Stripe amounts for the two configured plan prices -- the Manage Subscription page's pricing
 * cards need the actual monthly/annual amounts to show a price and to derive the annual saving
 * honestly (this slice's brief: "derive it from the actual price data rather than hardcoding a
 * percentage -- the prices are configuration, not constants"). This is the one place this
 * integration reads Stripe's *catalog* (Prices), as distinct from Checkout/Portal session
 * creation or the `subscriptions` projection the webhook keeps current -- still server-side only;
 * plan.md's "never read Stripe directly from the client" is unaffected, since the client only ever
 * sees this route's own narrow, derived response.
 *
 * Deliberately uncached: this route is visited rarely (a billing-management page, not a hot path
 * like the project list), and Stripe Price objects for an established subscription product change
 * essentially never, so the cost of two `retrieve` calls per visit is a reasonable, simple default
 * -- a short-TTL cache would be a reasonable addition if traffic to this page ever made it worth
 * one, not a correctness requirement of this slice.
 */
export async function fetchBillingPlans(
  port: BillingPort,
): Promise<{ monthly: PlanPrice; annual: PlanPrice }> {
  const [monthly, annual] = await Promise.all([
    port.client.prices.retrieve(port.priceIds.monthly),
    port.client.prices.retrieve(port.priceIds.annual),
  ]);
  return { monthly: describePlanPrice(monthly), annual: describePlanPrice(annual) };
}
