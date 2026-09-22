import { DEFAULT_COLLAB_DEV_PORT } from '@finaler-draft/config';
import { describe, expect, it } from 'vitest';
import { requireCollabPersistenceEnvironment, shouldLoadRootEnvironment } from './environment.js';

const validPersistence = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/finaler_draft',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3001',
};

describe('shouldLoadRootEnvironment', () => {
  it('loads local configuration only for unset or development environments', () => {
    expect(shouldLoadRootEnvironment({})).toBe(true);
    expect(shouldLoadRootEnvironment({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldLoadRootEnvironment({ NODE_ENV: 'test' })).toBe(false);
    expect(shouldLoadRootEnvironment({ NODE_ENV: 'production' })).toBe(false);
    expect(shouldLoadRootEnvironment({ FINALER_SYSTEM_TEST: 'true' })).toBe(false);
  });
});

describe('requireCollabPersistenceEnvironment PORT resolution', () => {
  it('falls back to DEFAULT_COLLAB_DEV_PORT in a real local run, clear of the API default of 3001', () => {
    // No NODE_ENV -- the same "unset means development" convention `shouldLoadRootEnvironment`
    // above uses -- and no PORT/COLLAB_PORT: the shape `pnpm dev` sees before this fix, since both
    // `apps/api` and `apps/collab` load the same root `.env`.
    const environment = requireCollabPersistenceEnvironment({ ...validPersistence });
    expect(environment.PORT).toBe(DEFAULT_COLLAB_DEV_PORT);
  });

  it('ignores an ambient PORT shared with apps/api in a real local run', () => {
    // Mirrors `pnpm dev` exactly: both processes load the identical root `.env`, so both see
    // PORT=3001 (the API's own default). Without this fix, `apps/collab` would resolve to the
    // same 3001 and lose the `EADDRINUSE` race against `apps/api`.
    const environment = requireCollabPersistenceEnvironment({
      ...validPersistence,
      NODE_ENV: 'development',
      PORT: '3001',
    });
    expect(environment.PORT).toBe(DEFAULT_COLLAB_DEV_PORT);
  });

  it('honors an explicit COLLAB_PORT override even in a real local run', () => {
    const environment = requireCollabPersistenceEnvironment({
      ...validPersistence,
      NODE_ENV: 'development',
      PORT: '3001',
      COLLAB_PORT: '5000',
    });
    expect(environment.PORT).toBe(5000);
  });

  it('rejects a COLLAB_PORT that is not a valid port number', () => {
    expect(() =>
      requireCollabPersistenceEnvironment({
        ...validPersistence,
        NODE_ENV: 'development',
        COLLAB_PORT: 'not-a-port',
      }),
    ).toThrow(/COLLAB_PORT must be an integer/);
    expect(() =>
      requireCollabPersistenceEnvironment({
        ...validPersistence,
        NODE_ENV: 'development',
        COLLAB_PORT: '0',
      }),
    ).toThrow(/COLLAB_PORT must be an integer/);
    expect(() =>
      requireCollabPersistenceEnvironment({
        ...validPersistence,
        NODE_ENV: 'development',
        COLLAB_PORT: '70000',
      }),
    ).toThrow(/COLLAB_PORT must be an integer/);
  });

  it('honors PORT as given in production, ignoring the development-only default', () => {
    // Railway assigns this service's own PORT directly to its container; that value must win
    // even though it happens to differ from DEFAULT_COLLAB_DEV_PORT.
    const environment = requireCollabPersistenceEnvironment({
      ...validPersistence,
      NODE_ENV: 'production',
      PORT: '8080',
    });
    expect(environment.PORT).toBe(8080);
  });

  it('honors PORT as given in the system-test harness, ignoring the development-only default', () => {
    // playwright.persistence.config.ts's webServer passes PORT=4175 directly to this one process;
    // it must not be overridden by DEFAULT_COLLAB_DEV_PORT.
    const environment = requireCollabPersistenceEnvironment({
      ...validPersistence,
      NODE_ENV: 'test',
      PORT: '4175',
    });
    expect(environment.PORT).toBe(4175);
  });

  it('falls back to the shared server-config default of 3001 in production with no PORT set', () => {
    // Should never happen against real Railway config (PORT is always injected), but this
    // documents that production never silently substitutes DEFAULT_COLLAB_DEV_PORT.
    const environment = requireCollabPersistenceEnvironment({
      ...validPersistence,
      NODE_ENV: 'production',
    });
    expect(environment.PORT).toBe(3001);
  });
});
