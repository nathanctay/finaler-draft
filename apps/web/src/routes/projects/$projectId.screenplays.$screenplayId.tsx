import { createFileRoute, useParams } from '@tanstack/react-router';
import { z } from 'zod';
import { api, type PersistedScreenplay } from '../../api.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import type { EntitlementReadOnly } from '../../App.js';

export const Route = createFileRoute('/projects/$projectId/screenplays/$screenplayId')({
  component: ScreenplayPage,
  params: {
    parse: (params) =>
      z.object({ projectId: z.string().uuid(), screenplayId: z.string().uuid() }).parse(params),
  },
});

const EditorWorkspace = lazy(async () => ({ default: (await import('../../App.js')).App }));

function ScreenplayPage() {
  const { screenplayId } = useParams({ from: '/projects/$projectId/screenplays/$screenplayId' });
  const queryClient = useQueryClient();
  // This query is intentionally consumed once. The editor owns the immutable route snapshot thereafter.
  const screenplay = useQuery({
    queryKey: ['screenplay', screenplayId],
    queryFn: () => api.screenplay(screenplayId),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  // Unlike `screenplay` above, this is deliberately live, ordinary `useQuery` state -- entitlement
  // can change while this screenplay stays open (the writer subscribes in another tab, or makes
  // a different screenplay editable and comes back here), and `switchEditableScreenplay`'s own
  // `onSuccess` below invalidates it so a successful "Make this one editable" click is reflected
  // without a route change or a full reload.
  const entitlement = useQuery({ queryKey: ['entitlement'], queryFn: api.entitlement });

  if (screenplay.isLoading || entitlement.isLoading)
    return <main className="loading-screen">Opening screenplay…</main>;
  if (screenplay.isError)
    return <main className="loading-screen">This screenplay is unavailable.</main>;

  // Fail safe, not fail open: an entitlement fetch that errored is treated exactly like a
  // restricted account for whom this screenplay is not the editable one -- reading, scrolling,
  // and exporting all keep working (nothing here blocks rendering the editor), but nothing is
  // ever silently allowed to type into a screenplay this app could not confirm it may edit. This
  // is the one gate plan.md's "a writer must never lose access to their own work" cuts the other
  // way for: not knowing the entitlement state is not a reason to guess "editable".
  const snapshot = entitlement.isError ? undefined : entitlement.data;
  const editable = snapshot
    ? snapshot.tier === 'paid' || snapshot.editableScreenplayId === screenplayId
    : false;
  const isCandidate = snapshot?.candidateScreenplayIds.includes(screenplayId) ?? false;
  // `cooldownEndsAt` is server-derived (entitlements.ts's `EDITABLE_SLOT_COOLDOWN_MS`, evaluated
  // against the account's actual switch history) and comes back even when it names a moment
  // already in the past -- a restricted account that switched more than 24h ago still carries its
  // last `cooldownEndsAt`, simply an elapsed one. Comparing it to `now` here is reading that
  // value for display, not recomputing the interval or the policy: the server remains the only
  // gate (`switchEditableScreenplay`'s own 409), and a stale or wrong read here costs at most one
  // avoidable click, never a false "you may edit."
  const cooldownEndsAt = snapshot?.cooldownEndsAt ? new Date(snapshot.cooldownEndsAt) : null;
  const cooldownActive = cooldownEndsAt !== null && cooldownEndsAt.getTime() > Date.now();

  const entitlementReadOnly: EntitlementReadOnly | undefined = editable
    ? undefined
    : {
        message:
          snapshot && snapshot.editableScreenplayId === null
            ? 'Your subscription has ended, and you haven’t chosen which screenplay stays editable yet. You can read and export every screenplay in the meantime.'
            : 'Your subscription has ended and a different screenplay is currently your account’s editable one. You can still read and export this one.',
        // Omitted (hiding the button entirely) when this screenplay isn't even a live candidate
        // for this account -- a reviewer-role screenplay, or the entitlement fetch itself failed
        // -- since offering an action that could only ever answer "not found" is worse than no
        // action at all. `finally`, not only the success path: a click that lands inside a
        // cooldown this app's own last fetch didn't yet know about (a real race, not a bug) still
        // refreshes entitlement, so the very next render carries the fresh `cooldownEndsAt` and
        // the banner's preemptive notice takes over from the one-off error message -- see
        // App.tsx's own comment on why the two are mutually exclusive, not both shown at once.
        onMakeEditable:
          isCandidate && !entitlement.isError
            ? async () => {
                try {
                  await api.switchEditableScreenplay(screenplayId);
                } finally {
                  await queryClient.invalidateQueries({ queryKey: ['entitlement'] });
                }
              }
            : undefined,
        // Known up front rather than discovered by a click that can only fail: plan.md never
        // asked for this, but a refusal with no visible reason is indistinguishable from a
        // broken button, and this app already has the one fact (the server's own cooldown
        // deadline) that turns it into an honest, dated explanation instead.
        cooldownUntil:
          isCandidate && !entitlement.isError && cooldownActive
            ? cooldownEndsAt!.toLocaleString()
            : undefined,
      };

  return (
    <Suspense fallback={<main className="loading-screen">Loading editor…</main>}>
      <EditorWorkspace
        entitlementReadOnly={entitlementReadOnly}
        initial={screenplay.data as PersistedScreenplay}
        key={screenplayId}
      />
    </Suspense>
  );
}
