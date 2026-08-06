import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

export interface BuildAppOptions {
  serveClient?: boolean;
  clientRoot?: URL;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'warn',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    },
  });

  app.get('/api/health', async () => ({ status: 'ok' as const }));

  if (options.serveClient) {
    await app.register(fastifyStatic, {
      root: options.clientRoot ?? new URL('../../web/dist/', import.meta.url),
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }

      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
