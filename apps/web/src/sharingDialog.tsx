import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  MessageApiError,
  type EffectiveRole,
  type SharedRole,
  type SharingMember,
  type SharingScope,
} from './api.js';

/**
 * The screenplay-invitations slice's inviter-side interface: who has access, who has been invited
 * and not answered, and the form that invites someone else.
 *
 * One component for both scopes. It is opened from three places -- the three-dot menu on a project
 * row, the three-dot menu on a screenplay row, and the editor's File menu -- and the only thing
 * that differs between them is the `scope` prop, exactly as on the server (`sharing.ts` takes a
 * `SharingScope` rather than offering two sets of operations). `title` is the human name of the
 * thing being shared, supplied by the caller because this component never fetches it.
 *
 * Follows `NamedRevisionDialog`'s own hand-built modal shell (`role="dialog"`, `aria-modal`,
 * Tab/Shift+Tab focus trap, Escape to close) rather than introducing a third dialog pattern, and
 * like that dialog it has real pending/error state per action: every row here performs a network
 * request that can legitimately fail, and the writer needs to see which one did.
 */
export function SharingDialog({
  onClose,
  scope,
  title,
}: {
  onClose: () => void;
  scope: SharingScope;
  title: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<SharedRole>('editor');
  // The last invite attempt's own answer, which is not an error state: "no account for that
  // address", "that is you", and "they already have this" are all successful evaluations of a
  // legitimate request, and each needs its own sentence rather than a shared failure banner.
  const [notice, setNotice] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  // Keyed on the scope so a dialog opened for a project and one opened for a screenplay never share
  // a cache entry. Stringified rather than spread into the key array because the shape differs
  // between the two scopes.
  const sharingKey = ['sharing', scope.kind, scopeId(scope)] as const;
  const sharing = useQuery({ queryKey: sharingKey, queryFn: () => api.sharing(scope) });

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, []);

  function focusableElements(): HTMLElement[] {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, input, select, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusableElements();
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
  }

  function refresh() {
    return queryClient.invalidateQueries({ queryKey: sharingKey });
  }

  /** Every write here reports a refusal through `MessageApiError.serverMessage` -- the server's own
   * sentence -- rather than a paraphrase, the same convention the free-tier limit prompt and the
   * restore dialog already use. */
  function describeFailure(error: unknown): string {
    if (error instanceof MessageApiError) return error.serverMessage;
    return 'That could not be completed. Try again.';
  }

  const invite = useMutation({
    mutationFn: () => api.invite(scope, email.trim(), role),
    onSuccess: async (result) => {
      setActionError(undefined);
      if (result.outcome === 'no-account') {
        // The server's own wording, shown verbatim. The owner chose to answer this honestly rather
        // than conceal whether an address has an account -- see `NO_ACCOUNT_MESSAGE` in
        // apps/api/src/sharing.ts for why that is sound for this endpoint specifically.
        setNotice(result.message);
        return;
      }
      if (result.outcome === 'self') {
        setNotice('That is your own account — you already have access.');
        return;
      }
      if (result.outcome === 'already-member') {
        setNotice(
          result.scope === 'project'
            ? `They already have ${result.role} access to the whole project.`
            : `They already have ${result.role} access to this screenplay.`,
        );
        return;
      }
      setNotice(
        result.created
          ? `Invitation sent to ${result.invitation.email}. They will see it on their projects page.`
          : `${result.invitation.email} already had an invitation here — it has been updated to ${result.invitation.role}.`,
      );
      setEmail('');
      await refresh();
    },
    onError: (error: unknown) => {
      setNotice(undefined);
      setActionError(describeFailure(error));
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, nextRole }: { userId: string; nextRole: SharedRole }) =>
      api.changeMemberRole(scope, userId, nextRole),
    onSuccess: async (result) => {
      setNotice(undefined);
      setActionError(
        result.outcome === 'owner-immutable'
          ? 'The project owner’s role cannot be changed.'
          : result.outcome === 'not-a-member'
            ? 'That person no longer has access here.'
            : undefined,
      );
      await refresh();
    },
    onError: (error: unknown) => setActionError(describeFailure(error)),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.removeMember(scope, userId),
    onSuccess: async (result) => {
      setNotice(undefined);
      setActionError(
        result.outcome === 'owner-immutable'
          ? 'The project owner cannot be removed.'
          : result.outcome === 'not-a-member'
            ? 'That person no longer has access here.'
            : undefined,
      );
      await refresh();
    },
    onError: (error: unknown) => setActionError(describeFailure(error)),
  });

  const revoke = useMutation({
    mutationFn: (invitationId: string) => api.revokeInvitation(invitationId),
    onSuccess: async () => {
      setNotice(undefined);
      setActionError(undefined);
      await refresh();
    },
    onError: (error: unknown) => setActionError(describeFailure(error)),
  });

  const busy =
    invite.isPending || changeRole.isPending || removeMember.isPending || revoke.isPending;

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog sharing-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Share “{title}”</h2>
        <p className="muted">
          {scope.kind === 'project'
            ? 'Everyone invited here can reach every screenplay in this project.'
            : 'Everyone invited here can reach this screenplay only — not the other screenplays in its project.'}
        </p>

        <form
          className="sharing-invite-row"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (email.trim().length === 0 || busy) return;
            invite.mutate();
          }}
        >
          <label className="dialog-field">
            <span>Email address</span>
            <input
              aria-label="Invite by email address"
              autoComplete="off"
              disabled={busy}
              maxLength={320}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </label>
          <label className="dialog-field">
            <span>Role</span>
            <select
              aria-label="Invited role"
              disabled={busy}
              onChange={(event) => setRole(event.target.value as SharedRole)}
              value={role}
            >
              <option value="editor">Editor — can make changes</option>
              <option value="reviewer">Reviewer — can read and export</option>
            </select>
          </label>
          <button
            className="primary-button"
            disabled={email.trim().length === 0 || busy}
            type="submit"
          >
            {invite.isPending ? 'Inviting…' : 'Invite'}
          </button>
        </form>
        {notice !== undefined && (
          <p className="sharing-notice" role="status">
            {notice}
          </p>
        )}
        {actionError !== undefined && (
          <p className="field-error" role="alert">
            {actionError}
          </p>
        )}

        {sharing.isLoading ? (
          <p>Loading who has access…</p>
        ) : sharing.isError ? (
          <p role="alert">Who has access could not be loaded.</p>
        ) : (
          <>
            <h3>Has access</h3>
            <ul className="sharing-list">
              {(sharing.data?.members ?? []).map((member) => (
                <li key={`${member.scope}-${member.userId}`}>
                  <MemberRow
                    busy={busy}
                    member={member}
                    // An inherited project-scoped grant is shown but not editable from a
                    // screenplay's dialog: changing project-wide membership belongs to the
                    // project's own sharing view, and offering it here would be a control whose
                    // effect reaches far outside the screenplay the writer opened it from. The
                    // owner is never manageable at any scope.
                    manageable={
                      member.role !== 'owner' &&
                      !(scope.kind === 'screenplay' && member.scope === 'project')
                    }
                    onChangeRole={(nextRole) =>
                      changeRole.mutate({ nextRole, userId: member.userId })
                    }
                    onRemove={() => removeMember.mutate(member.userId)}
                  />
                </li>
              ))}
            </ul>

            {(sharing.data?.invitations ?? []).length > 0 && (
              <>
                <h3>Invited, not yet accepted</h3>
                <ul className="sharing-list">
                  {(sharing.data?.invitations ?? []).map((invitation) => (
                    <li key={invitation.id}>
                      <div className="sharing-row">
                        <span className="sharing-row-identity">
                          <strong>{invitation.name}</strong>
                          <span className="sharing-row-email">{invitation.email}</span>
                        </span>
                        <span className="sharing-row-role">{invitation.role}</span>
                        <button
                          aria-label={`Withdraw the invitation for ${invitation.email}`}
                          disabled={busy}
                          onClick={() => revoke.mutate(invitation.id)}
                          type="button"
                        >
                          Withdraw
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One row of the "has access" list. Split out rather than inlined so each row's role `<select>`
 * carries its own per-person accessible name -- a list of identically-labelled selects is exactly
 * the assistive-technology problem `OverflowMenu`'s own `label` comment describes for a list of
 * identically-labelled buttons.
 */
function MemberRow({
  busy,
  manageable,
  member,
  onChangeRole,
  onRemove,
}: {
  busy: boolean;
  manageable: boolean;
  member: SharingMember;
  onChangeRole: (role: SharedRole) => void;
  onRemove: () => void;
}) {
  return (
    <div className="sharing-row">
      <span className="sharing-row-identity">
        <strong>{member.name}</strong>
        <span className="sharing-row-email">{member.email}</span>
      </span>
      {manageable ? (
        <>
          <select
            aria-label={`Role for ${member.email}`}
            disabled={busy}
            onChange={(event) => onChangeRole(event.target.value as SharedRole)}
            value={member.role as SharedRole}
          >
            <option value="editor">Editor</option>
            <option value="reviewer">Reviewer</option>
          </select>
          <button
            aria-label={`Remove ${member.email}`}
            disabled={busy}
            onClick={onRemove}
            type="button"
          >
            Remove
          </button>
        </>
      ) : (
        // A plain, non-interactive description rather than a disabled `<select>`: there is nothing
        // for this viewer to choose here, and a disabled control reads as "temporarily
        // unavailable" when the truth is "this is not managed from this screen."
        <span className="sharing-row-role">{describeUnmanageable(member)}</span>
      )}
    </div>
  );
}

function describeUnmanageable(member: SharingMember): string {
  if (member.role === 'owner') return 'Owner';
  return `${capitalize(member.role)} — via the project`;
}

function capitalize(role: EffectiveRole): string {
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

function scopeId(scope: SharingScope): string {
  return scope.kind === 'project' ? scope.projectId : scope.screenplayId;
}
