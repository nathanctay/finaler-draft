import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router';
import { z } from 'zod';
import { api, type FetchedScreenplay, type PersistedScreenplay } from '../../../api.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import type { EntitlementReadOnly } from '../../../App.js';

// Lazy for the same reason `EditorWorkspace` is: the dialog is only needed once a writer opens it.
const SharingDialog = lazy(async () => ({
  default: (await import('../../../sharingDialog.js')).SharingDialog,
}));

export const Route = createFileRoute('/projects/$projectId/screenplays/$screenplayId/')({
  component: ScreenplayPage,
  params: {
    parse: (params) =>
      z.object({ projectId: z.string().uuid(), screenplayId: z.string().uuid() }).parse(params),
  },
});

const EditorWorkspace = lazy(async () => ({ default: (await import('../../../App.js')).App }));

function ScreenplayPage() {
  const { projectId, screenplayId } = useParams({
    from: '/projects/$projectId/screenplays/$screenplayId/',
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sharingOpen, setSharingOpen] = useState(false);
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

  // The viewer's own effective role on this screenplay, from the same response that authorized the
  // read. `onOpenSharing` is supplied only when it is `owner` or `editor` -- exactly the bar
  // `apps/api`'s sharing store enforces -- so the File menu's "Share…" is present precisely when it
  // would work, and absent rather than disabled otherwise (`App.tsx`'s `onOpenSharing` comment).
  //
  // The same field is also handed to the editor as `viewerRole`, which is what makes a reviewer's
  // screenplay genuinely read-only rather than merely refused at the socket -- see `App.tsx`'s own
  // comment on that prop. It is passed as the role, not as a precomputed read-only decision, so the
  // ranking against `entitlementReadOnly` lives in the one component that gates editing.
  const fetched = screenplay.data as FetchedScreenplay;
  const mayShare = fetched.role === 'owner' || fetched.role === 'editor';

  return (
    <Suspense fallback={<main className="loading-screen">Loading editor…</main>}>
      {sharingOpen && (
        <Suspense fallback={null}>
          <SharingDialog
            onClose={() => setSharingOpen(false)}
            scope={{ kind: 'screenplay', screenplayId }}
            title={fetched.title}
          />
        </Suspense>
      )}
      <EditorWorkspace
        entitlementReadOnly={entitlementReadOnly}
        initial={screenplay.data as PersistedScreenplay}
        {...(mayShare ? { onOpenSharing: () => setSharingOpen(true) } : {})}
        // Renaming from the title bar updates the editor's own displayed title locally, which is
        // all the editor itself needs; these invalidations are for everything *else* that has the
        // old title cached. `['screenplay', screenplayId]` matters because this route's own fetch
        // seeds `initial` -- without it, a remount (a restore's epoch cutover, say) would show the
        // stale name again. `['screenplays', projectId]` and `['projects']` are the two listings a
        // writer reaches by navigating back, and they are keyed independently of this route.
        //
        // Deliberately not `await`ed and not blocking the rename's own success: the write already
        // succeeded server-side by the time this runs, and a refetch failing is not a reason to
        // tell the writer their rename did not happen.
        onScreenplayRenamed={() => {
          void queryClient.invalidateQueries({ queryKey: ['screenplay', screenplayId] });
          void queryClient.invalidateQueries({ queryKey: ['screenplays', projectId] });
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
        }}
        // Collaboration slice 5: the epoch is part of the key, not just the screenplay id. A restore
        // (performed here or by a collaborator) changes `currentEpoch`, and `App` must then be a fresh
        // mount -- new `HocuspocusProvider` for the new document name, new (empty) `y-indexeddb`
        // database, new editor state seeded from the restored content. Keying on the screenplay id
        // alone would keep the retired document's React tree and provider alive across the cutover.
        key={`${screenplayId}:${(screenplay.data as PersistedScreenplay).currentEpoch}`}
        onOpenRevisionHistory={() =>
          void navigate({
            params: { projectId, screenplayId },
            to: '/projects/$projectId/screenplays/$screenplayId/revisions',
          })
        }
        // Collaboration slice 5, plan.md step 4's "reload the new epoch". Invalidating this route's own
        // screenplay query is the whole of it: the refetch carries the new `currentEpoch`, which changes
        // the `key` above, which remounts `App` onto the restored collaboration document. Nothing here
        // reloads the page -- the writer keeps their place in the application rather than being bounced
        // through a full navigation.
        onReloadRestoredDocument={() => {
          void queryClient.invalidateQueries({ queryKey: ['screenplay', screenplayId] });
        }}
        viewerRole={fetched.role}
      />
    </Suspense>
  );
}
