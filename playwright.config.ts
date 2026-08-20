import { defineConfig, devices } from '@playwright/test';

const browserChannel = process.env.PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: './apps/web/e2e',
  // These specs create real accounts and require a real (disposable, per-run) database;
  // they run through test:system:persistence instead. See playwright.persistence.config.ts.
  testIgnore: [
    '**/persistence.spec.ts',
    '**/session-routing.spec.ts',
    '**/page-rendering-persistence.spec.ts',
  ],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // DIAGNOSTIC: testing whether font hinting is what rounds webfont glyph advances to whole
    // pixels on the Linux runner (60 characters measuring 600px instead of 575.6px).
    launchOptions: { args: ['--font-render-hinting=none'] },
    ...(browserChannel === undefined ? {} : { channel: browserChannel }),
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'FINALER_SYSTEM_TEST=true NODE_ENV=production PORT=4173 pnpm --filter @finaler-draft/api start',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
