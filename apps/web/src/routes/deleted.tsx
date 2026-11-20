import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * A pure redirect, matching `routes/index.tsx`'s own shape: this used to be the Deleted items
 * page itself, reachable only from the account menu. `progress/manage-account-page.md` moved that
 * page under the new Manage account layout, at `/account/deleted` (`routes/account.deleted.tsx`,
 * which renders the same `DeletedPage` this route used to mount directly). This path is kept as a
 * redirect, not deleted outright, so a bookmark or a link saved before that move keeps working --
 * verified internal-only: nothing external (Stripe's Customer Portal redirects go to `/projects`,
 * `/billing/success`, `/billing/canceled`) ever points here.
 */
export const Route = createFileRoute('/deleted')({
  beforeLoad: () => {
    throw redirect({ to: '/account/deleted' });
  },
});
