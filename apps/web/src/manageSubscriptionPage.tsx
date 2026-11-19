import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type BillingPlan } from './api.js';
import {
  computeAnnualSavingsLabel,
  defaultBillingInterval,
  formatDate,
  formatMoney,
  PLAN_NAMES,
  STATUS_LABELS,
} from './billingPresentation.js';
import { redirectToExternalUrl } from './externalRedirect.js';

/**
 * The Manage Subscription panel's content -- extracted out of `routes/billing.subscription.tsx`
 * (now a redirect to `routes/account.subscription.tsx`, part of the Manage account page,
 * `progress/manage-account-page.md`) for the identical reason `deletedItemsPage.tsx` was pulled
 * out of `routes/deleted.tsx`: this keeps its existing behaviour (and `billing.subscription.
 * test.tsx`'s own assertions, carried over to `account.subscription.test.tsx`) rather than
 * rewriting it against a fresh implementation, and stops it from bringing a second
 * `ApplicationTitlebar` underneath the Manage account layout's own one.
 *
 * `plan.md`'s "Integration shape" is explicit that the Customer Portal, not hand-built UI, owns an
 * actual change: "The Customer Portal handles upgrades, downgrades, cancellation and payment-
 * method updates ... Do not hand-build subscription management UI." That governs every button on
 * this page:
 *
 * - **No Stripe customer yet** (`hasStripeCustomer` false, a writer who has never subscribed): the
 *   Pro card's button starts a real Checkout Session for the selected interval.
 * - **A Stripe customer already exists** (`hasStripeCustomer` true -- currently paid, or lapsed
 *   after having paid before) -- *every* button on this page, on either card, opens the Customer
 *   Portal instead.
 */
export function ManageSubscriptionPage() {
  const entitlement = useQuery({ queryKey: ['entitlement'], queryFn: api.entitlement });
  const subscription = useQuery({
    queryKey: ['billingSubscription'],
    queryFn: api.billingSubscription,
  });
  const plans = useQuery({ queryKey: ['billingPlans'], queryFn: api.billingPlans });
  const portal = useMutation({
    mutationFn: api.createPortalSession,
    onSuccess: (result) => redirectToExternalUrl(result.url),
  });
  const checkout = useMutation({
    mutationFn: (plan: BillingPlan) => api.createCheckoutSession(plan),
    onSuccess: (result) => redirectToExternalUrl(result.url),
  });

  const loading = entitlement.isLoading || subscription.isLoading;
  const tier = entitlement.data?.tier;
  const current = subscription.data?.subscription ?? null;
  // The single dividing line for every button on this page -- see the module comment. `true` for
  // a currently-paying writer and for a lapsed one alike: both have a real Stripe customer on
  // record, so both go through the Portal for any change, never a fresh Checkout Session.
  const hasStripeCustomer = current !== null;

  // Derived, not a plain `useState` initializer: `current` is still `undefined` on the very first
  // render (the query hasn't resolved yet), so a lazy initializer would always compute the
  // never-subscribed default and never notice a real subscriber's interval once it loads. Reading
  // `current` fresh on every render, until the writer actually touches the toggle, fixes that
  // without an effect.
  const [intervalOverride, setIntervalOverride] = useState<BillingPlan | undefined>(undefined);
  const interval = intervalOverride ?? defaultBillingInterval(current);

  const proMatchesSelectedInterval = tier === 'paid' && current?.plan === interval;
  // Stripe's subscription `status` stays `'active'` right up until the period actually ends, so
  // `tier` alone cannot tell "renewing" apart from "cancelled but still paid up" -- only
  // `cancelAtPeriodEnd` can. This writer is still on Pro (the badge below still says so) but the
  // Pro card's action must read as *resuming* the plan, not merely managing an unrelated one.
  const isCancelledCurrentPlan = proMatchesSelectedInterval && current?.cancelAtPeriodEnd === true;
  const freeIsCurrent = tier !== 'paid';
  const selectedPrice = plans.data?.[interval];
  const savingsLabel = plans.data
    ? computeAnnualSavingsLabel(plans.data.monthly, plans.data.annual)
    : null;

  function switchToPro() {
    if (hasStripeCustomer) {
      portal.mutate();
    } else {
      checkout.mutate(interval);
    }
  }

  function switchToFree() {
    // Only reachable when `hasStripeCustomer` -- see the Free card below -- so this is always a
    // real downgrade/cancellation, which the Portal owns.
    portal.mutate();
  }

  return (
    <section className="project-list">
      <h1>Manage Subscription</h1>

      {loading ? (
        <p>Loading your subscription…</p>
      ) : (
        <>
          <fieldset className="interval-toggle">
            <legend className="visually-hidden">Billing interval</legend>
            <label
              className={
                interval === 'monthly'
                  ? 'interval-option interval-option-selected'
                  : 'interval-option'
              }
            >
              <input
                checked={interval === 'monthly'}
                name="billing-interval"
                onChange={() => setIntervalOverride('monthly')}
                type="radio"
                value="monthly"
              />
              Monthly
            </label>
            <label
              className={
                interval === 'annual'
                  ? 'interval-option interval-option-selected'
                  : 'interval-option'
              }
            >
              <input
                checked={interval === 'annual'}
                name="billing-interval"
                onChange={() => setIntervalOverride('annual')}
                type="radio"
                value="annual"
              />
              Annual
              {savingsLabel && <span className="interval-savings">{savingsLabel}</span>}
            </label>
          </fieldset>
          {tier === 'paid' &&
            current &&
            (current.plan === 'monthly' || current.plan === 'annual') && (
              <p className="interval-toggle-note">
                You&apos;re currently on the {current.plan} plan.
              </p>
            )}

          <div className="plan-cards">
            <section aria-labelledby="plan-free-heading" className="plan-card">
              <h2 id="plan-free-heading">Free</h2>
              <p className="plan-card-price">$0</p>
              <ul className="plan-card-features">
                <li>One fully editable screenplay</li>
                <li>Every authoring feature and keyboard flow</li>
                <li>Export to PDF, FDX, and DOCX</li>
              </ul>
              {freeIsCurrent ? (
                <p className="plan-card-badge">Current plan</p>
              ) : (
                <button
                  className="primary-button"
                  disabled={portal.isPending}
                  onClick={switchToFree}
                  type="button"
                >
                  {portal.isPending ? 'Opening billing…' : 'Switch to Free'}
                </button>
              )}
            </section>

            <section aria-labelledby="plan-pro-heading" className="plan-card">
              <h2 id="plan-pro-heading">Pro</h2>
              <p className="plan-card-price">
                {selectedPrice ? (
                  <>
                    {formatMoney(selectedPrice.amount, selectedPrice.currency)}
                    <span className="plan-card-price-interval">
                      /{interval === 'monthly' ? 'mo' : 'yr'}
                    </span>
                  </>
                ) : (
                  '—'
                )}
              </p>
              <ul className="plan-card-features">
                <li>Create and edit as many screenplays as you like</li>
                <li>Everything in Free</li>
              </ul>
              {proMatchesSelectedInterval && !isCancelledCurrentPlan ? (
                <p className="plan-card-badge">Current plan</p>
              ) : isCancelledCurrentPlan ? (
                <div className="plan-card-current-actions">
                  <p className="plan-card-badge">Current plan</p>
                  <button
                    className="primary-button"
                    disabled={portal.isPending}
                    onClick={switchToPro}
                    type="button"
                  >
                    {portal.isPending ? 'Opening billing…' : 'Resume subscription'}
                  </button>
                </div>
              ) : (
                <button
                  className="primary-button"
                  disabled={hasStripeCustomer ? portal.isPending : checkout.isPending}
                  onClick={switchToPro}
                  type="button"
                >
                  {hasStripeCustomer
                    ? portal.isPending
                      ? 'Opening billing…'
                      : 'Manage Subscription'
                    : checkout.isPending
                      ? 'Starting checkout…'
                      : `Upgrade to ${interval}`}
                </button>
              )}
              {current && (
                <div className="subscription-status">
                  <p className="subscription-plan">{PLAN_NAMES[current.plan]}</p>
                  <p>{STATUS_LABELS[current.status] ?? current.status}</p>
                  {tier === 'paid' ? (
                    current.cancelAtPeriodEnd ? (
                      <>
                        <p>Active until {formatDate(current.currentPeriodEnd)}</p>
                        <p>Cancelled -- won&apos;t renew after this date.</p>
                      </>
                    ) : (
                      <p>Renews on {formatDate(current.currentPeriodEnd)}</p>
                    )
                  ) : (
                    current.canceledAt && <p>Canceled on {formatDate(current.canceledAt)}</p>
                  )}
                </div>
              )}
            </section>
          </div>

          {(portal.isError || checkout.isError) && (
            <p className="field-error" role="alert">
              Could not open billing. Try again.
            </p>
          )}
        </>
      )}
    </section>
  );
}
