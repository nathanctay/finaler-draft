import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  checkMigrations,
  queryAppliedMigrations,
  readJournalMigrations,
} from './migrationCheck.js';

/**
 * Builds a real, throwaway `drizzle/` directory on disk -- a journal plus the `.sql` files it
 * references -- rather than mocking `node:fs`. `readJournalMigrations` does nothing but read
 * files; a real temp directory exercises the actual path-joining and JSON parsing, which a mock
 * would only restate.
 */
async function writeJournalFixture(
  entries: ReadonlyArray<{ idx: number; tag: string; contents: string }>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-check-'));
  await mkdir(path.join(dir, 'meta'), { recursive: true });
  await writeFile(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      entries: entries.map((entry) => ({ idx: entry.idx, version: '7', when: 0, tag: entry.tag })),
    }),
  );
  await Promise.all(
    entries.map((entry) => writeFile(path.join(dir, `${entry.tag}.sql`), entry.contents)),
  );
  return dir;
}

const hashOf = (contents: string) => createHash('sha256').update(contents).digest('hex');

function fakePool(query: Pool['query']): Pool {
  return { query } as unknown as Pool;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readJournalMigrations', () => {
  it('reads journal entries in idx order and hashes each file the way drizzle-orm does', async () => {
    const dir = await writeJournalFixture([
      { idx: 1, tag: '0001_b', contents: 'create table b ();' },
      { idx: 0, tag: '0000_a', contents: 'create table a ();' },
    ]);
    tempDirs.push(dir);

    await expect(readJournalMigrations(dir)).resolves.toEqual([
      { tag: '0000_a', hash: hashOf('create table a ();') },
      { tag: '0001_b', hash: hashOf('create table b ();') },
    ]);
  });
});

describe('queryAppliedMigrations', () => {
  it('returns the rows a successful query produces', async () => {
    const query = async () => ({ rows: [{ hash: 'hash-a' }, { hash: 'hash-b' }] }) as never;
    await expect(queryAppliedMigrations(fakePool(query))).resolves.toEqual([
      { hash: 'hash-a' },
      { hash: 'hash-b' },
    ]);
  });

  it('treats a missing migrations table as zero applied migrations, not an error', async () => {
    const query = async () => {
      throw Object.assign(new Error('relation "drizzle.__drizzle_migrations" does not exist'), {
        code: '42P01',
      });
    };
    await expect(queryAppliedMigrations(fakePool(query))).resolves.toEqual([]);
  });

  it('rethrows an unrelated database error rather than masking it as zero migrations', async () => {
    const query = async () => {
      throw Object.assign(new Error('password authentication failed'), { code: '28P01' });
    };
    await expect(queryAppliedMigrations(fakePool(query))).rejects.toThrow(
      'password authentication failed',
    );
  });
});

describe('checkMigrations', () => {
  it('reports ok when the applied hashes match the journal exactly', async () => {
    const dir = await writeJournalFixture([{ idx: 0, tag: '0000_a', contents: 'select 1;' }]);
    tempDirs.push(dir);
    const pool = fakePool(async () => ({ rows: [{ hash: hashOf('select 1;') }] }) as never);

    await expect(checkMigrations({ pool, drizzleDir: dir })).resolves.toEqual({ ok: true });
  });

  it('reports behind with the pending tag when a migration was never applied', async () => {
    const dir = await writeJournalFixture([
      { idx: 0, tag: '0000_a', contents: 'select 1;' },
      { idx: 1, tag: '0001_b', contents: 'select 2;' },
    ]);
    tempDirs.push(dir);
    const pool = fakePool(async () => ({ rows: [{ hash: hashOf('select 1;') }] }) as never);

    await expect(checkMigrations({ pool, drizzleDir: dir })).resolves.toEqual({
      ok: false,
      reason: 'behind',
      pending: ['0001_b'],
    });
  });

  it('reports unreachable, not behind, when the database cannot be connected to at all', async () => {
    const dir = await writeJournalFixture([{ idx: 0, tag: '0000_a', contents: 'select 1;' }]);
    tempDirs.push(dir);
    const pool = fakePool(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
        code: 'ECONNREFUSED',
      });
    });

    await expect(checkMigrations({ pool, drizzleDir: dir })).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'connect ECONNREFUSED 127.0.0.1:5432',
    });
  });

  it('reports unreachable for a connection that times out rather than refusing outright', async () => {
    const dir = await writeJournalFixture([{ idx: 0, tag: '0000_a', contents: 'select 1;' }]);
    tempDirs.push(dir);
    const pool = fakePool(async () => {
      throw new Error('timeout expired');
    });

    await expect(checkMigrations({ pool, drizzleDir: dir })).resolves.toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('reports queryFailed, not unreachable, for a real database rejecting the query', async () => {
    const dir = await writeJournalFixture([{ idx: 0, tag: '0000_a', contents: 'select 1;' }]);
    tempDirs.push(dir);
    const pool = fakePool(async () => {
      throw Object.assign(new Error('password authentication failed for user "postgres"'), {
        code: '28P01',
      });
    });

    await expect(checkMigrations({ pool, drizzleDir: dir })).resolves.toEqual({
      ok: false,
      reason: 'queryFailed',
      detail: 'password authentication failed for user "postgres"',
    });
  });

  it('reports ahead when the database has more applied migrations than the journal lists', async () => {
    const dir = await writeJournalFixture([{ idx: 0, tag: '0000_a', contents: 'select 1;' }]);
    tempDirs.push(dir);
    const pool = fakePool(
      async () => ({ rows: [{ hash: hashOf('select 1;') }, { hash: 'unknown-hash' }] }) as never,
    );

    await expect(checkMigrations({ pool, drizzleDir: dir })).resolves.toEqual({
      ok: false,
      reason: 'ahead',
      extraAppliedCount: 1,
    });
  });

  it('reports diverged when an applied migration does not match the journal by content', async () => {
    const dir = await writeJournalFixture([{ idx: 0, tag: '0000_a', contents: 'select 1;' }]);
    tempDirs.push(dir);
    const pool = fakePool(async () => ({ rows: [{ hash: 'edited-after-the-fact' }] }) as never);

    await expect(checkMigrations({ pool, drizzleDir: dir })).resolves.toEqual({
      ok: false,
      reason: 'diverged',
      atIndex: 0,
      journalTag: '0000_a',
    });
  });
});
