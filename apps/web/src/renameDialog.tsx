import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RESOURCE_TITLE_MAX_LENGTH } from '@finaler-draft/config';
import { MessageApiError } from './api.js';
import { titleFieldSchema } from './formFieldSchemas.js';
import { useFormValidation } from './useFormValidation.js';

/**
 * The 3-dot-menu "Rename…" item's dialog, on both the project screen
 * (routes/projects/index.tsx) and a project's own screenplay list
 * (routes/projects/$projectId/index.tsx) -- owner-only on both, matching the server
 * (apps/api/src/projects.ts's `renameProject`/`renameScreenplay`, both narrowed to owner-only by
 * the owner-only-rename slice, progress/owner-only-rename.md, which is this product's one
 * enforcement point for that: RLS is deliberately deferred).
 *
 * Follows `NamedRevisionDialog`'s modal shell exactly (`role="dialog"`, `aria-modal="true"`,
 * Tab/Shift+Tab focus trap, Escape to close, a real pending/error state) rather than inventing a
 * fourth hand-built dialog pattern in this codebase -- the owner-only-rename brief named it as the
 * closest existing shape, and reading it alongside `RestoreRevisionDialog` confirmed it: both are
 * the same shell with different content, not two different shells. Two things make this dialog
 * different from `NamedRevisionDialog`:
 *
 * **Pre-filled, not blank.** `initialTitle` seeds the field (and is selected on mount, matching a
 * desktop rename convention), so renaming is an edit of the current title rather than retyping it
 * from scratch -- the one real difference between "save a new label" and "rename an existing
 * thing."
 *
 * **Validated before submission, inline**, via the shared `useFormValidation` hook
 * (`useFormValidation.ts`) every form-validation-messages-slice form now uses: a field-level
 * message appears, and Rename disables, once the field has been blurred or a submit attempted --
 * not only after a round trip to the server. The one rule enforced -- non-empty after trimming, at
 * most `RESOURCE_TITLE_MAX_LENGTH` characters -- is exactly `renameInput`'s own
 * (`apps/api/src/projects.ts`: `z.string().trim().min(1).max(RESOURCE_TITLE_MAX_LENGTH)`), read
 * from the same shared `@finaler-draft/config` constant that schema itself uses rather than a
 * second `200` literal maintained here independently: a bound that drifted from the server's own
 * would mean this dialog accepting a title the server would still reject with a 400, or rejecting
 * one the server would have allowed. `noValidate` on the `<form>` below is what keeps the browser's
 * own validation bubble from ever pre-empting this message -- the `maxLength` attribute still stops
 * a keystroke past the bound (assistive and conventional), but no native constraint-validation UI
 * is allowed to render for it.
 *
 * A **server refusal is shown as the server's own sentence**, not a bare "Request failed (403)" --
 * the pattern `RestoreRevisionDialog.handleConfirm` already established for exactly this reason:
 * `api.renameProject`/`api.renameScreenplay` use `jsonWithServerMessage`, so a 403 (not the owner)
 * or 404 (deleted or no longer a member) arrives as a `MessageApiError` carrying the exact sentence
 * `app.ts` wrote for it ("Project owner access required" / "Screenplay owner access required" /
 * "Project not found" / "Screenplay not found"), read directly rather than paraphrased.
 */
export function RenameDialog({
  initialTitle,
  kind,
  onClose,
  onRename,
}: {
  initialTitle: string;
  /** Names the thing being renamed, for the heading and the fallback failure message -- the same
   * dialog serves both the project screen and a project's own screenplay list. */
  kind: 'project' | 'screenplay';
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [title, setTitle] = useState(initialTitle);
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [serverError, setServerError] = useState<string>();
  const { fields, validateOnSubmit } = useFormValidation({ title: titleFieldSchema }, { title });

  useEffect(() => {
    const input = dialogRef.current?.querySelector<HTMLInputElement>('input');
    input?.focus();
    input?.select();
  }, []);

  function focusableElements(): HTMLElement[] {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, input, [tabindex]:not([tabindex="-1"])',
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

  // The trimmed value is what is actually sent -- `titleFieldSchema`'s own `.trim()` only governs
  // what counts as valid, it does not change what this component holds in state or submits.
  const trimmed = title.trim();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Checked first, ahead of the pending guard below: a submit attempted while the title is
    // invalid must reveal the message and stop here, even if (hypothetically) a request were
    // already in flight -- there is no ordering in which an invalid title should be allowed to
    // skip straight to the pending branch because the button was also disabled for another reason.
    if (!validateOnSubmit() || state === 'pending') return;
    setState('pending');
    setServerError(undefined);
    onRename(trimmed).then(
      () => onClose(),
      (renameError: unknown) => {
        setState('error');
        setServerError(
          renameError instanceof MessageApiError
            ? renameError.serverMessage
            : renameError instanceof Error && renameError.message
              ? renameError.message
              : `This ${kind} could not be renamed. Try again.`,
        );
      },
    );
  }

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog rename-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>{kind === 'project' ? 'Rename project' : 'Rename screenplay'}</h2>
        <form noValidate onSubmit={handleSubmit}>
          <label className="dialog-field">
            <span>Title</span>
            <input
              disabled={state === 'pending'}
              maxLength={RESOURCE_TITLE_MAX_LENGTH}
              onChange={(event) => setTitle(event.target.value)}
              type="text"
              value={title}
              {...fields.title.inputProps}
            />
          </label>
          {fields.title.showError && <p {...fields.title.errorProps}>{fields.title.error}</p>}
          {state === 'error' && (
            <p className="field-error" role="alert">
              {serverError}
            </p>
          )}
          <div className="dialog-actions">
            <button disabled={state === 'pending'} onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={fields.title.error !== undefined || state === 'pending'}
              type="submit"
            >
              {state === 'pending' ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
