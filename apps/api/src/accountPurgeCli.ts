import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createPostgresAccountPurgeStore } from './accountPurge.js';
import { loadRootEnvironment, shouldLoadRootEnvironment } from './environment.js';

/**
 * The entry point `.railway/railway.ts`'s `accountPurge` cron service runs, on a schedule, as its
 * `start` command. See `accountPurge.ts`'s own module doc comment for what it does; this file is
 * only "connect, run once, close, exit" -- the plumbing Railway's own cron contract requires.
 *
 * **Railway's hard constraint, quoted directly from its docs:** a cron service "executes the
 * start command for that service on the given schedule," and the process "must exit and leave no
 * open resources" -- "If the code that runs in your Cron service does not exit, subsequent
 * executions of the Cron will be skipped." A silently skipped purge is exactly the class of
 * failure this project has already paid for once (progress/deploy-visibility.md's thirteen silent
 * days), so this is not treated as an incidental detail: closing the pool is in a `finally`, not
 * merely at the end of the happy path, and `accountPurgeCli.test.ts`'s "closes the pool exactly
 * once, success or failure" and `accountPurgeCli.integration.test.ts`'s "the compiled CLI
 * actually exits" both assert it against the real behaviour rather than trusting this comment.
 *
 * **Deliberately does not use `@finaler-draft/server-config`'s `requirePersistenceEnvironment`.**
 * That schema is the full `apps/api` server's persistence contract -- in production it additionally
 * demands `STRIPE_SECRET_KEY`, `COLLAB_TOKEN_SECRET`, `FEEDBACK_MAIL_TO`, and more, none of which
 * this script ever touches (Stripe cancellation already happened in slice B; this script only
 * removes database rows). Reusing it would make this cron fail to start in production over a
 * missing variable it has no use for -- a false dependency, not a safety net. `DATABASE_URL` is
 * the only environment this script actually needs, and it is checked directly, with the same
 * "fail loudly, at startup, with the exact fix" shape `checkMigrationsCli.ts`
 * (`@finaler-draft/database`) already uses for the identical variable.
 */

const CONNECTION_TIMEOUT_MS = 5_000;

function parseArgs(argv: readonly string[]): { dryRun: boolean } {
  return { dryRun: argv.includes('--dry-run') };
}

/** A `pg.Pool`-shaped minimum this module actually needs, so a test can inject a fake one instead
 * of opening a real connection just to prove `main`'s own control flow (argument parsing, the
 * missing-`DATABASE_URL` exit, and -- the one this file exists to guarantee -- that the pool is
 * always closed). `accountPurgeCli.integration.test.ts` separately proves the real, compiled CLI
 * against a real database and a real child process exit code. */
export type PoolLike = Pick<Pool, 'query' | 'connect' | 'end'>;

export interface AccountPurgeCliResult {
  exitCode: number;
}

/**
 * The testable core of this CLI: everything `main` below does, minus actually reading
 * `process.env`/`process.argv` and minus constructing a real `Pool` -- both are passed in, so a
 * test can supply a fake environment and a fake pool. Never throws; every failure becomes a
 * logged, structured event and an `exitCode: 1`, which is what lets `main` turn this into a
 * process exit code without a second, duplicate `try`/`catch`.
 */
export async function runAccountPurgeCli(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  createPool: (connectionString: string) => PoolLike = (connectionString) =>
    new Pool({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS }),
): Promise<AccountPurgeCliResult> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(JSON.stringify({ event: 'account_purge_missing_database_url' }));
    return { exitCode: 1 };
  }

  const { dryRun } = parseArgs(argv);
  const pool = createPool(databaseUrl);
  try {
    const store = createPostgresAccountPurgeStore(pool as Pool);
    await store.run({ dryRun });
    return { exitCode: 0 };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'account_purge_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    return { exitCode: 1 };
  } finally {
    // The one statement this whole file exists to guarantee runs -- see the module doc comment's
    // Railway constraint. `finally`, not the end of the `try` block, so it still runs when
    // `store.run` throws, and `await`ed, not fire-and-forget, so the pool's sockets are actually
    // closed before this function (and therefore `main`, and therefore the process) returns.
    await pool.end();
  }
}

/** Exported so `accountPurgeCli.test.ts` can exercise the real environment-reading wiring
 * directly (e.g. a missing `DATABASE_URL`, which fails before ever opening a socket) without
 * going through the process-entry guard below, which deliberately never fires under Vitest. */
export async function main(): Promise<void> {
  if (shouldLoadRootEnvironment(process.env)) {
    loadRootEnvironment();
  }
  const result = await runAccountPurgeCli(process.env, process.argv.slice(2));
  process.exitCode = result.exitCode;
}

// Only runs the real CLI when this file is the process's entry point -- `import.meta.url` is a
// `file://` URL and `process.argv[1]` a bare path, so they are compared through `pathToFileURL`
// rather than string-glued, which would silently never match on platforms (or path forms) where
// the two spellings differ. Guards `accountPurgeCli.test.ts`'s `import` of `runAccountPurgeCli`
// from also executing a real `main()` against the real environment as a side effect of loading
// this module under Vitest.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'account_purge_unexpected_error',
        error: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    process.exitCode = 1;
  });
}
