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
    // The Linux CI runner applies font hinting, which snaps *webfont* glyph advances to whole
    // pixels. Courier Prime's advance is 0.6em -- 9.6px at 12pt -- and hinting rounded it to
    // 10.0px, so a 60-character line measured 6.25in instead of 6.0in and every character-grid
    // assertion in this suite failed. Measured across sizes on the runner, the rounding is exact:
    // 10/19/38/77px per character at 12/24/48/96pt against true values of 9.6/19.2/38.4/76.8, with
    // the relative error collapsing from 4.2% to 0.26% as the glyphs grow -- the signature of a
    // fixed sub-pixel error, not a substituted typeface (the font loads correctly). System fonts
    // are unaffected, which is why generic `monospace` stayed fractional on the same runner.
    //
    // `deviceScaleFactor` is not the lever; 1, 2 and 3 all round identically. Disabling hinting
    // restores the font's true metrics, and CI then measures 9.59375px per character, matching
    // macOS exactly at every size. Both Playwright configs need this: the vertical line grid
    // rounds the same way (page-rendering-persistence failed by exactly one and two line heights
    // until `playwright.persistence.config.ts` got the same flag).
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
