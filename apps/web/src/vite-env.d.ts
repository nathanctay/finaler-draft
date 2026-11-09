/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** See `collabConfig.ts` for what this configures and why it is a build-time value. */
  readonly VITE_COLLAB_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Inlined by `vite.config.ts`'s `define` (`resolveAppVersion`) -- the git commit SHA at build
 * time, or `'dev'` when one could not be read. Always a non-empty string; see `appVersion.ts`,
 * the one module that reads this identifier.
 */
declare const __APP_VERSION__: string;
