import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
import Index from '../pages/index.astro';
import { APP_ORIGIN, APP_LINK_LABEL } from '../site.config.js';
import { formatPricePerInterval } from '../lib/money.js';
import { PRICE_MONTHLY, PRICE_ANNUAL } from '../site.config.js';

/**
 * Renders the real page through Astro's Container API rather than asserting on the pure
 * `site.config.ts` / `money.ts` values in isolation -- those unit tests catch a mutation in the
 * *data*, but only a rendered-HTML assertion catches a mutation in the *template wiring* (e.g. a
 * hardcoded price or link that stops reading from config but still happens to match today).
 */
describe('index page render', () => {
  it('renders the configured monthly and annual prices', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Index);

    expect(html).toContain(formatPricePerInterval(PRICE_MONTHLY));
    expect(html).toContain(formatPricePerInterval(PRICE_ANNUAL));
  });

  it('every link to the app points at the configured APP_ORIGIN, not a literal', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Index);

    const hrefs = [...html.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((href): href is string => href !== undefined);
    const appLinks = hrefs.filter((href) => href.startsWith(APP_ORIGIN));

    // The header nav, the hero's primary button, and the Pro card's CTA all point at the app.
    expect(appLinks.length).toBeGreaterThanOrEqual(3);
    for (const href of hrefs) {
      // No link accidentally hardcodes a different app origin (e.g. a stale literal from before
      // this was made configuration).
      if (href.includes('://') && !href.startsWith('http://localhost:4321')) {
        expect(href.startsWith(APP_ORIGIN)).toBe(true);
      }
    }
  });

  it('uses one neutral label for every link to the app, never "Sign in" or "Dashboard"', async () => {
    // The owner explicitly declined session detection (no fetch, no cookie read) that would let
    // this static page know whether a visitor is signed in, so the label must never presume
    // either state -- see APP_LINK_LABEL's own comment in site.config.ts.
    const container = await AstroContainer.create();
    const html = await container.renderToString(Index);

    expect(html).toContain(APP_LINK_LABEL);
    // Two links to the app carry this exact label; the Pro CTA composes it with a suffix.
    expect((html.match(new RegExp(`>${APP_LINK_LABEL}<`, 'g')) ?? []).length).toBe(2);
    expect(html).toContain(`${APP_LINK_LABEL} to upgrade`);
    expect(html).not.toMatch(/Sign in/i);
    expect(html).not.toMatch(/Dashboard/i);
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
