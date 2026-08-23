import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@finaler-draft/config';
import { createDatabase, schema } from '@finaler-draft/database';

export interface AuthEnvironment {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  CLIENT_ORIGIN?: string | undefined;
  DATABASE_URL: string;
}

export interface CreateAuthOptions {
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

export function createAuth(environment: AuthEnvironment, options: CreateAuthOptions = {}) {
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
      enabled: options.rateLimitEnabled ?? true,
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
      requireEmailVerification: false,
    },
  });

  return { auth, pool, database, trustedOrigins };
}
