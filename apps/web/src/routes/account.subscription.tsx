import { createFileRoute } from '@tanstack/react-router';
import { ManageSubscriptionPage } from '../manageSubscriptionPage.js';

/**
 * The "Manage Subscription" tab of the Manage account page (`routes/account.tsx`,
 * `progress/manage-account-page.md`). Guarded once, by the parent layout's own `beforeLoad` --
 * see `routes/account.deleted.tsx`'s identical comment. Renders `ManageSubscriptionPage`
 * (`manageSubscriptionPage.tsx`) unchanged.
 */
export const Route = createFileRoute('/account/subscription')({
  component: ManageSubscriptionPage,
});
