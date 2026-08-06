import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDrizzleArguments } from './environment.mjs';

const databasePackageRoot = fileURLToPath(new URL('../', import.meta.url));
const rootEnvironmentFile = fileURLToPath(new URL('../../../.env', import.meta.url));
const drizzleKit = fileURLToPath(new URL('../node_modules/drizzle-kit/bin.cjs', import.meta.url));

const child = spawn(
  process.execPath,
  createDrizzleArguments({
    environment: process.env,
    environmentFile: rootEnvironmentFile,
    drizzleKit,
    commandArguments: process.argv.slice(2),
  }),
  {
    cwd: databasePackageRoot,
    env: process.env,
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  console.error(`Unable to start Drizzle: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
