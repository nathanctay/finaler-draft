import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';

/**
 * Fails if the built web bundle is React's development build. This gate exists to test what ships,
 * and it silently did not: the build inherited NODE_ENV=test from the server environment, so Vite
 * emitted the development bundle and every run exercised code no user receives. The fix is the
 * `buildEnvironment` override below; this check is what stops it regressing unnoticed, since the
 * symptom is invisible from the test results themselves -- the suite passes either way.
 *
 * `react-dom.development` appears in the development bundle and in no production bundle, verified
 * both ways against a real build rather than assumed.
 */
async function assertProductionWebBundle() {
  const assets = new URL('../apps/web/dist/assets/', import.meta.url);
  const files = (await readdir(assets)).filter((name) => name.endsWith('.js'));
  if (files.length === 0) throw new Error('No built web assets found to verify.');
  for (const file of files) {
    const contents = await readFile(new URL(file, assets), 'utf8');
    if (contents.includes('react-dom.development')) {
      throw new Error(
        `The persistence gate built React's development bundle (${file}). It must build exactly ` +
          'what ships; check that NODE_ENV is not leaking into the build step.',
      );
    }
  }
}

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error('TEST_DATABASE_URL is required for persisted browser tests.');
const databaseName = `finaler_draft_test_${randomUUID().replaceAll('-', '')}`;
if (!/^finaler_draft_test_[a-f0-9]{32}$/u.test(databaseName))
  throw new Error('Unsafe test database name.');
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const admin = new Pool({ connectionString: adminUrl });

function run(command, args, environment) {
  const child = spawn(command, args, {
    cwd: new URL('../', import.meta.url),
    env: environment,
    stdio: 'inherit',
  });
  return once(child, 'exit').then(([code]) => {
    if (code !== 0) throw new Error(`${command} failed.`);
  });
}

try {
  await admin.query(`create database "${databaseName}"`);
  const environment = {
    ...process.env,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: 'http://127.0.0.1:4174',
    CLIENT_ORIGIN: 'http://127.0.0.1:4174',
    DATABASE_URL: databaseUrl.toString(),
    FINALER_SYSTEM_TEST: 'true',
    // Keep the *server* in test mode so loopback HTTP cannot weaken production HTTPS policy.
    // This applies to the processes that run the suite, never to the build -- see
    // `buildEnvironment` below.
    NODE_ENV: 'test',
  };
  /*
   * The web bundle has to be built exactly as it ships. Vite selects React's development or
   * production build from NODE_ENV, so building under NODE_ENV=test emits the development bundle:
   * 552 kB against production's 368 kB, with StrictMode double-invocation and different
   * scheduling. This gate would then exercise a bundle no user ever receives, and any bundle-size
   * figure read from it would be wrong. Only the build step overrides NODE_ENV; the server keeps
   * the test value above.
   */
  const buildEnvironment = { ...environment, NODE_ENV: 'production' };
  await run('pnpm', ['--filter', '@finaler-draft/database', 'db:migrate'], environment);
  await run('pnpm', ['build'], buildEnvironment);
  await assertProductionWebBundle();
  // Pass through any args given to `pnpm test:system:persistence` (e.g. `-g <pattern>` to scope
  // to one test, `--repeat-each=N` to check for flakes) straight to the Playwright CLI. Previously
  // this script swallowed them silently, forcing a full, unscoped run for any targeted
  // investigation -- diagnosed while chasing the intermittent element-menu save race, see
  // progress/element-menu-save-race.md.
  //
  // Unlike npm, `pnpm run <script> -- <args>` forwards the `--` itself into the script's argv
  // rather than stripping it (verified directly against the installed pnpm, not assumed), so a
  // bare `--` must be filtered out here or Playwright reads it as a positional file-pattern
  // argument and reports "No tests found".
  const passthroughArgs = process.argv.slice(2).filter((arg) => arg !== '--');
  await run(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'playwright.persistence.config.ts', ...passthroughArgs],
    environment,
  );
} finally {
  await admin.query(
    'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
    [databaseName],
  );
  await admin.query(`drop database if exists "${databaseName}"`);
  await admin.end();
}
