import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageApiError } from './api.js';
import { RestoreRevisionDialog } from './restoreRevisionDialog.js';

/**
 * Collaboration slice 5's confirmation step (plan.md's "Restore as current", step 1). What this
 * dialog owes the writer is narrow and specific, and each piece is asserted below:
 *
 *  - a plain statement of what a restore does, including the two consequences a writer would
 *    otherwise have to infer (the current content is kept; other writers are cut over too),
 *  - a confirming button labelled with the action rather than "OK",
 *  - one idempotency key per *confirmation*, not per click -- the property the server-side unique
 *    index cannot provide on its own, because it cannot stop a client minting new identities for the
 *    same intent,
 *  - and the server's own explanation when a restore is refused, since "something went wrong" after
 *    confirming a restore leaves a writer with no way to know whether their screenplay changed.
 */
const label = 'Named revision — March 4, 2026, 3:04 PM';

function renderDialog(overrides: Partial<Parameters<typeof RestoreRevisionDialog>[0]> = {}): {
  onClose: ReturnType<typeof vi.fn>;
  onConfirm: ReturnType<typeof vi.fn>;
} {
  const onClose = overrides.onClose ?? vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn().mockResolvedValue(undefined);
  render(
    <RestoreRevisionDialog
      onClose={onClose as () => void}
      onConfirm={onConfirm as (restoreRequestId: string) => Promise<void>}
      revisionLabel={overrides.revisionLabel ?? label}
      revisionSummary={overrides.revisionSummary}
      diffHref={overrides.diffHref}
    />,
  );
  return {
    onClose: onClose as ReturnType<typeof vi.fn>,
    onConfirm: onConfirm as ReturnType<typeof vi.fn>,
  };
}

describe('RestoreRevisionDialog', () => {
  it('is a labelled modal naming the revision, its summary, and every consequence of restoring', () => {
    renderDialog({ revisionSummary: '3 scenes · 40 blocks' });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Labelled by its own heading, not by a bare `aria-label` -- the heading is what a screen reader
    // announces on open.
    expect(dialog).toHaveAttribute(
      'aria-labelledby',
      screen.getByRole('heading', { name: 'Restore this revision as current' }).id,
    );
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(/3 scenes · 40 blocks/)).toBeVisible();
    expect(screen.getByText(/This revision’s content becomes the live screenplay/)).toBeVisible();
    expect(screen.getByText(/kept in revision history/)).toBeVisible();
    expect(screen.getByText(/kept separately rather than merged in/)).toBeVisible();
    // The action, never "OK".
    expect(screen.getByRole('button', { name: 'Restore as current' })).toBeVisible();
  });

  it('omits the summary line entirely when the revision carries no preview metadata', () => {
    renderDialog();
    expect(screen.getByText(label).textContent).toBe(label);
  });

  it('moves focus into the dialog on open, so a keyboard user is not left behind it', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('closes on Escape without confirming anything', async () => {
    const { onClose, onConfirm } = renderDialog();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  /** A focus trap, not merely an autofocus: Tab from the last control wraps to the first and
   * Shift+Tab from the first wraps to the last, so focus cannot escape to the page behind a modal. */
  it('traps Tab and Shift+Tab inside the dialog', async () => {
    renderDialog();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Restore as current' });
    await waitFor(() => expect(cancel).toHaveFocus());

    await userEvent.tab();
    expect(confirm).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it('ignores keys that are neither Escape nor Tab', async () => {
    const { onClose, onConfirm } = renderDialog();
    await userEvent.keyboard('{ArrowDown}x');
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  /**
   * The wiring point for the screenplay-aware diff. Rendered only when the route supplies a
   * destination -- a link to nowhere would be worse than no link.
   */
  it('links to the diff only when the route supplies one', () => {
    const { unmount } = render(
      <RestoreRevisionDialog
        onClose={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        revisionLabel={label}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    unmount();

    renderDialog({ diffHref: '/projects/p/screenplays/s/revisions/r/diff' });
    expect(
      screen.getByRole('link', { name: 'Compare this revision with the current screenplay' }),
    ).toHaveAttribute('href', '/projects/p/screenplays/s/revisions/r/diff');
  });

  it('confirms with a uuid request id, shows a pending state, and closes on success', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onConfirm = vi.fn().mockReturnValue(pending);
    const { onClose } = renderDialog({ onConfirm });

    await userEvent.click(screen.getByRole('button', { name: 'Restore as current' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Both controls are disabled while the cutover is in flight: Cancel too, because the request has
    // already been sent and closing the dialog would not recall it.
    expect(screen.getByRole('button', { name: 'Restoring…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    release!();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  /**
   * The double-submit case the idempotency key exists for, closed here as well as on the server: a
   * second click while the first request is in flight sends nothing at all.
   */
  it('ignores a second confirmation while the first is still in flight', async () => {
    const onConfirm = vi.fn().mockReturnValue(new Promise<void>(() => undefined));
    renderDialog({ onConfirm });
    const button = screen.getByRole('button', { name: 'Restore as current' });

    await userEvent.click(button);
    await userEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  /**
   * The key is generated when the dialog *opens*, in a `useState` initializer, so it survives both
   * re-renders and a failed attempt. A key generated per click would make a retry a second restore,
   * which is precisely the defect the server-side mechanism exists to prevent -- and cannot, if the
   * client keeps changing the identity of the same intent.
   */
  it('reuses the identical request id when a failed confirmation is retried', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new MessageApiError(409, 'Reload and try again.'))
      .mockResolvedValueOnce(undefined);
    const { onClose } = renderDialog({ onConfirm });

    await userEvent.click(screen.getByRole('button', { name: 'Restore as current' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload and try again.');
    // Still open, and still showing the revision it was about.
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Restore as current' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm.mock.calls[0]![0]).toBe(onConfirm.mock.calls[1]![0]);
  });

  /**
   * `serverMessage`, not `ApiError`'s own `message`. Every refusal this route can produce carries a
   * sentence written for the writer (403 not an editor, 402 outside the editable slot, 409 the
   * document moved on, 422 the revision cannot be opened); `Request failed (409)` would throw all of
   * it away at the moment a writer most needs to know whether their screenplay changed.
   */
  it('shows the server’s own explanation for a refusal, never a bare status code', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValue(
        new MessageApiError(
          402,
          'Restoring a revision needs edit access to this screenplay. Make it your editable screenplay, or upgrade.',
        ),
      );
    renderDialog({ onConfirm });

    await userEvent.click(screen.getByRole('button', { name: 'Restore as current' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Make it your editable screenplay, or upgrade.');
    expect(alert).not.toHaveTextContent('Request failed');
  });

  it('falls back to a plain error’s message, and to a safe sentence for a non-error rejection', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('The network is offline.'));
    const { unmount } = render(
      <RestoreRevisionDialog
        onClose={vi.fn()}
        onConfirm={onConfirm as (restoreRequestId: string) => Promise<void>}
        revisionLabel={label}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Restore as current' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The network is offline.');
    unmount();

    // A rejection that is not an `Error` at all (a thrown string from somewhere unexpected) must
    // still say something true: nothing was changed.
    renderDialog({ onConfirm: vi.fn().mockRejectedValue('not an error object') });
    await userEvent.click(screen.getByRole('button', { name: 'Restore as current' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This revision could not be restored. Nothing was changed.',
    );
  });
});
