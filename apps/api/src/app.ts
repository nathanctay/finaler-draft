import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import {
  ForbiddenError,
  type ProjectStore,
  createProjectInput,
  parseCreateScreenplayInput,
  parseUpdateScreenplayInput,
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

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    bodyLimit: MAX_SCREENPLAY_REQUEST_BODY_BYTES,
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'warn',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    },
  });
  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 413) return reply.code(413).send({ error: 'Request too large' });
    if (error instanceof z.ZodError || (error instanceof Error && error.name === 'ZodError'))
      return reply.code(400).send({ error: 'Invalid request' });
    request.log.error(
      { err: error instanceof Error ? error.name : 'UnknownError' },
      'Request failed',
    );
    return reply.code(500).send({ error: 'Internal server error' });
  });
  app.get('/api/health', async () => ({ status: 'ok' as const }));

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
    app.addHook('preHandler', async (request, reply) => {
      if (!request.url.startsWith('/api/projects') && !request.url.startsWith('/api/screenplays'))
        return;
      const actorId = await options.auth!.getActorId(fromNodeHeaders(request.headers));
      if (!actorId) return reply.code(401).send({ error: 'Authentication required' });
      request.actorId = actorId;
    });
    app.get('/api/projects', async (request) => options.projects!.listProjects(request.actorId!));
    app.post('/api/projects', async (request, reply) =>
      reply
        .code(201)
        .send(
          await options.projects!.createProject(
            request.actorId!,
            createProjectInput.parse(request.body).title,
          ),
        ),
    );
    app.get('/api/projects/:id/screenplays', async (request) =>
      options.projects!.listScreenplays(request.actorId!, idParam.parse(request.params).id),
    );
    app.post('/api/projects/:id/screenplays', async (request, reply) => {
      try {
        return reply
          .code(201)
          .send(
            await options.projects!.createScreenplay(
              request.actorId!,
              idParam.parse(request.params).id,
              parseCreateScreenplayInput(request.body),
            ),
          );
      } catch (error) {
        if (error instanceof ForbiddenError)
          return reply.code(403).send({ error: 'Project editor access required' });
        throw error;
      }
    });
    app.get('/api/screenplays/:id', async (request, reply) => {
      const screenplay = await options.projects!.getScreenplay(
        request.actorId!,
        idParam.parse(request.params).id,
      );
      if (screenplay === 'missing') return reply.code(404).send({ error: 'Screenplay not found' });
      return screenplay;
    });
    app.put('/api/screenplays/:id', async (request, reply) => {
      const result = await options.projects!.updateScreenplay(
        request.actorId!,
        idParam.parse(request.params).id,
        parseUpdateScreenplayInput(request.body),
      );
      if (result === 'missing') return reply.code(404).send({ error: 'Screenplay not found' });
      if (result === 'forbidden')
        return reply.code(403).send({ error: 'Screenplay editor access required' });
      if (result === 'invalid')
        return reply.code(400).send({ error: 'Screenplay identity must match request path' });
      if (result === 'conflict')
        return reply.code(409).send({ error: 'Screenplay changed; reload before saving' });
      return result;
    });
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
