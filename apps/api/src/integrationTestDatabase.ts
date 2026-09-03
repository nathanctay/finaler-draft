import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool, type PoolConfig } from 'pg';

const executeFile = promisify(execFile);

// Postgres's own SQLSTATE for "object_in_use" -- what `drop database` raises when sessions are
// still connected to it (e.g. "database "x" is being accessed by other users"). Matched on the
// code, not the message text, since the message is not guaranteed stable across Postgres
// versions.
const OBJECT_IN_USE = '55006';

/**
 * Shared support for this package's `*.integration.test.ts` suites, each of which provisions a
 * fresh, throwaway database, migrates it with the project's own tooling, and drops it in
 * `afterAll`. Consolidates that sequence in one place -- and, critically, fixes the teardown race
 * all three used to share: `pg_terminate_backend` unconditionally killed every remaining
 * connection to the database before dropping it, including a pool client that was still mid
 * graceful-close after its own `pool.end()` had already resolved. Postgres then raised
 * `57P01` ("terminating connection due to administrator command") on that client asynchronously,
 * with nothing left awaiting it -- Vitest reported it as an unhandled error and failed an
 * otherwise fully-passing run (see progress/integration-teardown-race.md).
 *
 * The fix: attempt the plain `drop database` first. In the ordinary case, `pool.end()` really did
 * finish and there is nothing left to terminate, so the drop just succeeds and no client is ever
 * killed. Only when the drop reports the database is still in use (SQLSTATE 55006) does this fall
 * back to `pg_terminate_backend` and retry -- the genuinely exceptional case terminate was meant
 * for, not the common path.
 */

/** A freshly generated, not-yet-created throwaway database name and its connection string. */
export interface IntegrationTestDatabaseName {
  readonly databaseName: string;
  readonly databaseUrl: string;
}

/**
 * Generates a unique throwaway database name and its connection string against `adminUrl`,
 * without creating anything yet. Split out from `createIntegrationDatabase` because every caller
 * needs `databaseUrl` synchronously at module scope, to decide `describe.skipIf(!databaseUrl)`,
 * before `beforeAll` (and its `await`s) ever runs.
 */
export function planIntegrationTestDatabase(adminUrl: string): IntegrationTestDatabaseName {
  const databaseName = `finaler_draft_test_${randomUUID().replaceAll('-', '')}`;
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${databaseName}`;
  return { databaseName, databaseUrl: parsed.toString() };
}

/**
 * Attaches the mandatory error listener a `pg` `Pool` needs before it is ever handed to code that
 * might outlive one of its clients: node-postgres surfaces a pooled client that errors while idle
 * (including one killed mid-shutdown by `dropIntegrationTestDatabase`'s terminate-and-retry
 * fallback below) as an `error` event on the pool, and a pool with no listener for that event
 * turns it into an unhandled process-level exception instead. This is belt-and-braces alongside
 * the drop-first fix above: the retry removes the cause, this removes the failure mode, so a
 * client killed for any other reason during teardown still can't fail the run.
 */
export function suppressPoolShutdownErrors(pool: Pool): Pool {
  pool.on('error', (error) => {
    console.error('Integration test pool error after shutdown (ignored):', error);
  });
  return pool;
}

/** `new Pool(...)` with `suppressPoolShutdownErrors` already attached. */
export function createIntegrationPool(config: PoolConfig): Pool {
  return suppressPoolShutdownErrors(new Pool(config));
}

/**
 * Creates the throwaway database itself. Callers own the admin `Pool` (via
 * `createIntegrationPool`) so they can keep using it afterward, e.g. to seed fixture rows or run
 * `dropIntegrationTestDatabase` later.
 */
export async function createIntegrationDatabase(admin: Pool, databaseName: string): Promise<void> {
  await admin.query(`create database ${quoteIdentifier(databaseName)}`);
}

/** Runs this repo's real migration tooling against `databaseUrl`. */
export async function runIntegrationMigrations(databaseUrl: string): Promise<void> {
  await executeFile('pnpm', ['--filter', '@finaler-draft/database', 'db:migrate'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

/**
 * Drops `databaseName`, trying the plain `drop database` first and terminating remaining backends
 * only if that reports the database still in use. See the module doc comment above for why this
 * ordering, not always-terminate, is the fix.
 */
export async function dropIntegrationTestDatabase(
  admin: Pool,
  databaseName: string,
): Promise<void> {
  try {
    await admin.query(`drop database ${quoteIdentifier(databaseName)}`);
  } catch (error) {
    if (!isObjectInUse(error)) throw error;
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`drop database if exists ${quoteIdentifier(databaseName)}`);
  }
}

function isObjectInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === OBJECT_IN_USE
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
