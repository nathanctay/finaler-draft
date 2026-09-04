import { describe, expect, it } from 'vitest';
import { formatPrice, formatPricePerInterval } from './money.js';
import { PRICE_MONTHLY, PRICE_ANNUAL } from '../site.config.js';

describe('formatPrice', () => {
  it('formats whole-dollar cents as a two-decimal USD string', () => {
    expect(formatPrice({ amount: 500, currency: 'usd', interval: 'month' })).toBe('$5.00');
    expect(formatPrice({ amount: 5000, currency: 'usd', interval: 'year' })).toBe('$50.00');
  });

  it('formats a non-whole-dollar amount correctly', () => {
    expect(formatPrice({ amount: 999, currency: 'usd', interval: 'month' })).toBe('$9.99');
  });
});

describe('formatPricePerInterval', () => {
  it('appends /month for a monthly price', () => {
    expect(formatPricePerInterval({ amount: 500, currency: 'usd', interval: 'month' })).toBe(
      '$5.00/month',
    );
  });

  it('appends /year for an annual price', () => {
    expect(formatPricePerInterval({ amount: 5000, currency: 'usd', interval: 'year' })).toBe(
      '$50.00/year',
    );
  });

  it('renders the configured monthly and annual prices exactly as this site displays them', () => {
    // Guards against the pricing section drifting from site.config.ts's actual constants --
    // the configured $5/month and $50/year (plan.md's "Open commercial decisions") are what a
    // reader must see, not a hardcoded string a future edit could leave stale.
    expect(formatPricePerInterval(PRICE_MONTHLY)).toBe('$5.00/month');
    expect(formatPricePerInterval(PRICE_ANNUAL)).toBe('$50.00/year');
  });
});
