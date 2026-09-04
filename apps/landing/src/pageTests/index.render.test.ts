import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
import Index from '../pages/index.astro';
import { APP_ORIGIN, APP_IS_LIVE, APP_LINK_LABEL } from '../site.config.js';
import { formatPricePerInterval } from '../lib/money.js';
import { PRICE_MONTHLY, PRICE_ANNUAL } from '../site.config.js';

/**
 * Renders the real page through Astro's Container API rather than asserting on the pure
 * `site.config.ts` / `money.ts` values in isolation -- those unit tests catch a mutation in the
 * *data*, but only a rendered-HTML assertion catches a mutation in the *template wiring* (e.g. a
 * hardcoded price or link that stops reading from config but still happens to match today).
 *
 * These run under the default config (no `PUBLIC_APP_IS_LIVE` set), which is deliberate: that
 * default -- `APP_IS_LIVE === false` -- is the state this site actually ships in first (see
 * `site.config.ts`'s own comment on why the default is `false` and not `true`). The complementary
 * "APP_IS_LIVE === true" rendering was verified manually via a real `astro build` with
 * `PUBLIC_APP_IS_LIVE=true PUBLIC_APP_ORIGIN=...` (see progress/landing-page.md) rather than
 * added here as an automated test: re-importing a compiled `.astro` module under a second env
 * value within one test run is not a natural fit for the Container API, and the one thing this
 * suite must protect against a silent regression in is the default -- a real "Open app" link
 * pointing at nothing, on the one config this site deploys with today.
 */
describe('index page render', () => {
  it('renders the configured monthly and annual prices', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Index);

    expect(html).toContain(formatPricePerInterval(PRICE_MONTHLY));
    expect(html).toContain(formatPricePerInterval(PRICE_ANNUAL));
  });

  it('renders no link to the app while APP_IS_LIVE is false, and says so honestly instead', async () => {
    // The behavior this task exists to protect: before the app is deployed, APP_ORIGIN resolves
    // to nothing real, and a rendered "Open app" button would be the most visible dead link on
    // the page. This is a precondition on the test itself, not an assertion: if a future default
    // ever flips APP_IS_LIVE to true, this test would silently stop testing the thing it says it
    // tests, so it fails loudly instead of passing vacuously.
    expect(APP_IS_LIVE).toBe(false);

    const container = await AstroContainer.create();
    const html = await container.renderToString(Index);

    const hrefs = [...html.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((href): href is string => href !== undefined);
    expect(hrefs.some((href) => href.startsWith(APP_ORIGIN))).toBe(false);
    expect(html).not.toContain(APP_LINK_LABEL);

    // The Pro card's CTA link is replaced with honest copy, not just removed -- a card with no
    // price-tier action at all would look broken rather than deliberately pre-launch.
    expect(html).toContain('Available when the app launches.');
  });

  it('marks the pre-launch state and claims nothing the product does not ship', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Index);

    expect(html).toContain('Coming soon');
    // Revision history and FDX import are not built. Asserting their absence means a future edit
    // that quietly reintroduces either has to update this test rather than slipping in unnoticed
    // -- this page is the URL handed to Stripe, so a claim the product cannot support is a
    // liability rather than merely inaccurate copy.
    expect(html).not.toMatch(/revision history/i);
    expect(html).not.toMatch(/FDX import/i);
    // Deliberately NOT asserted: a "Planned" badge and a Status section naming real-time
    // collaboration. Both belonged to an earlier draft, and the owner removed that section
    // (2026-09-04). Nothing on the page now describes unbuilt work, so there is no
    // planned-versus-shipped distinction left to protect -- the two absence assertions above are
    // what keep it that way. If planned features return, they need that visual distinction back
    // and a test for it: "Coming soon" is what makes such claims honest today, and it is gated on
    // `APP_IS_LIVE`, so it disappears at launch while any planned copy would not.
  });

  it('renders the product name and tagline exactly once each as the hero heading and subheading', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Index);

    // Container-rendered HTML carries dev-mode `data-astro-source-*` attributes on every
    // element, so match the tag loosely rather than asserting a literal `<h1>Finaler Draft</h1>`.
    expect(html).toMatch(/<h1[^>]*>Finaler Draft<\/h1>/);
    expect((html.match(/Finaler Draft<\/h1>/g) ?? []).length).toBe(1);
    expect(html).toContain('Made by filmmakers, for filmmakers.');
  });
});
