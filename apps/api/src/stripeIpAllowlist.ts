/**
 * Defence-in-depth IP allowlisting for the Stripe webhook route (plan.md: "Allowlist Stripe's
 * published IP ranges on the webhook route for defense in depth"). Signature verification
 * (stripeWebhook.ts, via `stripe.webhooks.constructEvent`) is what actually authenticates a
 * webhook request -- an HMAC over the raw body, keyed by the signing secret, that an attacker
 * cannot forge without the secret regardless of source address. This allowlist adds a second,
 * much weaker check on top: it costs an attacker who has somehow obtained the signing secret one
 * extra hurdle (originating from a Stripe-owned address), and rejects accidental or scanner
 * traffic before it is worth computing an HMAC over.
 *
 * A hand-maintained, hardcoded IP list was explicitly ruled out: Stripe's published ranges do
 * change, gives 7 days' notice via its `api-announce` mailing list before doing so
 * (https://docs.stripe.com/ips), and a list frozen into source at deploy time would eventually
 * start rejecting genuine Stripe traffic with no code change to explain why -- exactly the
 * failure mode plan.md warns is worse than having no allowlist at all.
 *
 * Instead this fetches Stripe's own published, machine-readable list
 * (https://docs.stripe.com/ips) on a timer and enforces membership only once that fetch has
 * succeeded at least once. Every failure mode -- the list has never loaded, the network to
 * stripe.com is unreachable, Stripe changes the response shape -- fails open (allows the
 * request through to signature verification) rather than closed. That asymmetry is deliberate:
 * signature verification is the layer this route actually depends on for correctness, so a
 * broken *supplementary* check must never be able to reject a legitimately signed event.
 */

export const STRIPE_WEBHOOK_IPS_URL = 'https://stripe.com/files/ips/ips_webhooks.json';

/**
 * Fetches and parses Stripe's published webhook source-IP list. Talks to the network -- callers
 * that want a fake list for tests should pass a different `fetchIps` into
 * `createStripeIpAllowlist` rather than mocking this function's internals.
 */
export async function fetchStripeWebhookIps(): Promise<readonly string[]> {
  const response = await fetch(STRIPE_WEBHOOK_IPS_URL);
  if (!response.ok) {
    throw new Error(`Stripe webhook IP list request failed with HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const webhooks =
    body !== null && typeof body === 'object' && 'WEBHOOKS' in body
      ? (body as { WEBHOOKS: unknown }).WEBHOOKS
      : undefined;
  if (!Array.isArray(webhooks)) {
    throw new Error('Stripe webhook IP list response did not contain a WEBHOOKS array');
  }
  return webhooks.filter((ip): ip is string => typeof ip === 'string' && ip.length > 0);
}

export interface StripeIpAllowlist {
  /**
   * `true` whenever the request should be allowed to proceed to signature verification: either
   * the address is in the last successfully fetched list, or no list has ever loaded yet (fail
   * open -- see the module comment).
   */
  isAllowed(ip: string): boolean;
  /** Fetches once immediately and replaces the cached list on success; never throws. */
  refresh(): Promise<void>;
  /** Starts the background refresh timer (an initial refresh, then one every interval). */
  start(): void;
  /** Stops the background refresh timer. Safe to call whether or not `start` was ever called. */
  stop(): void;
}

export interface CreateStripeIpAllowlistOptions {
  fetchIps: () => Promise<readonly string[]>;
  /** Defaults to 6 hours: frequent enough that a real Stripe rotation (7 days' notice) is picked
   * up well within its own notice period, infrequent enough that this route makes at most a
   * handful of outbound requests a day. */
  refreshIntervalMs?: number;
  /** Called with the raw error on a failed refresh, for logging. Never called with, and this
   * module never logs, anything from the response body -- only the fact that the fetch failed. */
  onRefreshError?: (error: unknown) => void;
}

export function createStripeIpAllowlist(
  options: CreateStripeIpAllowlistOptions,
): StripeIpAllowlist {
  const refreshIntervalMs = options.refreshIntervalMs ?? 6 * 60 * 60 * 1000;
  let allowed: ReadonlySet<string> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    try {
      const ips = await options.fetchIps();
      allowed = new Set(ips);
    } catch (error) {
      options.onRefreshError?.(error);
      // Deliberately keep whatever was cached before (including `null`, i.e. still-open) -- see
      // the module comment. A transient failure must not clear a previously good list, and must
      // never fabricate an empty one, which would enforce a false "nothing is allowed".
    }
  }

  return {
    isAllowed(ip) {
      if (allowed === null) return true;
      return allowed.has(ip);
    },
    refresh,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), refreshIntervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
