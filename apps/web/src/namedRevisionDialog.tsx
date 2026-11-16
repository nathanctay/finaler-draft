import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { z } from 'zod';
import { useFormValidation } from './useFormValidation.js';

/**
 * A label has no server-side bound to share (`apps/collab`'s named-revision write accepts any
 * non-empty string the editor's own `maxLength={200}` below already caps) -- "not blank" is this
 * schema's whole rule, and it is still a schema, for the one reason `useFormValidation.ts`'s own
 * top comment gives for that case: uniformity of the one validation mechanism, not because Zod is
 * carrying any shared bound here the way the title/password schemas elsewhere do.
 */
const labelFieldSchema = z.string().trim().min(1, 'Enter a label.');

/**
 * Collaboration slice 4a's "named milestones" revision trigger (plan.md) -- the one deliberate,
 * writer-initiated occasion for a revision among the four the slice describes; the other three
 * (idle session, structural change, export) all fire without a dialog. Reached from the File menu
 * (`App.tsx`'s "Save named revision…"). Follows `DocumentSettingsDialog`'s own hand-built modal
 * shell exactly (`role="dialog"`, `aria-modal="true"`, Tab/Shift+Tab focus trap, Escape to close)
 * rather than introducing a second dialog pattern.
 *
 * Unlike `DocumentSettingsDialog`, this has a real "Save" step with its own pending/error state:
 * naming a milestone is a network request that can fail (a cooldown-free but still real 403/404),
 * and the writer needs to see that, not have the dialog silently vanish.
 *
 * The label field is validated through the shared `useFormValidation` hook
 * (`useFormValidation.ts`): a blank/whitespace-only label shows "Enter a label." once the field has
 * been blurred or Save attempted, matching every other form this mechanism now covers. `noValidate`
 * on the `<form>` below keeps the browser's own validation bubble from ever being a possibility,
 * even though nothing here currently carries a `required`/`pattern`/`type="email"` attribute that
 * would trigger one today -- a future field added to this dialog gets the same protection by
 * construction rather than by remembering to add it again.
 */
export function NamedRevisionDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (label: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [label, setLabel] = useState('');
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const { fields, validateOnSubmit } = useFormValidation({ label: labelFieldSchema }, { label });

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input')?.focus();
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateOnSubmit() || state === 'pending') return;
    const trimmed = label.trim();
    setState('pending');
    setError(undefined);
    onSave(trimmed).then(
      () => onClose(),
      (saveError: unknown) => {
        setState('error');
        setError(
          saveError instanceof Error
            ? saveError.message
            : 'Could not save this revision. Try again.',
        );
      },
    );
  }

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog named-revision-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Save named revision</h2>
        <p className="muted">
          Labels the screenplay&apos;s current state as a milestone in its revision history. This
          does not change the live document.
        </p>
        <form noValidate onSubmit={handleSubmit}>
          <label className="dialog-field">
            <span>Label</span>
            <input
              aria-label="Revision label"
              disabled={state === 'pending'}
              maxLength={200}
              onChange={(event) => setLabel(event.target.value)}
              type="text"
              value={label}
              {...fields.label.inputProps}
            />
          </label>
          {fields.label.showError && <p {...fields.label.errorProps}>{fields.label.error}</p>}
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
              disabled={fields.label.error !== undefined || state === 'pending'}
              type="submit"
            >
              {state === 'pending' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
