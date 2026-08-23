import { beforeEach, describe, expect, it, vi } from 'vitest';

const createDatabase = vi.fn();
const drizzleAdapter = vi.fn();
const betterAuth = vi.fn();

vi.mock('@finaler-draft/database', () => ({ createDatabase, schema: { marker: 'schema' } }));
vi.mock('@better-auth/drizzle-adapter', () => ({ drizzleAdapter }));
vi.mock('better-auth', () => ({ betterAuth }));

const { createAuth } = await import('./auth.js');

describe('createAuth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createDatabase.mockReturnValue({ database: { marker: 'database' }, pool: { marker: 'pool' } });
    drizzleAdapter.mockReturnValue({ marker: 'adapter' });
    betterAuth.mockReturnValue({ marker: 'auth' });
  });

  it('configures the Drizzle adapter, local auth route, and trusted client origin', () => {
    expect(
      createAuth({
        DATABASE_URL: 'postgresql://localhost/finaler',
        BETTER_AUTH_SECRET: 'x'.repeat(32),
        BETTER_AUTH_URL: 'https://app.example.test',
        CLIENT_ORIGIN: 'https://writer.example.test',
      }),
    ).toEqual({
      auth: { marker: 'auth' },
      database: { marker: 'database' },
      pool: { marker: 'pool' },
      trustedOrigins: ['https://app.example.test', 'https://writer.example.test'],
    });
    expect(drizzleAdapter).toHaveBeenCalledWith(
      { marker: 'database' },
      { provider: 'pg', schema: { marker: 'schema' } },
    );
    expect(betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        basePath: '/api/auth',
        trustedOrigins: ['https://app.example.test', 'https://writer.example.test'],
        advanced: {
          // Railway sends the client's real IP as `X-Real-IP`, not the `X-Forwarded-For` Better
          // Auth's rate limiter reads by default, so without this the rate limiter cannot resolve
          // a per-client IP behind Railway's proxy and falls back to one shared bucket for every
          // client.
          ipAddress: { ipAddressHeaders: ['x-real-ip'] },
          // `BETTER_AUTH_URL` is `https://...` here, so cookies are secure.
          useSecureCookies: true,
          defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: true },
        },
        // Enabled unconditionally (not just in production -- see `CreateAuthOptions.rateLimitEnabled`),
        // and pinned to in-memory storage since this app has no Redis-shaped secondary storage
        // and no `rateLimit` table for the database-backed path.
        rateLimit: { enabled: true, storage: 'memory' },
        emailAndPassword: expect.objectContaining({
          enabled: true,
          minPasswordLength: 12,
          maxPasswordLength: 128,
          requireEmailVerification: false,
        }),
      }),
    );
  });

  it('disables cookie security and forces HTTP-derived cookie attributes when BETTER_AUTH_URL is plain HTTP', () => {
    createAuth({
      DATABASE_URL: 'postgresql://localhost/finaler',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3001',
    });
    expect(betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        advanced: expect.objectContaining({
          useSecureCookies: false,
          defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: false },
        }),
      }),
    );
  });

  it('lets a caller turn the built-in rate limiter back off explicitly, for test fixtures only', () => {
    createAuth(
      {
        DATABASE_URL: 'postgresql://localhost/finaler',
        BETTER_AUTH_SECRET: 'x'.repeat(32),
        BETTER_AUTH_URL: 'https://app.example.test',
      },
      { rateLimitEnabled: false },
    );
    expect(betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimit: { enabled: false, storage: 'memory' } }),
    );
  });

  it('uses only the server origin when no separate client origin is configured', () => {
    const result = createAuth({
      DATABASE_URL: 'postgresql://localhost/finaler',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3001',
    });
    expect(betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({ trustedOrigins: ['http://localhost:3001'] }),
    );
    expect(result.trustedOrigins).toEqual(['http://localhost:3001']);
  });
});
