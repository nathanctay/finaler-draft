import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { MessageApiError } from './api.js';

/**
 * Collaboration slice 5's confirmation step (plan.md's "Restore as current", step 1: "An authorized
 * owner/editor previews a screenplay-aware diff and confirms the target revision"). Reached from the
 * historical-preview banner's "Restore this revision…" button, which the preview route renders only
 * for an owner/editor.
 *
 * Follows `NamedRevisionDialog`'s own modal shell exactly (`role="dialog"`, `aria-modal="true"`,
 * Tab/Shift+Tab focus trap, Escape to close, a real pending/error state) rather than introducing a
 * third dialog pattern. Two things make it different from that dialog, and both are deliberate:
 *
 * **It is a confirmation, not a form.** There is nothing to type. What it adds is a plain statement
 * of exactly what a restore does -- including the two things a writer would otherwise have to infer:
 * the current content is kept as a revision, and everyone else editing right now is cut over too.
 * The confirming button is labelled with the action, never "OK".
 *
 * **The idempotency key is generated once, when the dialog opens.** `restoreRequestId` is created in
 * a `useState` initializer, so it survives re-renders and -- critically -- a failed attempt: a
 * writer who presses "Restore as current" twice, or retries after a network error, sends the
 * identical key both times, and the server recognises the second as a replay of the first rather
 * than performing a second cutover (`documentRevisions.restoreRequestId`). A key generated per click
 * would make a double-submit two restores, which is exactly the defect the server-side mechanism is
 * there to prevent -- it cannot prevent it if the client keeps minting new identities for the same
 * intent.
 */
export function RestoreRevisionDialog({
  diffHref,
  onClose,
  onConfirm,
  revisionLabel,
  revisionSummary,
}: {
  /**
   * **The wiring point for the screenplay-aware diff** that plan.md's step 1 describes. That diff
   * lives on an unmerged branch (`feature/screenplay-diff`) and is deliberately not depended on here:
   * when it lands, the route passes the diff's own URL for this revision and the link below starts
   * rendering, with no other change to this dialog, to `App`, or to the server. Until then the
   * confirmation stands on the revision's identity and the preview the writer is already looking at
   * behind this dialog, which is itself the full content of the revision being restored.
   */
  diffHref?: string | undefined;
  onClose: () => void;
  onConfirm: (restoreRequestId: string) => Promise<void>;
  /** The same string the historical banner shows, from `revisionDisplay.ts` -- one wording for one
   * revision, so the dialog cannot describe a different revision from the one on screen. */
  revisionLabel: string;
  /** `revisionPreviewSummary`'s scene/block counts, when the revision carries them. */
  revisionSummary?: string | undefined;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [restoreRequestId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [error, setError] = useState<string>();

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  function focusableElements(): HTMLElement[] {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button, [tabindex]:not([tabindex="-1"])',
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

  function handleConfirm() {
    if (state === 'pending') return;
    setState('pending');
    setError(undefined);
    onConfirm(restoreRequestId).then(
      () => onClose(),
      (confirmError: unknown) => {
        setState('error');
        // `serverMessage`, not `message`: every refusal this route can produce carries a specific
        // explanation written for the writer (`apps/api/src/app.ts` -- 403 not an editor, 402 outside
        // the editable slot, 409 the document moved on, 422 the revision cannot be opened), and
        // `api.restoreRevision` uses `jsonWithServerMessage` precisely so it survives. `ApiError`'s
        // own `message` is the bare `Request failed (409)`, which would throw all of that away at
        // the exact moment a writer most needs to know whether their screenplay changed. The same
        // idiom `App.tsx`'s `handleMakeEditable` already uses.
        setError(
          confirmError instanceof MessageApiError
            ? confirmError.serverMessage
            : confirmError instanceof Error && confirmError.message
              ? confirmError.message
              : 'This revision could not be restored. Nothing was changed.',
        );
      },
    );
  }

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog restore-revision-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Restore this revision as current</h2>
        <p>
          <strong>{revisionLabel}</strong>
          {revisionSummary ? ` — ${revisionSummary}` : ''}
        </p>
        <ul className="restore-revision-consequences">
          <li>This revision’s content becomes the live screenplay.</li>
          <li>
            The screenplay’s current content is kept in revision history — restoring does not delete
            anything.
          </li>
          <li>
            Anyone editing this screenplay right now is moved to the restored version, and changes
            they have not yet synced are kept separately rather than merged in.
          </li>
        </ul>
        {diffHref && (
          <p>
            <a href={diffHref}>Compare this revision with the current screenplay</a>
          </p>
        )}
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
            disabled={state === 'pending'}
            onClick={handleConfirm}
            type="button"
          >
            {state === 'pending' ? 'Restoring…' : 'Restore as current'}
          </button>
        </div>
      </div>
    </div>
  );
}
