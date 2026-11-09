import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { FEEDBACK_BODY_MAX_LENGTH } from '@finaler-draft/config';
import { ApiError, MessageApiError } from './api.js';

/**
 * Help > Send feedback. The backend capture path (`apps/api/src/feedback.ts`,
 * `progress/feedback-capture.md`) is already merged and already enforces everything that
 * matters -- authentication, the per-user rate limit, the length cap, and the `.strict()` schema
 * that makes "never any manuscript text" a property of the payload shape rather than a convention.
 * This dialog is the one caller: it collects the writer's message, refuses a doomed submission
 * before a round trip where the server's own refusal is already known client-side, and gives the
 * two refusals the brief names by name -- too long, rate-limited -- their own sentence rather than
 * a bare "Request failed (N)".
 *
 * Follows `NamedRevisionDialog`'s shape exactly: a hand-built modal (`role="dialog"`,
 * `aria-modal="true"`, Tab/Shift+Tab focus trap, Escape to close) with its own pending/error state,
 * because like naming a revision, sending feedback is a real network request that can fail and the
 * writer needs to see that rather than have the dialog silently vanish. `onSubmit` is supplied by
 * the caller (`App.tsx`, the diff route), which is the one place that knows this screen's own
 * `route`/`screenplayId`/`appVersion` context -- the identical division of labour
 * `NamedRevisionDialog.onSave` already has with `api.createNamedRevision`.
 */
export function FeedbackDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [body, setBody] = useState('');
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [error, setError] = useState<string>();

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('textarea')?.focus();
  }, []);

  function focusableElements(): HTMLElement[] {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, textarea, [tabindex]:not([tabindex="-1"])',
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

  // Trimmed for the identical reason the server trims (`feedback.ts`'s
  // `z.string().trim().min(1).max(...)`): a message of only whitespace is not a message, and the
  // count shown below must agree with what the server will actually see, not with the raw
  // textarea value a trailing newline could inflate.
  const trimmed = body.trim();
  // `maxLength` on the textarea below already stops ordinary typing at the cap; this is the
  // belt-and-suspenders half (a paste, or a submit mid-composition) that keeps Send disabled
  // rather than relying on the browser attribute alone to make the doomed submission unreachable.
  const tooLong = trimmed.length > FEEDBACK_BODY_MAX_LENGTH;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed.length === 0 || tooLong || state === 'pending') return;
    setState('pending');
    setError(undefined);
    onSubmit(trimmed).then(
      () => onClose(),
      (submitError: unknown) => {
        setState('error');
        setError(describeFeedbackError(submitError));
      },
    );
  }

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog feedback-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Send feedback</h2>
        <p className="muted">
          Tell us what went wrong or what would help. This never includes anything from your
          screenplay.
        </p>
        <form onSubmit={handleSubmit}>
          <label className="dialog-field">
            <span>Message</span>
            <textarea
              aria-label="Feedback message"
              disabled={state === 'pending'}
              maxLength={FEEDBACK_BODY_MAX_LENGTH}
              onChange={(event) => setBody(event.target.value)}
              rows={6}
              value={body}
            />
          </label>
          <p className="muted feedback-dialog-count">
            {body.length} / {FEEDBACK_BODY_MAX_LENGTH}
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
              className="primary-button"
              disabled={trimmed.length === 0 || tooLong || state === 'pending'}
              type="submit"
            >
              {state === 'pending' ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * The brief names one refusal that must not read as a generic failure: a 429 from
 * `apps/api/src/app.ts`'s per-user rate limit (`FEEDBACK_SUBMISSIONS_PER_HOUR`), which is going to
 * get more likely once the owner lowers that limit from its current opening value of 12
 * (`progress/feedback-capture.md`). Checked via `instanceof ApiError` -- not `MessageApiError`
 * specifically -- because `status` is what the 429 actually is; `MessageApiError` is only how this
 * client happens to carry the server's `{error: string}` body today, and a future refactor that
 * stopped doing that must not silently stop recognising the rate limit along with it.
 *
 * Every other refusal `api.submitFeedback` can throw is a `MessageApiError` carrying the server's
 * own `{error: string}` sentence (the 400 from a payload the client-side checks above should have
 * already prevented, chiefly) and is shown verbatim, the same convention `createNamedRevision`'s
 * and `renameProject`'s own callers already use. A thrown value that is not an `Error` at all
 * (`.then`'s rejection branch is `unknown`, not `Error`) falls back to one generic sentence rather
 * than printing whatever that value happens to `String()` into.
 */
function describeFeedbackError(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    return "You've sent a lot of feedback recently. Wait a bit and try again.";
  }
  if (error instanceof MessageApiError) {
    return error.serverMessage;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Could not send this feedback. Try again.';
}
