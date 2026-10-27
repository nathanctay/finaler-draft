import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RESOURCE_TITLE_MAX_LENGTH } from '@finaler-draft/config';
import { MessageApiError } from './api.js';
import { RenameDialog } from './renameDialog.js';

describe('RenameDialog', () => {
  it('pre-fills the field with the current title, selected, rather than starting blank', () => {
    render(
      <RenameDialog initialTitle="Draft One" kind="project" onClose={vi.fn()} onRename={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: 'Rename project' })).toBeVisible();
    const input = screen.getByRole('textbox', { name: 'Title' });
    expect(input).toHaveValue('Draft One');
  });

  it('names the heading after the kind of thing being renamed', () => {
    const { unmount } = render(
      <RenameDialog
        initialTitle="Act One"
        kind="screenplay"
        onClose={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Rename screenplay' })).toBeVisible();
    unmount();
    render(
      <RenameDialog initialTitle="Project" kind="project" onClose={vi.fn()} onRename={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: 'Rename project' })).toBeVisible();
  });

  it('disables Rename and shows no message yet for a blank field until it is touched or submitted', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(
      <RenameDialog
        initialTitle="Draft One"
        kind="project"
        onClose={vi.fn()}
        onRename={onRename}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(input);

    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces "Enter a title." once the blank field is blurred', async () => {
    const user = userEvent.setup();
    render(
      <RenameDialog initialTitle="Draft One" kind="project" onClose={vi.fn()} onRename={vi.fn()} />,
    );
    const input = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.tab();

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a title.');
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('treats a whitespace-only title the same as blank', async () => {
    const user = userEvent.setup();
    render(
      <RenameDialog initialTitle="Draft One" kind="project" onClose={vi.fn()} onRename={vi.fn()} />,
    );
    const input = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.type(input, '   ');
    await user.tab();

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a title.');
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('rejects a title whose trimmed length exceeds RESOURCE_TITLE_MAX_LENGTH, surfaced on blur', () => {
    render(
      <RenameDialog initialTitle="Draft One" kind="project" onClose={vi.fn()} onRename={vi.fn()} />,
    );
    const input = screen.getByRole('textbox', { name: 'Title' });
    // `fireEvent.change` sets the DOM value property directly, bypassing the input's own
    // `maxLength` attribute -- which is exactly what is needed here: proving the dialog's own
    // validation message is what refuses an overlong title, not merely that the browser trims
    // keystrokes before they ever reach React state.
    fireEvent.change(input, { target: { value: 'x'.repeat(RESOURCE_TITLE_MAX_LENGTH + 1) } });
    fireEvent.blur(input);

    expect(screen.getByRole('alert')).toHaveTextContent(
      `Titles can be at most ${RESOURCE_TITLE_MAX_LENGTH} characters.`,
    );
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('accepts a title at exactly RESOURCE_TITLE_MAX_LENGTH characters', () => {
    render(
      <RenameDialog initialTitle="Draft One" kind="project" onClose={vi.fn()} onRename={vi.fn()} />,
    );
    const input = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(input, { target: { value: 'x'.repeat(RESOURCE_TITLE_MAX_LENGTH) } });
    fireEvent.blur(input);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled();
  });

  it('calls onRename with the trimmed title, then onClose, on a successful submission', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <RenameDialog
        initialTitle="Draft One"
        kind="project"
        onClose={onClose}
        onRename={onRename}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.type(input, '  Draft Two  ');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(onRename).toHaveBeenCalledWith('Draft Two');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('never calls onRename for a blank title, even via Enter', async () => {
    // Matches `NamedRevisionDialog`'s identical test: once the field is blank, Rename is a real
    // native-`disabled` submit button, so the browser (and jsdom) never dispatches a submit event
    // for Enter in the field at all -- there is no form submission for `handleSubmit` to refuse.
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(
      <RenameDialog
        initialTitle="Draft One"
        kind="project"
        onClose={vi.fn()}
        onRename={onRename}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.keyboard('{Enter}');

    expect(onRename).not.toHaveBeenCalled();
  });

  it('shows the server’s own sentence verbatim for a MessageApiError, and does not close', async () => {
    const user = userEvent.setup();
    const onRename = vi
      .fn()
      .mockRejectedValue(new MessageApiError(403, 'Project owner access required'));
    const onClose = vi.fn();
    render(
      <RenameDialog
        initialTitle="Draft One"
        kind="project"
        onClose={onClose}
        onRename={onRename}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Project owner access required');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to a generic per-kind message when the rejection carries none', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn().mockRejectedValue('a bare string rejection');
    render(
      <RenameDialog
        initialTitle="Act One"
        kind="screenplay"
        onClose={vi.fn()}
        onRename={onRename}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This screenplay could not be renamed. Try again.',
    );
  });

  it('changes nothing on Cancel', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onClose = vi.fn();
    render(
      <RenameDialog
        initialTitle="Draft One"
        kind="project"
        onClose={onClose}
        onRename={onRename}
      />,
    );
    await user.clear(screen.getByRole('textbox', { name: 'Title' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Something else');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onRename).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without calling onRename', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onClose = vi.fn();
    render(
      <RenameDialog
        initialTitle="Draft One"
        kind="project"
        onClose={onClose}
        onRename={onRename}
      />,
    );
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('focuses and selects the title field on mount', () => {
    render(
      <RenameDialog initialTitle="Draft One" kind="project" onClose={vi.fn()} onRename={vi.fn()} />,
    );
    const input = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Draft One'.length);
  });

  it('wraps Tab from the last focusable control back to the first, keeping focus inside the dialog', () => {
    render(
      <RenameDialog initialTitle="Draft One" kind="project" onClose={vi.fn()} onRename={vi.fn()} />,
    );
    const first = screen.getByRole('textbox', { name: 'Title' });
    const last = screen.getByRole('button', { name: 'Rename' });
    last.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });

    expect(first).toHaveFocus();
  });

  it('wraps Shift+Tab from the first focusable control back to the last', () => {
    render(
      <RenameDialog initialTitle="Draft One" kind="project" onClose={vi.fn()} onRename={vi.fn()} />,
    );
    const first = screen.getByRole('textbox', { name: 'Title' });
    const last = screen.getByRole('button', { name: 'Rename' });
    first.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });

    expect(last).toHaveFocus();
  });

  it('ignores a key other than Escape/Tab entirely', () => {
    const onClose = vi.fn();
    render(
      <RenameDialog initialTitle="Draft One" kind="project" onClose={onClose} onRename={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
