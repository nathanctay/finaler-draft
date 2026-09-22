import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { checkMigrations } from './migrationCheck.js';
import { formatMigrationCheckMessage } from './migrationCheckMessage.js';

/**
 * The `pnpm dev` preflight this whole module exists for: a pending migration, run against
 * `apps/api` or `apps/collab` instead of a developer's terminal, used to surface as a confusing
 * failure well downstream of the actual cause (a missing table read back as an authentication
 * denial; a health check staying green while sign-up failed with `relation "user" does not
 * exist`). This runs once, here, before either server starts, and fails loudly with the exact
 * fix -- rather than each server discovering the same problem independently at its own boot and
 * printing two interleaved, redundant diagnoses under `pnpm dev`'s `--parallel --stream`.
 *
 * Deliberately does not apply the pending migration itself. `db:migrate` already exists as an
 * explicit, single-purpose command; a developer (or, in production, the `preDeploy` step in
 * `.railway/railway.ts`) runs it on purpose. Auto-applying it here would turn every `pnpm dev`
 * into a place a schema change can happen silently and unreviewed -- exactly the failure mode a
 * migration workflow exists to prevent -- in exchange for saving one command's worth of typing.
 *
 * Mirrors `apps/api/src/environment.ts` and `apps/collab/src/environment.ts`'s own
 * `loadRootEnvironment`/`shouldLoadRootEnvironment` pair (same two functions, same reasoning) as a
 * third small copy rather than a shared package: this is another seven-line concern -- "read this
 * literal path if it exists" -- with no real risk of three copies drifting apart from each other.
 */
const rootEnvironmentFile = fileURLToPath(new URL('../../../.env', import.meta.url));

function shouldLoadRootEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return (
    (environment.NODE_ENV === undefined || environment.NODE_ENV === 'development') &&
    environment.FINALER_SYSTEM_TEST !== 'true'
  );
}

function loadRootEnvironment(): void {
  if (!existsSync(rootEnvironmentFile)) return;
  loadEnvFile(rootEnvironmentFile);
}

/**
 * Bounded the same way `@finaler-draft/database`'s own `createDatabase` bounds its pool
 * (`index.ts`): without a `connectionTimeoutMillis`, pg's own default is falsy, which its
 * pool implementation treats as "no timeout at all" -- an unresponsive host (up, but silently
 * dropping packets, as opposed to outright refusing the connection) would hang this script, and
 * therefore `pnpm dev` itself, indefinitely instead of failing with the clear `unreachable`
 * message this check exists to produce.
 */
const CONNECTION_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  if (shouldLoadRootEnvironment(process.env)) {
    loadRootEnvironment();
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      [
        'DATABASE_URL is not set.',
        '',
        'apps/api and apps/collab both need a database to start. Set DATABASE_URL in your .env',
        '(see .env.example) and try again.',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
  try {
    const result = await checkMigrations({ pool });
    if (!result.ok) {
      console.error(formatMigrationCheckMessage(result));
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    'Unexpected error while checking the database migration state:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
