import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStripeIpAllowlist,
  fetchStripeWebhookIps,
  shouldEnforceStripeIpAllowlist,
  STRIPE_WEBHOOK_IPS_URL,
} from './stripeIpAllowlist.js';

describe('createStripeIpAllowlist', () => {
  it('fails open before any refresh has ever succeeded', () => {
    const allowlist = createStripeIpAllowlist({ fetchIps: async () => ['1.2.3.4'] });
    expect(allowlist.isAllowed('203.0.113.1')).toBe(true);
    expect(allowlist.isAllowed('1.2.3.4')).toBe(true);
  });

  it('enforces membership once a refresh has succeeded', async () => {
    const allowlist = createStripeIpAllowlist({ fetchIps: async () => ['3.18.12.63'] });
    await allowlist.refresh();
    expect(allowlist.isAllowed('3.18.12.63')).toBe(true);
    expect(allowlist.isAllowed('203.0.113.1')).toBe(false);
  });

  it('keeps the last known-good list, and stays open if none ever loaded, when a refresh fails', async () => {
    let shouldFail = false;
    const allowlist = createStripeIpAllowlist({
      fetchIps: async () => {
        if (shouldFail) throw new Error('network unreachable');
        return ['3.18.12.63'];
      },
    });
    // Never successfully loaded: a failing first refresh must not enforce an empty list.
    shouldFail = true;
    await allowlist.refresh();
    expect(allowlist.isAllowed('203.0.113.1')).toBe(true);

    // Loads successfully once...
    shouldFail = false;
    await allowlist.refresh();
    expect(allowlist.isAllowed('3.18.12.63')).toBe(true);
    expect(allowlist.isAllowed('203.0.113.1')).toBe(false);

    // ...then a later refresh fails: the previously good list must survive, not be cleared.
    shouldFail = true;
    await allowlist.refresh();
    expect(allowlist.isAllowed('3.18.12.63')).toBe(true);
    expect(allowlist.isAllowed('203.0.113.1')).toBe(false);
  });

  it('reports refresh failures through onRefreshError without throwing', async () => {
    const onRefreshError = vi.fn();
    const allowlist = createStripeIpAllowlist({
      fetchIps: async () => {
        throw new Error('network unreachable');
      },
      onRefreshError,
    });
    await expect(allowlist.refresh()).resolves.toBeUndefined();
    expect(onRefreshError).toHaveBeenCalledTimes(1);
    expect(onRefreshError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  describe('start/stop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('refreshes immediately on start and again on each interval, until stopped', async () => {
      const fetchIps = vi.fn(async () => ['3.18.12.63']);
      const allowlist = createStripeIpAllowlist({ fetchIps, refreshIntervalMs: 1000 });

      allowlist.start();
      // `start` kicks off the first refresh asynchronously (fire-and-forget) and separately
      // arms the interval; advancing by 0ms flushes the pending refresh's microtasks without
      // reaching the interval's first 1000ms tick.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchIps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchIps).toHaveBeenCalledTimes(2);

      allowlist.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchIps).toHaveBeenCalledTimes(2);
    });

    it('stop is safe to call before start', () => {
      const allowlist = createStripeIpAllowlist({ fetchIps: async () => [] });
      expect(() => allowlist.stop()).not.toThrow();
    });
  });
});

describe('fetchStripeWebhookIps', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('requests the published Stripe webhook IP list and returns its WEBHOOKS array', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(STRIPE_WEBHOOK_IPS_URL);
      return new Response(JSON.stringify({ WEBHOOKS: ['3.18.12.63', '3.130.192.231'] }), {
        status: 200,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(fetchStripeWebhookIps()).resolves.toEqual(['3.18.12.63', '3.130.192.231']);
  });

  it('throws on a non-OK HTTP response rather than silently returning an empty list', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('', { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(fetchStripeWebhookIps()).rejects.toThrow(/503/);
  });

  it('throws when the response is missing the expected WEBHOOKS array', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchStripeWebhookIps()).rejects.toThrow(/WEBHOOKS/);
  });
});

// Regression coverage for a real incident: `stripe listen` (the standard local-development tool
// for receiving real Stripe events) forwards from localhost, never a Stripe-owned address, so
// enforcing this allowlist outside production rejected the developer's own legitimate webhook
// traffic with a 403 before signature verification -- the actual authentication -- ever ran. See
// `shouldEnforceStripeIpAllowlist`'s own comment for the full incident and the reasoning against
// a loopback-address exemption instead of this explicit environment check.
describe('shouldEnforceStripeIpAllowlist', () => {
  it('enforces in production', () => {
    expect(shouldEnforceStripeIpAllowlist({ nodeEnv: 'production', systemTestMode: false })).toBe(
      true,
    );
  });

  it('does not enforce in development, so a local stripe listen session is never blocked', () => {
    expect(shouldEnforceStripeIpAllowlist({ nodeEnv: 'development', systemTestMode: false })).toBe(
      false,
    );
  });

  it('does not enforce in test mode', () => {
    expect(shouldEnforceStripeIpAllowlist({ nodeEnv: 'test', systemTestMode: false })).toBe(false);
  });

  it('does not enforce in system-test mode even if NODE_ENV were somehow production -- belt and suspenders', () => {
    expect(shouldEnforceStripeIpAllowlist({ nodeEnv: 'production', systemTestMode: true })).toBe(
      false,
    );
  });
});
