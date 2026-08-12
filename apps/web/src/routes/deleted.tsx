import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { api, type DeletedProject, type DeletedScreenplay } from '../api.js';
import { guardSessionUser } from '../session.js';

/**
 * The permanent route back to anything soft-deleted -- reachable only from the account menu
 * (see the "Deleted items" menu item in routes/projects/index.tsx), never linked from the
 * writing desk or a project's screenplay list. Named "Deleted", not "Recently deleted": nothing
 * here is purged and there is no retention window, so the friendlier name would promise an
 * expiry that does not exist (plan.md, "Deleting and restoring").
 *
 * Restore here is a rectangular button per row, not an overflow menu -- restoring is the only
 * action available on this page, so hiding it behind a menu would be perverse (plan.md again).
 */
export const Route = createFileRoute('/deleted')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  component: DeletedPage,
});

/**
 * `accessibleLabel` gives each Restore button a distinct name -- "Restore" repeated on every row
 * is indistinguishable to a screen reader user once more than one row is present, the same class
 * of defect the per-row OverflowMenu labels were built to avoid (see components/OverflowMenu.tsx).
 */
function RestoreButton({
  accessibleLabel,
  onRestored,
  restore,
}: {
  accessibleLabel: string;
  onRestored: () => void;
  restore: () => Promise<unknown>;
}) {
  const restoreMutation = useMutation({ mutationFn: restore, onSuccess: onRestored });
  return (
    <>
      <button
        aria-label={accessibleLabel}
        className="primary-button"
        disabled={restoreMutation.isPending}
        onClick={() => restoreMutation.mutate()}
        type="button"
      >
        {restoreMutation.isPending ? 'Restoring…' : 'Restore'}
      </button>
      {restoreMutation.isError && (
        <p className="field-error" role="alert">
          Restore failed. Try again.
        </p>
      )}
    </>
  );
}

function DeletedProjectRow({
  onRestored,
  project,
}: {
  onRestored: () => void;
  project: DeletedProject;
}) {
  return (
    <li>
      <div className="restore-row">
        <span className="restore-row-title">{project.title}</span>
        <RestoreButton
          accessibleLabel={`Restore ${project.title}`}
          onRestored={onRestored}
          restore={() => api.restoreProject(project.id)}
        />
      </div>
    </li>
  );
}

function DeletedScreenplayRow({
  onRestored,
  screenplay,
}: {
  onRestored: () => void;
  screenplay: DeletedScreenplay;
}) {
  return (
    <li>
      <div className="restore-row">
        <span>
          <span className="restore-row-title">{screenplay.title}</span>
          <span className="restore-row-meta">{`From ${screenplay.projectTitle}`}</span>
        </span>
        <RestoreButton
          accessibleLabel={`Restore ${screenplay.title}, from ${screenplay.projectTitle}`}
          onRestored={onRestored}
          restore={() => api.restoreScreenplay(screenplay.id)}
        />
      </div>
    </li>
  );
}

function DeletedPage() {
  const queryClient = useQueryClient();
  const deletedItems = useQuery({ queryKey: ['deleted'], queryFn: api.deletedItems });
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Restoring removes the row entirely rather than swapping it for another affordance (there is
  // nothing left to show once it is restored), so the same focus-loss risk DeletedRow's mount
  // effect solves for delete applies here in reverse: the just-clicked Restore button unmounts
  // and nothing claims focus afterward. `headingRef` is `tabIndex={-1}` specifically so it can
  // receive focus programmatically without becoming a stray stop in normal Tab order.
  function refresh() {
    headingRef.current?.focus();
    void queryClient.invalidateQueries({ queryKey: ['deleted'] });
  }

  const projects = deletedItems.data?.projects ?? [];
  const screenplays = deletedItems.data?.screenplays ?? [];

  return (
    <main className="project-screen">
      <header className="project-header">
        <Link to="/projects">Projects</Link>
      </header>
      <section className="project-list">
        <p className="eyebrow">RECOVERY</p>
        <h1 ref={headingRef} tabIndex={-1}>
          Deleted
        </h1>
        {deletedItems.isLoading ? (
          <p>Loading deleted items…</p>
        ) : deletedItems.isError ? (
          <p role="alert">Deleted items could not be loaded.</p>
        ) : (
          <>
            <div className="deleted-page-section">
              <h2>Projects</h2>
              {projects.length === 0 ? (
                <p className="muted">No deleted projects.</p>
              ) : (
                <ul>
                  {projects.map((project) => (
                    <DeletedProjectRow key={project.id} onRestored={refresh} project={project} />
                  ))}
                </ul>
              )}
            </div>
            <div className="deleted-page-section">
              <h2>Screenplays</h2>
              {screenplays.length === 0 ? (
                <p className="muted">No deleted screenplays.</p>
              ) : (
                <ul>
                  {screenplays.map((screenplay) => (
                    <DeletedScreenplayRow
                      key={screenplay.id}
                      onRestored={refresh}
                      screenplay={screenplay}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
