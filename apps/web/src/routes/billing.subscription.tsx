import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * A pure redirect, matching `routes/index.tsx`'s own shape: this used to be the Manage
 * Subscription page itself, reachable only from the account menu. `progress/manage-account-page.
 * md` moved that page under the new Manage account layout, at `/account/subscription`
 * (`routes/account.subscription.tsx`, which renders the same `ManageSubscriptionPage` this route
 * used to mount directly). This path is kept as a redirect, not deleted outright, so a bookmark
 * or a link saved before that move keeps working -- verified internal-only: Stripe's Customer
 * Portal `return_url` is `/projects`, and `success_url`/`cancel_url` are the separate
 * `/billing/success` and `/billing/canceled` routes, so nothing external ever points here.
 */
export const Route = createFileRoute('/billing/subscription')({
  beforeLoad: () => {
    throw redirect({ to: '/account/subscription' });
  },
});
