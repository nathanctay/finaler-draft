import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DeletedProject, type DeletedScreenplay } from './api.js';

/**
 * The Deleted items panel's content -- extracted out of `routes/deleted.tsx` (now a redirect to
 * `routes/account.deleted.tsx`, part of the Manage account page, `progress/manage-account-page.md`)
 * so the one component keeps every bit of its existing behaviour and `deleted.test.tsx`'s own
 * assertions, rather than those being rewritten against a second, newly-authored implementation.
 *
 * Deliberately just the content, not the page: this used to render its own `<main
 * className="project-screen"><ApplicationTitlebar .../>...`, but the Manage account layout
 * (`routes/account.tsx`) now owns one shared titlebar and left-side navigation for every tab, and
 * a second titlebar rendered underneath it would be the exact double-chrome bug the owner's "it
 * shouldn't say Projects before the page" complaint (this file's own original comment) was about,
 * one level further in. `DeletedPage` returns only the `<section className="project-list">` a
 * tab's content pane actually wants.
 *
 * Named "Deleted", not "Recently deleted": nothing here is purged and there is no retention
 * window, so the friendlier name would promise an expiry that does not exist (plan.md, "Deleting
 * and restoring").
 *
 * Restore here is a rectangular button per row, not an overflow menu -- restoring is the only
 * action available on this page, so hiding it behind a menu would be perverse (plan.md again).
 */

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

export function DeletedPage() {
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
    <section className="project-list">
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
  );
}
