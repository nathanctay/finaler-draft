import fastifyStatic from '@fastify/static';
import { screenplaySchema } from '@finaler-draft/screenplay';
import Fastify from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import {
  type ZodTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
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
 * A request with no `Origin` header at all is not rejected here. Every state-changing request
 * these routes accept is POST/PUT/PATCH/DELETE, and current browsers attach `Origin` to same-origin
 * fetch/XHR requests using those methods without exception, so an absent header is not the
 * legitimate case this function needs to protect. Failing closed on "absent" as well as "present
 * but wrong" was considered and rejected: it would reject every request made through Fastify's own
 * `.inject()` test helper (which sends no `Origin` unless a test sets one explicitly) across every
 * existing test in this file and the integration suite, for a case modern browsers don't produce.
 * This is deliberately narrower than a full CSRF-token scheme; it closes the specific attack an
 * audit of this repository demonstrated (a forged `Origin` reaching a restore handler and
 * succeeding), not every conceivable request-forgery vector.
 */
function isTrustedOrigin(originHeader: string | undefined, trustedOrigins: readonly string[]) {
  if (!originHeader) return true;
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
  // See the `onSend` hook below: this marks a reply as "serving index.html via the SPA
  // fallback" structurally, so the no-cache override there does not depend on sniffing a
  // Content-Type header that a 304 response is free to omit.
  app.decorateReply('indexFallback', false);
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 413) return reply.code(413).send({ error: 'Request too large' });
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
      if (!isTrustedOrigin(request.headers.origin, options.auth!.trustedOrigins))
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
