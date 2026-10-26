import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FdxImportConfirmDialog } from './fdxImportConfirmDialog.js';

/**
 * The FDX-import confirmation step (`progress/fdx-import.md`'s owner-decision note). This dialog's
 * whole purpose is that a writer sees what an import will and will not bring across *before*
 * anything is created, so what it owes them is narrow and each piece is asserted below:
 *
 *  - the file it is about, and how much of it became screenplay content,
 *  - every element type left behind, with a count, rather than a vague "some content was skipped",
 *  - an explicit statement when nothing was left behind, so silence is never the only signal,
 *  - a warning, naming the title page specifically, when `@finaler-draft/fdx` could not decode it
 *    (`progress/fdx-import.md`'s Task 2, this pass) -- the body still imported in full, which this
 *    warning says plainly rather than leaving the writer to wonder what else might be missing,
 *  - a warning when the result will open read-only, which is otherwise discovered only after
 *    committing,
 *  - and the modal-shell contract the other dialogs in this app already keep (initial focus,
 *    Escape to cancel, a Tab focus trap).
 *
 * It deliberately makes no API call of its own -- `onConfirm` is a callback the route owns -- so
 * there is nothing here about pending or error state; `routes/projects/$projectId/index.test.tsx`
 * covers what happens after each button.
 */
function renderDialog(overrides: Partial<Parameters<typeof FdxImportConfirmDialog>[0]> = {}): {
  onCancel: ReturnType<typeof vi.fn>;
  onConfirm: ReturnType<typeof vi.fn>;
} {
  const onCancel = overrides.onCancel ?? vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn();
  render(
    <FdxImportConfirmDialog
      blockCount={overrides.blockCount ?? 47}
      filename={overrides.filename ?? 'Driskill Hotel.fdx'}
      onCancel={onCancel as () => void}
      onConfirm={onConfirm as () => void}
      opensReadOnly={overrides.opensReadOnly ?? false}
      skipped={overrides.skipped ?? new Map()}
      titlePageUnreadable={overrides.titlePageUnreadable ?? false}
    />,
  );
  return {
    onCancel: onCancel as ReturnType<typeof vi.fn>,
    onConfirm: onConfirm as ReturnType<typeof vi.fn>,
  };
}

describe('FdxImportConfirmDialog', () => {
  it('names the file and how much of it became screenplay content', () => {
    renderDialog({ blockCount: 47, filename: 'Driskill Hotel.fdx' });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Driskill Hotel.fdx');
    expect(screen.getByText('Imported 47 blocks.')).toBeVisible();
  });

  it('says "block" rather than "blocks" for a single one', () => {
    // Trivial to get wrong and jarring to read in the one case a writer is most likely to hit
    // while testing an import with a small file.
    renderDialog({ blockCount: 1 });
    expect(screen.getByText('Imported 1 block.')).toBeVisible();
  });

  it('lists every skipped type with its count, in the tally order it was given', () => {
    renderDialog({
      skipped: new Map([
        ['Outline 1', 4],
        ['Note', 3],
        ['Summary', 1],
      ]),
    });
    expect(screen.getByText('Left behind, with no equivalent in this product:')).toBeVisible();
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['4 Outline 1', '3 Note', '1 Summary']);
  });

  it('states plainly that nothing was left behind, rather than showing an empty list', () => {
    // An absent list is ambiguous -- it reads the same as a bug that failed to render one. The
    // writer is told either way.
    renderDialog({ skipped: new Map() });
    expect(screen.getByText('Nothing was left behind.')).toBeVisible();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('warns, as an alert, when the imported screenplay will open read-only', () => {
    renderDialog({ opensReadOnly: true });
    expect(screen.getByRole('alert')).toHaveTextContent(/will open read-only/u);
  });

  it('says nothing about read-only when the screenplay will be editable', () => {
    renderDialog({ opensReadOnly: false });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns, as an alert naming the title page specifically, when it could not be read -- and says the body imported in full', () => {
    // The owner's own complaint about the prior wording, twice: too generic, and fatal when it
    // should not have been. This asserts the replacement is specific (names "title page") and
    // says plainly that the body still came across, not merely that something went wrong.
    renderDialog({ titlePageUnreadable: true });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/title page/iu);
    expect(alert).toHaveTextContent(/imported in full/iu);
  });

  it('says nothing about the title page when it decoded successfully', () => {
    renderDialog({ titlePageUnreadable: false });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows both the title-page and read-only warnings together when both apply, neither one replacing the other', () => {
    renderDialog({ titlePageUnreadable: true, opensReadOnly: true });
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts.some((alert) => /title page/iu.test(alert.textContent ?? ''))).toBe(true);
    expect(alerts.some((alert) => /read-only/iu.test(alert.textContent ?? ''))).toBe(true);
  });

  it('moves focus into the dialog on open, so a keyboard can reach it at all', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('cancels on Escape, the dismissal every other dialog in this app honours', async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Escape is a dismissal, never an accidental commit.
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('traps Tab inside the dialog in both directions', async () => {
    const user = userEvent.setup();
    renderDialog();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Import anyway' });

    // Forward past the last control wraps to the first.
    confirm.focus();
    await user.tab();
    expect(cancel).toHaveFocus();

    // And backward past the first wraps to the last.
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it('calls onConfirm exactly once per press of the committing button', async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Import anyway' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
