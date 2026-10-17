import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeJsonResponse,
  fetchMock,
  invalidateQueries,
  projectId,
  resetRouteHarness,
  routeState,
  screenplayId,
} from './test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('./test/routeHarness.js')).reactQueryMock(),
);

const { SharingDialog } = await import('./sharingDialog.js');

/**
 * The screenplay-invitations slice's inviter-side dialog. One component serves both scopes and all
 * three entry points, so these tests cover the scope-dependent wording and URLs explicitly rather
 * than testing one scope and assuming the other.
 */
const sharingView = {
  members: [
    {
      userId: 'owner-1',
      name: 'The Owner',
      email: 'owner@example.test',
      role: 'owner' as const,
      scope: 'project' as const,
    },
    {
      userId: 'editor-1',
      name: 'An Editor',
      email: 'editor@example.test',
      role: 'editor' as const,
      scope: 'project' as const,
    },
  ],
  invitations: [
    {
      id: '6f2b9d7c-1d4e-4a5b-9c8d-3e7f1a2b4c5d',
      name: 'Pending Person',
      email: 'pending@example.test',
      role: 'reviewer' as const,
      createdAt: '2026-08-06T00:00:00.000Z',
    },
  ],
};

function setSharingData(data: unknown, scope: 'project' | 'screenplay' = 'project') {
  const id = scope === 'project' ? projectId : screenplayId;
  routeState.queries[JSON.stringify(['sharing', scope, id])] = {
    data,
    isError: false,
    isLoading: false,
  };
}

/** Answers every sharing endpoint with `body`, and records what was requested. */
function respondWith(body: unknown, init?: { ok?: boolean; status?: number }) {
  fetchMock.mockImplementation(async () => fakeJsonResponse(body, init));
}

beforeEach(resetRouteHarness);

describe('the sharing dialog', () => {
  it('is a modal dialog with a focus trap and Escape to close, like every other dialog here', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    setSharingData(sharingView);
    render(
      <SharingDialog
        onClose={onClose}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Share “Night Shoot”');
    // Focus starts in the invite field, so a keyboard-only writer can begin typing an address
    // without hunting for it.
    expect(screen.getByLabelText('Invite by email address')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('wraps focus at both ends of the dialog rather than letting Tab escape it', async () => {
    const user = userEvent.setup();
    setSharingData({ members: [], invitations: [] });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    const focusable = screen.getAllByRole('button').concat(screen.getAllByRole('combobox'));
    expect(focusable.length).toBeGreaterThan(1);
    // Shift+Tab from the first element lands on the last, not outside the dialog.
    screen.getByLabelText('Invite by email address').focus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Invite by email address')).toHaveFocus();
  });

  it('says what the scope actually means, differently for a project and a screenplay', () => {
    setSharingData(sharingView);
    const { unmount } = render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    expect(screen.getByText(/every screenplay in this project/i)).toBeInTheDocument();
    unmount();

    setSharingData(sharingView, 'screenplay');
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'screenplay', screenplayId }}
        title="Act One"
      />,
    );
    // The single most important sentence in this dialog: it is what tells an owner that a
    // screenplay-scoped invitation does not reach the project's other screenplays.
    expect(
      screen.getByText(/this screenplay only — not the other screenplays in its project/i),
    ).toBeInTheDocument();
  });

  it('reads the sharing view from the scope’s own endpoint', async () => {
    setSharingData(sharingView, 'screenplay');
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'screenplay', screenplayId }}
        title="Act One"
      />,
    );
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/screenplays/${screenplayId}/sharing`,
        expect.anything(),
      ),
    );
  });

  it('lists members and pending invitations, and offers role and removal only where they apply', () => {
    setSharingData(sharingView);
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    expect(screen.getByText('The Owner')).toBeInTheDocument();
    expect(screen.getByText('owner@example.test')).toBeInTheDocument();
    // The owner is never manageable: no role select and no remove button, and a plain label
    // instead of a disabled control that would read as "temporarily unavailable".
    expect(screen.queryByLabelText('Role for owner@example.test')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove owner@example.test' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    // An editor is.
    expect(screen.getByLabelText('Role for editor@example.test')).toHaveValue('editor');
    expect(screen.getByRole('button', { name: 'Remove editor@example.test' })).toBeInTheDocument();
    // And the pending invitation is listed separately, with its own withdrawal.
    expect(screen.getByText('Pending Person')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Withdraw the invitation for pending@example.test' }),
    ).toBeInTheDocument();
  });

  it('shows inherited project access at screenplay scope, but never offers to change it from there', () => {
    // Changing project-wide membership from inside one screenplay's dialog would reach far outside
    // the thing the writer opened it from, so the row is informative only -- and it says *why* it
    // is not editable rather than appearing broken.
    setSharingData(
      {
        members: [
          {
            userId: 'editor-1',
            name: 'An Editor',
            email: 'editor@example.test',
            role: 'editor',
            scope: 'project',
          },
          {
            userId: 'guest-1',
            name: 'A Guest',
            email: 'guest@example.test',
            role: 'reviewer',
            scope: 'screenplay',
          },
        ],
        invitations: [],
      },
      'screenplay',
    );
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'screenplay', screenplayId }}
        title="Act One"
      />,
    );
    expect(screen.getByText('Editor — via the project')).toBeInTheDocument();
    expect(screen.queryByLabelText('Role for editor@example.test')).not.toBeInTheDocument();
    // The screenplay-scoped guest *is* managed from here.
    expect(screen.getByLabelText('Role for guest@example.test')).toHaveValue('reviewer');
  });

  it('invites through the scope’s own endpoint, with the typed address and chosen role', async () => {
    const user = userEvent.setup();
    setSharingData({ members: [], invitations: [] }, 'screenplay');
    respondWith({
      outcome: 'invited',
      created: true,
      invitation: sharingView.invitations[0],
    });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'screenplay', screenplayId }}
        title="Act One"
      />,
    );
    await user.type(screen.getByLabelText('Invite by email address'), 'invitee@example.test');
    await user.selectOptions(screen.getByLabelText('Invited role'), 'reviewer');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/screenplays/${screenplayId}/invitations`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'invitee@example.test', role: 'reviewer' }),
        }),
      ),
    );
    await screen.findByText(/Invitation sent to pending@example.test/);
    await vi.waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
  });

  it('shows the server’s own sentence when the address has no account, and does not clear the field', async () => {
    // The owner chose to answer this honestly rather than conceal it. The message is the server's
    // own (`NO_ACCOUNT_MESSAGE`), shown verbatim so he can reword it in one place -- and the typed
    // address stays put, because a typo is the likeliest cause and retyping it would be the one
    // thing this message exists to spare.
    const user = userEvent.setup();
    setSharingData({ members: [], invitations: [] });
    respondWith({
      outcome: 'no-account',
      message: 'No account found for that email address. They need a Finaler Draft account.',
    });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    await user.type(screen.getByLabelText('Invite by email address'), 'nobody@example.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('No account found for that email address');
    expect(screen.getByLabelText('Invite by email address')).toHaveValue('nobody@example.test');
    // Not an error: nothing failed, an authorized inviter asked a legitimate question.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains the other two non-invitation outcomes in their own words', async () => {
    const user = userEvent.setup();
    setSharingData({ members: [], invitations: [] });
    respondWith({ outcome: 'self' });
    const { unmount } = render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    await user.type(screen.getByLabelText('Invite by email address'), 'me@example.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByRole('status')).toHaveTextContent('That is your own account');
    unmount();

    respondWith({ outcome: 'already-member', role: 'editor', scope: 'project' });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'screenplay', screenplayId }}
        title="Act One"
      />,
    );
    await user.type(screen.getByLabelText('Invite by email address'), 'editor@example.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    // Says where the access comes from, so the inviter understands why a screenplay-scoped
    // invitation would have changed nothing.
    expect(await screen.findByRole('status')).toHaveTextContent(
      'They already have editor access to the whole project.',
    );
  });

  it('reports a reused invitation as updated rather than claiming a fresh one was sent', async () => {
    const user = userEvent.setup();
    setSharingData({ members: [], invitations: [] });
    respondWith({
      outcome: 'invited',
      created: false,
      invitation: { ...sharingView.invitations[0], role: 'editor' },
    });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    await user.type(screen.getByLabelText('Invite by email address'), 'pending@example.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'already had an invitation here — it has been updated to editor',
    );
  });

  it('shows the server’s own refusal message when an invite is rejected outright', async () => {
    const user = userEvent.setup();
    setSharingData({ members: [], invitations: [] });
    fetchMock.mockImplementation(async () =>
      fakeJsonResponse(
        { error: 'Project editor access required to share' },
        {
          ok: false,
          status: 403,
        },
      ),
    );
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    await user.type(screen.getByLabelText('Invite by email address'), 'invitee@example.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project editor access required to share',
    );
  });

  it('changes a role through the scope’s member endpoint and refreshes the list', async () => {
    const user = userEvent.setup();
    setSharingData(sharingView);
    respondWith({ outcome: 'changed', role: 'reviewer' });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    await user.selectOptions(screen.getByLabelText('Role for editor@example.test'), 'reviewer');
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${projectId}/members/editor-1`,
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ role: 'reviewer' }) }),
      ),
    );
    await vi.waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
  });

  it('removes a member through the scope’s member endpoint', async () => {
    const user = userEvent.setup();
    // A *screenplay-scoped* member, since at this scope a project-scoped row is inherited access
    // the dialog deliberately does not offer to remove (see the inherited-access test above).
    setSharingData(
      {
        members: [
          {
            userId: 'editor-1',
            name: 'An Editor',
            email: 'editor@example.test',
            role: 'editor',
            scope: 'screenplay',
          },
        ],
        invitations: sharingView.invitations,
      },
      'screenplay',
    );
    respondWith({ outcome: 'removed' });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'screenplay', screenplayId }}
        title="Act One"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove editor@example.test' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/screenplays/${screenplayId}/members/editor-1`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });

  it('explains the two outcomes a member change can report without failing', async () => {
    const user = userEvent.setup();
    setSharingData(sharingView);
    respondWith({ outcome: 'owner-immutable' });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove editor@example.test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The project owner cannot be removed.',
    );
  });

  it('withdraws a pending invitation through the invitation’s own endpoint, not the scope’s', async () => {
    // Revocation is authorized from the invitation row itself, so there is one route rather than
    // one per scope -- this is the client half of that decision.
    const user = userEvent.setup();
    setSharingData(sharingView, 'screenplay');
    respondWith({ outcome: 'revoked' });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'screenplay', screenplayId }}
        title="Act One"
      />,
    );
    await user.click(
      screen.getByRole('button', { name: 'Withdraw the invitation for pending@example.test' }),
    );
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/invitations/${sharingView.invitations[0]!.id}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });

  it('hides the invitation section entirely when nothing is outstanding', () => {
    setSharingData({ members: sharingView.members, invitations: [] });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    expect(screen.queryByText('Invited, not yet accepted')).not.toBeInTheDocument();
    expect(screen.getByText('Has access')).toBeInTheDocument();
  });

  it('refuses to submit an empty address, and reports a failed load without pretending the list is empty', async () => {
    const user = userEvent.setup();
    setSharingData({ members: [], invitations: [] });
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
    await user.type(screen.getByLabelText('Invite by email address'), '   ');
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
  });

  it('reports a failed sharing fetch rather than rendering an empty member list', () => {
    routeState.queries[JSON.stringify(['sharing', 'project', projectId])] = {
      data: undefined,
      isError: true,
      isLoading: false,
    };
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Who has access could not be loaded.');
  });

  it('reports the loading state rather than an empty list', () => {
    routeState.queries[JSON.stringify(['sharing', 'project', projectId])] = {
      data: undefined,
      isError: false,
      isLoading: true,
    };
    render(
      <SharingDialog
        onClose={vi.fn()}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    expect(screen.getByText('Loading who has access…')).toBeInTheDocument();
  });

  it('closes on Done', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    setSharingData(sharingView);
    render(
      <SharingDialog
        onClose={onClose}
        scope={{ kind: 'project', projectId }}
        title="Night Shoot"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
