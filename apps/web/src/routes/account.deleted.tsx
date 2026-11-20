import { createFileRoute } from '@tanstack/react-router';
import { DeletedPage } from '../deletedItemsPage.js';

/**
 * The "Deleted items" tab of the Manage account page (`routes/account.tsx`,
 * `progress/manage-account-page.md`). Guarded once, by the parent layout's own `beforeLoad` --
 * TanStack Router runs every ancestor's `beforeLoad` before a leaf route is reached, so repeating
 * `guardSessionUser` here would only re-run a check that already ran. Renders `DeletedPage`
 * (`deletedItemsPage.tsx`) unchanged: this tab contributes nothing of its own beyond the path.
 */
export const Route = createFileRoute('/account/deleted')({ component: DeletedPage });
