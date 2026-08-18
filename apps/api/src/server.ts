import { findPersistenceEnvironment, parseServerEnvironment } from '@finaler-draft/server-config';
import { createAuth } from './auth.js';
import { buildApp } from './app.js';
import { cachedProbe } from './cachedProbe.js';
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
  const { auth, pool, trustedOrigins } = createAuth(persistence);
  const app = await buildApp({
    ...options,
    auth: {
      baseUrl: persistence.BETTER_AUTH_URL,
      handler: auth.handler,
      getActorId: async (headers) => (await auth.api.getSession({ headers }))?.user.id ?? null,
      trustedOrigins,
    },
    projects: createPostgresProjectStore(pool),
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
