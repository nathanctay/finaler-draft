import { createFileRoute, Link, Outlet, redirect, useLocation } from '@tanstack/react-router';
import { AccountMenu } from '../accountMenu.js';
import { ApplicationTitlebar } from '../applicationShell.js';
import { guardSessionUser } from '../session.js';

/**
 * The Manage account page's layout, `progress/manage-account-page.md` -- the owner's own words:
 * "I also think we should consolidate the links from the account dropdown into a manage account
 * page... We can use left side navigation to switch between tabs (manage subscription, deleted
 * items, etc)." Three tabs nest under this route and share the chrome it renders once:
 *
 * - `/account` (index, `routes/account/index.tsx`) -- account info: name, email, and the
 *   way to `/account/delete` at the bottom.
 * - `/account/subscription` (`routes/account.subscription.tsx`) -- the existing Manage
 *   Subscription page, unmoved in behaviour (`manageSubscriptionPage.tsx`).
 * - `/account/deleted` (`routes/account.deleted.tsx`) -- the existing Deleted items page,
 *   likewise unmoved (`deletedItemsPage.tsx`).
 *
 * **`/account/delete` is deliberately not a fourth tab.** It stays its own full, independent
 * screen -- the owner's explicit instruction, because it already carries its own
 * `ApplicationTitlebar`, its own precheck, and substantial tests that this slice was told not to
 * disturb. `routes/account_.delete.tsx`'s filename (a trailing underscore on the `account`
 * segment) is what keeps the router from nesting it under this layout anyway, purely because its
 * path starts with `/account/`; see that file's own comment for the mechanism. The Account info
 * tab's own "Delete account" button is a plain navigation there, not a tab.
 *
 * **Deep-linkable, not local tab state.** Each tab is a real nested route reached by a real
 * `Link`, so a direct link to `/account/deleted` lands on that tab without a detour through the
 * index, and the browser back button moves between tabs the way it moves between any other two
 * pages -- neither of which a `useState`-held "current tab" index could offer.
 *
 * **One titlebar, not three.** `ApplicationTitlebar` and `AccountMenu` render here, once; every
 * tab (see each one's own module comment) returns only its content panel, matching how
 * `routes/projects/$projectId.tsx`'s `ProjectLayout` already renders the chrome once for every
 * screen nested under a project rather than each of those repeating it.
 *
 * **The left pane is a settings window's own navigation, not the application rail the owner
 * rejected earlier in this project** (`progress/app-bar-navigation.md`). It reuses `.project-list`'s
 * existing card idiom -- the same border, background, and shadow tokens Deleted items, Manage
 * Subscription, and Delete account already render inside -- widened into two columns
 * (`.account-window`/`.account-nav`/`.account-tab-content` in `styles.css`) rather than inventing a
 * second card-and-shadow language that exists nowhere else in this app.
 */
export const Route = createFileRoute('/account')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  component: AccountLayout,
});

const TABS = [
  { label: 'Account info', to: '/account' as const },
  { label: 'Manage Subscription', to: '/account/subscription' as const },
  { label: 'Deleted items', to: '/account/deleted' as const },
];

function AccountLayout() {
  const { pathname } = useLocation();

  return (
    <main className="project-screen">
      <ApplicationTitlebar
        accountMenu={<AccountMenu />}
        // A plain link, matching every other screen reached from the account menu rather than
        // descended from the dashboard (routes/deleted.tsx's own comment: "it shouldn't say
        // Projects before the page in the header").
        brand={{ href: '/projects' }}
        documentTitle="Manage account"
      />
      <div className="account-window">
        <nav aria-label="Account settings" className="account-nav">
          <ul>
            {TABS.map((tab) => {
              const active = pathname === tab.to;
              return (
                <li key={tab.to}>
                  <Link
                    aria-current={active ? 'page' : undefined}
                    className={
                      active ? 'account-nav-link account-nav-link-active' : 'account-nav-link'
                    }
                    to={tab.to}
                  >
                    {tab.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="account-tab-content">
          <Outlet />
        </div>
      </div>
    </main>
  );
}
