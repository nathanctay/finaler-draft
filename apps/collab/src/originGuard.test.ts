import { describe, expect, it } from 'vitest';
import { isTrustedConnectionOrigin } from './originGuard.js';

/**
 * Written after a mutation test on `authenticateConnection`'s origin check (see
 * progress/collaboration-slice-1.md's mutation-testing section) found that neither this
 * predicate nor the composed `authenticateConnection` function that calls it had any direct
 * test coverage at all -- `authenticate.test.ts` only ever exercised `resolveConnectionAuthorization`,
 * and the integration test's own `connectProvider` helper always attaches a trusted `Origin`, so
 * an untrusted or absent one was never actually driven through either suite. Deleting the origin
 * check entirely (`if (!isTrustedConnectionOrigin(...))` replaced with `if (false)`) passed every
 * existing test unchanged -- exactly the silent regression plan.md's own reasoning for this check
 * exists to prevent (cross-site WebSocket hijacking over a cookie-authenticated handshake). This
 * file and `authenticate.test.ts`'s new `authenticateConnection` block close that gap.
 */
const trustedOrigins = ['http://127.0.0.1:4000', 'https://app.example.test'];

describe('isTrustedConnectionOrigin', () => {
  it('rejects a connection with no Origin header at all', () => {
    expect(isTrustedConnectionOrigin(null, trustedOrigins)).toBe(false);
    expect(isTrustedConnectionOrigin(undefined, trustedOrigins)).toBe(false);
    expect(isTrustedConnectionOrigin('', trustedOrigins)).toBe(false);
  });

  it('rejects an Origin not on the allowlist', () => {
    expect(isTrustedConnectionOrigin('https://evil.example.test', trustedOrigins)).toBe(false);
  });

  it('accepts an Origin exactly on the allowlist', () => {
    expect(isTrustedConnectionOrigin('http://127.0.0.1:4000', trustedOrigins)).toBe(true);
    expect(isTrustedConnectionOrigin('https://app.example.test', trustedOrigins)).toBe(true);
  });

  it('rejects a malformed Origin header instead of throwing', () => {
    expect(isTrustedConnectionOrigin('not a url', trustedOrigins)).toBe(false);
  });

  it('compares the normalised origin, not the raw header string -- a trailing slash or extra path must not defeat the allowlist match', () => {
    expect(isTrustedConnectionOrigin('http://127.0.0.1:4000/', trustedOrigins)).toBe(true);
    expect(isTrustedConnectionOrigin('https://app.example.test/some/path', trustedOrigins)).toBe(
      true,
    );
  });

  it('rejects an origin that only differs from a trusted one by scheme or port', () => {
    expect(isTrustedConnectionOrigin('https://127.0.0.1:4000', trustedOrigins)).toBe(false);
    expect(isTrustedConnectionOrigin('http://127.0.0.1:4001', trustedOrigins)).toBe(false);
  });
});
