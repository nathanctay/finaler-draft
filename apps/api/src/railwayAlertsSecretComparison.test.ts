import type * as CryptoModule from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

/**
 * Isolated in its own file because `vi.mock('node:crypto', ...)` replaces that module for every
 * import *in this file*, for the duration of the file -- there is no way to spy on a single call
 * without doing that (Node's built-in modules are non-configurable in Vitest's ESM runtime: see
 * `railwayAlerts.test.ts`'s own comment on why a direct `vi.spyOn(crypto, 'timingSafeEqual')`
 * there throws "Module namespace is not configurable in ESM"). Keeping the mock confined to this
 * one file means every other test of `secretsMatch`'s actual input/output behavior
 * (`railwayAlerts.test.ts`) runs against the real `node:crypto`, and only this file's narrow
 * question -- *how* the comparison is made, not just whether it is correct -- runs against a
 * wrapped one.
 *
 * This is the test the brief's mutation table calls for directly: "Make the secret comparison
 * `===` instead of constant-time" must fail a test. A black-box test of `secretsMatch`'s return
 * value cannot catch that mutation -- `===` produces the identical booleans `timingSafeEqual`
 * does for every input. Only asserting that `timingSafeEqual` was actually the thing invoked
 * closes that gap.
 */
const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return {
    ...actual,
    timingSafeEqual: (...args: Parameters<typeof actual.timingSafeEqual>) =>
      timingSafeEqualSpy(...args),
  };
});

const { secretsMatch } = await import('./railwayAlerts.js');

describe('secretsMatch (constant-time wiring)', () => {
  it('calls node:crypto.timingSafeEqual to decide a match', () => {
    timingSafeEqualSpy.mockClear();
    expect(secretsMatch('correct-secret', 'correct-secret')).toBe(true);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('calls node:crypto.timingSafeEqual to decide a same-length mismatch, rather than a plain ===', () => {
    timingSafeEqualSpy.mockClear();
    expect(secretsMatch('correct-secret', 'wrong-secrettt')).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('never calls timingSafeEqual for a length mismatch -- the one case it would throw on', () => {
    timingSafeEqualSpy.mockClear();
    expect(secretsMatch('correct-secret', 'short')).toBe(false);
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });
});
