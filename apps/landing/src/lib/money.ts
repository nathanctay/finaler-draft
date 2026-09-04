import type { Price } from '../site.config.js';

/**
 * Formats a `Price` (smallest currency unit, matching Stripe's own convention) as e.g. "$5.00".
 * Locale is fixed to `en-US` rather than left `undefined` -- this only ever runs at build time on
 * the server, so there is no visiting browser to infer a locale from, unlike
 * `apps/web/src/billingPresentation.ts`'s equivalent helper, which runs client-side.
 */
export function formatPrice(price: Price): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: price.currency.toUpperCase(),
  }).format(price.amount / 100);
}

/** Formats a `Price` with its billing interval appended, e.g. "$5.00/month". */
export function formatPricePerInterval(price: Price): string {
  const suffix = price.interval === 'month' ? '/month' : '/year';
  return `${formatPrice(price)}${suffix}`;
}
