import { describe, expect, it } from 'vitest';
import { createDrizzleArguments, shouldLoadRootEnvironment } from './environment.mjs';

describe('Drizzle environment policy', () => {
  it('reads a root environment file only for unset or development environments', () => {
    expect(shouldLoadRootEnvironment({})).toBe(true);
    expect(shouldLoadRootEnvironment({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldLoadRootEnvironment({ NODE_ENV: 'test' })).toBe(false);
    expect(shouldLoadRootEnvironment({ NODE_ENV: 'production' })).toBe(false);
  });

  it('does not pass a local environment file to test or production Drizzle commands', () => {
    const argumentsForProduction = createDrizzleArguments({
      environment: { NODE_ENV: 'production' },
      environmentFile: '/repository/.env',
      drizzleKit: '/repository/node_modules/drizzle-kit/bin.cjs',
      commandArguments: ['migrate'],
    });

    expect(argumentsForProduction).toEqual([
      '/repository/node_modules/drizzle-kit/bin.cjs',
      'migrate',
    ]);
  });

  it('passes the root environment file ahead of Drizzle for local commands', () => {
    const argumentsForDevelopment = createDrizzleArguments({
      environment: { NODE_ENV: 'development' },
      environmentFile: '/repository/.env',
      drizzleKit: '/repository/node_modules/drizzle-kit/bin.cjs',
      commandArguments: ['generate'],
    });

    expect(argumentsForDevelopment).toEqual([
      '--env-file-if-exists=/repository/.env',
      '/repository/node_modules/drizzle-kit/bin.cjs',
      'generate',
    ]);
  });
});
