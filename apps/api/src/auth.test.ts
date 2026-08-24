import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailPort } from './mail.js';

const createDatabase = vi.fn();
const drizzleAdapter = vi.fn();
const betterAuth = vi.fn();

vi.mock('@finaler-draft/database', () => ({ createDatabase, schema: { marker: 'schema' } }));
vi.mock('@better-auth/drizzle-adapter', () => ({ drizzleAdapter }));
vi.mock('better-auth', () => ({ betterAuth }));

const { createAuth } = await import('./auth.js');

const environment = {
  DATABASE_URL: 'postgresql://localhost/finaler',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'https://app.example.test',
  CLIENT_ORIGIN: 'https://writer.example.test',
};

describe('createAuth', () => {
  let mail: MailPort;

  beforeEach(() => {
    vi.resetAllMocks();
    createDatabase.mockReturnValue({ database: { marker: 'database' }, pool: { marker: 'pool' } });
    drizzleAdapter.mockReturnValue({ marker: 'adapter' });
    betterAuth.mockReturnValue({ marker: 'auth' });
    mail = { send: vi.fn().mockResolvedValue(undefined) };
  });

  it('configures the Drizzle adapter, local auth route, and trusted client origin', () => {
    expect(createAuth(environment, { mail })).toEqual({
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
          // New accounts require verification; existing accounts were backfilled as verified in
          // the migration that ships with this (see the ruling in
          // progress/transactional-email.md), so this cannot be `false` any more.
          requireEmailVerification: true,
        }),
      }),
    );
  });

  it('disables cookie security and forces HTTP-derived cookie attributes when BETTER_AUTH_URL is plain HTTP', () => {
    createAuth(
      {
        DATABASE_URL: 'postgresql://localhost/finaler',
        BETTER_AUTH_SECRET: 'x'.repeat(32),
        BETTER_AUTH_URL: 'http://localhost:3001',
      },
      { mail },
    );
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
      { mail, rateLimitEnabled: false },
    );
    expect(betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimit: { enabled: false, storage: 'memory' } }),
    );
  });

  it('uses only the server origin when no separate client origin is configured', () => {
    const result = createAuth(
      {
        DATABASE_URL: 'postgresql://localhost/finaler',
        BETTER_AUTH_SECRET: 'x'.repeat(32),
        BETTER_AUTH_URL: 'http://localhost:3001',
      },
      { mail },
    );
    expect(betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({ trustedOrigins: ['http://localhost:3001'] }),
    );
    expect(result.trustedOrigins).toEqual(['http://localhost:3001']);
  });

  it('configures verification to be sent on both sign-up and a sign-in attempt against an unverified account', () => {
    createAuth(environment, { mail });
    const options = betterAuth.mock.calls[0]![0];
    expect(options.emailVerification).toMatchObject({ sendOnSignUp: true, sendOnSignIn: true });
  });

  describe('sendResetPassword', () => {
    function capturedCallback() {
      createAuth(environment, { mail });
      const options = betterAuth.mock.calls[0]![0];
      return options.emailAndPassword.sendResetPassword as (data: {
        user: { email: string };
        url: string;
      }) => Promise<void>;
    }

    it('sends a message to the requesting user containing the reset URL', async () => {
      const sendResetPassword = capturedCallback();
      await sendResetPassword({
        user: { email: 'writer@example.test' },
        url: 'https://app.example.test/api/auth/reset-password/abc123?callbackURL=%2Freset-password',
      });
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'writer@example.test',
          subject: expect.stringContaining('password'),
          text: expect.stringContaining(
            'https://app.example.test/api/auth/reset-password/abc123?callbackURL=%2Freset-password',
          ),
        }),
      );
    });

    it('logs a structured failure and rethrows when the mail port rejects, rather than swallowing the error here', async () => {
      const failure = new Error('Resend is down');
      (mail.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failure);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const sendResetPassword = capturedCallback();

      await expect(
        sendResetPassword({ user: { email: 'writer@example.test' }, url: 'https://x/y' }),
      ).rejects.toThrow('Resend is down');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(logged).toEqual({
        event: 'password_reset_email_failed',
        to: 'writer@example.test',
        error: 'Resend is down',
      });
      errorSpy.mockRestore();
    });

    it('stringifies a non-Error rejection rather than losing its content to an implicit conversion', async () => {
      (mail.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce('rate limited');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const sendResetPassword = capturedCallback();

      await expect(
        sendResetPassword({ user: { email: 'writer@example.test' }, url: 'https://x/y' }),
      ).rejects.toBe('rate limited');

      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(logged.error).toBe('rate limited');
      errorSpy.mockRestore();
    });
  });

  describe('sendVerificationEmail', () => {
    function capturedCallback() {
      createAuth(environment, { mail });
      const options = betterAuth.mock.calls[0]![0];
      return options.emailVerification.sendVerificationEmail as (data: {
        user: { email: string };
        url: string;
      }) => Promise<void>;
    }

    it('sends a message to the account being verified containing the verification URL', async () => {
      const sendVerificationEmail = capturedCallback();
      await sendVerificationEmail({
        user: { email: 'newwriter@example.test' },
        url: 'https://app.example.test/api/auth/verify-email?token=abc&callbackURL=%2Fverify-email',
      });
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'newwriter@example.test',
          subject: expect.stringContaining('Verify'),
          text: expect.stringContaining(
            'https://app.example.test/api/auth/verify-email?token=abc&callbackURL=%2Fverify-email',
          ),
        }),
      );
    });

    it('logs a structured failure and rethrows when the mail port rejects', async () => {
      const failure = new Error('Resend is down');
      (mail.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failure);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const sendVerificationEmail = capturedCallback();

      await expect(
        sendVerificationEmail({ user: { email: 'newwriter@example.test' }, url: 'https://x/y' }),
      ).rejects.toThrow('Resend is down');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(logged).toEqual({
        event: 'verification_email_failed',
        to: 'newwriter@example.test',
        error: 'Resend is down',
      });
      errorSpy.mockRestore();
    });
  });
});
