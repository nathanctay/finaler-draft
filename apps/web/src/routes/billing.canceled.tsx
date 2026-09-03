import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { guardSessionUser } from '../session.js';

/**
 * Where Stripe Checkout's `cancel_url` sends the browser if a writer backs out before paying
 * (stripeCheckout.ts's `createCheckoutSession`). Purely informational -- there is nothing to
 * confirm or grant here, and this page makes no network call at all.
 */
export const Route = createFileRoute('/billing/canceled')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  component: BillingCanceledPage,
});

function BillingCanceledPage() {
  return (
    <main className="project-screen">
      <section className="project-list">
        <p className="eyebrow">BILLING</p>
        <h1>Checkout canceled</h1>
        <p>No changes were made. You can upgrade any time from the account menu.</p>
        <p>
          <Link to="/projects">Back to your projects</Link>
        </p>
      </section>
    </main>
  );
}
