import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export { schema };
export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 });
  return { pool, database: drizzle(pool, { schema }) };
}
