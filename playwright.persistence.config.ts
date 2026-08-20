import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: [
    '**/persistence.spec.ts',
    '**/session-routing.spec.ts',
    '**/page-rendering-persistence.spec.ts',
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
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'FINALER_SYSTEM_TEST=true NODE_ENV=test PORT=4174 pnpm --filter @finaler-draft/api start',
    url: 'http://127.0.0.1:4174/api/health',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
