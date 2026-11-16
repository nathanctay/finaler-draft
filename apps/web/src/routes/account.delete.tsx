import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { api, MessageApiError, type OwnedProjectWithCollaborators } from '../api.js';
import { AccountMenu } from '../accountMenu.js';
import { SharingDialog } from '../sharingDialog.js';
import { ApplicationTitlebar } from '../applicationShell.js';
import { formatDate } from '../billingPresentation.js';
import { guardSessionUser } from '../session.js';

/**
 * Account deletion (slice D), the owner's own words: "Prompt them which ones have other members
 * and allow them to transfer them, but also put a 'Delete anyway' button with another
 * confirmation dialog ... if they haven't transferred to new ownership." The backend
 * (`progress/account-deletion-backend.md`) is an **informed override, never a hard block** -- this
 * page is the one place that override is offered.
 *
 * **Where this lives, and why a route at all.** There is no account/settings page in this app
 * (`accountMenu.tsx`'s own module comment lists the three destinations that existed before this
 * slice). This follows `routes/billing.subscription.tsx`/`routes/deleted.tsx` exactly: a flat
 * route reached only from the account menu, wearing the same `ApplicationTitlebar` chrome, guarded
 * by the same `guardSessionUser` every other authenticated route uses -- not nested under
 * `/projects`, for the identical reason those two pages give (`routes/deleted.tsx`'s own comment:
 * "it shouldn't say Projects before the page in the header. That doesn't make sense" -- this page
 * is not inside a project either).
 *
 * **The two flows.**
 *
 * 1. **No owned project has another member.** The precheck (`GET
 *    /api/account/owned-projects-with-collaborators`, run unconditionally on mount) comes back
 *    empty. The page offers a single "Delete account" button, which opens `ConfirmDeleteDialog` --
 *    a plain confirmation naming what deletion actually does (immediate, subscription cancelled,
 *    purged after 30 days). Confirming calls `api.deleteAccount(false)`.
 *
 * 2. **At least one owned project has another member.** The precheck lists them, each with a
 *    "Manage sharing…" link (see "Transferring," below) so a writer can move a project away
 *    *before* deciding anything else -- the brief's "allow them to transfer them." The page's one
 *    button becomes "Delete anyway" and opens `DeleteAnywayDialog` directly: there is no reason to
 *    show the generic dialog first and then a second one that only repeats it with an added
 *    sentence, when the collaborator consequence is already known before the writer clicks
 *    anything. Confirming there calls `api.deleteAccount(true)`.
 *
 * **Why the UI does not trust its own precheck as the gate.** `accountDeletion.ts`'s own comment
 * is explicit that `deleteAccount` re-runs the identical collaborator query itself, under lock,
 * "rather than trusting a result the caller might be holding from an earlier call" -- a
 * collaborator can be added in the gap between this page's `GET` and the writer's click. So flow 1
 * above still has to handle `deleteAccount(false)` coming back `'owned-projects-have-collaborators'`
 * instead of `'deleted'`: `performDelete` treats that exactly like a fresh refusal -- it replaces
 * whatever the precheck showed with the response's own (authoritative, freshly-locked) list, closes
 * `ConfirmDeleteDialog`, and opens `DeleteAnywayDialog` on top of it. The override is never implicit:
 * reaching flow 2 by this path still requires the writer to see the named list and click "Delete
 * anyway" themselves, exactly as if the precheck had caught it to begin with.
 *
 * **The second confirmation's wording.** `DeleteAnywayDialog` names the thing the owner asked for
 * by name -- "other collaborators," "they will lose access entirely" -- never a generic "this
 * cannot be undone." The generic consequences (signed out, subscription cancelled, 30-day purge)
 * are still stated too, underneath, so this dialog is self-sufficient rather than assuming the
 * writer remembers the plain dialog's wording from a path they may never have seen.
 *
 * **The 502, surfaced as retryable.** `api.deleteAccount` uses `jsonWithServerMessage`, so a 502
 * (`accountDeletion.ts`'s Stripe-cancellation failure -- nothing written, safe to retry) arrives as
 * a `MessageApiError` carrying the server's own sentence, "Could not cancel the subscription. Try
 * again shortly." Both dialogs show it as a `.field-error` **inside the still-open dialog**, not as
 * a page-level error and not by closing anything -- closing on a retryable failure would make a
 * writer re-navigate and re-decide which button to press for no reason, when the honest answer is
 * "press the same button again."
 *
 * **What happens on success, and the trap it has to avoid.** Deletion deletes the account's
 * `session` rows server-side (`accountDeletion.ts`): the instant `api.deleteAccount` resolves
 * `'deleted'`, this browser's every subsequent authenticated request answers 401. The chosen
 * resolution is a **terminal confirmation state on this same page**
 * (`DeleteAccountPage`/`AccountDeletedPage` below), not a redirect: `onDeleted` swaps the whole
 * subtree for `AccountDeletedPage`, which renders no `ApplicationTitlebar`, no `AccountMenu`, and
 * runs no query of its own -- so `ConfirmDeleteDialog`/`DeleteAnywayDialog` and the precheck's
 * `useQuery` are all unmounted at the same moment, and nothing in this component tree holds an
 * active observer that could refetch `['accountOwnedProjectsWithCollaborators']` (or anything else)
 * on a later window-focus event (`main.tsx`'s `QueryClient` has no `refetchOnWindowFocus: false`
 * override, so that risk is real for any query left mounted, not hypothetical). Rendering the
 * message in place, rather than navigating to `/sign-in`, also means the writer is never bounced
 * through a guard that would itself have to notice the session is gone -- there is nothing left to
 * notice, because nothing further is ever asked of the server. The one link this terminal state
 * offers (`/sign-in`) is a plain, un-auto-followed `Link`, so leaving the page is the writer's own
 * choice, never something that could look like a redirect loop.
 *
 * **The 30-day date shown on that terminal screen is computed client-side**
 * (`Date.now()` plus 30 days), not echoed by the server: `'deleted'`'s own response carries no
 * timestamp, and slice C's actual purge cron does not exist yet (`accountDeletion.ts`'s own "slice
 * C ... this module does not build" note). The few seconds between this click and the server's own
 * `now()` are immaterial against a 30-day window, but this is a real, stated limitation: if that
 * window ever changes, this literal has to be updated by hand -- there is no shared constant
 * between this file and the backend's own prose "30 days" to keep the two in lockstep, because
 * slice C has not defined one yet.
 */
export const Route = createFileRoute('/account/delete')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  component: DeleteAccountPage,
});

/** The backend's documented, but not-yet-cron-enforced, grace window -- see the module comment's
 * last paragraph for why this is a local literal rather than a shared constant. */
const GRACE_PERIOD_DAYS = 30;

function DeleteAccountPage() {
  // Lifted above `DeleteAccountForm` specifically so that becoming `true` unmounts that whole
  // subtree -- the precheck query, both dialogs, everything -- rather than merely hiding it behind
  // a conditional inside the same component, which would leave its `useQuery` call still mounted
  // and still subscribed. See the module comment's "What happens on success" section.
  const [deleted, setDeleted] = useState(false);
  if (deleted) return <AccountDeletedPage />;
  return <DeleteAccountForm onDeleted={() => setDeleted(true)} />;
}

/**
 * The terminal state. Deliberately bare: no `ApplicationTitlebar`, no `AccountMenu` (whose own
 * "Sign out" and "Manage Subscription"/"Deleted items" destinations are all authenticated calls
 * this account can no longer make), and no query of any kind -- see the module comment for why
 * that absence is the point, not an oversight.
 */
function AccountDeletedPage() {
  const purgeDate = formatDate(
    new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  );
  return (
    <main className="project-screen">
      <section className="project-list">
        <p className="eyebrow">ACCOUNT</p>
        <h1>Your account has been deleted</h1>
        <p>
          You have been signed out of every session, and any subscription has been cancelled. Your
          data will be permanently removed on or after {purgeDate}.
        </p>
        <p>
          <Link to="/sign-in">Return to the sign-in page</Link>
        </p>
      </section>
    </main>
  );
}

function DeleteAccountForm({ onDeleted }: { onDeleted: () => void }) {
  // Unconditional, run on mount, independently of whether the writer has clicked anything yet --
  // see the module comment's "no owned project has another member" / "at least one" split. Never
  // the source of truth for what `deleteAccount` itself does; see `performDelete` below.
  const ownedProjects = useQuery({
    queryKey: ['accountOwnedProjectsWithCollaborators'],
    queryFn: api.ownedProjectsWithCollaborators,
  });
  // The project whose sharing dialog is open, or `undefined` for none. Holding the project rather
  // than just its id keeps the dialog's `title` prop honest without a second lookup.
  const [sharingProject, setSharingProject] = useState<OwnedProjectWithCollaborators | undefined>(
    undefined,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  // Set only by a refusal response, never by the precheck query -- see `performDelete`. Once set,
  // it wins over the precheck's own `data` for the rest of this page's life: it is the freshest,
  // under-lock answer the server has ever given this writer, and the precheck's own answer may
  // already be stale by the time a refusal comes back.
  const [refusedProjects, setRefusedProjects] = useState<
    OwnedProjectWithCollaborators[] | undefined
  >(undefined);

  async function performDelete(deleteOwnedProjectsWithCollaborators: boolean): Promise<void> {
    const result = await api.deleteAccount(deleteOwnedProjectsWithCollaborators);
    if (result.outcome === 'deleted') {
      onDeleted();
      return;
    }
    // Refused. `deleteOwnedProjectsWithCollaborators` was `false` here -- `accountDeletion.ts`'s
    // own gate never returns this outcome when the flag is `true` -- so this is always the first
    // attempt's refusal, never the override's. Replace the list, close whichever dialog just
    // submitted, and open the override: a fresh, explicit click is still required (see the module
    // comment's "The override is never implicit").
    setRefusedProjects(result.projects);
    setConfirmOpen(false);
    setOverrideOpen(true);
  }

  const projects = refusedProjects ?? ownedProjects.data?.projects ?? [];
  const hasCollaboratorProjects = projects.length > 0;
  // Only while nothing more authoritative (a real refusal) has ever arrived -- once
  // `refusedProjects` is set, the precheck query's own loading/error state is no longer relevant
  // to what this page shows.
  const precheckUnresolved = refusedProjects === undefined && ownedProjects.isLoading;
  const precheckFailed = refusedProjects === undefined && ownedProjects.isError;

  return (
    <main className="project-screen">
      <ApplicationTitlebar
        accountMenu={<AccountMenu />}
        // A plain link, matching `routes/deleted.tsx`/`routes/billing.subscription.tsx`: this page
        // is reached from the account menu on any screen, not by descending from the dashboard, so
        // it carries no breadcrumb either.
        brand={{ href: '/projects' }}
        documentTitle="Delete account"
      />
      <section className="project-list">
        <p className="eyebrow">ACCOUNT</p>
        <h1>Delete your account</h1>
        <p>
          Deleting your account stops it from working immediately: you are signed out everywhere,
          and any subscription is cancelled right away. Your data is kept for {GRACE_PERIOD_DAYS}{' '}
          days in case you change your mind, then permanently deleted.
        </p>
        {precheckUnresolved ? (
          <p>Checking your projects for other collaborators…</p>
        ) : (
          <>
            {precheckFailed && (
              <p className="muted">
                We could not check which of your projects have other collaborators on them. Deleting
                your account below still checks this and lets you transfer ownership first if any
                are found.
              </p>
            )}
            {hasCollaboratorProjects && (
              <>
                <div className="dialog-warning">
                  <p>
                    {projects.length === 1
                      ? 'One project you own has other collaborators on it.'
                      : `${projects.length} projects you own have other collaborators on them.`}{' '}
                    Transfer ownership of each one first, or delete your account anyway to remove{' '}
                    {projects.length === 1 ? 'it' : 'them'} for everyone.
                  </p>
                </div>
                <ul className="account-deletion-project-list">
                  {projects.map((project) => (
                    <li className="restore-row" key={project.id}>
                      <span className="restore-row-title">{project.title}</span>
                      {/* Opens the real `SharingDialog` over this page, rather than navigating away. Still
                          not a second transfer mechanism: this mounts the same component
                          `routes/projects/index.tsx` mounts, so "Make owner" remains the one shipped
                          control, gated the same way.
                      
                          The earlier version linked to `/projects`, arguing that no per-project deep link to
                          that dialog existed and inventing one would be new plumbing. That did not survive
                          contact with the component: `SharingDialog` takes plain props (`scope`, `title`,
                          `viewerIsOwner`), so mounting it here costs three props and no plumbing. The link
                          also made the page actively unhelpful -- a writer trying to keep a collaborator's
                          project was sent away from the deletion flow to find the right row themselves. The
                          owner: "I don't want to just be sent back to the home page."
                      
                          `viewerIsOwner` is true here by construction: this list is exactly the projects this
                          account *owns* that have other members. The server re-checks ownership on the
                          transfer itself regardless. */}
                      <button
                        className="primary-button"
                        onClick={() => {
                          setSharingProject(project);
                        }}
                        type="button"
                      >
                        Manage sharing…
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <button
              className="destructive-button"
              onClick={() => {
                if (hasCollaboratorProjects) setOverrideOpen(true);
                else setConfirmOpen(true);
              }}
              type="button"
            >
              {hasCollaboratorProjects ? 'Delete anyway' : 'Delete account'}
            </button>
          </>
        )}
      </section>
      {sharingProject !== undefined && (
        <SharingDialog
          onClose={() => {
            setSharingProject(undefined);
            /*
             * Refetch the precheck after the dialog closes. A transfer made in there means this
             * account no longer owns that project, so it must leave this list -- otherwise the
             * page would keep insisting a project needs attention after the writer has already
             * dealt with it, and the "Delete anyway" copy would name a project they no longer own.
             *
             * Unconditional rather than only on a detected transfer: the dialog also changes
             * collaborator roles and can remove the last collaborator, which equally changes
             * whether a project belongs in a list of "owned projects that have other members".
             * Refetching once on close is cheaper than trying to infer which of those happened.
             */
            void ownedProjects.refetch();
          }}
          scope={{ kind: 'project', projectId: sharingProject.id }}
          title={sharingProject.title}
          viewerIsOwner
        />
      )}
      {confirmOpen && (
        <ConfirmDeleteDialog
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => performDelete(false)}
        />
      )}
      {overrideOpen && (
        <DeleteAnywayDialog
          onClose={() => setOverrideOpen(false)}
          onConfirm={() => performDelete(true)}
          projects={projects}
        />
      )}
    </main>
  );
}

/**
 * Shared by both dialogs below, which is the one reason this is factored out at all: everywhere
 * else in this codebase (`renameDialog.tsx`, `documentSettingsDialog.tsx`,
 * `restoreRevisionDialog.tsx`) this exact Tab/Shift+Tab-trap-plus-Escape block is copied verbatim
 * into each dialog's own file, because each of those dialogs is the only one in its file. Both
 * dialogs here live in this one file, so copying it a second time within the same module would be
 * copying from four lines above rather than from a different file -- not worth it.
 */
function buildDialogKeyDownHandler(
  dialogRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}

/** Converts whatever `performDelete` rejected with into the sentence shown inside a dialog's own
 * `.field-error`. `MessageApiError.serverMessage` carries the 502's exact "Could not cancel the
 * subscription. Try again shortly." (see the module comment); anything else is a network failure
 * or a shape this page did not anticipate, and gets a generic, honestly-worded fallback that does
 * not claim the account is "half deleted" -- nothing was changed by this call either way. */
function deletionFailureMessage(error: unknown): string {
  return error instanceof MessageApiError
    ? error.serverMessage
    : 'Your account could not be deleted. Nothing was changed -- try again.';
}

/** The plain confirmation -- no owned project has another member. Follows
 * `restoreRevisionDialog.tsx`'s own shape exactly: a confirmation, not a form, with the confirming
 * button labelled with the action rather than "OK", and `onConfirm` a plain async callback whose
 * rejection this dialog (not its caller) turns into the shown message. */
function ConfirmDeleteDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const handleKeyDown = buildDialogKeyDownHandler(dialogRef, onClose);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  function handleConfirm() {
    if (state === 'pending') return;
    setState('pending');
    setError(undefined);
    // No `.then(onClose, ...)` on success: a `'deleted'` result means `performDelete` has already
    // called `onDeleted`, which unmounts this entire dialog from above (`DeleteAccountPage`); a
    // refusal means `performDelete` has already called `setConfirmOpen(false)`, which unmounts it
    // the same way. Either way there is nothing left for this component to do on success, and
    // nothing here would still be mounted to do it.
    onConfirm().catch((confirmError: unknown) => {
      setState('error');
      setError(deletionFailureMessage(confirmError));
    });
  }

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Delete your account?</h2>
        <p>
          This stops your account from working immediately: you are signed out everywhere, and any
          subscription is cancelled right away. Your data is kept for {GRACE_PERIOD_DAYS} days, then
          permanently deleted. This cannot be undone once that window passes.
        </p>
        {state === 'error' && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button disabled={state === 'pending'} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="destructive-button"
            disabled={state === 'pending'}
            onClick={handleConfirm}
            type="button"
          >
            {state === 'pending' ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The override's own confirmation -- reached only when at least one owned project has another
 * member, whether from the page's own precheck or from a refusal the plain dialog above just
 * received. Names the real consequence in the owner's own terms rather than a generic warning;
 * see the module comment's "The second confirmation's wording."
 */
function DeleteAnywayDialog({
  onClose,
  onConfirm,
  projects,
}: {
  onClose: () => void;
  onConfirm: () => Promise<void>;
  projects: readonly OwnedProjectWithCollaborators[];
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const handleKeyDown = buildDialogKeyDownHandler(dialogRef, onClose);
  const plural = projects.length !== 1;

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  function handleConfirm() {
    if (state === 'pending') return;
    setState('pending');
    setError(undefined);
    // Same reasoning as `ConfirmDeleteDialog.handleConfirm`: on success this dialog is already
    // unmounted by the time this promise resolves, so there is nothing to do here but handle the
    // rejection.
    onConfirm().catch((confirmError: unknown) => {
      setState('error');
      setError(deletionFailureMessage(confirmError));
    });
  }

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Delete anyway?</h2>
        <p>
          {/* The owner's own wording, almost verbatim: "Are you sure? this will delete these
              projects for all collaborators." Named as *collaborators* specifically, not "data" or
              "content" in the abstract -- the entire point of this second confirmation is that the
              cost lands on people other than the one clicking the button. */}
          Are you sure? {plural ? 'These projects have' : 'This project has'} other collaborators on{' '}
          {plural ? 'them' : 'it'}. Deleting your account now permanently deletes{' '}
          {plural ? 'them' : 'it'} for every collaborator too, not just you -- they will lose access
          entirely.
        </p>
        <ul className="account-deletion-project-list">
          {projects.map((project) => (
            <li key={project.id}>{project.title}</li>
          ))}
        </ul>
        <p>
          Your account also stops working immediately, any subscription is cancelled right away, and
          your own data is permanently deleted after {GRACE_PERIOD_DAYS} days.
        </p>
        {state === 'error' && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button disabled={state === 'pending'} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="destructive-button"
            disabled={state === 'pending'}
            onClick={handleConfirm}
            type="button"
          >
            {state === 'pending' ? 'Deleting…' : 'Delete anyway'}
          </button>
        </div>
      </div>
    </div>
  );
}
