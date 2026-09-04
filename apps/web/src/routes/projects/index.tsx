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
  // Drives the persistent lapse-chooser banner below: plan.md's "a lapsed account with several
  // screenplays must be asked which one stays editable" -- shown only when there is genuinely a
  // choice to make (more than one candidate) and none has been made yet. An active subscriber, a
  // restricted account with zero or one candidate (nothing to choose among -- `resolveEditable
  // ScreenplayId`, apps/api/src/entitlements.ts, already resolves that case on its own), and a
  // restricted account that has already chosen all render nothing here. An errored fetch also
  // renders nothing: this banner is advisory, not a gate -- every screenplay stays readable and
  // exportable regardless, so there is nothing unsafe about staying silent until the next
  // successful fetch, unlike the editor's own fail-safe-to-read-only rule for actual editing.
  //
  // This page previously fetched entitlement eagerly for the account menu's own labelling, and
  // that turned out to cost real backend load: `getSnapshot` runs three parallel SQL queries, and
  // this is the one page every flow in the system suite touches at least once, which measurably
  // regressed `test:system:persistence` under Playwright's 3-worker contention
  // (progress/billing-checkout.md's "A regression, found and fixed"). That fetch was later
  // deferred to the account menu's own open event, then removed from this page entirely once
  // `routes/billing.subscription.tsx` took over as the one place entitlement state was shown. The
  // banner below reintroduces an unconditional fetch here -- there is no interaction to defer it
  // behind, since a persistent banner must be visible without one -- so `staleTime` is set well
  // above React Query's zero-second default specifically to blunt the repeat-fetch cost a single
  // browsing session's several visits to this page would otherwise add back; entitlement changing
  // (a lapse, or a switch made elsewhere) is not something a writer needs reflected within a
  // minute of it happening on a page whose own action is "go read the details on another page".
  const entitlement = useQuery({
    queryKey: ['entitlement'],
    queryFn: api.entitlement,
    staleTime: 60_000,
  });
  const showLapseChooserBanner =
    entitlement.data !== undefined &&
    entitlement.data.tier === 'restricted' &&
    entitlement.data.editableScreenplayId === null &&
    entitlement.data.candidateScreenplayIds.length > 1;
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
        {showLapseChooserBanner && (
          // Persistent, not dismissible: this state does not resolve itself, and the owner
          // explicitly rejected a blocking modal here (it would interrupt someone who only
          // wanted to read or export) in favor of exactly this -- inform, then let the choice
          // happen in place. No screenplay title is listed and no default is offered; plan.md
          // is explicit that the system must never choose on the writer's behalf, or fall back
          // to the oldest, newest, or largest -- the choice is made from inside the screenplay
          // the writer actually wants (App.tsx's read-only banner and its "Make this one
          // editable" action), not from a list of titles picked here.
          <div className="lapse-chooser-banner" role="status">
            <p>
              Your subscription has ended, and none of your screenplays is set as editable yet. Open
              any screenplay and choose “Make this one editable” to keep writing there — reading and
              exporting stay available on every screenplay in the meantime.
            </p>
          </div>
        )}
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
