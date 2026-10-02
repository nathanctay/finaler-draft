import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

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
    const trimmed = label.trim();
    if (trimmed.length === 0 || state === 'pending') return;
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
        <form onSubmit={handleSubmit}>
          <label className="dialog-field">
            <span>Label</span>
            <input
              aria-label="Revision label"
              disabled={state === 'pending'}
              maxLength={200}
              onChange={(event) => setLabel(event.target.value)}
              type="text"
              value={label}
            />
          </label>
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
              disabled={label.trim().length === 0 || state === 'pending'}
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
