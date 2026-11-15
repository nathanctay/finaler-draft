import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, runAccountPurgeCli, type PoolLike } from './accountPurgeCli.js';

/**
 * Covers `runAccountPurgeCli`'s own control flow against a fake pool -- argument parsing, the
 * missing-`DATABASE_URL` exit, and, the property this whole file exists to guarantee, that the
 * pool is closed exactly once on every path, including when the store throws. The real,
 * compiled-and-spawned CLI's actual process-exit behaviour against a real database is proven
 * separately in `accountPurgeCli.integration.test.ts` -- this file cannot prove "the process
 * exits," only "this function always calls `pool.end()`," which is necessary but not sufficient
 * on its own.
 */

function emptyResult() {
  return { rowCount: 0, rows: [] };
}

function fakePool(overrides?: {
  query?: ReturnType<typeof vi.fn>;
  end?: ReturnType<typeof vi.fn>;
}): {
  pool: PoolLike;
  end: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const query = overrides?.query ?? vi.fn(async () => emptyResult());
  const end = overrides?.end ?? vi.fn(async () => undefined);
  const connect = vi.fn(async () => ({
    query: vi.fn(async () => emptyResult()),
    release: vi.fn(),
  }));
  return {
    pool: { query, connect, end } as unknown as PoolLike,
    end,
    query,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('runAccountPurgeCli', () => {
  it('reports exitCode 1 and never opens a pool when DATABASE_URL is absent', async () => {
    const createPool = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runAccountPurgeCli({}, [], createPool);

    expect(result).toEqual({ exitCode: 1 });
    expect(createPool).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: 'account_purge_missing_database_url' }),
    );
  });

  it('runs the purge and closes the pool exactly once on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { pool, end } = fakePool();
    const createPool = vi.fn(() => pool);

    const result = await runAccountPurgeCli(
      { DATABASE_URL: 'postgresql://example.test/db' },
      [],
      createPool,
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(createPool).toHaveBeenCalledWith('postgresql://example.test/db');
    expect(end).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it('passes dryRun through when --dry-run is on the command line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { pool } = fakePool();
    const createPool = vi.fn(() => pool);

    await runAccountPurgeCli(
      { DATABASE_URL: 'postgresql://example.test/db' },
      ['--dry-run'],
      createPool,
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string) as { event: string };
    expect(logged.event).toBe('account_purge_dry_run');
    logSpy.mockRestore();
  });

  it('falls back to constructing a real pg.Pool when no override is given, and still closes it on failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // No `createPool` argument -- exercises the real default factory. Port 1 on loopback refuses
    // the connection immediately (nothing ever listens there), so this needs no running database
    // and still proves the real `new Pool(...)` branch and its `finally`-closed `pool.end()`.
    const result = await runAccountPurgeCli(
      { DATABASE_URL: 'postgresql://127.0.0.1:1/nonexistent' },
      [],
    );

    expect(result).toEqual({ exitCode: 1 });
    errorSpy.mockRestore();
  }, 10_000);

  it('still closes the pool exactly once, and reports exitCode 1, when the store throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failingQuery = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const { pool, end } = fakePool({ query: failingQuery });
    const createPool = vi.fn(() => pool);

    const result = await runAccountPurgeCli(
      { DATABASE_URL: 'postgresql://example.test/db' },
      [],
      createPool,
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(end).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: 'account_purge_failed', error: 'Error' }),
    );
  });
});

describe('main', () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    // Vitest's own process would otherwise inherit whatever this test just set, and exit
    // non-zero even though every assertion passed -- restored explicitly rather than left to
    // whatever the next test happens to overwrite it with.
    process.exitCode = originalExitCode;
  });

  it('sets a nonzero process.exitCode when DATABASE_URL is not set in the real environment', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    delete process.env.DATABASE_URL;
    process.env.FINALER_SYSTEM_TEST = 'true';
    process.env.NODE_ENV = 'test';
    process.exitCode = undefined;

    await main();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: 'account_purge_missing_database_url' }),
    );
  });

  it('attempts to load the root .env file when nothing says not to (a no-op here: this worktree has none)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    delete process.env.DATABASE_URL;
    delete process.env.FINALER_SYSTEM_TEST;
    process.env.NODE_ENV = 'development';
    process.exitCode = undefined;

    await main();

    // `loadRootEnvironment` ran (there is no `.env` in this worktree, so it found nothing to
    // load) and control still reached `runAccountPurgeCli`, which reports the same missing-
    // `DATABASE_URL` failure as the test above -- proving this branch does not itself throw or
    // otherwise divert `main`'s own control flow.
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: 'account_purge_missing_database_url' }),
    );
  });
});
