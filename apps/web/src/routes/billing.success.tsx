import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { api } from '../api.js';
import { guardSessionUser } from '../session.js';

/**
 * Where Stripe Checkout's `success_url` sends the browser after a writer completes payment
 * (stripeCheckout.ts's `createCheckoutSession`). plan.md's rule, stated as directly as it can be
 * stated: **"The Checkout success redirect is not proof of payment. A user can navigate to the
 * success URL directly ... Granting access on redirect is the single most common way subscription
 * integrations leak paid features."**
 *
 * This page obeys that by construction, not by care: it makes exactly one network call, a plain
 * `GET /api/entitlement`, which only ever *reads* the `subscriptions` projection
 * (apps/api/src/entitlementStore.ts) -- there is no mutation this component could call even by
 * accident that would grant anything. Entitlement becomes `'paid'` only once Stripe's webhook has
 * delivered and processed a `customer.subscription.*` event (stripeWebhook.ts), which typically
 * lands within moments of a real payment but is not guaranteed to have arrived by the time the
 * browser redirect completes -- so this page shows a pending state and lets the writer continue
 * (or re-check) rather than asserting success it cannot yet prove.
 */
export const Route = createFileRoute('/billing/success')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  component: BillingSuccessPage,
});

function BillingSuccessPage() {
  const entitlement = useQuery({ queryKey: ['entitlement'], queryFn: api.entitlement });
  const confirmed = entitlement.data?.tier === 'paid';

  return (
    <main className="project-screen">
      <section className="project-list">
        <p className="eyebrow">BILLING</p>
        {confirmed ? (
          <>
            <h1>You&apos;re on Finaler Draft Pro</h1>
            <p>Your subscription is active. Every screenplay is editable now.</p>
          </>
        ) : (
          <>
            <h1>Thanks -- finishing up</h1>
            <p>
              We&apos;re confirming your payment with Stripe. This usually takes just a moment; if
              this page still says so after a refresh, your subscription may still be processing.
            </p>
          </>
        )}
        <p>
          <Link to="/projects">Back to your projects</Link>
        </p>
      </section>
    </main>
  );
}
