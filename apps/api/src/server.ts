import { findPersistenceEnvironment, parseServerEnvironment } from '@finaler-draft/server-config';
import { createAuth } from './auth.js';
import { buildApp } from './app.js';
import { loadRootEnvironment, shouldLoadRootEnvironment } from './environment.js';
import { createPostgresProjectStore } from './projects.js';

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
  options: { serveClient: boolean },
) {
  const { auth, pool } = createAuth(persistence);
  const app = await buildApp({
    ...options,
    auth: {
      baseUrl: persistence.BETTER_AUTH_URL,
      handler: auth.handler,
      getActorId: async (headers) => (await auth.api.getSession({ headers }))?.user.id ?? null,
    },
    projects: createPostgresProjectStore(pool),
  });
  app.addHook('onClose', async () => {
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
