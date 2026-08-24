import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@finaler-draft/config';
import { createDatabase, schema } from '@finaler-draft/database';
import type { MailMessage, MailPort } from './mail.js';

export interface AuthEnvironment {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  CLIENT_ORIGIN?: string | undefined;
  DATABASE_URL: string;
}

export interface CreateAuthOptions {
  mail: MailPort;
  /**
   * Better Auth's own `rateLimit.enabled` defaults to `options.rateLimit?.enabled ?? isProduction`
   * (confirmed against the installed 1.6.25 source, `create-context.mjs`) -- correct in
   * production by luck of that fallback, not by a decision recorded anywhere, so this function
   * pins it to `true` unconditionally instead (plan.md: "Apply rate limiting to authentication
   * endpoints ... This is foundation work, not pre-launch work: credential stuffing is live the
   * moment the service is reachable" -- that is just as true against a staging or dev deployment
   * as production).
   *
   * The one place that always-on default needs to be turned back off is test fixtures: the
   * integration suite's shared `beforeAll` instance signs up and signs in dozens of unrelated
   * users to set up fixtures for tests that have nothing to do with rate limiting, all from the
   * same loopback address, and would trip Better Auth's built-in 3-requests-per-10-seconds
   * sign-in/sign-up rule long before any of them ran. Rather than threading that through an
   * environment variable -- there is no deployment scenario where this should ever be off in a
   * real environment, so it is not configuration -- it is a plain constructor override that the
   * test file needing it sets explicitly at its own call site (see
   * persistence.integration.test.ts), while a dedicated test builds its own instance with the
   * real, enabled-by-default behavior to prove a fourth rapid sign-in is actually refused.
   */
  rateLimitEnabled?: boolean;
}

/**
 * Sends through `mail` and, on failure, logs a structured line before rethrowing -- deliberately
 * not left to Better Auth's own `runInBackgroundOrAwait` (the mechanism both
 * `/request-password-reset` and the sign-up-triggered verification send use to invoke this
 * callback; confirmed by reading the installed `better-auth` package's
 * `api/routes/password.mjs`, `api/routes/sign-up.mjs`, and `context/create-context.mjs`).
 * Without a configured `advanced.backgroundTasks.handler` -- this project has none --
 * `runInBackgroundOrAwait`'s default implementation is `try { await promise } catch (e) {
 * logger.error(...) }`: it catches and only logs, it never rethrows into the route handler. That
 * is deliberate on Better Auth's part, not a bug: `/request-password-reset` always answers with
 * the same generic "if this email exists..." message so the response itself can never reveal
 * whether an address is registered, and letting a send failure flip that response to an error
 * would leak exactly that. This wrapper cannot change that HTTP-level behaviour and does not try
 * to -- weakening the anti-enumeration response to make a failure "louder" would be the wrong
 * trade to make unilaterally. What it guarantees is a structured, greppable log line
 * (`password_reset_email_failed` / `verification_email_failed`) distinct from Better Auth's own
 * generic logger call, so a Resend outage on the single most important flow in this slice
 * (plan.md: "until this exists there is no account recovery path at all") is loud in production
 * logs even though the client-visible response stays generic.
 */
function sendOrLogFailure(mail: MailPort, event: string, message: MailMessage): Promise<void> {
  return mail.send(message).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event,
        to: message.to,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  });
}

export function createAuth(environment: AuthEnvironment, dependencies: CreateAuthOptions) {
  const { database, pool } = createDatabase(environment.DATABASE_URL);
  // Computed once and handed back to the caller (see server.ts) rather than recomputed there:
  // this is the exact same allowlist app.ts's origin guard needs to enforce (see the
  // `isTrustedOrigin` comment in app.ts), and Better Auth's own cross-origin request handling
  // needs to agree with it byte-for-byte, so there is exactly one place this list is built.
  const trustedOrigins = [
    environment.BETTER_AUTH_URL,
    ...(environment.CLIENT_ORIGIN ? [environment.CLIENT_ORIGIN] : []),
  ];
  // Better Auth derives the session cookie's `Secure` attribute (and its `__Secure-` name
  // prefix) from `baseURL` when `advanced.useSecureCookies` is left unset (reading the installed
  // `cookies/index.mjs`: true when `baseURL` starts with `https://`, false otherwise, falling
  // back to `isProduction` only when `baseURL` isn't a plain string). That already resolves
  // correctly here -- `requirePersistenceEnvironment` (packages/server-config) forces
  // `BETTER_AUTH_URL` to HTTPS in production -- but only because of two layers of inference this
  // function does not control. Computed and passed explicitly instead, so an upgrade that changes
  // either fallback cannot silently change cookie security out from under this app.
  const useSecureCookies = environment.BETTER_AUTH_URL.startsWith('https://');
  const auth = betterAuth({
    database: drizzleAdapter(database, { provider: 'pg', schema }),
    baseURL: environment.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins,
    advanced: {
      // Railway's own documentation lists the request headers it adds at the edge --
      // `X-Real-IP`, `X-Forwarded-Proto`, `X-Forwarded-Host` -- and `X-Forwarded-For` (what
      // Better Auth's rate limiter reads by default, per `DEFAULT_IP_HEADERS` in
      // @better-auth/core's ip.ts) is not among them. Left at the default, every request behind
      // Railway's proxy resolves to no IP at all, and the rate limiter's own fallback (confirmed
      // in the same source) is a single shared bucket per path for every client combined, meaning
      // one abusive client can exhaust the limit and lock out every legitimate user. Pointing
      // this at the header Railway actually sends restores per-client rate limiting.
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
      useSecureCookies,
      // `httpOnly: true` and `sameSite: 'lax'` already match Better Auth's own defaults (same
      // source), so this changes nothing about how the app behaves today -- but a default that
      // happens to be right is not a decision, and won't survive an upgrade that quietly changes
      // it. `secure` is included too, redundantly with `useSecureCookies` above (which also
      // controls the `__Secure-` cookie-name prefix, so it stays the single source of truth for
      // that), purely so all three of plan.md's required attributes are visibly pinned together
      // in one place rather than split across two options.
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: useSecureCookies },
    },
    rateLimit: {
      enabled: dependencies.rateLimitEnabled ?? true,
      // Better Auth 1.6.25 only ships a working `'memory'` and `'secondary-storage'` backend.
      // The type also permits `'database'`, but reading the installed rate-limiter source shows
      // that path (`createDatabaseStorageWrapper`) reads and writes a `rateLimit` model through
      // the configured adapter -- and this app's Drizzle schema (`@finaler-draft/database`)
      // defines no such table, so selecting it would fail the first time it ran, not degrade
      // gracefully. `'secondary-storage'` needs a Redis-shaped adapter (`get`/`set`/`increment`)
      // this infrastructure does not have. `audit/pushbacks.md` (D1/SEC-1) reached the same
      // conclusion independently and confirmed via Railway's own API that this app has never run
      // more than one instance, so per-process memory is not silently under-enforcing anything
      // today. Recorded as a known limitation rather than left to be discovered later: the
      // moment a second app instance exists, in-memory storage means each instance enforces this
      // limit independently, so two instances split traffic across two buckets and silently
      // double the effective limit (three sign-in attempts per instance, not three total) --
      // plan.md already anticipates Redis arriving before a second instance does, which is what
      // `'secondary-storage'` is for when that happens.
      storage: 'memory',
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // Ruling recorded in progress/transactional-email.md: new accounts require verification,
      // and every account that already existed before this change was backfilled to
      // `email_verified = true` in the migration that ships alongside it (see
      // packages/database/drizzle for the backfill and packages/database/src/schema.ts for the
      // column -- it already existed, this only starts enforcing it). Without that backfill,
      // flipping this to `true` would lock out every existing account, including the owner's own,
      // the exact self-inflicted outage the ruling exists to prevent.
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await sendOrLogFailure(dependencies.mail, 'password_reset_email_failed', {
          to: user.email,
          subject: 'Reset your Finaler Draft password',
          text:
            `Someone requested a password reset for this Finaler Draft account. If this was ` +
            `you, set a new password using the link below. It expires in one hour and can only ` +
            `be used once.\n\n${url}\n\n` +
            `If you did not request this, you can safely ignore this email -- your password has ` +
            `not been changed.`,
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sendOrLogFailure(dependencies.mail, 'verification_email_failed', {
          to: user.email,
          subject: 'Verify your Finaler Draft email address',
          text:
            `Confirm this email address to finish setting up your Finaler Draft account. This ` +
            `link expires in one hour.\n\n${url}\n\n` +
            `If you did not create this account, you can safely ignore this email.`,
        });
      },
      // Explicit rather than relying on the installed `sign-up.mjs`'s own fallback (`sendOnSignUp
      // ?? emailAndPassword.requireEmailVerification`, so this would already default to `true`
      // now that the setting above is `true`) -- spelling it out here means a reader doesn't have
      // to trace that fallback through Better Auth's source to know a new account actually gets a
      // verification email, not just a requirement it can never satisfy.
      sendOnSignUp: true,
      // Deliberately off. A rejected sign-in used to resend automatically, which made "try
      // signing in again" the recovery path -- but it also meant every further attempt sent
      // another email, so a visitor who did not verify promptly would accumulate them. The
      // owner asked for an explicit affordance instead, and there now is one: sign-in.tsx offers
      // a "Resend verification email" button on both the post-sign-up panel and the rejected
      // sign-in, calling `/send-verification-email` directly. One click, one email.
      //
      // Note this path only ever fired on a *correct* password -- confirmed by reading the
      // installed `api/routes/sign-in.mjs`, where the verification check sits after the password
      // comparison -- so it was never a way to post mail to an address you did not control.
      // Turning it off is about not surprising the account's real owner, not about abuse.
      sendOnSignIn: false,
    },
  });

  return { auth, pool, database, trustedOrigins };
}
