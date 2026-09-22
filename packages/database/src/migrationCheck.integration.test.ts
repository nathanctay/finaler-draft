import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMigrations, readJournalMigrations } from './migrationCheck.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';

/**
 * The end-to-end proof the check itself asks for: a real, freshly migrated throwaway database
 * reports up to date, and the identical database with its most recently applied migration erased
 * from `drizzle.__drizzle_migrations` reports pending -- naming that exact migration. Everything
 * else (the connectivity classification, the hash comparison's edge cases) is unit-tested in
 * `migrationCheck.test.ts` against a fake pool and a fixture journal; what only a real database
 * can prove is that a real `db:migrate` run and a real `drizzle.__drizzle_migrations` table are
 * shaped the way this check assumes.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;

let admin: Pool | undefined;
let pool: Pool | undefined;
let databaseCreated = false;

describe.skipIf(!databaseUrl)('checkMigrations against a real database', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);
    pool = createIntegrationPool({ connectionString: databaseUrl! });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  it('reports ok immediately after a full db:migrate run', async () => {
    await expect(checkMigrations({ pool: pool! })).resolves.toEqual({ ok: true });
  });

  it('fails, naming the pending migration, once the most recent one is missing from the database', async () => {
    const journal = await readJournalMigrations();
    const lastMigration = journal.at(-1);
    if (!lastMigration) throw new Error('Expected at least one migration in the journal.');

    // Deletes only the *bookkeeping row* drizzle-orm's migrator writes to
    // `drizzle.__drizzle_migrations`, not the schema the migration created -- this check reads
    // that table as its record of "what has been applied," identically to how drizzle's own
    // migrator decides what still needs to run, so removing this row is a faithful simulation of
    // "this migration was never applied," independent of whatever DDL happened to run.
    await pool!.query(
      'delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)',
    );

    await expect(checkMigrations({ pool: pool! })).resolves.toEqual({
      ok: false,
      reason: 'behind',
      pending: [lastMigration.tag],
    });
  });
});
