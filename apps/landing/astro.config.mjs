import { defineConfig } from 'astro/config';

// The landing page is deliberately static: no adapter, no server, no API calls -- see
// src/site.config.ts for why (Better Auth's CSRF origin allowlist) and for every other
// environment-driven value. `site` only affects generated canonical/OpenGraph URLs; it does not
// change how or where this builds. Read directly from `process.env` here, not from the shared
// `site.config.ts` module: astro.config.mjs is loaded before Vite's `import.meta.env` pipeline
// exists, so `import.meta.env` is not yet available in this file.
export default defineConfig({
  output: 'static',
  site: process.env.PUBLIC_SITE_URL?.trim() || 'http://localhost:4321',
});
