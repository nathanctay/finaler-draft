import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
} from './integrationTestDatabase.js';

/**
 * The one thing no other test in this repository can prove, because of how every other one is
 * built: that migration `0007`'s data-migration clause actually carries a *pre-existing*
 * `document_yjs_state` row forward into a bootstrap `document_yjs_checkpoints` row before dropping
 * that table.
 *
 * Every other integration suite creates a throwaway database and runs the whole migration chain
 * from empty, so `document_yjs_state` never holds a row at the moment `0007` runs -- which means
 * deleting that clause entirely leaves every suite green while the migration silently destroys the
 * durable Yjs state of every screenplay that existed before this slice. That was verified, not
 * assumed: with the `INSERT ... SELECT` removed, `packages/database` (32) and `apps/collab`'s
 * integration suite (18) both still passed.
 *
 * This test therefore applies the migrations *in two halves* -- everything before `0007`, then a
 * seeded row, then `0007` itself -- rather than using `runIntegrationMigrations`, which would run
 * them all at once and reproduce exactly the blind spot above. It reads the shipped `.sql` files,
 * so what it exercises is the migration that actually runs in production (via `app`'s
 * `preDeploy`), not a reimplementation of its intent.
 *
 * The payload is deliberately opaque bytes rather than a real encoded `Y.Doc`: the invariant is
 * that the stored bytes survive the table swap byte for byte, and asserting that needs no `yjs`
 * dependency in this package. Reconstructing a real document *from* such a checkpoint is covered
 * by `apps/collab`'s own suite.
 */
const drizzleDirectory = resolve(import.meta.dirname, '../drizzle');

async function applyMigrationFile(pool: Pool, fileName: string): Promise<void> {
  const sql = readFileSync(resolve(drizzleDirectory, fileName), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed) await pool.query(trimmed);
  }
}

function migrationFileNames(): { before: string[]; bootstrap: string } {
  const all = readdirSync(drizzleDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const bootstrap = all.find((name) => name.startsWith('0007'));
  if (!bootstrap) throw new Error('Migration 0007 is missing from packages/database/drizzle.');
  return { before: all.filter((name) => name !== bootstrap), bootstrap };
}

const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;

let admin: Pool | undefined;
let pool: Pool | undefined;
let databaseCreated = false;

const projectId = '00000000-0000-4000-8000-0000000007a1';
const screenplayId = '00000000-0000-4000-8000-0000000007a2';
const snapshotBytes = Buffer.from([1, 2, 3, 250, 251, 252, 0, 42, 255]);

describe.skipIf(!databaseUrl)('migration 0007: the durable state of existing screenplays', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    pool = createIntegrationPool({ connectionString: databaseUrl! });

    const { before, bootstrap } = migrationFileNames();
    for (const fileName of before) await applyMigrationFile(pool, fileName);

    // A screenplay that already existed, holding a durable snapshot, exactly as slice 1 left it.
    await pool.query('insert into projects (id, title) values ($1, $2)', [projectId, 'Existing']);
    await pool.query(
      `insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash)
         values ($1, $2, $3, $4::jsonb, $5)`,
      [screenplayId, projectId, 'Existing Screenplay', '{}', 'hash'],
    );
    await pool.query(
      `insert into document_yjs_state (screenplay_id, state, updated_at)
         values ($1, $2, now() - interval '3 days')`,
      [screenplayId, snapshotBytes],
    );

    await applyMigrationFile(pool, bootstrap);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  it('carries the pre-existing snapshot into exactly one bootstrap checkpoint, byte for byte', async () => {
    const result = await pool!.query<{
      screenplayId: string;
      epoch: number;
      throughSequence: string;
      mergedUpdate: Buffer;
    }>(
      `select screenplay_id as "screenplayId", epoch, through_sequence as "throughSequence",
              merged_update as "mergedUpdate"
         from document_yjs_checkpoints`,
    );

    expect(result.rowCount).toBe(1);
    const checkpoint = result.rows[0]!;
    expect(checkpoint.screenplayId).toBe(screenplayId);
    // Byte-for-byte, not merely non-empty: a checkpoint holding *different* bytes is data loss
    // that a length or null check would not notice.
    expect(Buffer.compare(checkpoint.mergedUpdate, snapshotBytes)).toBe(0);
    // Epoch 0 and no absorbed updates: the log did not exist before this migration, so every
    // update logged afterwards must sort strictly after this checkpoint.
    expect(checkpoint.epoch).toBe(0);
    expect(Number(checkpoint.throughSequence)).toBe(0);
  });

  it('dates the bootstrap checkpoint from the snapshot it came from, not from when the migration ran', async () => {
    const result = await pool!.query<{ createdAt: Date }>(
      'select created_at as "createdAt" from document_yjs_checkpoints',
    );
    const createdAt = result.rows[0]!.createdAt.getTime();
    // Seeded three days back; a reset-to-now would land within seconds of this assertion.
    expect(createdAt).toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);
  });

  it('drops the old table, leaving the checkpoint as the only record of that state', async () => {
    const result = await pool!.query<{ table: string | null }>(
      `select to_regclass('public.document_yjs_state')::text as "table"`,
    );
    expect(result.rows[0]!.table).toBeNull();
  });
});
