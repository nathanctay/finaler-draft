import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { api, type Project } from '../../api.js';
import { guardSessionUser } from '../../session.js';
import { DeletedRow } from '../../components/DeletedRow.js';
import { OverflowMenu } from '../../components/OverflowMenu.js';

export const Route = createFileRoute('/projects/')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  component: ProjectsPage,
});

/**
 * A single project row, either its normal Link-plus-menu form or -- once its own delete
 * mutation has succeeded -- nothing at all: `ProjectsPage` swaps this out for `DeletedRow`
 * rather than rendering both, so a just-deleted row never keeps a live Link into the project it
 * no longer has access to, or a menu whose only action (Delete) no longer applies.
 *
 * The menu itself only renders for an owner. `deleteProject` is owner-only server-side, so
 * showing Delete to an editor or reviewer would be a control that always 403s -- the exact
 * "broken control" class of defect called out for a Restore button that can't succeed. Non-owner
 * members still get a real, if empty, menu affordance in Rename/Edit's eventual home; there is
 * nothing else to put there yet, so the menu is simply omitted rather than rendered disabled.
 */
function ProjectRow({ onDeleted, project }: { onDeleted: () => void; project: Project }) {
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: onDeleted,
  });
  return (
    <div className="project-row">
      <Link
        className="project-row-link"
        params={{ projectId: project.id }}
        to="/projects/$projectId"
      >
        <strong>{project.title}</strong>
        <span className="project-row-role">{project.role}</span>
      </Link>
      {project.role === 'owner' && (
        <OverflowMenu
          items={[{ label: 'Delete', onSelect: () => deleteMutation.mutate() }]}
          label={`Project actions for ${project.title}`}
        />
      )}
      {deleteMutation.isError && (
        <p className="field-error" role="alert">
          Delete failed. Try again.
        </p>
      )}
    </div>
  );
}

function ProjectsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  // id -> title captured at the moment of deletion. Deliberately not cleared by invalidating
  // the `['projects']` query on delete -- see the module comment on DeletedRow and the scope's
  // "what happens when the affordance goes away" requirement. It persists until Undo succeeds
  // (which does invalidate, restoring the row from fresh server data) or this component
  // unmounts on navigation, whichever comes first; it never auto-dismisses on a timer. A
  // background refetch cannot make the affordance vanish either: entries here are rendered
  // regardless of whether the id is still present in `projects.data`, via `orphanedDeletedIds`
  // below, so an incidental window-focus refetch can never silently drop the only route back to
  // Undo before the writer chooses to use it or leave.
  const [deletedProjects, setDeletedProjects] = useState<Record<string, string>>({});
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const create = useMutation({
    mutationFn: () => api.createProject(title),
    onSuccess: () => {
      setTitle('');
      return queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const signOut = useMutation({
    mutationFn: api.signOut,
    onSuccess: () => {
      // Clearing the whole cache, not just ['session'], keeps the next person to sign
      // in on this browser from seeing this user's project and screenplay titles.
      queryClient.clear();
      return navigate({ to: '/sign-in' });
    },
  });

  function forgetDeleted(projectId: string) {
    setDeletedProjects((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== projectId)),
    );
  }

  function handleRestored(projectId: string) {
    forgetDeleted(projectId);
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }

  const liveProjects = projects.data ?? [];
  const orphanedDeletedIds = Object.keys(deletedProjects).filter(
    (id) => !liveProjects.some((project) => project.id === id),
  );

  return (
    <main className="project-screen">
      <header className="project-header">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        <OverflowMenu
          items={[
            // A single, always-available entry rather than two tier-conditional ones ("Upgrade
            // to Pro" vs. "Manage billing", the previous shape): both destinations are now the
            // same page (routes/billing.subscription.tsx), which shows the writer's actual plan
            // and status and offers the right action from there -- upgrade for a free/restricted
            // account, the Customer Portal for a paying one. This also means the account menu no
            // longer needs to fetch entitlement state itself just to decide a label or an action;
            // the destination page owns that.
            {
              label: 'Manage Subscription',
              onSelect: () => void navigate({ to: '/billing/subscription' }),
            },
            { label: 'Deleted items', onSelect: () => void navigate({ to: '/deleted' }) },
            { label: 'Sign out', onSelect: () => signOut.mutate() },
          ]}
          label="Account menu"
          triggerContent="Account"
        />
      </header>
      {signOut.isError && (
        <p className="sign-out-error" role="alert">
          Sign out failed. Try again.
        </p>
      )}
      <section className="project-list">
        <p className="eyebrow">PRIVATE PROJECTS</p>
        <h1>Your writing desk</h1>
        <form
          className="create-row"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <input
            aria-label="New project title"
            placeholder="New project title"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button className="primary-button" disabled={create.isPending} type="submit">
            New project
          </button>
        </form>
        {projects.isLoading ? (
          <p>Loading projects…</p>
        ) : projects.isError ? (
          <p role="alert">Projects could not be loaded.</p>
        ) : (
          <ul>
            {liveProjects.map((project) =>
              deletedProjects[project.id] === undefined ? (
                <li key={project.id}>
                  <ProjectRow
                    onDeleted={() =>
                      setDeletedProjects((current) => ({
                        ...current,
                        [project.id]: project.title,
                      }))
                    }
                    project={project}
                  />
                </li>
              ) : (
                <li key={project.id}>
                  <DeletedRow
                    onRestored={() => handleRestored(project.id)}
                    restore={() => api.restoreProject(project.id)}
                    title={deletedProjects[project.id]!}
                  />
                </li>
              ),
            )}
            {orphanedDeletedIds.map((id) => (
              <li key={id}>
                <DeletedRow
                  onRestored={() => handleRestored(id)}
                  restore={() => api.restoreProject(id)}
                  title={deletedProjects[id]!}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
