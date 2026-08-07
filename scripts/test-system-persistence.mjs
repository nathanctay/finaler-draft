import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';

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
    // The server still serves the production build in explicit system-test mode.
    // Keep Node in test mode so loopback HTTP cannot weaken production HTTPS policy.
    NODE_ENV: 'test',
  };
  await run('pnpm', ['--filter', '@finaler-draft/database', 'db:migrate'], environment);
  await run('pnpm', ['build'], environment);
  await run(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'playwright.persistence.config.ts'],
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
