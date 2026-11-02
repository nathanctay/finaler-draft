import { useEffect, useId, useRef, type KeyboardEvent } from 'react';

/**
 * One stat's document total, and -- when the writer has a selection -- that same stat counted
 * over the selection alone. `selection` is `undefined` with no selection active, which is what
 * tells this dialog to report the document total alone rather than a "N of M" pair; it is never
 * `undefined` *because* the selection's count happens to be zero (an empty but present selection
 * is not offered at all -- see `hasSelection` in App.tsx, which gates this the same way Cut/Copy
 * already do).
 */
export interface WordCountStat {
  readonly documentTotal: number;
  readonly selection: number | undefined;
}

function formatStat(stat: WordCountStat): string {
  return stat.selection === undefined
    ? String(stat.documentTotal)
    : `${stat.selection} of ${stat.documentTotal}`;
}

/**
 * Tools > Word count (plan.md's menubar labels list; this slice gives `Tools` its first real
 * item, `progress/menus-slice-2.md`). Follows `DocumentSettingsDialog`'s own hand-built modal
 * shell exactly -- `role="dialog"`, `aria-modal="true"`, Tab/Shift+Tab focus trap, Escape to close
 * -- rather than inventing a second dialog idiom; see that component's own comment for why this is
 * a plain overlay rather than the native `<dialog>` element (jsdom, this project's test
 * environment, has no `HTMLDialogElement.showModal`).
 *
 * Unlike `DocumentSettingsDialog`, nothing here is editable: counting words never mutates the
 * document, so (per the owner's own framing) a reviewer on a read-only entitlement may open this
 * exactly as they may still copy text -- there is no `editingAllowed` gate anywhere in this
 * component or its one menu item in `App.tsx`.
 *
 * Words and characters are reported Google-Docs-style: "N of M" against the whole document while
 * a selection is active, the document's own total alone otherwise. Pages has no selection-aware
 * reading at all -- "pages in a selection" is not a thing a reader of this dialog is asking for,
 * and Google Docs' own word-count dialog does not attempt it either -- so it is always the one
 * document-wide number, sourced from the pagination plugin's own `pageCount` state (`App.tsx`),
 * never recomputed here.
 */
export function WordCountDialog({
  characters,
  onClose,
  pages,
  words,
}: {
  characters: WordCountStat;
  onClose: () => void;
  pages: number;
  words: WordCountStat;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  function focusableElements(): HTMLElement[] {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])') ??
        [],
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const elements = focusableElements();
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog word-count-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Word count</h2>
        <dl className="word-count-stats">
          <div className="word-count-stat">
            <dt>Words</dt>
            <dd>{formatStat(words)}</dd>
          </div>
          <div className="word-count-stat">
            <dt>Characters</dt>
            <dd>{formatStat(characters)}</dd>
          </div>
          <div className="word-count-stat">
            <dt>Pages</dt>
            <dd>{pages}</dd>
          </div>
        </dl>
        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
