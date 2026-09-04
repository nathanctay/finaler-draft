import { describe, expect, it } from 'vitest';
import { legalNavItems } from './legalNav.js';

describe('legalNavItems', () => {
  it('returns an empty list when no legal documents exist', () => {
    // This is the default state today: src/content/legal/ is deliberately empty (no LLM-drafted
    // legal text -- see the brief and content.config.ts). The footer must not link a page that
    // says nothing, and this is the function that decision runs through.
    expect(legalNavItems([])).toEqual([]);
  });

  it('produces one link per document, sorted by id, with a trailing-slash href', () => {
    const result = legalNavItems([
      { id: 'refund-policy', title: 'Refund Policy' },
      { id: 'privacy', title: 'Privacy Policy' },
      { id: 'terms', title: 'Terms of Service' },
    ]);

    expect(result).toEqual([
      { title: 'Privacy Policy', href: '/legal/privacy/' },
      { title: 'Refund Policy', href: '/legal/refund-policy/' },
      { title: 'Terms of Service', href: '/legal/terms/' },
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [
      { id: 'b', title: 'B' },
      { id: 'a', title: 'A' },
    ];
    const inputCopy = [...input];
    legalNavItems(input);
    expect(input).toEqual(inputCopy);
  });
});
