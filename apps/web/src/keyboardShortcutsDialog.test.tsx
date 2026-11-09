import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { KEYBOARD_SHORTCUTS, renderBinding } from './keyboardShortcuts.js';
import { KeyboardShortcutsDialog } from './keyboardShortcutsDialog.js';

describe('KeyboardShortcutsDialog', () => {
  it('lists every KEYBOARD_SHORTCUTS entry, its rendered key(s) and its description', () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toBeVisible();
    for (const entry of KEYBOARD_SHORTCUTS) {
      const row = screen.getByText(entry.description).closest('li');
      expect(row).not.toBeNull();
      for (const binding of entry.bindings) {
        expect(row).toHaveTextContent(renderBinding(binding));
      }
    }
  });

  /** Proves this component renders what `keyboardShortcuts.ts` exports rather than a second,
   * hand-copied list of its own -- changing the module's content changes the dialog with no edit
   * here, which is the whole point of the single-source design that module's own comment argues
   * for. */
  it('renders exactly as many rows as KEYBOARD_SHORTCUTS has entries', () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(KEYBOARD_SHORTCUTS.length);
  });

  it('closes on Escape and on the Close button, both via onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<KeyboardShortcutsDialog onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(<KeyboardShortcutsDialog onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focuses the Close button on mount, so Escape and Tab both work with no prior click', () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('wraps Tab from (and Shift+Tab back to) the one focusable control, keeping focus inside the dialog', () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
  });

  it('ignores a key other than Escape/Tab entirely', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsDialog onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' });

    expect(onClose).not.toHaveBeenCalled();
  });
});
