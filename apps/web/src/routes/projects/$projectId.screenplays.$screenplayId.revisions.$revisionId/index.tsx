import { lazy, Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate, useParams } from '@tanstack/react-router';
import { z } from 'zod';
import { api, type PersistedScreenplay, type RevisionDetail } from '../../../api.js';
import {
  formatRevisionCreatedAt,
  humanizeRevisionKind,
  revisionPreviewSummary,
} from '../../../revisionDisplay.js';
import { RestoreRevisionDialog } from '../../../restoreRevisionDialog.js';
import { guardSessionUser } from '../../../session.js';

export const Route = createFileRoute(
  '/projects/$projectId/screenplays/$screenplayId/revisions/$revisionId/',
)({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  params: {
    parse: (params) =>
      z
        .object({
          projectId: z.string().uuid(),
          revisionId: z.string().uuid(),
          screenplayId: z.string().uuid(),
        })
        .parse(params),
  },
  component: RevisionPreviewPage,
});

const EditorWorkspace = lazy(async () => ({ default: (await import('../../../App.js')).App }));

/**
 * Collaboration slice 4a's read-only historical preview -- the one addressable route for it.
 * `revisionId` in the URL is the only revision-identifying state this route carries; the
 * screenplay content itself is never put in the URL or in any client-side state this route
 * constructs on its own (plan.md's "routes carry only safe addressable state"). Everything the
 * editor renders comes from `GET /api/screenplays/:id/revisions/:revisionId`, read fresh on every
 * visit.
 *
 * Renders `App` with `historicalRevision` set and *no* `onOpenRevisionHistory` -- see that prop's
 * own comment on why history is never offered from inside history.
 *
 * Collaboration slice 5 adds the one path from here back into the live document: `historicalRevision.
 * onRestore`, offered only when `GET /api/entitlement` confirms this account may actually edit this
 * screenplay. That check is a courtesy, not the gate -- the server resolves membership, role and
 * entitlement for itself on every restore request (`apps/api/src/restore.ts`) and answers 403/402
 * regardless of what this route rendered. Hiding the button for an account that cannot use it is the
 * same reasoning `entitlementReadOnly.onMakeEditable` already applies to a non-candidate screenplay.
 */
function RevisionPreviewPage() {
  const { projectId, revisionId, screenplayId } = useParams({
    from: '/projects/$projectId/screenplays/$screenplayId/revisions/$revisionId/',
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const revision = useQuery({
    queryKey: ['revision', screenplayId, revisionId],
    queryFn: () => api.revision(screenplayId, revisionId),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  // The live screenplay, for exactly one field: its `currentEpoch`, which the restore request must
  // carry as `expectedEpoch` so a restore confirmed against a document that has since moved on is
  // refused rather than silently applied (`restoreRevisionInput.expectedEpoch`). Read from the same
  // `['screenplay', id]` cache entry the live editor route populates, so arriving here from that route
  // -- the only way in -- costs no extra request.
  const screenplay = useQuery({
    queryKey: ['screenplay', screenplayId],
    queryFn: () => api.screenplay(screenplayId),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const entitlement = useQuery({ queryKey: ['entitlement'], queryFn: api.entitlement });
  const snapshot = entitlement.isError ? undefined : entitlement.data;
  const mayRestore =
    screenplay.data !== undefined &&
    (snapshot?.tier === 'paid' || snapshot?.editableScreenplayId === screenplayId);

  if (revision.isLoading) return <main className="loading-screen">Opening revision…</main>;
  if (revision.isError)
    return <main className="loading-screen">This revision is unavailable.</main>;

  // Matches the live screenplay route's own convention (`screenplay.data as PersistedScreenplay`):
  // the `isLoading`/`isError` checks above already exhaust every state this query can be in once
  // it settles, but React Query's own types do not narrow `.data` from that alone.
  const data = revision.data as RevisionDetail;
  const initial: PersistedScreenplay = {
    id: data.id,
    projectId,
    screenplay: data.screenplay,
    title: data.screenplay.title,
    // Never used: `App` constructs no `HocuspocusProvider` and no `IndexeddbPersistence` at all when
    // `historicalRevision` is set (`App.historicalRevision.test.tsx` asserts exactly that), and the
    // epoch is read only to name those two things. `0` rather than the live screenplay's real epoch
    // because this route deliberately never fetches the live screenplay -- a historical preview must
    // not depend on the state of the document it is not showing.
    currentEpoch: 0,
  };
  const label = `${humanizeRevisionKind(data)} — ${formatRevisionCreatedAt(data.createdAt)}`;
  // The banner's own way out, supplied here rather than performed inside `App` -- see
  // `HistoricalRevisionInfo.onBackToLiveDocument`. The live editor route, not this route's parent:
  // a writer leaving a historical revision wants the document, not the revision list they may not
  // have come through.
  const backToLiveDocument = () => {
    void navigate({
      params: { projectId, screenplayId },
      to: '/projects/$projectId/screenplays/$screenplayId',
    });
  };

  return (
    <Suspense fallback={<main className="loading-screen">Loading editor…</main>}>
      <EditorWorkspace
        historicalRevision={{
          label,
          onBackToLiveDocument: backToLiveDocument,
          onRestore: mayRestore ? () => setRestoreDialogOpen(true) : undefined,
        }}
        initial={initial}
        key={revisionId}
      />
      {restoreDialogOpen && screenplay.data && (
        <RestoreRevisionDialog
          onClose={() => setRestoreDialogOpen(false)}
          onConfirm={async (restoreRequestId) => {
            await api.restoreRevision(screenplayId, revisionId, {
              expectedEpoch: (screenplay.data as PersistedScreenplay).currentEpoch,
              restoreRequestId,
            });
            // Both invalidations matter before navigating. `['screenplay', id]` is cached with
            // `staleTime: Infinity` and `refetchOnMount: false`, so without this the live route would
            // reopen the *pre-restore* snapshot -- including its old `currentEpoch`, which would point
            // the collaboration provider at the epoch the restore just retired. `['revisions', id]`
            // is invalidated because the restore wrote new rows (the `restore` record, and the
            // `pre_restore` capture of what it replaced) that history must show.
            await queryClient.invalidateQueries({ queryKey: ['screenplay', screenplayId] });
            await queryClient.invalidateQueries({ queryKey: ['revisions', screenplayId] });
            await navigate({
              params: { projectId, screenplayId },
              to: '/projects/$projectId/screenplays/$screenplayId',
            });
          }}
          revisionLabel={label}
          revisionSummary={revisionPreviewSummary(data.previewMetadata)}
        />
      )}
    </Suspense>
  );
}
