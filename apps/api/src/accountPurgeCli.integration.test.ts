import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';

const executeFile = promisify(execFile);

/**
 * The one test in this slice that proves the thing Railway's cron contract actually requires:
 * that running the **real, unmodified** `accountPurgeCli.ts` entry point -- not a function call
 * inside this test process, which proves nothing about the process boundary -- exits on its own,
 * with no open resources left behind. `accountPurgeCli.test.ts` proves `runAccountPurgeCli`
 * always calls `pool.end()`; this file proves that calling it is actually sufficient to let a
 * real `node` process started with this file as its entry point terminate by itself.
 *
 * Run through `tsx` directly (`apps/api`'s own `pnpm dev` already depends on it being installed)
 * rather than against a prior `pnpm build`'s `dist/` output, so this test does not silently pass
 * against a stale build left over from before the file it is supposed to be testing changed.
 *
 * Skips entirely without `TEST_DATABASE_URL`, matching every other integration suite in this
 * package.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;
let admin: Pool | undefined;
let databaseCreated = false;

const cliPath = fileURLToPath(new URL('./accountPurgeCli.ts', import.meta.url));
/**
 * **`apps/api`, not the repo root.** `tsx` is a devDependency of `apps/api` and `apps/collab` only,
 * never of the workspace root, so pnpm links it at `apps/api/node_modules/.bin/tsx` and nowhere
 * else. Spawning `pnpm exec tsx` with the root as its working directory therefore failed with
 * `Command "tsx" not found` -- every test in this file, on every machine, since the file was
 * written. Nothing caught it because the whole suite skips without `TEST_DATABASE_URL`, which CI
 * never sets.
 *
 * `apps/api` is also the working directory the real cron runs from: Railway's start command is
 * `pnpm --filter @finaler-draft/api purge:accounts`, so this is the more faithful choice as well as
 * the working one.
 */
const cliWorkingDirectory = fileURLToPath(new URL('../', import.meta.url));

describe.skipIf(!databaseUrl)('accountPurgeCli (real process)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);
  }, 30_000);

  afterAll(async () => {
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  it('exits with code 0 and terminates on its own against a real, empty backlog', async () => {
    const { stdout } = await executeFile('pnpm', ['exec', 'tsx', cliPath], {
      cwd: cliWorkingDirectory,
      env: { ...process.env, DATABASE_URL: databaseUrl, FINALER_SYSTEM_TEST: 'true' },
      timeout: 20_000,
    });
    const lastLine = stdout.trim().split('\n').at(-1) ?? '';
    const logged = JSON.parse(lastLine) as { event: string };
    expect(logged.event).toBe('account_purge_completed');
  }, 25_000);

  it('exits with code 0 in --dry-run mode too', async () => {
    const { stdout } = await executeFile('pnpm', ['exec', 'tsx', cliPath, '--dry-run'], {
      cwd: cliWorkingDirectory,
      env: { ...process.env, DATABASE_URL: databaseUrl, FINALER_SYSTEM_TEST: 'true' },
      timeout: 20_000,
    });
    const lastLine = stdout.trim().split('\n').at(-1) ?? '';
    const logged = JSON.parse(lastLine) as { event: string };
    expect(logged.event).toBe('account_purge_dry_run');
  }, 25_000);

  it('exits with a nonzero code, still promptly, when DATABASE_URL is absent', async () => {
    const envWithoutDatabase: Record<string, string | undefined> = {
      ...process.env,
      FINALER_SYSTEM_TEST: 'true',
    };
    delete envWithoutDatabase.DATABASE_URL;
    await expect(
      executeFile('pnpm', ['exec', 'tsx', cliPath], {
        cwd: cliWorkingDirectory,
        env: envWithoutDatabase,
        timeout: 20_000,
      }),
    ).rejects.toMatchObject({ code: 1 });
  }, 25_000);
});
