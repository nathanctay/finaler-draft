import { useEffect, useId, useRef, type KeyboardEvent } from 'react';

/**
 * The confirmation step the owner specifically approved (see `progress/fdx-import.md`'s "owner
 * decision" note on the relaxed skip policy): after `fdxToScreenplay` parses successfully, the
 * writer sees exactly what will and will not be imported -- block count, every skipped `Type`
 * tallied, and whether the result will open read-only -- and chooses before anything is created
 * server-side. **Cancelling creates no screenplay**: this dialog makes no API call of its own;
 * `onCancel` only dismisses it, and `onConfirm` is the one and only path that leads to
 * `api.createScreenplay` (`routes/projects/$projectId/index.tsx`'s `commitImport` mutation).
 *
 * Follows `RestoreRevisionDialog`'s modal shell exactly (`role="dialog"`, `aria-modal="true"`,
 * Tab/Shift+Tab focus trap, Escape to cancel) rather than introducing a fourth dialog pattern --
 * this is a confirmation, not a form, so it carries no pending/error state of its own; the route
 * that opens it owns whatever happens after `onConfirm` is clicked.
 */
export function FdxImportConfirmDialog({
  blockCount,
  filename,
  onCancel,
  onConfirm,
  opensReadOnly,
  skipped,
  titlePageUnreadable,
}: {
  blockCount: number;
  filename: string;
  onCancel: () => void;
  onConfirm: () => void;
  /**
   * Whether `@finaler-draft/screenplay-editor`'s own `editorContentFromScreenplay` would throw
   * for this result -- computed by the route by actually calling that function in a `try`/`catch`
   * (not restated here), so this prop can never diverge from the editor's real behavior.
   */
  opensReadOnly: boolean;
  /** Every skipped FDX `Type`, tallied, in first-seen order (`FdxSkippedTally` from
   * `@finaler-draft/fdx`). Empty when nothing was left out. */
  skipped: ReadonlyMap<string, number>;
  /**
   * `@finaler-draft/fdx`'s `FdxImportResult.titlePageUnreadable`, passed straight through -- see
   * `progress/fdx-import.md`'s Task 2 (this pass). A title page this package could not decode is
   * no longer a fatal error: the body imported in full regardless, and this is how that specific,
   * actionable fact reaches the writer, through the same confirmation step a skipped element type
   * already uses, rather than the old generic "content this product cannot represent" refusal.
   */
  titlePageUnreadable: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

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
      onCancel();
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

  const skippedEntries = Array.from(skipped.entries());

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog fdx-import-confirm-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Importing &ldquo;{filename}&rdquo;</h2>
        <p>
          Imported {blockCount} {blockCount === 1 ? 'block' : 'blocks'}.
        </p>
        {skippedEntries.length > 0 ? (
          <>
            <p>Left behind, with no equivalent in this product:</p>
            <ul>
              {skippedEntries.map(([type, count]) => (
                <li key={type}>
                  {count} {type}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>Nothing was left behind.</p>
        )}
        {titlePageUnreadable && (
          <p role="alert">
            This file&rsquo;s title page could not be read, so it was left out of the import -- the
            script body imported in full.
          </p>
        )}
        {opensReadOnly && (
          <p role="alert">
            This script uses dual dialogue, a forced page break, more than one title page, or an
            annotation — this editor cannot edit those directly yet, so the imported screenplay will
            open read-only.
          </p>
        )}
        <p>The script body imported in full.</p>
        <div className="dialog-actions">
          <button onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-button" onClick={onConfirm} type="button">
            Import anyway
          </button>
        </div>
      </div>
    </div>
  );
}
