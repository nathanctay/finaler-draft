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
    });
    expect(drizzleAdapter).toHaveBeenCalledWith(
      { marker: 'database' },
      { provider: 'pg', schema: { marker: 'schema' } },
    );
    expect(betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        basePath: '/api/auth',
        trustedOrigins: ['https://app.example.test', 'https://writer.example.test'],
        emailAndPassword: expect.objectContaining({
          enabled: true,
          minPasswordLength: 12,
          maxPasswordLength: 128,
          requireEmailVerification: false,
        }),
      }),
    );
  });

  it('uses only the server origin when no separate client origin is configured', () => {
    createAuth({
      DATABASE_URL: 'postgresql://localhost/finaler',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3001',
    });
    expect(betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({ trustedOrigins: ['http://localhost:3001'] }),
    );
  });
});
