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
}

export interface BuildAppOptions {
  serveClient?: boolean;
  clientRoot?: URL;
  auth?: AuthPort;
  projects?: ProjectStore;
}

const idParam = z.object({ id: z.string().uuid() });
export const MAX_SCREENPLAY_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

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
  typedApp.get(
    '/api/health',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
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
      if (!request.url.startsWith('/api/projects') && !request.url.startsWith('/api/screenplays'))
        return;
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
  }
  if (options.serveClient) {
    await app.register(fastifyStatic, {
      root: options.clientRoot ?? new URL('../../web/dist/', import.meta.url),
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) =>
      request.method === 'GET' && !request.url.startsWith('/api/')
        ? reply.sendFile('index.html')
        : reply.code(404).send({ error: 'Not found' }),
    );
  }
  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    actorId?: string;
  }
}
