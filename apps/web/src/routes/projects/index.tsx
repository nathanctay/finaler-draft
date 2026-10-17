import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { api, type IncomingInvitation, type Project, type SharedScreenplay } from '../../api.js';
import { guardSessionUser } from '../../session.js';
import { DeletedRow } from '../../components/DeletedRow.js';
import { OverflowMenu } from '../../components/OverflowMenu.js';

// Lazy for the same reason the upgrade dialog is on the project page: the sharing dialog is only
// needed once a writer actually opens it, not on every visit to the dashboard, so it stays out of
// this route's eagerly-loaded chunk graph.
const SharingDialog = lazy(async () => ({
  default: (await import('../../sharingDialog.js')).SharingDialog,
}));

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
  const [sharingOpen, setSharingOpen] = useState(false);
  // The first of the slice's three entry points. Offered to an owner *or* an editor, which is
  // exactly the bar the server enforces (`sharing.ts`: owner-or-editor on the project, for both
  // scopes) -- so this is never a control that answers 403, and never one withheld from someone
  // who could have used it. A reviewer gets no menu at all, as before.
  const canShare = project.role === 'owner' || project.role === 'editor';
  return (
    <div className="project-row">
      <Link
        className="project-row-link"
        params={{ projectId: project.id }}
        to="/projects/$projectId"
      >
        <strong>{project.title}</strong>
        <span className="project-row-role">{roleLabel(project.role)}</span>
      </Link>
      {canShare && (
        <OverflowMenu
          items={[
            { label: 'Share…', onSelect: () => setSharingOpen(true) },
            // Still owner-only -- `deleteProject` is owner-only server-side, so showing it to an
            // editor would be the broken control this file's own comment already warns about.
            ...(project.role === 'owner'
              ? [{ label: 'Delete', onSelect: () => deleteMutation.mutate() }]
              : []),
          ]}
          label={`Project actions for ${project.title}`}
        />
      )}
      {sharingOpen && (
        <Suspense fallback={null}>
          <SharingDialog
            onClose={() => setSharingOpen(false)}
            scope={{ kind: 'project', projectId: project.id }}
            title={project.title}
          />
        </Suspense>
      )}
      {deleteMutation.isError && (
        <p className="field-error" role="alert">
          Delete failed. Try again.
        </p>
      )}
    </div>
  );
}

/**
 * One pending invitation, with Accept and Decline right-aligned as a pair.
 *
 * This is the authoritative accept mechanism for the whole slice (the notification email carries
 * no token and no accept link -- see `invitationMail.ts`): it needs nothing to expire or leak, the
 * inviter can withdraw it at any time, and it does not depend on mail having been delivered.
 *
 * `.readonly-banner`/`.readonly-banner-actions` are reused rather than a new pair of classes
 * invented: that is already the established shape for "a persistent strip of explanation with a
 * right-aligned action group", and `.readonly-banner-actions` exists for exactly a two-action row
 * (App.tsx's historical-revision banner) and is already covered by its own tests.
 */
function InvitationRow({ invitation }: { invitation: IncomingInvitation }) {
  const queryClient = useQueryClient();
  const respond = useMutation({
    mutationFn: (response: 'accept' | 'decline') =>
      api.respondToInvitation(invitation.id, response),
    onSuccess: async () => {
      // Three caches can change on an accept: the invitation list it leaves, and whichever of the
      // project list or the shared-screenplay list it joins. Invalidating all three on either
      // response is simpler than branching on the outcome, and a decline makes the two listing
      // refetches cheap no-ops.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['invitations'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['shared-screenplays'] }),
      ]);
    },
  });
  const what =
    invitation.screenplayTitle === null
      ? `the project “${invitation.projectTitle}”`
      : `the screenplay “${invitation.screenplayTitle}” in “${invitation.projectTitle}”`;
  const who = invitation.invitedByName ?? 'Someone';
  return (
    <div className="readonly-banner" role="status">
      <p>
        <strong>{who}</strong> invited you to {what} as{' '}
        {invitation.role === 'editor' ? 'an editor' : 'a reviewer'}.
      </p>
      <div className="readonly-banner-actions">
        <button
          className="primary-button"
          disabled={respond.isPending}
          onClick={() => respond.mutate('accept')}
          type="button"
        >
          Accept
        </button>
        <button
          disabled={respond.isPending}
          onClick={() => respond.mutate('decline')}
          type="button"
        >
          Decline
        </button>
      </div>
      {respond.isError && (
        <p className="field-error" role="alert">
          That could not be completed. Try again.
        </p>
      )}
    </div>
  );
}

/**
 * A screenplay reached through screenplay-scoped membership. Deliberately rendered as a screenplay
 * linking straight into the editor, never as a project row: the invitee is not a member of the
 * project, so a project row would lead to a page whose every control -- rename, New screenplay,
 * the project's own three-dot menu -- they cannot use. See `ProjectStore.listSharedScreenplays`.
 */
/**
 * How a row tells the viewer whose it is. `owner` is stated plainly; every other role is prefixed
 * with "shared with you" rather than shown as a bare role word, because "editor" on its own reads
 * as a capability rather than as someone else's document. The role is kept alongside it rather than
 * replaced by it -- whether this is editable is the next thing a writer wants to know.
 */
function roleLabel(role: 'owner' | 'editor' | 'reviewer'): string {
  return role === 'owner' ? 'owner' : `shared with you \u00b7 ${role}`;
}

function SharedScreenplayRow({ screenplay }: { screenplay: SharedScreenplay }) {
  return (
    <div className="project-row">
      <Link
        className="project-row-link"
        params={{ projectId: screenplay.projectId, screenplayId: screenplay.id }}
        to="/projects/$projectId/screenplays/$screenplayId"
      >
        <strong>{screenplay.title}</strong>
        <span className="project-row-role">
          {roleLabel(screenplay.role)} · in {screenplay.projectTitle}
        </span>
      </Link>
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
  // The screenplay-invitations slice's two dashboard additions. Both are unconditional fetches on
  // the one page every flow in the system suite touches, which this file's own `entitlement`
  // comment records as a real cost -- so both carry the same `staleTime` that comment settled on,
  // for the same reason: an invitation arriving, or a screenplay being shared, is not something a
  // writer needs reflected within a second of it happening, and both are cheap single-index reads
  // rather than `getSnapshot`'s three parallel queries. Neither is deferred behind an interaction,
  // because an invitation nobody is looking for has to be visible without one.
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: api.invitations,
    staleTime: 60_000,
  });
  const sharedScreenplays = useQuery({
    queryKey: ['shared-screenplays'],
    queryFn: api.sharedScreenplays,
    staleTime: 60_000,
  });
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
        {/* Above the lapse-chooser banner and above the project list: an invitation is the one
            thing on this page that someone else is waiting on, and (plan.md) "the invitation itself
            is the moment the upgrade is most legible" -- it has to be the first thing seen, not
            something found below a list. An errored fetch renders nothing, matching the banner
            below: there is nothing unsafe about staying silent until the next successful fetch. */}
        {(invitations.data ?? []).length > 0 && (
          <section className="invitation-list" aria-label="Invitations">
            {(invitations.data ?? []).map((invitation) => (
              <InvitationRow invitation={invitation} key={invitation.id} />
            ))}
          </section>
        )}
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
            {/* Screenplay-scoped shares sit in this same list rather than under a heading of their
                own. A separate section made "what do I have access to" two questions instead of one,
                and the row's own role label already answers which of these is someone else's -- see
                `roleLabel`. They are screenplay rows among project rows, which is the shape the
                thing actually shared has: screenplay-scoped access grants one screenplay inside
                someone else's project, not the project, so surfacing the parent would name a
                container the viewer cannot otherwise open. */}
            {(sharedScreenplays.data ?? []).map((screenplay) => (
              <li key={screenplay.id}>
                <SharedScreenplayRow screenplay={screenplay} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
