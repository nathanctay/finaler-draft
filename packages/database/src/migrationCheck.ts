import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from 'pg';
import {
  compareMigrationState,
  type AppliedMigration,
  type JournalMigration,
} from './migrationStatus.js';

/**
 * The I/O half of the pending-migration check: reading this checkout's own migration journal off
 * disk, reading what a database has recorded as applied, and telling the two apart from a genuine
 * connectivity failure. `migrationStatus.ts` owns the actual comparison and stays pure; everything
 * here is either a filesystem read or a database round trip, which is why this file -- not that
 * one -- is where every test in this module needs either a real temp directory or a real
 * database, not a mock standing in for one.
 */

/** `packages/database/drizzle`, resolved relative to this file so it is correct whether this runs
 * from `src` (vitest, ts-node) or from `dist` (the built CLI) -- both sit one level below
 * `packages/database`, exactly where `drizzle/` itself lives. */
const DEFAULT_DRIZZLE_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

interface JournalFile {
  readonly entries: ReadonlyArray<{ readonly idx: number; readonly tag: string }>;
}

/**
 * Reads every migration this checkout's journal declares, in journal order, hashing each `.sql`
 * file's raw contents exactly the way drizzle-orm's own migrator does (confirmed by reading the
 * installed package's `pg-core/dialect.cjs`: `crypto.createHash("sha256").update(query)`, where
 * `query` is the untouched file contents -- not the statement-breakpoint-split pieces it also
 * computes for actually running the SQL). Matching that computation byte-for-byte is what lets
 * `compareMigrationState` compare against `__drizzle_migrations.hash` directly, without
 * reimplementing or second-guessing how drizzle itself decides a migration's identity.
 */
export async function readJournalMigrations(
  drizzleDir: string = DEFAULT_DRIZZLE_DIR,
): Promise<JournalMigration[]> {
  const journalPath = path.join(drizzleDir, 'meta', '_journal.json');
  const journalRaw = await readFile(journalPath, 'utf8');
  const journal = JSON.parse(journalRaw) as JournalFile;
  const orderedEntries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  return Promise.all(
    orderedEntries.map(async (entry) => {
      const sqlPath = path.join(drizzleDir, `${entry.tag}.sql`);
      const contents = await readFile(sqlPath, 'utf8');
      return { tag: entry.tag, hash: createHash('sha256').update(contents).digest('hex') };
    }),
  );
}

/** Postgres's SQLSTATE for "undefined_table" -- what a `select` against `__drizzle_migrations`
 * raises when neither the `drizzle` schema nor the table exist yet, i.e. a database that has
 * never had a single migration applied to it. Not an error condition for this check: it is
 * indistinguishable from (and handled identically to) "zero migrations applied," which
 * `compareMigrationState` already reports as `behind` with every journal entry pending. */
const UNDEFINED_TABLE = '42P01';

/**
 * Reads what `pool`'s database has actually recorded as applied, ordered by `id` -- the bookkeeping
 * table's own serial primary key, which reflects true application order even in the (practically
 * impossible, but not assumed away) case of two migrations sharing a `created_at` millisecond.
 * Never writes anything: unlike drizzle's own migrator, which `CREATE SCHEMA IF NOT EXISTS`s and
 * `CREATE TABLE IF NOT EXISTS`s this table as a side effect of checking it, this is a read-only
 * check and must not mutate a database it is merely inspecting -- a missing table is read as "no
 * migrations applied," not created.
 */
export async function queryAppliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  try {
    const result = await pool.query<{ hash: string }>(
      'select hash from drizzle.__drizzle_migrations order by id asc',
    );
    return result.rows;
  } catch (error) {
    if (hasSqlState(error, UNDEFINED_TABLE)) return [];
    throw error;
  }
}

function hasSqlState(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/**
 * Node/pg's own signatures for "could not reach the server at all," as distinct from a query that
 * reached a real Postgres and failed for some other reason (wrong credentials, insufficient
 * privilege, ...). This distinction is the entire point of a separate `unreachable` result: the
 * owner mis-diagnosed a missing table as a database outage once already (see the module comment
 * on `checkMigrations` below), and conflating the two here would make that mistake easy to repeat.
 * `ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`/`ENETUNREACH`/`ETIMEDOUT` are Node's own `net` module
 * error codes for a TCP connection that never established; `'timeout expired'` is the literal
 * message pg's own `Client` throws when `connectionTimeoutMillis` elapses waiting on a connection
 * that neither succeeds nor fails outright (confirmed by reading the installed `pg/lib/client.js`)
 * -- a silently unresponsive host, not a Postgres-level rejection.
 */
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true;
  return error.message === 'timeout expired';
}

export type MigrationCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unreachable'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'queryFailed'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'behind'; readonly pending: readonly string[] }
  | { readonly ok: false; readonly reason: 'ahead'; readonly extraAppliedCount: number }
  | {
      readonly ok: false;
      readonly reason: 'diverged';
      readonly atIndex: number;
      readonly journalTag: string;
    };

export interface MigrationCheckOptions {
  readonly pool: Pool;
  /** Overridable for tests only; production callers always get `packages/database/drizzle`. */
  readonly drizzleDir?: string;
}

/**
 * Ties `readJournalMigrations` and `queryAppliedMigrations` together into the single answer a
 * caller actually wants: is this database current, and if not, exactly how is it not current.
 *
 * A database that cannot be reached at all is reported as `unreachable`, before `behind`/`ahead`/
 * `diverged` are ever considered -- Postgres being down and a migration being pending are two
 * different problems with two different fixes, and the incident this check exists to prevent was
 * made worse, not better, by a diagnosis that conflated them (`onLoadDocument`'s failure surfaced
 * as an authentication denial; the owner's first theory was a database outage, and the actual
 * cause -- one missing table -- took three sessions to find specifically because nothing said so
 * directly). A query that fails for some other reason entirely (bad credentials, insufficient
 * privilege on the `drizzle` schema) is reported as `queryFailed` rather than folded into either
 * bucket, for the identical reason: neither "start Postgres" nor "run db:migrate" is the right
 * next step for those, and telling a developer the wrong one is worse than a generic message.
 */
export async function checkMigrations(
  options: MigrationCheckOptions,
): Promise<MigrationCheckResult> {
  const journal = await readJournalMigrations(options.drizzleDir);

  let applied: AppliedMigration[];
  try {
    applied = await queryAppliedMigrations(options.pool);
  } catch (error) {
    if (isConnectionError(error)) {
      return { ok: false, reason: 'unreachable', detail: describeError(error) };
    }
    return { ok: false, reason: 'queryFailed', detail: describeError(error) };
  }

  const comparison = compareMigrationState(journal, applied);
  switch (comparison.kind) {
    case 'upToDate':
      return { ok: true };
    case 'behind':
      return { ok: false, reason: 'behind', pending: comparison.pending };
    case 'ahead':
      return { ok: false, reason: 'ahead', extraAppliedCount: comparison.extraAppliedCount };
    case 'diverged':
      return {
        ok: false,
        reason: 'diverged',
        atIndex: comparison.atIndex,
        journalTag: comparison.journalTag,
      };
  }
}

/** `error.message` only -- never the error object itself, which for a `pg` connection failure can
 * carry the attempted connection's own fields. This service's message strings never include a
 * connection string, so callers may print this directly. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
