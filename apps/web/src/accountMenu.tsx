import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from './api.js';
import { OverflowMenu } from './components/OverflowMenu.js';

/**
 * The account menu: `Manage Subscription`, `Deleted items`, `Sign out` -- one definition, rendered
 * identically on every screen that wears the shared app bar (`applicationShell.tsx`'s
 * `ApplicationTitlebar`). It used to be three hand-written copies (the writing desk's own menu, and
 * the dead `<span className="account-button">` the project screen, the Deleted screen, the editor
 * and the revision-diff view each carried instead of a working one) -- see
 * `progress/app-bar-navigation.md`'s "the account-menu seam" for why a fourth or fifth copy was
 * rejected in favour of this one component, rather than a per-caller item list the bar itself
 * assembles.
 *
 * Deliberately **not** inside `applicationShell.tsx`. That module is rendered by the lazily-loaded
 * editor (`App.tsx`) and by the read-only revision-diff route, and `App.tsx`'s own standalone test
 * suite (1057 tests, 67 render sites) provides neither router nor query-client context -- the exact
 * reason the brand there is a plain `<a href>` rather than a router `Link` (see that module's own
 * comment). This component needs both: `useNavigate` for three destinations and `useMutation` for
 * the sign-out request, which is a write with a pending state and a failure to report, not
 * something a plain callback prop can carry on its own. Giving the bar that dependency, even only
 * to satisfy this one control, would mean mocking both providers at every one of those 67 render
 * sites to keep `App.test.tsx` passing -- a cost paid everywhere to avoid passing one `ReactNode`
 * here. So this stays a component the bar receives, never one it builds: every router-aware screen
 * (the writing desk, the project screen, Deleted items, and the diff route, which renders
 * `ApplicationTitlebar` directly) mounts `<AccountMenu />` itself and hands it to the bar as the
 * `accountMenu` prop; the editor's own route does the same and passes it down through `App`'s
 * identical `accountMenu` prop, exactly as `onOpenSharing`/`onOpenRevisionHistory`/
 * `onScreenplayRenamed` already flow from a route into that router-agnostic component.
 */
export function AccountMenu() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Local state for the failure message, not `signOut.isError` -- the same choice
  // `sharingDialog.tsx`'s own `actionError` already made, and for the identical reason recorded
  // on its `invite`/`changeRole`/`removeMember`/`revoke` mutations there: this component is now
  // mounted on every screen that wears the shared app bar, several of which have their own
  // unrelated mutations (a project rename, a screenplay delete, a free-tier-limit create) running
  // at the same time. `onError` is the one react-query callback that tells *this* mutation,
  // specifically, that it failed; reading a shared `isError` flag would answer "did *something*
  // on this page just fail", which is a different, wrong question once more than one mutation can
  // be in flight on the same screen.
  const [signOutFailed, setSignOutFailed] = useState(false);
  const signOut = useMutation({
    mutationFn: api.signOut,
    onSuccess: () => {
      // Clearing the whole cache, not just ['session'], keeps the next person to sign in on this
      // browser from seeing this user's project and screenplay titles.
      queryClient.clear();
      return navigate({ to: '/sign-in' });
    },
    onError: () => setSignOutFailed(true),
  });

  return (
    <div className="account-menu">
      <OverflowMenu
        items={[
          // A single, always-available entry rather than two tier-conditional ones: both
          // destinations are the same page (routes/billing.subscription.tsx), which shows the
          // writer's actual plan and status and offers the right action from there.
          {
            label: 'Manage Subscription',
            onSelect: () => void navigate({ to: '/billing/subscription' }),
          },
          { label: 'Deleted items', onSelect: () => void navigate({ to: '/deleted' }) },
          {
            label: 'Sign out',
            onSelect: () => {
              // Cleared on every new attempt, matching "Try again": a writer who sees the
              // message, fixes whatever was wrong (a flaky connection, say) and retries should not
              // keep seeing the previous attempt's message hang around through a second failure
              // of a different kind, or linger if the retry succeeds.
              setSignOutFailed(false);
              signOut.mutate();
            },
          },
        ]}
        label="Account menu"
        triggerContent="Account"
      />
      {signOutFailed && (
        <p className="sign-out-error" role="alert">
          Sign out failed. Try again.
        </p>
      )}
    </div>
  );
}
