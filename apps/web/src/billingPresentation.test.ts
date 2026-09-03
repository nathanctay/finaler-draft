import { describe, expect, it } from 'vitest';
import {
  computeAnnualSavingsLabel,
  defaultBillingInterval,
  formatMoney,
} from './billingPresentation.js';

describe('formatMoney', () => {
  it('formats a Stripe amount (smallest currency unit) as a localized currency string', () => {
    expect(formatMoney(500, 'usd')).toBe('$5.00');
    expect(formatMoney(5000, 'usd')).toBe('$50.00');
  });

  it('accepts a lowercase currency code, matching what Stripe itself returns', () => {
    expect(formatMoney(999, 'usd')).toBe('$9.99');
  });
});

describe('computeAnnualSavingsLabel', () => {
  it('derives the saving from the actual configured prices, not a hardcoded percentage', () => {
    // The owner's own example figures: $5/month, $50/year -- twelve months at the monthly rate
    // is $60, so annual saves $10, roughly two months free (~17%).
    const label = computeAnnualSavingsLabel(
      { amount: 500, currency: 'usd', interval: 'month' },
      { amount: 5000, currency: 'usd', interval: 'year' },
    );
    expect(label).toBe('Save $10.00 (17%) a year');
  });

  it('recomputes correctly for a different price pair, proving it is not hardcoded', () => {
    // $10/month => $120/year at the monthly rate; $90/year annual saves $30 (25%).
    const label = computeAnnualSavingsLabel(
      { amount: 1000, currency: 'usd', interval: 'month' },
      { amount: 9000, currency: 'usd', interval: 'year' },
    );
    expect(label).toBe('Save $30.00 (25%) a year');
  });

  it('never claims a saving when annual costs the same as twelve months of monthly', () => {
    const label = computeAnnualSavingsLabel(
      { amount: 500, currency: 'usd', interval: 'month' },
      { amount: 6000, currency: 'usd', interval: 'year' },
    );
    expect(label).toBeNull();
  });

  it('never claims a saving when annual actually costs more than twelve months of monthly', () => {
    const label = computeAnnualSavingsLabel(
      { amount: 500, currency: 'usd', interval: 'month' },
      { amount: 7000, currency: 'usd', interval: 'year' },
    );
    expect(label).toBeNull();
  });

  it('returns null rather than comparing mismatched currencies', () => {
    const label = computeAnnualSavingsLabel(
      { amount: 500, currency: 'usd', interval: 'month' },
      { amount: 5000, currency: 'eur', interval: 'year' },
    );
    expect(label).toBeNull();
  });
});

describe('defaultBillingInterval', () => {
  it("defaults to the subscriber's own interval when they have one", () => {
    expect(
      defaultBillingInterval({
        plan: 'monthly',
        status: 'active',
        currentPeriodEnd: '2026-10-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        canceledAt: null,
      }),
    ).toBe('monthly');
    expect(
      defaultBillingInterval({
        plan: 'annual',
        status: 'active',
        currentPeriodEnd: '2026-10-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        canceledAt: null,
      }),
    ).toBe('annual');
  });

  it('defaults to annual for a writer who has never subscribed', () => {
    expect(defaultBillingInterval(null)).toBe('annual');
  });

  it("defaults to annual when the subscriber's price id matches neither configured plan", () => {
    expect(
      defaultBillingInterval({
        plan: 'unknown',
        status: 'active',
        currentPeriodEnd: '2026-10-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        canceledAt: null,
      }),
    ).toBe('annual');
  });
});
