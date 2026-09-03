import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { screenplaySchema } from '@finaler-draft/screenplay';
import {
  DEFAULT_API_RATE_LIMIT_MAX,
  DEFAULT_API_RATE_LIMIT_WINDOW_MS,
} from '@finaler-draft/server-config';
import Fastify, { type FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import {
  type ZodTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import Stripe from 'stripe';
import { z } from 'zod';
import {
  EDITABLE_SLOT_COOLDOWN_MS,
  EntitlementLimitError,
  resolveEditableScreenplayId,
  tierForSubscriptionStatus,
  type EntitlementSnapshot,
} from './entitlements.js';
import type { EntitlementStore } from './entitlementStore.js';
import type { MailMessage } from './mail.js';
import {
  ForbiddenError,
  type ProjectStore,
  createProjectInput,
  createScreenplayInput,
  renameInput,
  updateScreenplayInput,
} from './projects.js';
import {
  createCheckoutSession,
  createPortalSession,
  fetchBillingPlans,
  type BillingPort,
} from './stripeCheckout.js';
import type { StripeIpAllowlist } from './stripeIpAllowlist.js';
import type { SubscriptionProjection, SubscriptionStore } from './stripeSubscriptions.js';
import { dispatchStripeEvent } from './stripeWebhook.js';

export interface AuthPort {
  baseUrl: string;
  handler(request: Request): Promise<Response>;
  getActorId(headers: Headers): Promise<string | null>;
  /**
   * The exact allowlist Better Auth itself trusts (`BETTER_AUTH_URL` plus the optional
   * `CLIENT_ORIGIN`; see `createAuth` in auth.ts, which builds and returns this same array).
   * `isTrustedOrigin` below compares an incoming `Origin` header's full origin against this
   * list rather than against the request's own `Host` header -- see that function's comment
   * for why the `Host`-based check this replaced was actually broken.
   */
  trustedOrigins: readonly string[];
}

/**
 * The webhook route's dependencies (app.ts's `POST /api/webhooks/stripe` registration below).
 * `client` is typed down to just `webhooks` -- the only member this route calls
 * (`client.webhooks.constructEvent`) -- rather than the full `Stripe` class, so a test can supply
 * a client built from nothing but a signing secret (signature verification is pure HMAC, no
 * network access or API key required) instead of a full, real, API-key-bearing instance.
 */
export interface StripeWebhookPort {
  client: Pick<Stripe, 'webhooks'>;
  webhookSecret: string;
  store: SubscriptionStore;
  /**
   * Typed down to just `isAllowed` -- the only member this route calls -- for the same testing
   * reason as `client` above: a test can supply a trivial stub instead of the full
   * `createStripeIpAllowlist` machinery (refresh timers, network fetches). Omitted entirely
   * means no IP check is enforced -- see stripeIpAllowlist.ts for why an unenforced allowlist
   * (not just an "always allow" one) is the correct default until a real one is wired up.
   */
  ipAllowlist?: Pick<StripeIpAllowlist, 'isAllowed'> | undefined;
}

export interface BuildAppOptions {
  serveClient?: boolean;
  clientRoot?: URL;
  auth?: AuthPort;
  projects?: ProjectStore;
  /**
   * Backs `GET /api/entitlement` and `PUT /api/entitlement/editable-screenplay` -- the read/write
   * surface a later slice's UI needs to show and change a restricted account's single editable
   * screenplay. Entitlement *enforcement* itself does not live here: it is wired into `projects`
   * directly (see server.ts, which wraps `createPostgresProjectStore` in
   * `createEntitlementEnforcedProjectStore` before ever handing it to `buildApp`), so that every
   * write to a screenplay is gated whether or not this option -- or any route below -- exists.
   * This option only powers the two routes that report and change entitlement *state*.
   */
  entitlements?: EntitlementStore;
  stripe?: StripeWebhookPort | undefined;
  /**
   * Backs `POST /api/billing/checkout-session`, `POST /api/billing/portal-session`, and
   * `GET /api/billing/subscription` -- the purchase, manage-billing, and billing-status-read entry
   * points this slice adds. Deliberately a separate option from `stripe` above rather than reusing
   * the same port: `stripe`'s `client` is narrowed to `Pick<Stripe, 'webhooks'>` because the
   * webhook route only ever verifies and dispatches an already-received event, while these routes
   * only ever *create* Checkout/Portal sessions (or read this app's own `subscriptions` projection,
   * never Stripe directly) and never see a webhook payload -- two disjoint capabilities of the same
   * underlying `Stripe` client, each narrowed to exactly what its own routes call (see
   * `BillingPort` in stripeCheckout.ts). `server.ts` constructs one real `Stripe` instance and
   * passes it into both options, so this split costs nothing at runtime; it only keeps each route's
   * test surface minimal.
   */
  billing?: BillingPort | undefined;
  /**
   * A cheap, side-effect-free database reachability probe (e.g. `select 1`), wired to `/api/health`
   * when persistence is configured. Railway only consults the healthcheck endpoint while gating a
   * new deployment's rollout -- confirmed against Railway's own documentation, it is never polled
   * again once a deployment is live -- so this cannot turn a transient database blip into a restart
   * of an already-healthy running deployment. It can only stop a deployment with missing migrations
   * or an unreachable database from ever being marked healthy in the first place.
   */
  databaseReady?: () => Promise<boolean>;
  /**
   * Exposes the most recent message sent to a given address. Registered only under
   * `FINALER_SYSTEM_TEST` (see server.ts's `buildPersistentApp`) -- it is the one seam that lets
   * a Playwright spec, which has no way to inject a fake `MailPort` the way a Vitest test does,
   * complete the real `/api/auth/verify-email` (or reset) exchange against a real, just-issued
   * token. The alternative -- writing straight to the `email_verified` column -- would leave
   * `requireEmailVerification` itself unexercised by every browser-driven suite, which is exactly
   * the "quietly configured off" failure mode progress/transactional-email.md warns against. It
   * must never be reachable outside system-test mode: `undefined` here means the route below is
   * not registered at all, not that it is registered and denies.
   */
  testMail?: { latestTo(to: string): MailMessage | undefined } | undefined;
  /**
   * The global per-client request cap (plan.md: "a global request cap, so a single client cannot
   * exhaust the API regardless of endpoint" -- distinct from Better Auth's own rate limiter in
   * `auth.ts`, which only ever sees `/api/auth/*`; reading its installed source confirmed nothing
   * else is covered without this). Defaults to the real production values from
   * `@finaler-draft/server-config` when omitted -- not to a number sized for test convenience.
   * A caller that legitimately needs a different cap (the persistence integration suite drives
   * one shared app instance through far more requests, in the same window, than any real client
   * would) raises it explicitly here at its own call site instead of this default being loosened
   * to accommodate it.
   */
  rateLimit?: { max: number; timeWindowMs: number };
}

const idParam = z.object({ id: z.string().uuid() });
export const MAX_SCREENPLAY_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Same-site sibling-origin CSRF defense (plan.md's session-verification section: every request
 * that carries identity is re-verified server-side). `SameSite=Lax` cookies stop fully cross-site
 * requests but not a request from a sibling origin on the same registrable domain -- a different
 * subdomain, or a different port on localhost -- since `SameSite` reasons about the *site*, not
 * the exact origin.
 *
 * This compares the `Origin` header against a fixed allowlist (`trustedOrigins`, built once in
 * `createAuth` from `BETTER_AUTH_URL` and the optional `CLIENT_ORIGIN` -- the same list Better
 * Auth itself trusts) rather than against the request's own `Host` header. An earlier version of
 * this function compared `Origin`'s host against `Host` instead, on the theory that the SPA and
 * API always share an origin. That theory holds in production (both are served from the same
 * Fastify process) but not in the documented `pnpm dev` workflow: Vite's dev proxy forwards
 * `/api` requests to the API with `changeOrigin: true`, which rewrites the outgoing `Host` header
 * to the API's own host (`localhost:3001`) while leaving the browser's original `Origin` header
 * (`http://localhost:5173`) untouched. Every authenticated write in local development was
 * therefore rejected with 403 -- not a forged-request rejection, the legitimate case failing.
 * Comparing against a fixed allowlist instead of the request's own (proxy-rewritable) `Host`
 * header fixes that without weakening the check: `Host` was never a trustworthy signal here in
 * the first place, since a reverse proxy is free to rewrite it.
 *
 * The full origin (scheme included) is compared, not just the host: unlike `request.protocol`
 * (which reflects the connection this process actually terminates, plain HTTP behind Railway's
 * proxy even when the browser connected over HTTPS), the `Origin` header itself is set by the
 * browser from the page's real origin and is not rewritten by the proxy, so comparing its scheme
 * is safe and `BETTER_AUTH_URL`'s own enforced HTTPS-in-production is naturally honored.
 *
 * A request with no `Origin` header is judged by method, not waved through unconditionally.
 * Current browsers attach `Origin` to same-origin fetch/XHR requests using POST/PUT/PATCH/DELETE
 * without exception, so an unsafe method arriving with no `Origin` at all is not the legitimate
 * case this function needs to protect -- it is refused. A safe method (GET/HEAD) is a different
 * story: browsers omit `Origin` on ordinary same-origin reads (plain navigations included), and
 * this route group is read from as well as written to (`GET /api/projects` and friends share this
 * same `preValidation` hook), so requiring `Origin` on those would 403 the entire signed-in
 * workspace the moment a real browser does what real browsers do. This is precisely how the
 * owner's projects page loaded correctly on an unfamiliar port -- a GET with no `Origin` is
 * supposed to pass -- while the 403 he then saw on sign-out (a POST, correctly carrying an
 * `Origin` that didn't match `trustedOrigins`) was this guard working as designed, not this gap.
 *
 * Failing closed on "unsafe method, absent Origin" does mean every write exercised through
 * Fastify's own `.inject()` test helper (which sends no `Origin` unless a test sets one) now
 * needs an explicit `Origin` header to reach 200 -- the test suites were updated accordingly
 * rather than left to rely on the old blanket allowance.
 *
 * This is deliberately narrower than a full CSRF-token scheme; it closes the specific attack an
 * audit of this repository demonstrated (a forged `Origin` reaching a restore handler and
 * succeeding), not every conceivable request-forgery vector.
 */
function isTrustedOrigin(
  originHeader: string | undefined,
  trustedOrigins: readonly string[],
  method: string,
) {
  if (!originHeader) return method === 'GET' || method === 'HEAD';
  try {
    return trustedOrigins.includes(new URL(originHeader).origin);
  } catch {
    return false;
  }
}

// Success response schemas mirror the ProjectStore interface's return types field for field.
// Declaring a schema for a shape whose fields don't match the real return value would silently
// strip fields (or throw a 500 on mismatch), so each one is a direct mirror of its ProjectStore
// method's return type rather than a hand-written guess. The nested `screenplay` field reuses the
// exact `screenplaySchema` that already validated the same data on write, so re-validating it
// here on the way out cannot reject or strip anything that wasn't already rejected before it
// reached the database.
//
// Every route below also lists its error status codes with `errorResponseSchema`, even though
// their bodies were never schema-validated before this refactor. That is not optional: once a
// route declares any `response` schema, Fastify's typed reply narrows `.code()` to only the
// status codes present in that schema, so a route that both succeeds and fails needs every status
// code it sends listed, not just the success one. `errorResponseSchema` matches the existing
// `{ error: string }` bodies exactly, so this changes nothing observable — it only makes the
// handler's existing error replies type-checked, too.
const errorResponseSchema = z.object({ error: z.string() });
const projectListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  role: z.string(),
});
const createProjectResponseSchema = z.object({ id: z.string(), title: z.string() });
const screenplayListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.number(),
  updatedAt: z.string(),
});
const createScreenplayResponseSchema = z.object({ id: z.string(), version: z.number() });
const screenplayResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  version: z.number(),
  screenplay: screenplaySchema,
});
const updateScreenplayResponseSchema = z.object({ version: z.number() });
// Shared by both projects and screenplays: rename and restore both return the resource's
// current id and title, and delete returns just the id it acted on. One schema per shape rather
// than four near-identical ones, since the two resources' responses are structurally identical.
const renameResponseSchema = z.object({ id: z.string(), title: z.string() });
const deleteResponseSchema = z.object({ id: z.string() });
const deletedProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string(),
});
const deletedScreenplaySchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string(),
  projectId: z.string(),
  projectTitle: z.string(),
});
const deletedResponseSchema = z.object({
  projects: z.array(deletedProjectSchema),
  screenplays: z.array(deletedScreenplaySchema),
});
// Mirrors `describeEntitlement`'s return shape below field for field, for the same reason every
// other response schema in this file mirrors its handler's actual return value: a schema whose
// fields don't match would silently strip data rather than fail loudly.
const entitlementResponseSchema = z.object({
  tier: z.enum(['paid', 'restricted']),
  editableScreenplayId: z.string().nullable(),
  candidateScreenplayIds: z.array(z.string()),
  slotUpdatedAt: z.string().nullable(),
  cooldownEndsAt: z.string().nullable(),
});
const switchEditableScreenplayInput = z.object({ screenplayId: z.string().uuid() }).strict();
const switchEditableScreenplayResponseSchema = z.object({
  screenplayId: z.string(),
  updatedAt: z.string(),
});
// `.strict()`: an unknown field (most pointedly a `userId` naming a different actor) is rejected
// with 400 rather than silently ignored. This is the whole answer to "a user cannot create a
// billing session for another user" -- the route always acts on `request.actorId!`, the
// authenticated session's own id, and the request body has no field capable of naming anyone
// else in the first place.
const checkoutSessionInput = z.object({ plan: z.enum(['monthly', 'annual']) }).strict();
const checkoutSessionResponseSchema = z.object({ url: z.string() });
const portalSessionResponseSchema = z.object({ url: z.string() });
// Mirrors `stripeSubscriptions.ts`'s `SubscriptionStatus` union exactly (kept in sync by hand, the
// same convention that file's own doc comment establishes for its Postgres enum) -- a specific,
// closed enum here rather than a bare `z.string()`, matching this codebase's general discipline
// for wire shapes that have a known, finite set of values.
const billingSubscriptionStatusSchema = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);
// Backs `GET /api/billing/subscription` -- the Manage Subscription page's data source (see that
// route's own comment for why this is a new, narrow endpoint rather than folding these fields
// into `GET /api/entitlement`). `subscription: null` means no `subscriptions` row exists at all
// (never subscribed); a lapsed or canceled account still returns a non-null `subscription` with
// its last-known `status`, distinguishing "never subscribed" from "subscribed once."
const billingSubscriptionResponseSchema = z.object({
  subscription: z
    .object({
      plan: z.enum(['monthly', 'annual', 'unknown']),
      status: billingSubscriptionStatusSchema,
      currentPeriodEnd: z.string(),
      cancelAtPeriodEnd: z.boolean(),
      canceledAt: z.string().nullable(),
    })
    .nullable(),
});
// Backs `GET /api/billing/plans` -- real Stripe amounts for the pricing cards
// (routes/billing.subscription.tsx), so the annual saving shown there is derived from actual
// configured prices rather than a hardcoded percentage. `amount` mirrors Stripe's own
// `unit_amount` exactly (the smallest unit of `currency`, e.g. cents for USD).
const planPriceSchema = z.object({
  amount: z.number(),
  currency: z.string(),
  interval: z.string().nullable(),
});
const billingPlansResponseSchema = z.object({ monthly: planPriceSchema, annual: planPriceSchema });

/**
 * Pure projection from an `EntitlementSnapshot` to the wire shape `GET /api/entitlement` returns.
 * `cooldownEndsAt` is derived here, not left for a client to compute from `slotUpdatedAt` plus a
 * hardcoded interval of its own -- the interval lives in exactly one place
 * (`entitlements.ts`'s `EDITABLE_SLOT_COOLDOWN_MS`), and a client re-deriving it would be a second
 * place that constant would need to change in lockstep.
 */
function describeEntitlement(snapshot: EntitlementSnapshot) {
  const tier = tierForSubscriptionStatus(snapshot.subscriptionStatus);
  return {
    tier,
    editableScreenplayId: tier === 'restricted' ? resolveEditableScreenplayId(snapshot) : null,
    candidateScreenplayIds: tier === 'restricted' ? [...snapshot.candidateScreenplayIds] : [],
    slotUpdatedAt: snapshot.slot ? snapshot.slot.updatedAt.toISOString() : null,
    cooldownEndsAt:
      tier === 'restricted' && snapshot.slot
        ? new Date(snapshot.slot.updatedAt.getTime() + EDITABLE_SLOT_COOLDOWN_MS).toISOString()
        : null,
  };
}

/**
 * Pure projection from a raw `subscriptions` row (slice 1's projection, kept current by the
 * webhook -- never read live from Stripe) to the wire shape `GET /api/billing/subscription`
 * returns. `GET /api/entitlement` deliberately doesn't carry this: it answers "what can this actor
 * do" (tier, the editable slot) for the free-tier/lapse mechanics, while this answers "what does
 * this actor's Stripe subscription actually look like" for the Manage Subscription page
 * (routes/billing.subscription.tsx) -- two different questions with two different shapes, and
 * folding billing detail into the authorization-shaped endpoint would have bloated it for a
 * concern only one page needs. A new, narrow `/api/billing/*` route (alongside this slice's other
 * two) is cleaner than extending `/api/entitlement` for that reason.
 *
 * Deliberately narrower than the full `SubscriptionProjection`: `stripeCustomerId` and
 * `stripeSubscriptionId` are Stripe-internal identifiers the browser has no use for and no reason
 * to receive (least-privilege data exposure). `subscription: null` means no row exists at all
 * (never subscribed) -- distinct from a lapsed/canceled account, which still returns a non-null
 * `subscription` carrying its last-known `status`, so the page can tell the two apart.
 */
function describeBillingSubscription(
  row: SubscriptionProjection | undefined,
  priceIds: { monthly: string; annual: string },
) {
  if (!row) return { subscription: null };
  return {
    subscription: {
      plan:
        row.stripePriceId === priceIds.monthly
          ? ('monthly' as const)
          : row.stripePriceId === priceIds.annual
            ? ('annual' as const)
            : ('unknown' as const),
      status: row.status,
      currentPeriodEnd: row.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      canceledAt: row.canceledAt ? row.canceledAt.toISOString() : null,
    },
  };
}

/**
 * Logs an operator-diagnosable line when Stripe itself rejects a request this process made to
 * it -- distinct from, and more specific than, the generic top-level error handler below
 * (`request.log.error({ err: error.name }, 'Request failed')`), which was the entire problem
 * this exists to fix. Running this branch against a real Stripe sandbox, both Checkout buttons
 * returned a bare 400 with no way to tell why; the actual cause (Stripe refusing
 * `automatic_tax: { enabled: true }` because the account's Tax Settings have no origin address
 * configured yet -- an account-configuration prerequisite, not a bug in this code, see plan.md's
 * Tax section) took directly checking the account's `/v1/tax/settings` to find, because nothing
 * server-side named it.
 *
 * `StripeError`'s own `type`, `rawType`, `code`, `param`, `requestId`, `statusCode`, and `doc_url`
 * name a failure precisely enough to diagnose from the log line alone, and are genuinely safe to
 * log: unlike `.message` or `.raw` (which can echo request content back) or `.headers`, none of
 * those six fields carry anything from this request's own body. `type` and `rawType` are two
 * different things, both worth having -- confirmed against the installed SDK's own source
 * (`Error.js`): `type` is the specific error *class* Stripe's SDK constructed
 * (`StripeInvalidRequestError`, `StripeCardError`, ...), which is what Stripe's own error-handling
 * documentation is organized around, while `rawType` is the broader category the raw HTTP response
 * reported (`invalid_request_error`, `card_error`, ...). This is the same "log a bounded,
 * structured description, never the raw error object" discipline stripeWebhook.ts's
 * signature-rejection logging already established, applied to the other direction (a request
 * *this* server made to Stripe, not one Stripe made to us).
 */
function logStripeRequestFailure(request: FastifyRequest, operation: string, error: unknown): void {
  if (error instanceof Stripe.errors.StripeError) {
    request.log.error(
      {
        event: 'stripe_request_failed',
        operation,
        stripeErrorType: error.type,
        stripeErrorRawType: error.rawType,
        stripeErrorCode: error.code,
        stripeErrorParam: error.param,
        stripeRequestId: error.requestId,
        stripeStatusCode: error.statusCode,
        stripeDocUrl: error.doc_url,
      },
      'Stripe rejected a request this server made',
    );
    return;
  }
  request.log.error(
    {
      event: 'stripe_request_failed',
      operation,
      err: error instanceof Error ? error.name : 'UnknownError',
    },
    'A billing request failed for a reason other than a Stripe API rejection',
  );
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    bodyLimit: MAX_SCREENPLAY_REQUEST_BODY_BYTES,
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'warn',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Global per-client cap, ahead of every route including `/api/auth/*` and `/api/health` --
  // "regardless of endpoint" per plan.md, and Better Auth's own limiter (auth.ts) never sees
  // anything outside `/api/auth/*` to begin with. `fastify-plugin` (which this plugin uses
  // internally) breaks the usual encapsulation, so this applies to every route the whole app
  // registers -- not just ones declared after this line -- but it is registered first anyway so
  // that is never load-bearing.
  await app.register(fastifyRateLimit, {
    max: options.rateLimit?.max ?? DEFAULT_API_RATE_LIMIT_MAX,
    timeWindow: options.rateLimit?.timeWindowMs ?? DEFAULT_API_RATE_LIMIT_WINDOW_MS,
    // Railway's edge sends the client's real address as `X-Real-IP`; Fastify's own `request.ip`
    // reflects the proxy's address instead unless `trustProxy` is configured, which this app does
    // not do. Left at the plugin's own default key (`request.ip`), every request behind Railway's
    // proxy would collapse onto one shared bucket -- exactly the failure mode already fixed for
    // Better Auth's own rate limiter in auth.ts (`advanced.ipAddress.ipAddressHeaders`), for the
    // identical reason.
    keyGenerator(request) {
      const realIp = request.headers['x-real-ip'];
      return typeof realIp === 'string' ? realIp : request.ip;
    },
    // Scoped to the API. This cap exists to bound work that reaches the application and the
    // database; static asset serving does neither, and counting it spends the budget on the wrong
    // thing. One page load pulls the bundle, the stylesheet and several font files, so an
    // all-routes cap is consumed by ordinary browsing -- a writer reloading a few times in a
    // minute can exhaust it, and the browser system suite did exactly that, exhausting it partway
    // through a run and failing whichever test happened to be last.
    //
    // Note this is deliberately not the same boundary as the origin guard's (`/api/projects`,
    // `/api/screenplays`, `/api/deleted`): `/api/auth/*` must be capped too, and is the endpoint
    // that most needs it.
    allowList: (request) => !request.url.startsWith('/api'),
  });
  // See the `onSend` hook below: this marks a reply as "serving index.html via the SPA
  // fallback" structurally, so the no-cache override there does not depend on sniffing a
  // Content-Type header that a 304 response is free to omit.
  app.decorateReply('indexFallback', false);
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 413) return reply.code(413).send({ error: 'Request too large' });
    // @fastify/rate-limit (registered above) throws rather than replying directly, so its 429
    // would otherwise fall into the generic 4xx branch below and come back as the misleading
    // "Invalid request" -- nothing about a rate-limited request was invalid.
    if (error.statusCode === 429) return reply.code(429).send({ error: 'Too many requests' });
    // The whole workspace resolves a single zod v4 install (verified via `pnpm prune` and the
    // lockfile: apps/api and @finaler-draft/screenplay both depend on the identical pinned
    // version, and pnpm dedupes them to one copy in the store), so `instanceof` reliably
    // recognizes a ZodError raised from either package's `.parse()` calls. A prior string-based
    // `error.name === 'ZodError'` fallback existed only to bridge two distinct ZodError classes
    // from two different zod majors coexisting in one process; that hazard no longer exists, so
    // the fallback was removed rather than kept as unexplained defense in depth.
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request' });
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500)
      return reply.code(error.statusCode).send({ error: 'Invalid request' });
    request.log.error(
      { err: error instanceof Error ? error.name : 'UnknownError' },
      'Request failed',
    );
    return reply.code(500).send({ error: 'Internal server error' });
  });
  app.addHook('onSend', async (request, reply) => {
    // Every response under /api/ carries or reflects authenticated state (screenplay titles,
    // project membership, even the shape of an auth error), so plan.md requires this explicitly
    // rather than leaving it to a CDN's content-type heuristics -- see "Consequences that must
    // be honored" in the deployment topology section, which cites a real Railway CDN
    // misconfiguration incident as the reason this is not optional. Keyed on the URL prefix
    // alone, so it applies uniformly to success and error responses alike, including routes
    // registered later in this function.
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'private, no-store');
      return;
    }
    // index.html is the one file the static plugin below serves whose content changes without
    // its URL changing -- unlike a content-hashed asset, a new deploy still answers at `/`. It
    // must never be served `immutable`, unlike everything else that plugin serves.
    //
    // This cannot be done through `@fastify/static`'s own `setHeaders` option: reading its
    // installed source (serveFileHandler in @fastify/static's index.js) shows `setHeaders` runs,
    // then the plugin unconditionally calls `reply.headers(headers)` with its own computed
    // Cache-Control immediately afterward, clobbering whatever `setHeaders` set. An `onSend` hook
    // runs later in the reply lifecycle, after the route handler (and the plugin's own header
    // assignment) has already completed, so it is the layer this can actually be overridden from.
    //
    // Identified structurally (request URL for the two paths the plugin serves index.html at
    // directly, plus the `indexFallback` reply decorator the SPA-fallback handler below sets),
    // not by sniffing the response's Content-Type header. An earlier version of this hook keyed
    // off `Content-Type: text/html`, which works for a normal 200 but not for a conditional
    // request that revalidates to 304: reading `@fastify/send`'s installed source (the
    // `@fastify/send` dependency `@fastify/static` uses internally) shows its 304 path explicitly
    // deletes `Content-Type` from the response before sending it (see `send.js`'s
    // `sendNotModified`). A content-type sniff therefore silently stopped applying to every
    // conditionally-revalidated request for index.html, leaving the plugin's default
    // `public, max-age=31536000, immutable` policy in place instead -- letting a browser cache
    // the app shell, and any embedded security code, as immutable for a year. Checking the
    // request/response shape instead of a header that a valid HTTP response is free to omit
    // closes that gap for every status code index.html can be served with, 200 or 304 alike.
    if (
      options.serveClient &&
      (request.url === '/' || request.url === '/index.html' || reply.indexFallback)
    ) {
      reply.header('Cache-Control', 'no-cache');
    }
  });
  typedApp.get(
    '/api/health',
    {
      schema: {
        response: {
          200: z.object({ status: z.literal('ok') }),
          503: z.object({ status: z.literal('unavailable') }),
        },
      },
    },
    async (_request, reply) => {
      if (options.databaseReady && !(await options.databaseReady())) {
        return reply.code(503).send({ status: 'unavailable' as const });
      }
      return { status: 'ok' as const };
    },
  );

  // See `BuildAppOptions.testMail`'s comment: this route exists at all only under
  // `FINALER_SYSTEM_TEST`, never in a real deployment, and it is registered here -- ahead of the
  // actor-authorization hook below -- deliberately unauthenticated, the same as `/api/health`: a
  // Playwright spec reads it before it has a session to authenticate with (it needs the
  // verification link to *get* a session in the first place).
  // Two independent conditions, deliberately. `options.testMail` alone is not enough: this route
  // returns the body of the most recent email sent to an address, which is how a Playwright spec
  // follows a real verification link -- and that body contains live password-reset and
  // verification tokens. `FINALER_SYSTEM_TEST`, the flag that sets `testMail` upstream, is not a
  // production kill switch: `server.ts` also uses it to *relax* the "persistence required in
  // production" check, so it is a variable that can plausibly be set in a production-shaped
  // environment. One misplaced environment variable must not be enough to serve account-recovery
  // tokens to anyone who asks, so the route additionally refuses to exist under
  // `NODE_ENV=production` regardless of what it was passed.
  if (options.testMail && process.env.NODE_ENV !== 'production') {
    typedApp.get(
      '/api/test/last-mail',
      {
        schema: {
          querystring: z.object({ to: z.string() }),
          response: {
            200: z.object({ subject: z.string(), text: z.string() }),
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const message = options.testMail!.latestTo(request.query.to);
        if (!message) return reply.code(404).send({ error: 'No mail recorded for that address' });
        return { subject: message.subject, text: message.text };
      },
    );
  }

  if (options.stripe) {
    const stripe = options.stripe;
    // Registered inside a child `register` context so the raw-body content type parser below is
    // scoped to this one route -- Fastify's plugin encapsulation means a parser added on `scoped`
    // shadows the parent app's default JSON parser only for routes registered on `scoped` itself,
    // never for routes registered directly on `app`/`typedApp` elsewhere in this function. This is
    // Fastify's own documented pattern for a webhook route that needs its raw body (plan.md:
    // "The webhook route needs the raw request body. Fastify's JSON parser will consume and
    // re-serialize the body, which invalidates the signature. Register a raw-body content type
    // parser scoped to that route only; do not disable JSON parsing globally").
    // `app.test.ts`'s "still parses JSON normally on a sibling route" test is what proves this
    // scoping actually holds, rather than this comment being the only evidence.
    await app.register(async (scoped) => {
      scoped.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer' },
        (_request, body, done) => done(null, body),
      );
      scoped.post('/api/webhooks/stripe', async (request, reply) => {
        // Cheap defence-in-depth check ahead of the signature verification below (stripeIpAllowlist.ts's
        // module comment covers why this fails open rather than closed). Reuses the same
        // `x-real-ip`-first resolution as the global rate limiter's `keyGenerator` above, for the
        // identical reason: behind Railway's proxy, Fastify's own `request.ip` is the proxy's
        // address, not the caller's.
        const realIp = request.headers['x-real-ip'];
        const sourceIp = typeof realIp === 'string' ? realIp : request.ip;
        if (stripe.ipAllowlist && !stripe.ipAllowlist.isAllowed(sourceIp)) {
          request.log.warn(
            { event: 'stripe_webhook_ip_rejected' },
            "Rejected a webhook request from an IP outside Stripe's published range",
          );
          return reply.code(403).send({ error: 'Forbidden' });
        }
        const signatureHeader = request.headers['stripe-signature'];
        if (typeof signatureHeader !== 'string') {
          return reply.code(400).send({ error: 'Missing Stripe-Signature header' });
        }
        let event: Stripe.Event;
        try {
          // Verified before anything about the payload is trusted (plan.md: "Verify the webhook
          // signature on every event ... before parsing or acting on anything"). `request.body`
          // is the raw `Buffer` the content type parser above handed back, byte-identical to what
          // Stripe sent and signed -- never Fastify's own re-serialized JSON, which would not
          // match the signature.
          event = stripe.client.webhooks.constructEvent(
            request.body as Buffer,
            signatureHeader,
            stripe.webhookSecret,
          );
        } catch (error) {
          // Never logs the error object itself: `constructEvent`'s thrown
          // `StripeSignatureVerificationError` carries the raw header and payload it failed to
          // verify, which must not reach the logs. Same convention as the global error handler
          // above -- only the error's name.
          //
          // The message text itself carries an actionable hint, though, for the same reason
          // `logStripeRequestFailure` above exists: a bare "rejected" line here is a confusing
          // dead end from the outside. This route's most common real cause of rejection isn't an
          // attack -- it's a stale `STRIPE_WEBHOOK_SECRET`: `stripe listen` (the standard local
          // dev tool for receiving real events) prints a fresh `whsec_...` every time it starts,
          // and a leftover value from a previous session in `.env` produces exactly this
          // rejection with no indication of why. Naming that possibility directly turns a
          // confusing dead end into a one-line diagnosis, without logging anything from the
          // header or payload that caused it.
          request.log.warn(
            {
              event: 'stripe_webhook_signature_rejected',
              err: error instanceof Error ? error.name : 'UnknownError',
            },
            'Rejected a webhook request with an invalid or missing signature -- if this is ' +
              'unexpected, check that STRIPE_WEBHOOK_SECRET matches the currently running ' +
              '`stripe listen` session (it prints a fresh whsec_ value every time it starts) or ' +
              'the signing secret configured for this endpoint in the Stripe Dashboard',
          );
          return reply.code(400).send({ error: 'Invalid signature' });
        }
        const outcome = await dispatchStripeEvent(stripe.store, event);
        request.log.info(
          { event: 'stripe_webhook_processed', type: event.type, outcome },
          'Processed a Stripe webhook event',
        );
        return reply.code(200).send({ received: true });
      });
    });
  }

  if (options.auth) {
    app.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      async handler(request, reply) {
        try {
          // Better Auth receives a web `Request` and so has no access to the socket -- it can only
          // resolve a client IP from a header. `auth.ts` points it at `x-real-ip`, which Railway's
          // proxy sends; nothing sends it on a direct connection, and Better Auth's fallback when
          // no address resolves is a **single shared bucket per path for every client combined**
          // (confirmed in the installed `api/rate-limiter/index.mjs`: `NO_TRUSTED_IP_KEY`). That is
          // worse than no limit -- one abusive client exhausts it and locks out everyone -- and it
          // is what the owner saw locally as "Rate limiting could not determine a client IP".
          //
          // Filling it in from Fastify's own view of the connection, and only when absent, restores
          // per-client buckets wherever there is no proxy. Behind Railway the header is already
          // present and is left exactly as received.
          //
          // Known limitation, unchanged by this and worth stating plainly: a client that reaches
          // the API directly can still set `x-real-ip` itself and rotate it to evade the limit.
          // Closing that needs `advanced.ipAddress.trustedProxies` so the header is only believed
          // from a known proxy, which is a deployment-topology decision rather than a code one.
          const forwardedHeaders = fromNodeHeaders(request.headers);
          if (!forwardedHeaders.has('x-real-ip') && request.ip) {
            forwardedHeaders.set('x-real-ip', request.ip);
          }
          const response = await options.auth!.handler(
            new Request(new URL(request.raw.url ?? request.url, options.auth!.baseUrl).toString(), {
              method: request.method,
              headers: forwardedHeaders,
              ...(request.method === 'GET' || request.method === 'HEAD'
                ? {}
                : { body: JSON.stringify(request.body) }),
            }),
          );
          response.headers.forEach((value, key) => reply.header(key, value));
          return reply.code(response.status).send(response.body ? await response.text() : null);
        } catch (error) {
          request.log.error(
            { err: error instanceof Error ? error.name : 'UnknownError' },
            'Authentication request failed',
          );
          return reply.code(500).send({ error: 'Authentication failed' });
        }
      },
    });
  }

  if (options.auth && (options.projects || options.entitlements || options.billing)) {
    // Runs as `preValidation`, not `preHandler`. Fastify's request lifecycle runs
    // preValidation -> schema validation -> preHandler -> the route handler, and before this
    // refactor every id/body check was a manual `.parse()` call inside the handler, i.e. later
    // than `preHandler`. So an unauthenticated request with a malformed id or body has always
    // been rejected for authentication first (401), never for validation (400). Declaring
    // `params`/`body` as route schemas moves validation ahead of `preHandler`; keeping this check
    // in `preValidation` (ahead of validation too) is what keeps that precedence, and that
    // precedence, byte-identical to before.
    //
    // `/api/entitlement` and `/api/billing` share this hook rather than getting their own: they
    // carry the same authenticated-actor and same-origin requirements as every other route here,
    // and reporting entitlement state or minting a Checkout/Portal session without knowing which
    // actor is asking would defeat the point of either.
    app.addHook('preValidation', async (request, reply) => {
      if (
        !request.url.startsWith('/api/projects') &&
        !request.url.startsWith('/api/screenplays') &&
        !request.url.startsWith('/api/deleted') &&
        !request.url.startsWith('/api/entitlement') &&
        !request.url.startsWith('/api/billing')
      )
        return;
      // Checked ahead of the session lookup: a forged cross-origin request is rejected outright
      // rather than paying for a database-backed session check first.
      if (!isTrustedOrigin(request.headers.origin, options.auth!.trustedOrigins, request.method))
        return reply.code(403).send({ error: 'Cross-origin request rejected' });
      const actorId = await options.auth!.getActorId(fromNodeHeaders(request.headers));
      if (!actorId) return reply.code(401).send({ error: 'Authentication required' });
      request.actorId = actorId;
    });
  }

  if (options.auth && options.entitlements) {
    const entitlementsStore = options.entitlements;
    typedApp.get(
      '/api/entitlement',
      { schema: { response: { 200: entitlementResponseSchema } } },
      async (request) =>
        describeEntitlement(await entitlementsStore.getSnapshot(request.actorId!, new Date())),
    );
    typedApp.put(
      '/api/entitlement/editable-screenplay',
      {
        schema: {
          body: switchEditableScreenplayInput,
          response: {
            200: switchEditableScreenplayResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await entitlementsStore.switchEditableScreenplay(
          request.actorId!,
          request.body.screenplayId,
          new Date(),
        );
        if (result.outcome === 'not-a-candidate')
          return reply.code(404).send({ error: 'Screenplay not found' });
        if (result.outcome === 'cooldown')
          return reply.code(409).send({
            error: 'The editable screenplay was changed recently; try again once the cooldown ends',
          });
        return { screenplayId: result.screenplayId, updatedAt: result.updatedAt.toISOString() };
      },
    );
  }

  if (options.auth && options.billing) {
    const billing = options.billing;
    typedApp.post(
      '/api/billing/checkout-session',
      {
        schema: {
          body: checkoutSessionInput,
          response: { 200: checkoutSessionResponseSchema, 502: errorResponseSchema },
        },
      },
      async (request, reply) => {
        try {
          return await createCheckoutSession(billing, request.actorId!, request.body.plan);
        } catch (error) {
          logStripeRequestFailure(request, 'checkout_session', error);
          return reply.code(502).send({ error: 'Could not start checkout. Try again shortly.' });
        }
      },
    );
    typedApp.post(
      '/api/billing/portal-session',
      {
        schema: {
          response: {
            200: portalSessionResponseSchema,
            404: errorResponseSchema,
            502: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        try {
          const result = await createPortalSession(billing, request.actorId!);
          if (result.outcome === 'no-customer') {
            return reply
              .code(404)
              .send({ error: 'No billing account yet. Subscribe first to manage billing.' });
          }
          return { url: result.url };
        } catch (error) {
          logStripeRequestFailure(request, 'portal_session', error);
          return reply
            .code(502)
            .send({ error: 'Could not open billing management. Try again shortly.' });
        }
      },
    );
    typedApp.get(
      '/api/billing/subscription',
      { schema: { response: { 200: billingSubscriptionResponseSchema } } },
      async (request) =>
        describeBillingSubscription(
          await billing.store.getSubscriptionForUser(request.actorId!),
          billing.priceIds,
        ),
    );
    typedApp.get(
      '/api/billing/plans',
      { schema: { response: { 200: billingPlansResponseSchema, 502: errorResponseSchema } } },
      async (request, reply) => {
        try {
          return await fetchBillingPlans(billing);
        } catch (error) {
          logStripeRequestFailure(request, 'billing_plans', error);
          return reply.code(502).send({ error: 'Could not load pricing. Try again shortly.' });
        }
      },
    );
  }

  if (options.auth && options.projects) {
    typedApp.get(
      '/api/projects',
      { schema: { response: { 200: z.array(projectListItemSchema) } } },
      async (request) => options.projects!.listProjects(request.actorId!),
    );
    typedApp.post(
      '/api/projects',
      { schema: { body: createProjectInput, response: { 201: createProjectResponseSchema } } },
      async (request, reply) =>
        reply
          .code(201)
          .send(await options.projects!.createProject(request.actorId!, request.body.title)),
    );
    typedApp.patch(
      '/api/projects/:id',
      {
        schema: {
          params: idParam,
          body: renameInput,
          response: {
            200: renameResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await options.projects!.renameProject(
          request.actorId!,
          request.params.id,
          request.body.title,
        );
        if (result === 'missing') return reply.code(404).send({ error: 'Project not found' });
        if (result === 'forbidden')
          return reply.code(403).send({ error: 'Project editor access required' });
        return result;
      },
    );
    typedApp.delete(
      '/api/projects/:id',
      {
        schema: {
          params: idParam,
          response: {
            200: deleteResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await options.projects!.deleteProject(request.actorId!, request.params.id);
        if (result === 'missing') return reply.code(404).send({ error: 'Project not found' });
        if (result === 'forbidden')
          return reply.code(403).send({ error: 'Project owner access required' });
        return result;
      },
    );
    typedApp.post(
      '/api/projects/:id/restore',
      {
        schema: {
          params: idParam,
          response: {
            200: renameResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await options.projects!.restoreProject(request.actorId!, request.params.id);
        if (result === 'missing') return reply.code(404).send({ error: 'Project not found' });
        if (result === 'forbidden')
          return reply.code(403).send({ error: 'Project owner access required' });
        return result;
      },
    );
    typedApp.get(
      '/api/projects/:id/screenplays',
      { schema: { params: idParam, response: { 200: z.array(screenplayListItemSchema) } } },
      async (request) => options.projects!.listScreenplays(request.actorId!, request.params.id),
    );
    typedApp.post(
      '/api/projects/:id/screenplays',
      {
        schema: {
          params: idParam,
          body: createScreenplayInput,
          response: {
            201: createScreenplayResponseSchema,
            402: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        try {
          return reply
            .code(201)
            .send(
              await options.projects!.createScreenplay(
                request.actorId!,
                request.params.id,
                request.body,
              ),
            );
        } catch (error) {
          // Checked ahead of `ForbiddenError`: entitlement enforcement (server.ts wraps
          // `options.projects` in `createEntitlementEnforcedProjectStore` before it ever reaches
          // here) throws its own distinct error type specifically so a billing-driven refusal is
          // never reported to the client -- or logged -- as a plain membership failure.
          //
          // 402 Payment Required, not 403: this slice adds a client (the free-tier limit prompt,
          // see routes/projects/$projectId/index.tsx) that needs to react specifically to "you
          // must pay to do this" and never to a plain membership failure -- the two used to share
          // 403 (set in slice 2, before any client needed to tell them apart), which is
          // indistinguishable without inspecting the message text. 402 is the status HTTP actually
          // reserves for this, and the distinction is real: 403 still means "you have no rights
          // here regardless of billing," 402 means "you have rights here, but not on the free
          // tier."
          if (error instanceof EntitlementLimitError)
            return reply.code(402).send({ error: error.message });
          if (error instanceof ForbiddenError)
            return reply.code(403).send({ error: 'Project editor access required' });
          throw error;
        }
      },
    );
    typedApp.get(
      '/api/screenplays/:id',
      {
        schema: {
          params: idParam,
          response: { 200: screenplayResponseSchema, 404: errorResponseSchema },
        },
      },
      async (request, reply) => {
        const screenplay = await options.projects!.getScreenplay(
          request.actorId!,
          request.params.id,
        );
        if (screenplay === 'missing')
          return reply.code(404).send({ error: 'Screenplay not found' });
        return screenplay;
      },
    );
    typedApp.put(
      '/api/screenplays/:id',
      {
        schema: {
          params: idParam,
          body: updateScreenplayInput,
          response: {
            200: updateScreenplayResponseSchema,
            400: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await options.projects!.updateScreenplay(
          request.actorId!,
          request.params.id,
          request.body,
        );
        if (result === 'missing') return reply.code(404).send({ error: 'Screenplay not found' });
        if (result === 'forbidden')
          return reply.code(403).send({ error: 'Screenplay editor access required' });
        if (result === 'invalid')
          return reply.code(400).send({ error: 'Screenplay identity must match request path' });
        if (result === 'conflict')
          return reply.code(409).send({ error: 'Screenplay changed; reload before saving' });
        return result;
      },
    );
    typedApp.patch(
      '/api/screenplays/:id',
      {
        schema: {
          params: idParam,
          body: renameInput,
          response: {
            200: renameResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await options.projects!.renameScreenplay(
          request.actorId!,
          request.params.id,
          request.body.title,
        );
        if (result === 'missing') return reply.code(404).send({ error: 'Screenplay not found' });
        if (result === 'forbidden')
          return reply.code(403).send({ error: 'Screenplay editor access required' });
        return result;
      },
    );
    typedApp.delete(
      '/api/screenplays/:id',
      {
        schema: {
          params: idParam,
          response: {
            200: deleteResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await options.projects!.deleteScreenplay(
          request.actorId!,
          request.params.id,
        );
        if (result === 'missing') return reply.code(404).send({ error: 'Screenplay not found' });
        if (result === 'forbidden')
          return reply.code(403).send({ error: 'Screenplay editor access required' });
        return result;
      },
    );
    typedApp.post(
      '/api/screenplays/:id/restore',
      {
        schema: {
          params: idParam,
          response: {
            200: renameResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await options.projects!.restoreScreenplay(
          request.actorId!,
          request.params.id,
        );
        if (result === 'missing') return reply.code(404).send({ error: 'Screenplay not found' });
        if (result === 'forbidden')
          return reply.code(403).send({ error: 'Screenplay editor access required' });
        return result;
      },
    );
    // Not `/api/projects/deleted`: `/api/projects/:id` already owns that path shape, so
    // `deleted` would bind as `:id` and fail UUID validation with a 400 before this handler
    // ever ran. Powers the Deleted page — see the ProjectStore.listDeleted interface comment
    // for how each collection is scoped to what the actor may actually restore.
    typedApp.get(
      '/api/deleted',
      { schema: { response: { 200: deletedResponseSchema } } },
      async (request) => options.projects!.listDeleted(request.actorId!),
    );
  }
  if (options.serveClient) {
    // Vite emits content-hashed filenames (e.g. `index-CD6YQ5bG.js`), so every distinct build of
    // a given asset lives at its own URL forever -- `immutable` plus a one-year `maxAge` is
    // correct, not just permissive, because the URL itself changes the moment the content does.
    // `index.html` needs the opposite policy; see the `onSend` hook above for why that carve-out
    // has to live there instead of in this registration's own `setHeaders` option.
    await app.register(fastifyStatic, {
      root: options.clientRoot ?? new URL('../../web/dist/', import.meta.url),
      wildcard: false,
      maxAge: '1y',
      immutable: true,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/'))
        return reply.code(404).send({ error: 'Not found' });
      reply.indexFallback = true;
      return reply.sendFile('index.html');
    });
  }
  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    actorId?: string;
  }
  interface FastifyReply {
    indexFallback?: boolean;
  }
}
