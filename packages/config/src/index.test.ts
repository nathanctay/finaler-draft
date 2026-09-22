import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLLAB_DEV_PORT,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS_MESSAGE,
} from './index.js';

describe('password policy', () => {
  it('publishes the shared password policy for auth clients and the server', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(PASSWORD_REQUIREMENTS_MESSAGE).toBe('Password must be 12–128 characters.');
  });
});

describe('DEFAULT_COLLAB_DEV_PORT', () => {
  it('is a valid port number clear of every other local dev port this monorepo already uses', () => {
    expect(Number.isInteger(DEFAULT_COLLAB_DEV_PORT)).toBe(true);
    expect(DEFAULT_COLLAB_DEV_PORT).toBeGreaterThan(0);
    expect(DEFAULT_COLLAB_DEV_PORT).toBeLessThanOrEqual(65535);
    // apps/api (3001), Vite (5173), the landing app (4321), and the Playwright harnesses
    // (4173-4175) -- see this export's own doc comment for why 1234 (Hocuspocus's own
    // conventional default) was rejected instead of just picking a port clear of those.
    expect([3001, 5173, 4321, 4173, 4174, 4175]).not.toContain(DEFAULT_COLLAB_DEV_PORT);
  });
});
