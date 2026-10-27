import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectId,
  resetRouteHarness,
  routeState,
  screenplayId,
} from '../../../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../../../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./index.js');
const ProjectPage = Route.options.component!;

/**
 * The second of the slice's three entry points -- the owner's "the 3 dot menu on both the project
 * or just the screenplay if thats all they want to share."
 *
 * In its own file alongside `index.delete.test.tsx`, matching this directory's convention.
 */
function setScreenplays(role: 'owner' | 'editor' | 'reviewer') {
  routeState.query = {
    data: [{ id: screenplayId, title: 'Act One', updatedAt: '2026-08-06T00:00:00.000Z', role }],
    isError: false,
    isLoading: false,
  };
}

beforeEach(resetRouteHarness);

describe('the screenplay row’s Share entry point', () => {
  it('is offered to an owner and to an editor', async () => {
    const user = userEvent.setup();
    for (const role of ['owner', 'editor'] as const) {
      setScreenplays(role);
      const { unmount } = render(<ProjectPage />);
      await user.click(screen.getByRole('button', { name: 'Screenplay actions for Act One' }));
      expect(screen.getByRole('menuitem', { name: 'Share…' })).toBeInTheDocument();
      unmount();
    }
  });

  // A reviewer cannot share server-side (`sharing.ts` requires owner-or-editor on the project),
  // and -- as of the owner-only-rename slice (progress/owner-only-rename.md) -- can neither rename
  // nor delete either (`renameScreenplay`/`deleteScreenplay` are both owner-only now). A reviewer
  // therefore has nothing this menu could offer, so there is no menu at all, matching ProjectRow's
  // own rule in routes/projects/index.tsx. Before that slice, Delete was shown here unconditionally
  // -- this test used to assert the menu "stays" with Delete still in it, which was itself the
  // broken-control defect the owner-only-rename slice's Task 3 fixed.
  it('is withheld entirely from a reviewer, who can neither share, rename, nor delete', () => {
    setScreenplays('reviewer');
    render(<ProjectPage />);
    expect(
      screen.queryByRole('button', { name: 'Screenplay actions for Act One' }),
    ).not.toBeInTheDocument();
  });

  it('opens the dialog scoped to this screenplay, not to its project', async () => {
    const user = userEvent.setup();
    setScreenplays('owner');
    routeState.queries[JSON.stringify(['sharing', 'screenplay', screenplayId])] = {
      data: { members: [], invitations: [] },
      isError: false,
      isLoading: false,
    };
    render(<ProjectPage />);
    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Act One' }));
    await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Share “Act One”');
    // The scope-specific sentence is the proof it was opened at screenplay scope: a
    // project-scoped dialog says the opposite.
    expect(dialog).toHaveTextContent(/this screenplay only — not the other screenplays/i);
    expect(dialog).not.toHaveTextContent(/every screenplay in this project/i);
  });

  it('closes the dialog again, leaving the row as it was', async () => {
    // The dialog is dismissible from this entry point too, not only from the dashboard's -- each
    // caller owns its own open/close state, so "it opens" is only half the contract.
    const user = userEvent.setup();
    setScreenplays('owner');
    routeState.queries[JSON.stringify(['sharing', 'screenplay', screenplayId])] = {
      data: { members: [], invitations: [] },
      isError: false,
      isLoading: false,
    };
    render(<ProjectPage />);
    await user.click(screen.getByRole('button', { name: 'Screenplay actions for Act One' }));
    await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: 'Screenplay actions for Act One' }),
    ).toBeInTheDocument();
  });

  it('keeps Share off the row entirely when there are no screenplays to share', () => {
    routeState.query = { data: [], isError: false, isLoading: false };
    render(<ProjectPage />);
    expect(screen.queryByRole('menuitem', { name: 'Share…' })).not.toBeInTheDocument();
  });

  it('still links the row into the editor regardless of role', () => {
    setScreenplays('reviewer');
    render(<ProjectPage />);
    expect(screen.getByRole('link', { name: 'Act One' })).toHaveAttribute(
      'href',
      '/projects/$projectId/screenplays/$screenplayId',
    );
    expect(projectId).toBeTruthy();
  });
});
