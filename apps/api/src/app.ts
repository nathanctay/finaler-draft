import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { screenplaySchema } from '@finaler-draft/screenplay';
import {
  DEFAULT_API_RATE_LIMIT_MAX,
  DEFAULT_API_RATE_LIMIT_WINDOW_MS,
} from '@finaler-draft/server-config';
import Fastify from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import {
  type ZodTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { MailMessage } from './mail.js';
import {
  ForbiddenError,
  type ProjectStore,
  createProjectInput,
  createScreenplayInput,
  renameInput,
  updateScreenplayInput,
} from './projects.js';

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

export interface BuildAppOptions {
  serveClient?: boolean;
  clientRoot?: URL;
  auth?: AuthPort;
  projects?: ProjectStore;
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

  if (options.auth) {
    app.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      async handler(request, reply) {
        try {
          const response = await options.auth!.handler(
            new Request(new URL(request.raw.url ?? request.url, options.auth!.baseUrl).toString(), {
              method: request.method,
              headers: fromNodeHeaders(request.headers),
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

  if (options.auth && options.projects) {
    // Runs as `preValidation`, not `preHandler`. Fastify's request lifecycle runs
    // preValidation -> schema validation -> preHandler -> the route handler, and before this
    // refactor every id/body check was a manual `.parse()` call inside the handler, i.e. later
    // than `preHandler`. So an unauthenticated request with a malformed id or body has always
    // been rejected for authentication first (401), never for validation (400). Declaring
    // `params`/`body` as route schemas moves validation ahead of `preHandler`; keeping this check
    // in `preValidation` (ahead of validation too) is what keeps that precedence, and that
    // precedence, byte-identical to before.
    app.addHook('preValidation', async (request, reply) => {
      if (
        !request.url.startsWith('/api/projects') &&
        !request.url.startsWith('/api/screenplays') &&
        !request.url.startsWith('/api/deleted')
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
          response: { 201: createScreenplayResponseSchema, 403: errorResponseSchema },
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
