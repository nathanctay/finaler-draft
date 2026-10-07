import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate, useParams } from '@tanstack/react-router';
import { z } from 'zod';
import { api, type PersistedScreenplay, type RevisionDetail } from '../../../api.js';
import { formatRevisionCreatedAt, humanizeRevisionKind } from '../../../revisionDisplay.js';
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
 */
function RevisionPreviewPage() {
  const { projectId, revisionId, screenplayId } = useParams({
    from: '/projects/$projectId/screenplays/$screenplayId/revisions/$revisionId/',
  });
  const navigate = useNavigate();
  const revision = useQuery({
    queryKey: ['revision', screenplayId, revisionId],
    queryFn: () => api.revision(screenplayId, revisionId),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

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
        historicalRevision={{ label, onBackToLiveDocument: backToLiveDocument }}
        initial={initial}
        key={revisionId}
      />
    </Suspense>
  );
}
