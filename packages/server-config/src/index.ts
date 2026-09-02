/**
 * Server-only environment parsing, split out of `@finaler-draft/config` so the browser bundle
 * has no import path to the shape of the server's environment.
 *
 * This is a separate package rather than a module inside `apps/api` (e.g. `apps/api/src/
 * environment.ts`) even though `apps/api` is currently its only consumer. A same-package module
 * would be equally safe against `apps/web` today — `apps/web` cannot import from `apps/api`
 * either — but the isolation would be incidental rather than intentional, and `plan.md` already
 * schedules a second server-side consumer inside this phase: deterministic PDF export is a
 * required Phase 1 capability, and the export worker will likely need its own Dockerfile,
 * meaning its own deployable process with its own environment to parse. A package expresses that
 * "more than one server process needs this" is the actual shape of the problem, not a guess about
 * the future; a module would need to be promoted to a package later anyway, at which point
 * whichever process didn't get updated first would silently keep duplicating this logic instead.
 */
import { z } from 'zod';

/**
 * The global per-client request cap (plan.md, "Launch readiness": "Rate limiting on
 * authentication and a global request cap" — foundation work, not pre-launch work, since
 * credential stuffing and simple floods are live the moment the service is reachable). This is
 * distinct from Better Auth's own built-in rate limiter (`auth.ts`), which only ever sees
 * `/api/auth/*`; nothing else in the API is covered without this.
 *
 * These are the real production numbers, not values sized for test convenience: `apps/api`'s
 * `buildApp` defaults to them whenever a caller doesn't override `rateLimit` explicitly. A test
 * that legitimately needs a different cap (the persistence integration suite drives one shared
 * app instance through far more requests, in the same window, than any real client would) raises
 * it explicitly at its own call site instead of this default being loosened to accommodate it —
 * otherwise nobody could ever tighten this number later without chasing down a mysterious test
 * failure first.
 */
export const DEFAULT_API_RATE_LIMIT_MAX = 300;
export const DEFAULT_API_RATE_LIMIT_WINDOW_MS = 60_000;

const serverEnvironment = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url().optional(),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  CLIENT_ORIGIN: z.string().url().optional(),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(DEFAULT_API_RATE_LIMIT_MAX),
  API_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_API_RATE_LIMIT_WINDOW_MS),
  // Resend's API key and the address transactional mail is sent from. Optional here for the same
  // reason the persistence fields above are: a health/static-only process, and local development
  // without a key, both need to start. `requirePersistenceEnvironment` below is what makes them
  // mandatory in production -- see its comment for why plan.md treats a missing mail
  // configuration as a launch blocker rather than a runtime surprise.
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().email().optional(),
  // Stripe Billing (plan.md, "Subscription and billing architecture"). Optional here for the
  // same reason as the Resend fields above: a health/static-only process, and local development
  // without Stripe configured, both need to start. `requirePersistenceEnvironment` below is what
  // makes them mandatory in production.
  //
  // `STRIPE_SECRET_KEY` deliberately accepts either an unrestricted secret key (`sk_...`, used
  // in development) or a restricted key (`rk_...`, required in production per plan.md). Both are
  // drop-in-compatible Stripe API keys and the code that constructs the Stripe client
  // (apps/api/src/stripeClient.ts) must not care which it was handed -- so this schema does not
  // validate the prefix, only that a value is present.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID_MONTHLY: z.string().optional(),
  STRIPE_PRICE_ID_ANNUAL: z.string().optional(),
});

export type ServerEnvironment = z.infer<typeof serverEnvironment>;

export function parseServerEnvironment(
  input: Record<string, string | undefined>,
): ServerEnvironment {
  return serverEnvironment.parse(input);
}

export function requirePersistenceEnvironment(environment: ServerEnvironment) {
  const persistence = z
    .object({
      DATABASE_URL: z.string().url(),
      BETTER_AUTH_SECRET: z.string().min(32),
      BETTER_AUTH_URL: z.string().url(),
      CLIENT_ORIGIN: z.string().url().optional(),
      RESEND_API_KEY: z.string().optional(),
      MAIL_FROM_ADDRESS: z.string().email().optional(),
      STRIPE_SECRET_KEY: z.string().optional(),
      STRIPE_WEBHOOK_SECRET: z.string().optional(),
      STRIPE_PRICE_ID_MONTHLY: z.string().optional(),
      STRIPE_PRICE_ID_ANNUAL: z.string().optional(),
    })
    .parse(environment);
  if (environment.NODE_ENV === 'production') {
    if (new URL(persistence.BETTER_AUTH_URL).protocol !== 'https:') {
      throw new Error('BETTER_AUTH_URL must use HTTPS in production.');
    }
    // plan.md's launch-readiness section: "Until this exists there is no account recovery path
    // at all." A production process that started without a working password-reset path should
    // never happen quietly -- failing here, at startup, is what makes that a deploy-time error
    // instead of the first stranded writer's problem. Development and test stay unaffected
    // (`createLoggingMailPort` in mail.ts covers them: loud in the log, but never blocking).
    if (!persistence.RESEND_API_KEY || !persistence.MAIL_FROM_ADDRESS) {
      throw new Error(
        'RESEND_API_KEY and MAIL_FROM_ADDRESS are required in production: without them, ' +
          'password reset and email verification cannot be delivered.',
      );
    }
    // plan.md: "Verify the webhook signature on every event ... Treat the signing secret with
    // the same care as an API key" and the restricted-key production requirement. A production
    // process that started without these could not verify Stripe webhooks (so no subscription
    // state would ever update) or price a Checkout Session -- failing at startup turns that into
    // a deploy-time error instead of a silent billing outage discovered by a paying customer.
    if (
      !persistence.STRIPE_SECRET_KEY ||
      !persistence.STRIPE_WEBHOOK_SECRET ||
      !persistence.STRIPE_PRICE_ID_MONTHLY ||
      !persistence.STRIPE_PRICE_ID_ANNUAL
    ) {
      throw new Error(
        'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID_MONTHLY, and ' +
          'STRIPE_PRICE_ID_ANNUAL are required in production: without them, subscription ' +
          'billing cannot verify webhooks or price a subscription.',
      );
    }
  }
  return persistence;
}

export function findPersistenceEnvironment(environment: ServerEnvironment) {
  const values = [
    environment.DATABASE_URL,
    environment.BETTER_AUTH_SECRET,
    environment.BETTER_AUTH_URL,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  return requirePersistenceEnvironment(environment);
}
