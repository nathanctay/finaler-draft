import { findPersistenceEnvironment, parseServerEnvironment } from '@finaler-draft/server-config';
import { createAuth } from './auth.js';
import { buildApp } from './app.js';
import { cachedProbe } from './cachedProbe.js';
import { createEntitlementEnforcedProjectStore } from './entitlementProjectStore.js';
import { createPostgresEntitlementStore } from './entitlementStore.js';
import { loadRootEnvironment, shouldLoadRootEnvironment } from './environment.js';
import { selectMailPort, type MailMessage } from './mail.js';
import { createPostgresProjectStore } from './projects.js';
import { createStripeClient } from './stripeClient.js';
import {
  createStripeIpAllowlist,
  fetchStripeWebhookIps,
  shouldEnforceStripeIpAllowlist,
} from './stripeIpAllowlist.js';
import { createPostgresSubscriptionStore } from './stripeSubscriptions.js';

// High enough that no realistic system-test run -- three Playwright workers sharing one loopback
// address -- ever reaches it, while still leaving the limiter itself registered and exercised (see
// the comment at its use below). Not `Infinity` or `Number.MAX_SAFE_INTEGER`: `@fastify/rate-limit`
// treats `max` as a bucket size it allocates per key, and this stays a plain, readable number.
const SYSTEM_TEST_API_RATE_LIMIT_MAX = 1_000_000;

try {
  const systemTestMode = process.env.FINALER_SYSTEM_TEST === 'true';
  if (shouldLoadRootEnvironment(process.env)) {
    loadRootEnvironment();
  }
  const environment = parseServerEnvironment(process.env);
  const persistence = findPersistenceEnvironment(environment);
  if (!persistence && environment.NODE_ENV === 'production' && !systemTestMode) {
    throw new Error('Persistence configuration is required in production.');
  }
  const appOptions = {
    serveClient: environment.NODE_ENV === 'production' || systemTestMode,
    systemTestMode,
    // Threaded through explicitly so `buildPersistentApp` can decide whether to enforce the
    // Stripe webhook IP allowlist at all -- see `shouldEnforceStripeIpAllowlist`'s own comment for
    // why that decision belongs on the raw `NODE_ENV` value, not on `serveClient`'s
    // production-or-system-test conflation just above.
    nodeEnv: environment.NODE_ENV,
    // Threaded through explicitly: `buildApp`'s own default already matches
    // `@finaler-draft/server-config`'s constants, but only this wiring makes
    // `API_RATE_LIMIT_MAX`/`API_RATE_LIMIT_WINDOW_MS` actually adjustable by an operator --
    // without it, setting either environment variable would parse successfully and do nothing.
    //
    // In system-test mode the cap itself is raised, for the same reason Better Auth's own limiter
    // is disabled outright a few lines below: the browser system suite runs several Playwright
    // workers in parallel, all issuing requests from one loopback address, so this per-client cap
    // measures an artifact of the test harness (three workers sharing an IP) rather than the
    // single-client abuse it exists to defend against. Measured directly: a branch adding more
    // request volume per test pushed the suite over the production default (300/60s), failing the
    // same test deterministically at the default while passing 18/18 with the cap raised.
    //
    // Raised, not disabled -- unlike Better Auth's limiter below, which is a boolean switch with no
    // middle ground. `fastifyRateLimit` stays registered ahead of every route in system-test mode
    // too, so `keyGenerator`, its header handling, and its 429 response shape all still run on
    // every system-test request; only the ceiling moves high enough that no real test run reaches
    // it. The production bound keeps its own dedicated coverage: app.test.ts's "global per-client
    // request cap" builds an instance with an explicit low cap and asserts the 429, independent of
    // both this value and `API_RATE_LIMIT_MAX`'s default.
    rateLimit: {
      max: systemTestMode ? SYSTEM_TEST_API_RATE_LIMIT_MAX : environment.API_RATE_LIMIT_MAX,
      timeWindowMs: environment.API_RATE_LIMIT_WINDOW_MS,
    },
  };
  const app = persistence
    ? await buildPersistentApp(persistence, appOptions)
    : await buildApp(appOptions);
  await app.listen({ host: '0.0.0.0', port: environment.PORT });
} catch (error) {
  console.error(JSON.stringify({ event: 'server_start_failed', error: describeError(error) }));
  process.exitCode = 1;
}

async function buildPersistentApp(
  persistence: NonNullable<ReturnType<typeof findPersistenceEnvironment>>,
  options: {
    serveClient: boolean;
    systemTestMode: boolean;
    nodeEnv: string;
    rateLimit: { max: number; timeWindowMs: number };
  },
) {
  // `selectMailPort` (mail.ts) is what actually enforces the safety property this comment used
  // to only assert: in system-test mode the logging port is selected regardless of whether
  // Resend credentials are present, so a real `RESEND_API_KEY` sitting in a developer's
  // environment or `.env` -- which legitimately belongs there for normal local runs -- can never
  // reach a live send during a system-test process (`scripts/test-system-persistence.mjs` and
  // `playwright.config.ts`'s `webServer` both spawn this process by inheriting the ambient
  // environment). Outside system-test mode, unset credentials still select the logging port,
  // which is always true outside production -- `server-config`'s `requirePersistenceEnvironment`
  // refuses to start a production process without both.
  //
  // `testMailbox` and the `onSend` hook below exist only so a Playwright spec -- which has no way
  // to inject a fake `MailPort` the way a Vitest test does -- can still complete the real
  // Better Auth verification/reset flow against a real, just-issued token, instead of writing
  // straight to the `email_verified` column and leaving `requireEmailVerification` itself
  // unexercised by the browser-driven suites. It is only ever populated, and only ever served
  // (see app.ts's `testMail` option), when `FINALER_SYSTEM_TEST` is set.
  const testMailbox = new Map<string, MailMessage>();
  const mail = selectMailPort({
    systemTestMode: options.systemTestMode,
    resendApiKey: persistence.RESEND_API_KEY,
    mailFromAddress: persistence.MAIL_FROM_ADDRESS,
    onSend: options.systemTestMode ? (message) => testMailbox.set(message.to, message) : undefined,
  });
  // The browser system suite runs several Playwright workers in parallel, and every one of them
  // signs up a fresh writer from the same loopback address -- so Better Auth's own limit (3
  // requests per 10 seconds on `/sign-up` and `/sign-in`, hardcoded in 1.6.25) throttles the
  // workers against each other rather than defending anything. Measured directly: 4 of 11
  // persistence tests fail with it on, repeatably. This slice adds *more* auth-endpoint traffic
  // per test (verification, sign-in-after-verification), so the failure mode without this is even
  // more pronounced, not less.
  //
  // Reuses the same `systemTestMode` flag `testMailbox` above is gated on, rather than a second,
  // separately named boolean meaning the same thing -- named here, visibly, at the one place it
  // happens. The real behaviour keeps its own coverage:
  // `persistence.integration.test.ts`'s "rate-limits repeated sign-in attempts" builds a dedicated
  // instance with the override omitted, exercising exactly what a deployment runs.
  const { auth, pool, trustedOrigins } = createAuth(persistence, {
    mail,
    rateLimitEnabled: !options.systemTestMode,
  });
  // Optional in every environment short of production (`requirePersistenceEnvironment` in
  // `@finaler-draft/server-config` is what makes all four mandatory there) -- so a development or
  // test process without Stripe configured still starts, just without the webhook route or the
  // billing (Checkout/Portal) routes registered at all (see `BuildAppOptions.stripe`/`.billing` in
  // app.ts: `undefined` here means the route does not exist, mirroring `testMail`'s "not
  // registered, not registered-and-denies" contract). The two Pro price ids gate the same flag and
  // feed `billing.priceIds` below, where Checkout Session creation actually selects between them.
  const stripeConfigured = Boolean(
    persistence.STRIPE_SECRET_KEY &&
      persistence.STRIPE_WEBHOOK_SECRET &&
      persistence.STRIPE_PRICE_ID_MONTHLY &&
      persistence.STRIPE_PRICE_ID_ANNUAL,
  );
  // `stripeConfigured` alone used to be the only gate here, which is exactly what let this
  // allowlist reject the developer's own `stripe listen` traffic in every local run: see
  // `shouldEnforceStripeIpAllowlist`'s own comment for the incident and the reasoning against a
  // loopback-address exemption instead of this explicit environment check.
  const ipAllowlist =
    stripeConfigured &&
    shouldEnforceStripeIpAllowlist({
      nodeEnv: options.nodeEnv,
      systemTestMode: options.systemTestMode,
    })
      ? createStripeIpAllowlist({ fetchIps: fetchStripeWebhookIps })
      : undefined;
  ipAllowlist?.start();
  // One real `Stripe` client instance, shared by the webhook route and the checkout/portal
  // routes below rather than constructed twice -- both are narrowed views of the same client
  // (see `StripeWebhookPort.client` and `BillingPort.client` in app.ts/stripeCheckout.ts), and
  // there is no reason for this process to hold two separate connections to the same API.
  const stripeClient = stripeConfigured
    ? createStripeClient(persistence.STRIPE_SECRET_KEY!)
    : undefined;
  // The public origin Checkout's `success_url`/`cancel_url` and the Customer Portal's
  // `return_url` redirect back to. Same fallback `auth.ts`'s `trustedOrigins` and
  // `apps/web/src/api.ts`'s `appUrl` already use: `CLIENT_ORIGIN` in local development, where the
  // SPA (:5173) and the API (:3001) are different origins, or `BETTER_AUTH_URL` otherwise, since
  // the same process serves both client and API in every deployed environment.
  const appOrigin = persistence.CLIENT_ORIGIN ?? persistence.BETTER_AUTH_URL;
  // Shared by the entitlement store below and, when Stripe is configured, the webhook route --
  // one instance either way, not two independent connections to the same table. Entitlement
  // enforcement needs subscription status regardless of whether Stripe itself is configured in
  // this environment: `getSubscriptionForUser` returning `undefined` for every account (an empty
  // table, not a missing dependency) is exactly the free-tier default plan.md asks for, so a
  // development or test process with persistence but no Stripe keys still enforces the free
  // tier correctly rather than skipping entitlement checks entirely.
  const subscriptions = createPostgresSubscriptionStore(pool);
  const entitlements = createPostgresEntitlementStore(pool, subscriptions);
  const app = await buildApp({
    serveClient: options.serveClient,
    rateLimit: options.rateLimit,
    auth: {
      baseUrl: persistence.BETTER_AUTH_URL,
      handler: auth.handler,
      getActorId: async (headers) => (await auth.api.getSession({ headers }))?.user.id ?? null,
      trustedOrigins,
    },
    // Wrapped, not the bare Postgres store: plan.md requires entitlement to be enforced in the
    // same layer as project/screenplay authorization, on every write, regardless of which routes
    // happen to be registered -- see entitlementProjectStore.ts's module comment for exactly what
    // this wrapper gates and what it deliberately leaves untouched.
    projects: createEntitlementEnforcedProjectStore(createPostgresProjectStore(pool), entitlements),
    entitlements,
    stripe: stripeConfigured
      ? {
          client: stripeClient!,
          webhookSecret: persistence.STRIPE_WEBHOOK_SECRET!,
          store: subscriptions,
          ipAllowlist,
        }
      : undefined,
    // Checkout Session and Customer Portal session creation (this slice). Gated behind the same
    // `stripeConfigured` check as the webhook route above -- both need the same four Stripe
    // environment variables (`requirePersistenceEnvironment` makes all four mandatory in
    // production), and a process without them configured should offer no purchase path rather
    // than fail every request to it.
    billing: stripeConfigured
      ? {
          client: stripeClient!,
          store: subscriptions,
          priceIds: {
            monthly: persistence.STRIPE_PRICE_ID_MONTHLY!,
            annual: persistence.STRIPE_PRICE_ID_ANNUAL!,
          },
          appOrigin,
        }
      : undefined,
    testMail: options.systemTestMode ? { latestTo: (to) => testMailbox.get(to) } : undefined,
    // A cheap connectivity probe, not a migration-state check: it answers "can this process
    // reach the database at all," which is exactly what Railway's rollout gate needs to catch a
    // deployment whose DATABASE_URL is wrong or whose database is unreachable. It shares the same
    // pool every request already uses, so it costs one lightweight round trip, not a new
    // connection.
    //
    // `/api/health` is registered ahead of the auth hook (see app.ts), so it is reachable
    // without a session and without Better Auth's own rate limiting. Wrapped in `cachedProbe` so
    // an unauthenticated flood of health checks -- accidental or not -- costs at most one real
    // pool round trip every few seconds instead of one per request, competing with real autosaves
    // for a pool slot. 5 seconds keeps a genuine outage or recovery visible to Railway's rollout
    // gate quickly, while still meaningfully absorbing a burst.
    databaseReady: cachedProbe(async () => {
      try {
        await pool.query('select 1');
        return true;
      } catch {
        return false;
      }
    }, 5_000),
  });
  app.addHook('onClose', async () => {
    ipAllowlist?.stop();
    await pool.end();
  });
  return app;
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: 'UnknownError', message: 'An unknown startup error occurred.' };
}
