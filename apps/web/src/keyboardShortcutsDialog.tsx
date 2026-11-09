import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { KEYBOARD_SHORTCUTS, renderBinding } from './keyboardShortcuts.js';

/**
 * Help > Keyboard shortcuts. A read-only list, following `WordCountDialog`'s own hand-built modal
 * shell exactly (`role="dialog"`, `aria-modal="true"`, Tab/Shift+Tab focus trap, Escape to close)
 * -- nothing here is editable, so there is no pending/error state the way `FeedbackDialog` needs.
 *
 * The content itself is `keyboardShortcuts.ts`'s `KEYBOARD_SHORTCUTS`, not restated here: this
 * component only renders what that module exports, and `keyboardShortcuts.test.ts` is what proves
 * every entry it lists actually has a binding somewhere in the real editor. See that module's own
 * comment for what this deliberately leaves out and why.
 */
export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
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
        className="dialog keyboard-shortcuts-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Keyboard shortcuts</h2>
        <ul className="keyboard-shortcuts-list">
          {KEYBOARD_SHORTCUTS.map((entry) => (
            <li className="keyboard-shortcut-row" key={entry.description}>
              <span className="keyboard-shortcut-keys">
                {entry.bindings.map((binding) => (
                  <kbd key={binding}>{renderBinding(binding)}</kbd>
                ))}
              </span>
              <span className="keyboard-shortcut-description">{entry.description}</span>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
