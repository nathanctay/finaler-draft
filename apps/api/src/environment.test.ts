import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvironmentFile, shouldLoadRootEnvironment } from './environment.js';

const environmentKey = 'FINALER_DRAFT_ENVIRONMENT_TEST_VALUE';
const originalValue = process.env[environmentKey];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalValue === undefined) {
    delete process.env[environmentKey];
  } else {
    process.env[environmentKey] = originalValue;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('loadEnvironmentFile', () => {
  it('loads local configuration only for unset or development environments', () => {
    expect(shouldLoadRootEnvironment({})).toBe(true);
    expect(shouldLoadRootEnvironment({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldLoadRootEnvironment({ NODE_ENV: 'test' })).toBe(false);
    expect(shouldLoadRootEnvironment({ NODE_ENV: 'production' })).toBe(false);
    expect(shouldLoadRootEnvironment({ FINALER_SYSTEM_TEST: 'true' })).toBe(false);
  });

  it('does nothing when the root environment file is absent', () => {
    delete process.env[environmentKey];

    loadEnvironmentFile(join(tmpdir(), 'finaler-draft-environment-file-does-not-exist'));

    expect(process.env[environmentKey]).toBeUndefined();
  });

  it('loads a local environment file without replacing injected variables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'finaler-draft-environment-'));
    temporaryDirectories.push(directory);
    const environmentFile = join(directory, '.env');
    await writeFile(environmentFile, `${environmentKey}=from-file\n`, 'utf8');

    delete process.env[environmentKey];
    loadEnvironmentFile(environmentFile);
    expect(process.env[environmentKey]).toBe('from-file');

    process.env[environmentKey] = 'injected-value';
    loadEnvironmentFile(environmentFile);
    expect(process.env[environmentKey]).toBe('injected-value');
  });
});
