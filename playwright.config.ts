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
    // `retain-on-failure`, not `on-first-retry`: retries are 0 locally, so `on-first-retry` meant
    // a local failure produced no trace at all -- which is exactly the situation that blocked
    // diagnosing the intermittent `app-shell.spec.ts` timeout (30s, cold first run after a build,
    // roughly one run in ten, and every artifact overwritten by the next passing run before it
    // could be read). A trace is only written when a test fails, so this costs nothing on a green
    // run and is the difference between diagnosing the next occurrence and re-rolling for it.
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'FINALER_SYSTEM_TEST=true NODE_ENV=production PORT=4173 pnpm --filter @finaler-draft/api start',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
    },
    {
      // apps/landing is a separate static app with no server of its own -- `astro preview` is
      // the closest equivalent to the api's `start` above (serve the real build, not a dev
      // server). The command builds first so this works whether or not `pnpm build` already
      // covered it (it does not today -- apps/landing is not part of the root build chain; see
      // progress/landing-page.md). `--host 127.0.0.1` is required, not cosmetic: astro preview's
      // default `localhost` bound this process to `::1` only on this machine, so Playwright's
      // plain-IPv4 readiness probe against `url` below timed out at 60s against a server that
      // was, in fact, already up.
      //
      // PUBLIC_APP_IS_LIVE=true is deliberate, not the site's real default (see site.config.ts):
      // header-contrast.spec.ts exists to measure the *computed colour* of the "Open app"
      // button's border, which only exists in the DOM when APP_IS_LIVE is true. The complementary
      // case -- no app link at all while APP_IS_LIVE is false, which is this site's actual
      // shipping default -- is already covered where it belongs, at the render layer
      // (apps/landing/src/pageTests/index.render.test.ts), which can assert an element's *absence*
      // without a browser. This project stays free to build with whatever config makes its own
      // assertions meaningful, same as the api webServer above sets FINALER_SYSTEM_TEST=true for
      // its own reasons.
      command:
        'PUBLIC_APP_IS_LIVE=true pnpm --filter @finaler-draft/landing build && pnpm --filter @finaler-draft/landing exec astro preview --host 127.0.0.1 --port 4322',
      url: 'http://127.0.0.1:4322',
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      // Its own project, not folded into "chromium": a distinct testDir (apps/landing/e2e) and
      // baseURL (the landing webServer above, not the api's). `fullyParallel`, `retries`,
      // `reporter`, and the shared `use` block (trace, font-hinting flag) above still apply.
      name: 'landing',
      testDir: './apps/landing/e2e',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4322' },
    },
  ],
});
