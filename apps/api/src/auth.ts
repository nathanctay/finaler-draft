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

export function createAuth(environment: AuthEnvironment) {
  const { database, pool } = createDatabase(environment.DATABASE_URL);
  // Computed once and handed back to the caller (see server.ts) rather than recomputed there:
  // this is the exact same allowlist app.ts's origin guard needs to enforce (see the
  // `isTrustedOrigin` comment in app.ts), and Better Auth's own cross-origin request handling
  // needs to agree with it byte-for-byte, so there is exactly one place this list is built.
  const trustedOrigins = [
    environment.BETTER_AUTH_URL,
    ...(environment.CLIENT_ORIGIN ? [environment.CLIENT_ORIGIN] : []),
  ];
  const auth = betterAuth({
    database: drizzleAdapter(database, { provider: 'pg', schema }),
    baseURL: environment.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins,
    // Better Auth's built-in rate limiter (enabled by default in production) resolves the
    // client IP by reading `x-forwarded-for` (reading its installed source: `DEFAULT_IP_HEADERS`
    // in @better-auth/core's ip.ts). Railway's own documentation lists the request headers it
    // adds at the edge -- `X-Real-IP`, `X-Forwarded-Proto`, `X-Forwarded-Host` -- and
    // `X-Forwarded-For` is not among them. Left at the default, every request behind Railway's
    // proxy resolves to no IP at all, and the rate limiter's own fallback (confirmed in the same
    // source) is a single shared bucket per path for every client combined, meaning one abusive
    // client can exhaust the limit and lock out every legitimate user. Pointing this at the
    // header Railway actually sends restores per-client rate limiting.
    advanced: { ipAddress: { ipAddressHeaders: ['x-real-ip'] } },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      requireEmailVerification: false,
    },
  });

  return { auth, pool, database, trustedOrigins };
}
