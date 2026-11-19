import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailPort } from './mail.js';

const createDatabase = vi.fn();
const drizzleAdapter = vi.fn();
const betterAuth = vi.fn();
// A minimal stand-in for Better Auth's real `APIError`, matching only what
// `refusePendingSessionForDeletedAccount` calls (`APIError.from(status, { message, code })`) --
// the production code imports the real class from `better-auth`, which this file mocks wholesale,
// so the mock has to provide something under the same name or the import resolves to `undefined`
// and the hook under test would throw `TypeError: Cannot read properties of undefined` instead of
// the error it is actually supposed to throw. Constructing a real `Error` (not a bare object) is
// what lets `.rejects.toThrow(...)` assertions below work the normal way.
const APIError = {
  from: vi.fn((status: string, error: { message: string; code?: string }) =>
    Object.assign(new Error(error.message), { status, code: error.code }),
  ),
};

vi.mock('@finaler-draft/database', () => ({ createDatabase, schema: { marker: 'schema' } }));
vi.mock('@better-auth/drizzle-adapter', () => ({ drizzleAdapter }));
vi.mock('better-auth', () => ({ betterAuth, APIError }));

const { createAuth } = await import('./index.js');

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
        // The Manage account page's email change (progress/manage-account-page.md):
        // `updateEmailWithoutVerification` and `sendChangeEmailConfirmation` are deliberately
        // absent, not merely falsy -- see this call site's own comment for why their absence,
        // not a `false` here, is what makes the verification-first path the only one Better
        // Auth's installed `changeEmail` handler can reach.
        user: { changeEmail: { enabled: true } },
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

  it('sends verification on sign-up but never automatically on a rejected sign-in', () => {
    // `sendOnSignIn` was `true` when this slice first landed, making "try signing in again" the
    // way to get a fresh link. It also meant every further attempt sent another email, so a
    // visitor who did not verify promptly accumulated them. The owner asked for an explicit
    // affordance instead, and sign-in.tsx now offers one on both stuck states -- so the automatic
    // send is off, and this assertion pins that rather than the behaviour it replaced.
    createAuth(environment, { mail });
    const options = betterAuth.mock.calls[0]![0];
    expect(options.emailVerification).toMatchObject({ sendOnSignUp: true, sendOnSignIn: false });
  });

  describe('databaseHooks.session.create.before (account-deletion sign-in gate)', () => {
    // Overrides the top-level `beforeEach`'s `pool: { marker: 'pool' }` with something that
    // actually answers `.query` -- the top-level fixture is intentionally opaque (it only needs
    // to be *passed through* for the other tests in this file), but this hook calls `pool.query`
    // directly, so these tests need a pool that can be told what to return.
    function capturedHook(queryResult: { rows: Array<{ deletedAt: string | null }> }) {
      const query = vi.fn().mockResolvedValue(queryResult);
      createDatabase.mockReturnValue({ database: { marker: 'database' }, pool: { query } });
      createAuth(environment, { mail });
      const options = betterAuth.mock.calls[0]![0];
      const before = options.databaseHooks.session.create.before as (session: {
        userId: string;
      }) => Promise<void>;
      return { before, query };
    }

    it('refuses to create a session for a soft-deleted account', async () => {
      const { before, query } = capturedHook({ rows: [{ deletedAt: '2026-01-01T00:00:00.000Z' }] });

      await expect(before({ userId: 'user-deleted' })).rejects.toThrow(
        'This account has been deleted.',
      );
      expect(APIError.from).toHaveBeenCalledWith('FORBIDDEN', {
        message: 'This account has been deleted.',
        code: 'ACCOUNT_DELETED',
      });
      expect(query).toHaveBeenCalledWith(
        'select deleted_at as "deletedAt" from "user" where id = $1',
        ['user-deleted'],
      );
    });

    it('allows a session to be created for an account that has not been deleted', async () => {
      const { before } = capturedHook({ rows: [{ deletedAt: null }] });

      await expect(before({ userId: 'user-active' })).resolves.toBeUndefined();
      expect(APIError.from).not.toHaveBeenCalled();
    });

    it('allows session creation when no matching user row is found', async () => {
      // Defensive only -- `session.user_id` is a foreign key into `user`, so a session row with
      // no corresponding user should not exist in practice. Refusing here on a genuinely
      // unmatched id would be the wrong failure mode (nothing to protect; `user_id`'s own foreign
      // key is what guards that), so an empty result is treated the same as "not deleted."
      const { before } = capturedHook({ rows: [] });

      await expect(before({ userId: 'user-unknown' })).resolves.toBeUndefined();
      expect(APIError.from).not.toHaveBeenCalled();
    });
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
