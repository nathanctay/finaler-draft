/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** See `collabConfig.ts` for what this configures and why it is a build-time value. */
  readonly VITE_COLLAB_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
