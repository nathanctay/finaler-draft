import type { BillingPlan, BillingSubscription, PlanPrice } from './api.js';

/**
 * Pure presentation helpers for the Manage Subscription page (routes/billing.subscription.tsx),
 * split into their own module rather than exported directly from the route file: TanStack
 * Router's file-based routes are only meant to export their route config, and
 * `react-refresh/only-export-components` (this repo's lint config, run at `--max-warnings=0`)
 * flags any other named export from a route module for exactly that reason. None of this needs
 * React or a rendered component to test, so this split also makes each function directly
 * unit-testable without going through the page.
 */

export const PLAN_NAMES: Record<'monthly' | 'annual' | 'unknown', string> = {
  monthly: 'Pro (monthly)',
  annual: 'Pro (annual)',
  unknown: 'Pro',
};

// A short, human status phrase per `SubscriptionStatus` value -- plain wording over the raw
// Stripe status string, matching how this app already avoids surfacing internal vocabulary
// (billing.success.tsx's "Thanks -- finishing up" over a bare "pending", for instance).
export const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Payment past due',
  canceled: 'Canceled',
  unpaid: 'Unpaid',
  paused: 'Paused',
  incomplete: 'Incomplete',
  incomplete_expired: 'Incomplete (expired)',
};

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Formats a Stripe amount -- the smallest unit of `currency`, e.g. cents for USD, exactly as
 * `GET /api/billing/plans` reports it -- as a localized currency string. Assumes a two-decimal
 * currency: both of this app's configured prices are USD today. A genuinely zero-decimal currency
 * (JPY and similar) would need its own branch here; left unhandled deliberately rather than
 * silently wrong, since nothing in this app is configured with one yet.
 */
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

/**
 * The annual saving, called out on the toggle -- derived from the real configured prices
 * (`GET /api/billing/plans`), never a hardcoded percentage: at the owner's example figures
 * ($5/month, $50/year) this returns "roughly two months free," but it is computed from whatever
 * `monthly`/`annual` actually report, so it stays correct if either price changes. Returns `null`,
 * rather than a fabricated figure, whenever the comparison wouldn't be honest: mismatched
 * currencies, or an annual price that does not actually undercut twelve months of the monthly
 * price -- this must never claim a saving that isn't real.
 */
export function computeAnnualSavingsLabel(monthly: PlanPrice, annual: PlanPrice): string | null {
  if (monthly.currency !== annual.currency) return null;
  const yearlyAtMonthlyRate = monthly.amount * 12;
  if (yearlyAtMonthlyRate <= 0) return null;
  const savings = yearlyAtMonthlyRate - annual.amount;
  if (savings <= 0) return null;
  const percent = Math.round((savings / yearlyAtMonthlyRate) * 100);
  return `Save ${formatMoney(savings, annual.currency)} (${percent}%) a year`;
}

/**
 * The toggle's default position. A subscriber -- current or lapsed -- defaults to their own
 * interval, so switching the toggle always represents a real *change* from their actual plan
 * rather than an arbitrary starting point (and so a paying visitor immediately sees their own
 * plan's price, not a possibly-different one). A writer who has never subscribed has no interval
 * to default to; annual is chosen deliberately for that case -- it is the better value (see
 * `computeAnnualSavingsLabel`) and leads a first-time visitor with the plan this product would
 * rather they choose, matching the common pricing-page convention of defaulting to the
 * higher-value option rather than the lowest-commitment one.
 */
export function defaultBillingInterval(current: BillingSubscription): BillingPlan {
  if (current && (current.plan === 'monthly' || current.plan === 'annual')) return current.plan;
  return 'annual';
}
