import Stripe from 'stripe';

/**
 * Pinned explicitly rather than left to the SDK's own default. `stripe@22.4.0`'s installed
 * default (`esm/apiVersion.js`) happens to already be this value, but pinning it here means a
 * future SDK upgrade that changes its default cannot silently change the shape of every webhook
 * payload this process parses -- that would only happen through a deliberate edit to this
 * constant, reviewed alongside the API version's own migration notes.
 */
export const STRIPE_API_VERSION = '2026-07-29.dahlia';

/**
 * Constructs one `Stripe` client instance from an already-validated secret. Never a bare
 * `Stripe.setApiKey`/global-singleton pattern -- current Stripe guidance across its SDKs is to
 * instantiate a client, not configure a process-wide default, and a single instance built once
 * at startup (see server.ts) is cheap to hold for the life of the process.
 *
 * Takes the raw secret string, not `ServerEnvironment` or `PersistenceEnvironment`: this module
 * has no reason to know how the key was validated or where it came from, only that it is a
 * non-empty string. The caller is responsible for sourcing it from an environment variable --
 * never a literal -- and this function does not log, echo, or otherwise surface the value it is
 * given.
 *
 * Deliberately indifferent to whether `secretKey` is an unrestricted secret key (`sk_...`) or a
 * restricted key (`rk_...`, required in production per plan.md): both are drop-in Stripe API
 * keys accepted by this same constructor, and this function does not branch on the prefix.
 */
export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
  });
}
