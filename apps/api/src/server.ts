import { parseServerEnvironment } from '@finaler-draft/config';
import { buildApp } from './app.js';

try {
  const environment = parseServerEnvironment(process.env);
  const app = await buildApp({ serveClient: environment.NODE_ENV === 'production' });
  await app.listen({ host: '0.0.0.0', port: environment.PORT });
} catch (error) {
  console.error(JSON.stringify({ event: 'server_start_failed', error: describeError(error) }));
  process.exitCode = 1;
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: 'UnknownError', message: 'An unknown startup error occurred.' };
}
