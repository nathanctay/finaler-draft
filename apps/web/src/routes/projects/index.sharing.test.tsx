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
} from '../../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./index.js');
const ProjectsPage = Route.options.component!;

/**
 * The dashboard's two screenplay-invitations additions: the pending-invitation rows an invitee
 * accepts or declines from (the authoritative accept mechanism for the whole slice), and the
 * "Shared with you" section a screenplay-scoped member's work appears in.
 *
 * Kept in its own file rather than grown onto `index.test.tsx`, matching this directory's own
 * `index.delete.test.tsx` convention: these are a distinct feature of the same page with their own
 * fixtures, and folding them in would make both files harder to read.
 */
const invitation = {
  id: '6f2b9d7c-1d4e-4a5b-9c8d-3e7f1a2b4c5d',
  role: 'editor' as const,
  createdAt: '2026-08-06T00:00:00.000Z',
  projectId,
  projectTitle: 'Night Shoot',
  screenplayId: null,
  screenplayTitle: null,
  invitedByName: 'The Inviter',
};

const ownedProject = {
  id: projectId,
  title: 'Night Shoot',
  updatedAt: '2026-08-06T00:00:00.000Z',
  role: 'owner' as const,
};
const sharedScreenplay = {
  id: screenplayId,
  title: 'Act One',
  updatedAt: '2026-08-06T00:00:00.000Z',
  projectId,
  projectTitle: 'Night Shoot',
  role: 'editor' as const,
};

function setQueries(overrides: { projects?: unknown; invitations?: unknown; shared?: unknown }) {
  routeState.queries[JSON.stringify(['projects'])] = {
    data: overrides.projects ?? [],
    isError: false,
    isLoading: false,
  };
  routeState.queries[JSON.stringify(['invitations'])] = {
    data: overrides.invitations ?? [],
    isError: false,
    isLoading: false,
  };
  routeState.queries[JSON.stringify(['shared-screenplays'])] = {
    data: overrides.shared ?? [],
    isError: false,
    isLoading: false,
  };
}

beforeEach(resetRouteHarness);

describe('pending invitations on the dashboard', () => {
  it('renders nothing at all when there are none', () => {
    setQueries({});
    render(<ProjectsPage />);
    expect(screen.queryByRole('region', { name: 'Invitations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('names who invited you, to what, and as what -- for a project-scoped invitation', () => {
    setQueries({ invitations: [invitation] });
    render(<ProjectsPage />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('The Inviter');
    expect(banner).toHaveTextContent('the project “Night Shoot”');
    expect(banner).toHaveTextContent('as an editor');
  });

  it('names the screenplay, not just the project, for a screenplay-scoped invitation', () => {
    // plan.md: "Someone invited into a screenplay should see what they were invited to." Naming
    // only the project would be exactly the thing that sentence rules out.
    setQueries({
      invitations: [
        { ...invitation, screenplayId, screenplayTitle: 'Act One', role: 'reviewer' as const },
      ],
    });
    render(<ProjectsPage />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('the screenplay “Act One” in “Night Shoot”');
    expect(banner).toHaveTextContent('as a reviewer');
  });

  it('still reads sensibly when the inviter’s account has since been deleted', () => {
    // `invited_by_user_id` is `on delete set null`, so this is a real state rather than a defensive
    // one -- and a row rendering "null invited you" would be the visible result of not handling it.
    setQueries({ invitations: [{ ...invitation, invitedByName: null }] });
    render(<ProjectsPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Someone invited you to');
  });

  it('offers Accept and Decline as a right-aligned pair, the way the historical-revision banner does', () => {
    setQueries({ invitations: [invitation] });
    render(<ProjectsPage />);
    const accept = screen.getByRole('button', { name: 'Accept' });
    const decline = screen.getByRole('button', { name: 'Decline' });
    // `.readonly-banner-actions` is the existing class for exactly a two-action row, reused rather
    // than a new one invented -- see the component's own comment.
    const actions = accept.closest('.readonly-banner-actions');
    expect(actions).not.toBeNull();
    expect(actions).toContainElement(decline);
  });

  it('accepts through the invitation’s own endpoint and refreshes all three affected lists', async () => {
    const user = userEvent.setup();
    setQueries({ invitations: [invitation] });
    fetchMock.mockImplementation(async () =>
      fakeJsonResponse({ outcome: 'accepted', projectId, screenplayId: null, role: 'editor' }),
    );
    render(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/invitations/${invitation.id}/respond`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ response: 'accept' }),
        }),
      ),
    );
    // The invitation list it leaves, and both lists it could join.
    await vi.waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['invitations'] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] });
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['shared-screenplays'] });
    });
  });

  it('declines through the same endpoint, with the other response', async () => {
    const user = userEvent.setup();
    setQueries({ invitations: [invitation] });
    fetchMock.mockImplementation(async () => fakeJsonResponse({ outcome: 'declined' }));
    render(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/invitations/${invitation.id}/respond`,
        expect.objectContaining({ body: JSON.stringify({ response: 'decline' }) }),
      ),
    );
  });

  it('reports a failed response instead of silently appearing to have worked', () => {
    // Scoped to the invitation row: `routeState.mutationError` makes *every* mutation on this page
    // report a failure, including sign-out and project creation, so a bare `getByRole('alert')`
    // would be ambiguous about which control actually reported.
    routeState.mutationError = true;
    setQueries({ invitations: [invitation] });
    render(<ProjectsPage />);
    const row = screen.getByRole('status');
    expect(
      Array.from(row.querySelectorAll('[role="alert"]')).map((node) => node.textContent),
    ).toEqual(['That could not be completed. Try again.']);
  });

  it('renders every outstanding invitation, not only the first', () => {
    setQueries({
      invitations: [
        invitation,
        { ...invitation, id: '7a3c0e8d-2e5f-4b6c-9d0e-4f8a2b3c5d6e', projectTitle: 'Day Shoot' },
      ],
    });
    render(<ProjectsPage />);
    expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(2);
  });

  it('fetches the invitation list from the endpoint the page actually reads', async () => {
    setQueries({});
    render(<ProjectsPage />);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/invitations', expect.anything()),
    );
  });
});

describe('screenplay-scoped shares in the one project list', () => {
  it('contributes no row at all when nothing has been shared screenplay-by-screenplay', () => {
    setQueries({});
    render(<ProjectsPage />);
    // Asserted on the row rather than on a heading: there is no longer a heading to be absent, so
    // checking for one would pass whatever the list did.
    expect(screen.queryByRole('link', { name: /Act One/ })).not.toBeInTheDocument();
  });

  it('links straight into the editor, never to the project page the invitee cannot use', async () => {
    // The whole reason these arrive as screenplays rather than as project rows: a project row
    // would lead somewhere whose every control -- rename, New screenplay, the project's own menu --
    // answers 403 for a screenplay-scoped member.
    setQueries({ shared: [sharedScreenplay] });
    render(<ProjectsPage />);
    const link = screen.getByRole('link', { name: /Act One/ });
    expect(link).toHaveAttribute('href', '/projects/$projectId/screenplays/$screenplayId');
    expect(screen.queryByRole('link', { name: 'Night Shoot' })).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/shared-screenplays', expect.anything()),
    );
  });

  it('says which project the screenplay lives in, and the viewer’s role on it', () => {
    setQueries({ shared: [sharedScreenplay] });
    render(<ProjectsPage />);
    // "shared with you" rather than a bare "editor": the role alone read as a capability, not as
    // somebody else's screenplay, once these rows stopped sitting under a heading that said so.
    expect(screen.getByText('shared with you · editor · in Night Shoot')).toBeInTheDocument();
  });

  it('sits in the same list as the viewer own projects, not a second one', () => {
    setQueries({ projects: [ownedProject], shared: [sharedScreenplay] });
    render(<ProjectsPage />);
    // One list, both kinds of row in it -- the property the removed "SHARED WITH YOU" heading used
    // to make trivially true and which nothing else was checking.
    const lists = screen.getAllByRole('list');
    const rowNames = lists.flatMap((list) =>
      Array.from(list.querySelectorAll('a')).map((anchorEl) => anchorEl.textContent ?? ''),
    );
    expect(rowNames.some((name) => name.includes('Night Shoot'))).toBe(true);
    expect(rowNames.some((name) => name.includes('Act One'))).toBe(true);
    expect(lists).toHaveLength(1);
  });

  it('offers no three-dot menu on a shared screenplay row', () => {
    // Sharing, deleting and renaming are all things this viewer may or may not be able to do
    // depending on their role, and none of them is what a shared-with-you row is for -- they belong
    // on the project page and in the editor, where the role is known.
    setQueries({ shared: [sharedScreenplay] });
    render(<ProjectsPage />);
    expect(
      screen.queryByRole('button', { name: /Screenplay actions for Act One/ }),
    ).not.toBeInTheDocument();
  });
});

describe('the project row’s Share entry point', () => {
  it('is offered to an owner, alongside Delete', async () => {
    const user = userEvent.setup();
    setQueries({ projects: [ownedProject] });
    render(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Project actions for Night Shoot' }));
    expect(screen.getByRole('menuitem', { name: 'Share…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('is offered to an editor, who gets no Delete -- that is still owner-only', async () => {
    // Matching the server exactly on both counts: sharing is owner-or-editor, deleting a project is
    // owner-only. Showing Delete to an editor would be a control that always answers 403.
    const user = userEvent.setup();
    setQueries({ projects: [{ ...ownedProject, role: 'editor' }] });
    render(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Project actions for Night Shoot' }));
    expect(screen.getByRole('menuitem', { name: 'Share…' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('is not offered to a reviewer, who gets no menu at all', () => {
    setQueries({ projects: [{ ...ownedProject, role: 'reviewer' }] });
    render(<ProjectsPage />);
    expect(
      screen.queryByRole('button', { name: 'Project actions for Night Shoot' }),
    ).not.toBeInTheDocument();
  });

  it('opens the sharing dialog for this project’s own scope', async () => {
    const user = userEvent.setup();
    setQueries({ projects: [ownedProject] });
    routeState.queries[JSON.stringify(['sharing', 'project', projectId])] = {
      data: { members: [], invitations: [] },
      isError: false,
      isLoading: false,
    };
    render(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Project actions for Night Shoot' }));
    await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Share “Night Shoot”');
    expect(dialog).toHaveTextContent(/every screenplay in this project/i);
  });
});
