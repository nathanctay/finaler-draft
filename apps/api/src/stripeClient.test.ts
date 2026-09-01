import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { createStripeClient, STRIPE_API_VERSION } from './stripeClient.js';

describe('createStripeClient', () => {
  it('constructs a real Stripe client instance pinned to the documented API version', () => {
    // Obviously-fake test key, never a value resembling a real credential.
    const client = createStripeClient('sk_test_FAKE');
    expect(client).toBeInstanceOf(Stripe);
    expect(client.getApiField('version')).toBe(STRIPE_API_VERSION);
    expect(STRIPE_API_VERSION).toBe('2026-07-29.dahlia');
  });

  it('does not care whether it is handed an unrestricted or a restricted key', () => {
    // Both are structurally just "a Stripe API key" to this constructor -- neither is validated
    // for its prefix, matching plan.md: "the code must not care which it is handed."
    expect(() => createStripeClient('sk_test_FAKE')).not.toThrow();
    expect(() => createStripeClient('rk_test_FAKE')).not.toThrow();
  });
});
