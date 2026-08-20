import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@finaler-draft/screenplay';
import { DocumentSettingsDialog } from './documentSettingsDialog.js';

function settings(overrides: Partial<DocumentSettings> = {}): DocumentSettings {
  return { ...DEFAULT_DOCUMENT_SETTINGS, ...overrides };
}

describe('DocumentSettingsDialog', () => {
  it('renders every adjustable control at its current value, and nothing that is never adjustable', () => {
    render(
      <DocumentSettingsDialog
        onChange={vi.fn()}
        onClose={vi.fn()}
        settings={settings({
          characterIndentIn: 3.7,
          parentheticalIndentIn: 3.3,
          parentheticalWidthIn: 2.1,
          pageNumberStyle: 'roman',
          sceneNumbersEnabled: true,
          autoMoreContinued: false,
        })}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Document settings' })).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: 'Character indent, in inches' })).toHaveValue(
      3.7,
    );
    expect(screen.getByRole('spinbutton', { name: 'Parenthetical indent, in inches' })).toHaveValue(
      3.3,
    );
    expect(screen.getByRole('spinbutton', { name: 'Parenthetical width, in inches' })).toHaveValue(
      2.1,
    );
    expect(screen.getByRole('radio', { name: 'Roman numerals' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Numbers' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Number scenes' })).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: "Automatically insert (MORE) and CONT'D" }),
    ).not.toBeChecked();

    // plan.md: "Not adjustable, ever: the typeface, the type size, the pitch." And page-number
    // *position* is fixed top-right (this scope's own resolved discrepancy, see the progress
    // log) -- neither may appear as a control here.
    expect(screen.queryByText(/typeface/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/type size/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pitch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/position/i)).not.toBeInTheDocument();
  });

  it('reports a complete next DocumentSettings, not a partial patch, when a number field changes', () => {
    const onChange = vi.fn();
    render(<DocumentSettingsDialog onChange={onChange} onClose={vi.fn()} settings={settings()} />);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Character indent, in inches' }), {
      target: { value: '4.1' },
    });

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_DOCUMENT_SETTINGS, characterIndentIn: 4.1 });
  });

  it('ignores a transiently non-numeric input rather than propagating NaN', () => {
    const onChange = vi.fn();
    render(<DocumentSettingsDialog onChange={onChange} onClose={vi.fn()} settings={settings()} />);

    // A writer clearing the field to retype it passes through '' for a moment; that must never
    // reach pagination as NaN.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Character indent, in inches' }), {
      target: { value: '' },
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('flips page-number style with a click, in plain language rather than numeral-system names', () => {
    const onChange = vi.fn();
    render(<DocumentSettingsDialog onChange={onChange} onClose={vi.fn()} settings={settings()} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Roman numerals' }));

    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_DOCUMENT_SETTINGS,
      pageNumberStyle: 'roman',
    });
  });

  it('toggles scene numbers and automatic (MORE)/CONT’D independently via their checkboxes', () => {
    const onChange = vi.fn();
    render(<DocumentSettingsDialog onChange={onChange} onClose={vi.fn()} settings={settings()} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Number scenes' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_DOCUMENT_SETTINGS,
      sceneNumbersEnabled: true,
    });

    fireEvent.click(
      screen.getByRole('checkbox', { name: "Automatically insert (MORE) and CONT'D" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_DOCUMENT_SETTINGS,
      autoMoreContinued: false,
    });
  });

  describe('the parenthetical-vs-character-indent warning', () => {
    /**
     * The owner's ruling on a genuine `plan.md` self-contradiction (recorded in
     * `documentSettingsDialog.tsx`'s own comment and this scope's progress log): the warning
     * measures drift from the *default* 0.6in gap between the character and parenthetical
     * indents (3.7 - 3.1), not the absolute distance from the character indent. Reading
     * "Document settings"' threshold literally as an absolute distance would put
     * `DEFAULT_DOCUMENT_SETTINGS` itself -- which "Element indents" presents as correct -- 0.1in
     * past its own warning boundary. This is the regression that ruling exists to prevent, and
     * the one most likely to be missed by a future change to the threshold.
     */
    it('produces no warning for DEFAULT_DOCUMENT_SETTINGS, the specification-endorsed default gap', () => {
      render(<DocumentSettingsDialog onChange={vi.fn()} onClose={vi.fn()} settings={settings()} />);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('does not warn at exactly a half-inch of drift from the default gap', () => {
      // Default gap is 0.6in (3.7 - 3.1). A gap of 1.1in is exactly 0.5in wider -- the boundary,
      // which the strict `>` comparison must not treat as a warning.
      render(
        <DocumentSettingsDialog
          onChange={vi.fn()}
          onClose={vi.fn()}
          settings={settings({ characterIndentIn: 3.7, parentheticalIndentIn: 2.6 })}
        />,
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('warns when the gap widens more than half an inch beyond the default', () => {
      // Gap = 3.7 - 2.5 = 1.2in, 0.6in wider than the 0.6in default -- past the boundary.
      render(
        <DocumentSettingsDialog
          onChange={vi.fn()}
          onClose={vi.fn()}
          settings={settings({ characterIndentIn: 3.7, parentheticalIndentIn: 2.5 })}
        />,
      );
      expect(screen.getByRole('status')).toHaveTextContent(/drifted more than half an inch/i);
    });

    it('warns for the opposite direction too -- a gap that narrows or reverses, not only one that widens', () => {
      // Gap = 3.7 - 4.4 = -0.7in (the parenthetical has moved past the character indent
      // entirely), 1.3in away from the 0.6in default -- well past the boundary in the other
      // direction.
      render(
        <DocumentSettingsDialog
          onChange={vi.fn()}
          onClose={vi.fn()}
          settings={settings({ characterIndentIn: 3.7, parentheticalIndentIn: 4.4 })}
        />,
      );
      expect(screen.getByRole('status')).toHaveTextContent(/drifted more than half an inch/i);
    });

    it('still accepts the value while warning -- a warning, not a block', () => {
      const onChange = vi.fn();
      render(
        <DocumentSettingsDialog
          onChange={onChange}
          onClose={vi.fn()}
          settings={settings({ characterIndentIn: 3.7, parentheticalIndentIn: 3.2 })}
        />,
      );

      fireEvent.change(
        screen.getByRole('spinbutton', { name: 'Parenthetical indent, in inches' }),
        { target: { value: '4.4' } },
      );

      // The new (warning-triggering) value is reported unchanged, not clamped or rejected.
      expect(onChange).toHaveBeenCalledWith({
        ...DEFAULT_DOCUMENT_SETTINGS,
        characterIndentIn: 3.7,
        parentheticalIndentIn: 4.4,
      });
    });
  });

  describe('keyboard operation', () => {
    it('closes on Escape', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<DocumentSettingsDialog onChange={vi.fn()} onClose={onClose} settings={settings()} />);

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('closes on Escape from the Close button too, not only while an input has focus', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<DocumentSettingsDialog onChange={vi.fn()} onClose={onClose} settings={settings()} />);

      screen.getByRole('button', { name: 'Close' }).focus();
      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('moves initial focus into the dialog on mount', () => {
      render(<DocumentSettingsDialog onChange={vi.fn()} onClose={vi.fn()} settings={settings()} />);

      expect(screen.getByRole('spinbutton', { name: 'Character indent, in inches' })).toHaveFocus();
    });

    it('wraps Tab from the last focusable control back to the first, keeping focus inside the dialog', () => {
      render(<DocumentSettingsDialog onChange={vi.fn()} onClose={vi.fn()} settings={settings()} />);

      const first = screen.getByRole('spinbutton', { name: 'Character indent, in inches' });
      const last = screen.getByRole('button', { name: 'Close' });
      last.focus();

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });

      expect(first).toHaveFocus();
    });

    it('wraps Shift+Tab from the first focusable control back to the last', () => {
      render(<DocumentSettingsDialog onChange={vi.fn()} onClose={vi.fn()} settings={settings()} />);

      const first = screen.getByRole('spinbutton', { name: 'Character indent, in inches' });
      const last = screen.getByRole('button', { name: 'Close' });
      first.focus();

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });

      expect(last).toHaveFocus();
    });
  });

  it('closes via the Close button', () => {
    const onClose = vi.fn();
    render(<DocumentSettingsDialog onChange={vi.fn()} onClose={onClose} settings={settings()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
