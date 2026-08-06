import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const rootEnvironmentFile = fileURLToPath(new URL('../../../.env', import.meta.url));

export function loadRootEnvironment(): void {
  loadEnvironmentFile(rootEnvironmentFile);
}

export function shouldLoadRootEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return (
    (environment.NODE_ENV === undefined || environment.NODE_ENV === 'development') &&
    environment.FINALER_SYSTEM_TEST !== 'true'
  );
}

export function loadEnvironmentFile(environmentFile: string): void {
  if (!existsSync(environmentFile)) return;

  // Node preserves values already injected by the shell or Railway.
  loadEnvFile(environmentFile);
}
