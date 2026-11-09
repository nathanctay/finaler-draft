import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FEEDBACK_BODY_MAX_LENGTH } from '@finaler-draft/config';
import { ApiError, MessageApiError } from './api.js';
import { FeedbackDialog } from './feedbackDialog.js';

describe('FeedbackDialog', () => {
  it('renders an empty message field and a disabled Send button until something is typed', () => {
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Feedback message' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('enables Send once a non-blank message is typed, and disables it again for a blank/whitespace-only one', async () => {
    const user = userEvent.setup();
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={vi.fn()} />);
    const textarea = screen.getByRole('textbox', { name: 'Feedback message' });

    await user.type(textarea, 'The save indicator never clears.');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    await user.clear(textarea);
    await user.type(textarea, '   ');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  /**
   * The live counter is read, not hand-maintained: it moves with the textarea's own raw length
   * (what the browser's `maxLength` attribute actually bounds), not the trimmed length the server
   * sees -- a trailing space the writer has not finished replacing should not make the counter lie
   * about how much room is left.
   */
  it('counts characters live against the shared FEEDBACK_BODY_MAX_LENGTH bound', async () => {
    const user = userEvent.setup();
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByText(`0 / ${FEEDBACK_BODY_MAX_LENGTH}`)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Feedback message' }), 'Hello');
    expect(screen.getByText(`5 / ${FEEDBACK_BODY_MAX_LENGTH}`)).toBeInTheDocument();
  });

  /**
   * The textarea's own `maxLength` attribute is the first line of defence (an ordinary typed or
   * pasted character simply cannot land past the cap); this proves the second, independent one --
   * a body that is somehow over the limit anyway (set directly, bypassing the attribute, the way a
   * malformed paste event or a future regression might) still leaves Send disabled rather than
   * relying on the attribute alone.
   */
  it('disables Send when the message is over the length cap, even bypassing the textarea’s own maxLength', () => {
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={vi.fn()} />);
    const textarea = screen.getByRole('textbox', { name: 'Feedback message' });

    fireEvent.change(textarea, { target: { value: 'x'.repeat(FEEDBACK_BODY_MAX_LENGTH + 1) } });

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('exposes the shared max length as the textarea’s own maxLength attribute', () => {
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Feedback message' })).toHaveAttribute(
      'maxlength',
      String(FEEDBACK_BODY_MAX_LENGTH),
    );
  });

  it('calls onSubmit with the trimmed message, then onClose, on a successful send', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<FeedbackDialog onClose={onClose} onSubmit={onSubmit} />);

    await user.type(
      screen.getByRole('textbox', { name: 'Feedback message' }),
      '  The save indicator never clears.  ',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSubmit).toHaveBeenCalledWith('The save indicator never clears.');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows a generic server refusal inline, verbatim, and does not close', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new MessageApiError(400, 'Message is required'));
    const onClose = vi.fn();
    render(<FeedbackDialog onClose={onClose} onSubmit={onSubmit} />);

    await user.type(screen.getByRole('textbox', { name: 'Feedback message' }), 'A problem.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Message is required');
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * The one refusal the brief names by name: a 429 must read as "you've sent a lot of feedback,
   * try later," not a bare "Request failed (429)" or the server's own generic `{error: 'Too many
   * requests'}` sentence either -- both would be a worse experience than naming the actual
   * situation, which is going to come up more often once the owner lowers the rate limit.
   * `ApiError` directly, not `MessageApiError`, proving the check keys on `status` and not on
   * which error class happened to carry it.
   */
  it('gives a 429 refusal its own sentence, not the server’s bare "Too many requests" or a generic failure', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(429));
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.type(screen.getByRole('textbox', { name: 'Feedback message' }), 'A problem.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("You've sent a lot of feedback recently");
    expect(alert).not.toHaveTextContent('Too many requests');
    expect(alert).not.toHaveTextContent('429');
  });

  it('shows a generic message when the rejection is not an Error instance', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue('a bare string rejection');
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.type(screen.getByRole('textbox', { name: 'Feedback message' }), 'A problem.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not send this feedback. Try again.',
    );
  });

  it('closes on Cancel and on Escape without calling onSubmit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<FeedbackDialog onClose={onClose} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    onClose.mockClear();
    rerender(<FeedbackDialog onClose={onClose} onSubmit={onSubmit} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('never submits a blank message even via a direct form submit', () => {
    const onSubmit = vi.fn();
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('wraps Tab from the last focusable control back to the first, keeping focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={vi.fn()} />);
    const first = screen.getByRole('textbox', { name: 'Feedback message' });
    await user.type(first, 'A problem.');
    const last = screen.getByRole('button', { name: 'Send' });
    last.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });

    expect(first).toHaveFocus();
  });

  it('wraps Shift+Tab from the first focusable control back to the last', async () => {
    const user = userEvent.setup();
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={vi.fn()} />);
    const first = screen.getByRole('textbox', { name: 'Feedback message' });
    await user.type(first, 'A problem.');
    const last = screen.getByRole('button', { name: 'Send' });
    first.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });

    expect(last).toHaveFocus();
  });

  it('leaves focus alone for a plain Tab/Shift+Tab in the middle of the dialog', () => {
    render(<FeedbackDialog onClose={vi.fn()} onSubmit={vi.fn()} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
  });

  it('ignores a key other than Escape/Tab entirely', () => {
    const onClose = vi.fn();
    render(<FeedbackDialog onClose={onClose} onSubmit={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
