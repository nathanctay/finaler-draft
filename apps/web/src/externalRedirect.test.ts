import { describe, expect, it } from 'vitest';
import { redirectToExternalUrl } from './externalRedirect.js';

describe('redirectToExternalUrl', () => {
  it('sets window.location.href to the given url', () => {
    // jsdom does not implement real navigation (this module's own top-of-file comment), so the
    // assertion here is on the assignment itself -- the same `Object.defineProperty` stand-in
    // App.test.tsx already uses for `window.location.reload`.
    const originalLocation = window.location;
    const stubLocation = { href: '' };
    Object.defineProperty(window, 'location', { configurable: true, value: stubLocation });
    try {
      redirectToExternalUrl('https://checkout.stripe.test/cs_test_1');
      expect(stubLocation.href).toBe('https://checkout.stripe.test/cs_test_1');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
  });
});
