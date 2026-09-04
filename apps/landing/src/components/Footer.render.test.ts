import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
import Footer from './Footer.astro';

/**
 * `src/content/legal/` is deliberately empty (no LLM-drafted legal text -- the brief's most
 * important constraint). This is the integration-level half of that guarantee: the pure
 * `legalNavItems([])` unit test (lib/legalNav.test.ts) proves the *function* returns no links for
 * an empty collection, but only rendering the real component through the real `astro:content`
 * collection proves the *template* actually honors that and never falls back to a hardcoded
 * legal link.
 */
describe('Footer render', () => {
  it('renders no legal nav and no legal links while src/content/legal/ is empty', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Footer);

    expect(html).not.toContain('legal-nav');
    expect(html).not.toContain('/legal/');
  });

  it('still renders the copyright line', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Footer);

    expect(html).toContain('Finaler Draft');
    expect(html).toMatch(/copyright/);
  });
});
