import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: [
    '**/persistence.spec.ts',
    '**/session-routing.spec.ts',
    '**/page-rendering-persistence.spec.ts',
    '**/presence-persistence.spec.ts',
  ],
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    // See `playwright.config.ts` for why this flag is required. This suite needs it for the
    // vertical grid as much as the horizontal one: without it the runner's hinting rounds line
    // boxes, and `page-rendering-persistence.spec.ts` fails by exactly one and two line heights
    // (0.167in and 0.333in at six lines per inch).
    launchOptions: { args: ['--font-render-hinting=none'] },
    // See `playwright.config.ts` for why this is `retain-on-failure` rather than `on-first-retry`.
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'FINALER_SYSTEM_TEST=true NODE_ENV=test PORT=4174 pnpm --filter @finaler-draft/api start',
      url: 'http://127.0.0.1:4174/api/health',
      reuseExistingServer: false,
    },
    {
      // `apps/collab`'s Hocuspocus server, real rather than stubbed: these specs open a real
      // signed-in editor whose body is Yjs-backed (`App.tsx`'s `collab` -- see `collabConfig.ts`),
      // and the geometry/persistence assertions in `page-rendering-persistence.spec.ts` need every
      // typed edit to reach the real save path -- `apps/collab`'s debounced `onStoreDocument`,
      // writing through `packages/database`'s `document_yjs_state`/`canonical_screenplay` -- not a
      // build that silently falls back to an unconnected local `Y.Doc` (which is what happens
      // whenever `VITE_COLLAB_WS_URL` is unset; see `collabConfig.ts`'s own doc comment). Reads the
      // same DATABASE_URL/BETTER_AUTH_SECRET/BETTER_AUTH_URL/CLIENT_ORIGIN as the api webServer
      // above, inherited from `test-system-persistence.mjs`'s `environment` -- the identical
      // disposable database and the identical Better Auth session-verification allowlist, so a
      // cookie either service issues is valid for both (`apps/collab/src/authenticate.ts`'s own
      // doc comment on why this must agree byte-for-byte).
      //
      // No `--host 127.0.0.1` (contrast the landing webServer's own comment, `playwright.config.ts`):
      // confirmed directly against the installed `@hocuspocus/server`, its `Server.listen()` passes
      // no `host` when `address` is left unconfigured (as here), which is a true unspecified bind
      // (`::`/`0.0.0.0` together on this OS and on Linux CI), not the narrower `localhost` ->
      // `::1`-only resolution that broke the landing webServer's readiness probe. Verified by
      // starting this exact server and curling `127.0.0.1` directly -- no ambiguity to guard
      // against here.
      //
      // `url` points at the bare root, not a dedicated health route: Hocuspocus's own
      // `requestHandler` (read from the installed package) answers any plain, non-upgrade HTTP
      // request with `200 Welcome to Hocuspocus!` by default, and Playwright's readiness probe
      // only needs *a* response, not a 200 specifically -- the same real endpoint
      // `.railway/railway.ts`'s `healthcheck: '/'` already relies on for this service in
      // production.
      command:
        'FINALER_SYSTEM_TEST=true NODE_ENV=test PORT=4175 pnpm --filter @finaler-draft/collab start',
      url: 'http://127.0.0.1:4175/',
      reuseExistingServer: false,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
