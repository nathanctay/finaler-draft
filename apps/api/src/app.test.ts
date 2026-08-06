import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe('GET /api/health', () => {
  it('returns an explicit healthy status', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('production client serving', () => {
  it('uses the default client root when no override is supplied', async () => {
    const productionApp = await buildApp({ serveClient: true });

    try {
      const response = await productionApp.inject({ method: 'GET', url: '/api/health' });

      expect(response.statusCode).toBe(200);
    } finally {
      await productionApp.close();
    }
  });

  it('serves the client entry point while preserving API 404 responses', async () => {
    const productionApp = await buildApp({
      serveClient: true,
      clientRoot: new URL('./fixtures/web/', import.meta.url),
    });

    try {
      const clientResponse = await productionApp.inject({
        method: 'GET',
        url: '/writer/the-long-way-home',
      });
      const apiResponse = await productionApp.inject({ method: 'GET', url: '/api/unknown' });

      expect(clientResponse.statusCode).toBe(200);
      expect(clientResponse.body).toContain('Finaler Draft workspace fixture');
      expect(apiResponse.statusCode).toBe(404);
      expect(apiResponse.json()).toEqual({ error: 'Not found' });
    } finally {
      await productionApp.close();
    }
  });
});

describe('logging', () => {
  it('raises the logging threshold in production', async () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const productionApp = await buildApp();

    try {
      expect(productionApp.log.level).toBe('info');
    } finally {
      await productionApp.close();
      if (previousEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousEnvironment;
      }
    }
  });
});
