import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NamedRevisionDialog } from './namedRevisionDialog.js';

describe('NamedRevisionDialog', () => {
  it('renders an empty label field and a disabled Save button until something is typed', () => {
    render(<NamedRevisionDialog onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Save named revision' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Revision label' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('enables Save once a non-blank label is typed, and disables it again for a blank/whitespace-only one', async () => {
    const user = userEvent.setup();
    render(<NamedRevisionDialog onClose={vi.fn()} onSave={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Revision label' });

    await user.type(input, 'Draft 2');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await user.clear(input);
    await user.type(input, '   ');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('calls onSave with the trimmed label, then onClose, on a successful save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NamedRevisionDialog onClose={onClose} onSave={onSave} />);

    await user.type(screen.getByRole('textbox', { name: 'Revision label' }), '  Draft 2  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith('Draft 2');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows the failure inline and does not close when the save is rejected', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error('Screenplay editor access required'));
    const onClose = vi.fn();
    render(<NamedRevisionDialog onClose={onClose} onSave={onSave} />);

    await user.type(screen.getByRole('textbox', { name: 'Revision label' }), 'Draft 2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Screenplay editor access required');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Cancel and on Escape without calling onSave', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<NamedRevisionDialog onClose={onClose} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();

    onClose.mockClear();
    rerender(<NamedRevisionDialog onClose={onClose} onSave={onSave} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('never submits a blank label even via Enter in the field', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NamedRevisionDialog onClose={vi.fn()} onSave={onSave} />);

    screen.getByRole('textbox', { name: 'Revision label' }).focus();
    await user.keyboard('{Enter}');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows a generic message when the rejection is not an Error instance', async () => {
    const user = userEvent.setup();
    // Deliberately a non-Error rejection -- proving the fallback message branch (not every
    // rejection this app might see is guaranteed to be an `Error` instance).
    const onSave = vi.fn().mockRejectedValue('a bare string rejection');
    render(<NamedRevisionDialog onClose={vi.fn()} onSave={onSave} />);

    await user.type(screen.getByRole('textbox', { name: 'Revision label' }), 'Draft 2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save this revision. Try again.',
    );
  });

  it('wraps Tab from the last focusable control back to the first, keeping focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(<NamedRevisionDialog onClose={vi.fn()} onSave={vi.fn()} />);
    const first = screen.getByRole('textbox', { name: 'Revision label' });
    // A blank label leaves Save disabled, and a disabled control cannot actually receive focus --
    // type one first so Save is a real, focusable last stop.
    await user.type(first, 'Draft 2');
    const last = screen.getByRole('button', { name: 'Save' });
    last.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });

    expect(first).toHaveFocus();
  });

  it('wraps Shift+Tab from the first focusable control back to the last', async () => {
    const user = userEvent.setup();
    render(<NamedRevisionDialog onClose={vi.fn()} onSave={vi.fn()} />);
    const first = screen.getByRole('textbox', { name: 'Revision label' });
    // The last focusable control is Save, but it starts disabled (blank label) and therefore
    // unfocusable -- type a label first so Save is the real last stop in the trap, exactly as a
    // writer tabbing through this dialog would experience it.
    await user.type(first, 'Draft 2');
    const last = screen.getByRole('button', { name: 'Save' });
    first.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });

    expect(last).toHaveFocus();
  });

  it('leaves focus alone for a plain Tab/Shift+Tab in the middle of the dialog', () => {
    render(<NamedRevisionDialog onClose={vi.fn()} onSave={vi.fn()} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
  });

  it('ignores a key other than Escape/Tab entirely', () => {
    const onClose = vi.fn();
    render(<NamedRevisionDialog onClose={onClose} onSave={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
