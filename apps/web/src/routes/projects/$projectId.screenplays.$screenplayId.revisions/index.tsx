import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useParams } from '@tanstack/react-router';
import { z } from 'zod';
import { api, type RevisionListItem } from '../../../api.js';
import { AccountMenu } from '../../../accountMenu.js';
import { ApplicationTitlebar } from '../../../applicationShell.js';
import { RouteBreadcrumb } from '../../../routeBreadcrumb.js';
import {
  formatRevisionCreatedAt,
  humanizeRevisionKind,
  revisionPreviewSummary,
} from '../../../revisionDisplay.js';
import { guardSessionUser } from '../../../session.js';

export const Route = createFileRoute('/projects/$projectId/screenplays/$screenplayId/revisions/')({
  // The screenplay's own crumb, resolved the same way `$projectId.tsx` resolves the project's --
  // a loader priming the cache, and a label read off `loaderData`. `Projects` and the project
  // title are inherited from that pathless layout and are deliberately not restated here.
  //
  // This crumb is what replaces the "Back to screenplay" link this header used to carry: the way
  // back is now a segment of the trail rather than a second, separate affordance saying the same
  // thing. `ensureQueryData` on the *same* `['screenplay', id]` key the editor route already uses,
  // so arriving here from the editor is a cache hit rather than a second fetch.
  loader: async ({ context, params }) => {
    const { api } = await import('../../../api.js');
    const screenplay = await context.queryClient.ensureQueryData({
      queryKey: ['screenplay', params.screenplayId],
      queryFn: () => api.screenplay(params.screenplayId),
    });
    return { screenplayTitle: screenplay.title };
  },
  staticData: {
    breadcrumb: [
      {
        label: (ctx) => (ctx.loaderData as { screenplayTitle?: string }).screenplayTitle,
        to: (ctx) => `/projects/${ctx.params.projectId}/screenplays/${ctx.params.screenplayId}`,
      },
    ],
  },
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  params: {
    parse: (params) =>
      z.object({ projectId: z.string().uuid(), screenplayId: z.string().uuid() }).parse(params),
  },
  component: RevisionHistoryPage,
});

/**
 * Collaboration slice 4a's revision history. A plain list, reachable only from the live editor's
 * "Revision history…" File menu item (App.tsx's `onOpenRevisionHistory`) -- never from anywhere
 * that would suggest history is itself editable. Carries no screenplay text in its own route
 * state (plan.md: "a revision identifier in the URL is fine; screenplay text is not") -- each row
 * links to `/revisions/$revisionId`, and only that route's own `GET` resolves the revision's
 * content.
 */
function RevisionRow({
  projectId,
  revision,
  screenplayId,
}: {
  projectId: string;
  revision: RevisionListItem;
  screenplayId: string;
}) {
  const summary = revisionPreviewSummary(revision.previewMetadata);
  return (
    <li className="revision-row">
      <Link
        className="revision-row-link"
        params={{ projectId, revisionId: revision.id, screenplayId }}
        to="/projects/$projectId/screenplays/$screenplayId/revisions/$revisionId"
      >
        <span className="revision-row-title">{humanizeRevisionKind(revision)}</span>
        <span className="revision-row-meta">
          {formatRevisionCreatedAt(revision.createdAt)}
          {summary ? ` · ${summary}` : ''}
        </span>
      </Link>
      {/* Collaboration slice 4b's screenplay-aware diff: the writer-facing entry point into the
          diff view, compared against the screenplay's current live content by default -- the same
          comparison plan.md's restore flow will need. A sibling of the row's own link, not nested
          inside it, since the two navigate to genuinely different places. */}
      <Link
        className="revision-row-diff-link"
        params={{ projectId, revisionId: revision.id, screenplayId }}
        to="/projects/$projectId/screenplays/$screenplayId/revisions/$revisionId/diff"
      >
        Compare to current
      </Link>
    </li>
  );
}

function RevisionHistoryPage() {
  const { projectId, screenplayId } = useParams({
    from: '/projects/$projectId/screenplays/$screenplayId/revisions/',
  });
  const revisions = useQuery({
    queryKey: ['revisions', screenplayId],
    queryFn: () => api.listRevisions(screenplayId),
  });

  return (
    <main className="project-screen">
      <ApplicationTitlebar
        accountMenu={<AccountMenu />}
        // No `wipeLabel`: the owner's wipe ask was for the editor and the comparison. This screen
        // reaches its screenplay through the breadcrumb's own segment instead.
        brand={{ href: '/projects' }}
        breadcrumb={<RouteBreadcrumb />}
        documentTitle="Revision history"
      />
      <section className="project-list">
        <p className="eyebrow">HISTORY</p>
        <h1>Revision history</h1>
        {revisions.isLoading ? (
          <p>Loading revision history…</p>
        ) : revisions.isError ? (
          <p role="alert">Revision history could not be loaded.</p>
        ) : (revisions.data as RevisionListItem[]).length === 0 ? (
          <p className="muted">No revisions yet.</p>
        ) : (
          <ul>
            {(revisions.data as RevisionListItem[]).map((revision) => (
              <RevisionRow
                key={revision.id}
                projectId={projectId}
                revision={revision}
                screenplayId={screenplayId}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
