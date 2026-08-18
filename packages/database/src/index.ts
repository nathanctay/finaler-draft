import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export { schema };
export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 10,
    // node-postgres's own default for `connectionTimeoutMillis` is falsy, which its pool
    // implementation (pg-pool) treats as "no timeout at all" (reading its installed source,
    // `lib/index.js`'s `connect` skips setting a timer entirely when this is unset) -- a request
    // for a client from an exhausted pool queues forever with no error. Every mutation route
    // holds a client across several round trips while it holds a `for update` lock, so a burst of
    // saves can exhaust the pool; without this, that presents as a silently hung request instead
    // of a fast, retryable failure.
    connectionTimeoutMillis: 5_000,
    // Bounds how long a single statement may run and how long a transaction may sit open but
    // idle (e.g. if application code threw between `begin` and `commit`/`rollback`, leaking a
    // held `for update` lock). Both are forwarded to Postgres as session parameters (confirmed in
    // pg's installed `lib/client.js`), not enforced client-side, so they hold even if this
    // process's own logic misbehaves.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  return { pool, database: drizzle(pool, { schema }) };
}
