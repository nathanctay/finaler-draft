import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { DEFAULT_COLLAB_DEV_PORT } from '@finaler-draft/config';
import { parseServerEnvironment } from '@finaler-draft/server-config';

// Mirrors `apps/api/src/environment.ts` exactly (same three functions, same reasoning): loads the
// monorepo-root `.env` for local development only, never in a system-test or production process.
// Kept as a second small copy rather than a third shared package for one seven-line concern --
// unlike `createAuth` and `checkEntitlement`, there is no risk of two copies of "read this literal
// path if it exists" drifting into disagreement.
const rootEnvironmentFile = fileURLToPath(new URL('../../../.env', import.meta.url));

export function loadRootEnvironment(): void {
  if (!existsSync(rootEnvironmentFile)) return;
  loadEnvFile(rootEnvironmentFile);
}

export function shouldLoadRootEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return (
    (environment.NODE_ENV === undefined || environment.NODE_ENV === 'development') &&
    environment.FINALER_SYSTEM_TEST !== 'true'
  );
}

/**
 * `apps/collab`'s own environment requirement, deliberately narrower than
 * `@finaler-draft/server-config`'s `requirePersistenceEnvironment`: that function also mandates
 * Resend and Stripe configuration, which belong to `apps/api` alone -- this service never sends
 * mail and never talks to Stripe. Reusing `parseServerEnvironment` (the safe-defaults parser
 * shared by every server process, per that package's own doc comment on why it exists) and adding
 * only the check this service actually needs keeps the parsing itself -- and its defaults -- in
 * exactly one place, without inheriting requirements this process cannot satisfy and does not
 * need to.
 */
export interface CollabPersistenceEnvironment {
  readonly DATABASE_URL: string;
  readonly BETTER_AUTH_SECRET: string;
  readonly BETTER_AUTH_URL: string;
  readonly CLIENT_ORIGIN: string | undefined;
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly PORT: number;
}

export function requireCollabPersistenceEnvironment(
  environment: NodeJS.ProcessEnv,
): CollabPersistenceEnvironment {
  const parsed = parseServerEnvironment(environment);
  if (!parsed.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (!parsed.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is required.');
  if (!parsed.BETTER_AUTH_URL) throw new Error('BETTER_AUTH_URL is required.');
  return {
    DATABASE_URL: parsed.DATABASE_URL,
    BETTER_AUTH_SECRET: parsed.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: parsed.BETTER_AUTH_URL,
    CLIENT_ORIGIN: parsed.CLIENT_ORIGIN,
    NODE_ENV: parsed.NODE_ENV,
    PORT: resolveCollabPort(environment, parsed),
  };
}

/**
 * `PORT` (parsed above via `parseServerEnvironment`) is ambient, shared configuration: `apps/api`
 * reads the identical variable, off the identical root `.env` (`loadRootEnvironment` above), via
 * its own copy of this same loading logic. That is harmless in production and in the system-test
 * harness, where each process is handed its own `PORT` directly and never shares a file with a
 * sibling process (Railway assigns one `PORT` per service; `playwright.persistence.config.ts`'s
 * `webServer` entries pass `PORT=4174`/`PORT=4175` straight into each spawned command). It is not
 * harmless under `pnpm dev`: that script starts `apps/api` and `apps/collab` in parallel, both
 * loading the same root `.env`, so both would resolve the identical `PORT` and the second process
 * to bind loses with `EADDRINUSE`.
 *
 * `COLLAB_PORT` is this service's own escape hatch out of that: an explicit `COLLAB_PORT`
 * always wins. Absent that, a real local run (`NODE_ENV` resolving to `'development'` -- the same
 * condition `shouldLoadRootEnvironment` above treats as "this is a real local process") falls back
 * to `DEFAULT_COLLAB_PORT` instead of the ambient `PORT`, so `pnpm dev` works with no `.env` edit
 * and no manual per-process override. Production and the system-test harness both set `NODE_ENV`
 * to something other than `'development'` (`'production'`, `'test'`) and both hand `PORT` directly
 * to this one process, so they fall through to `parsed.PORT` unchanged -- Railway's assignment, or
 * the harness's explicit override, keeps winning exactly as before.
 *
 * The actual port number (`DEFAULT_COLLAB_DEV_PORT`) lives in `@finaler-draft/config`, not here:
 * `apps/web`'s dev server needs the identical number for its own `VITE_COLLAB_WS_URL` fallback
 * (`collabConfig.ts`), and `@finaler-draft/config` is exactly the package that exists for a
 * plain, secret-free constant a server process and a browser bundle both need to agree on --
 * see its own doc comment on this export for why 4400 rather than Hocuspocus's conventional 1234.
 */
function resolveCollabPort(
  environment: NodeJS.ProcessEnv,
  parsed: Pick<ReturnType<typeof parseServerEnvironment>, 'NODE_ENV' | 'PORT'>,
): number {
  if (environment.COLLAB_PORT !== undefined) return parseCollabPort(environment.COLLAB_PORT);
  return parsed.NODE_ENV === 'development' ? DEFAULT_COLLAB_DEV_PORT : parsed.PORT;
}

function parseCollabPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`COLLAB_PORT must be an integer between 1 and 65535, got "${value}".`);
  }
  return port;
}
