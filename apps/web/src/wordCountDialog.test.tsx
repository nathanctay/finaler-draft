import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WordCountDialog, type WordCountStat } from './wordCountDialog.js';

const noSelection: WordCountStat = { documentTotal: 345, selection: undefined };
const withSelection: WordCountStat = { documentTotal: 345, selection: 12 };

describe('WordCountDialog', () => {
  it('reports the document totals alone when neither stat has a selection', () => {
    render(
      <WordCountDialog
        characters={{ documentTotal: 1820, selection: undefined }}
        onClose={vi.fn()}
        pages={3}
        words={noSelection}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Word count' });
    expect(dialog).toBeVisible();
    expect(screen.getByText('345')).toBeInTheDocument();
    expect(screen.getByText('1820')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // Docs-style "N of M" must not appear at all with nothing selected.
    expect(screen.queryByText(/of/)).not.toBeInTheDocument();
  });

  /** Docs' own convention: "Words: 12 of 345" while a selection is active. Pages has no
   * selection-aware reading at all (plan.md records no such thing as "pages in a selection"), so
   * it stays the one plain document-wide number regardless of whether the other two stats are
   * reporting a selection. */
  it('reports "selection of document" for words and characters while a selection is active, leaving pages alone', () => {
    render(
      <WordCountDialog
        characters={{ documentTotal: 1820, selection: 60 }}
        onClose={vi.fn()}
        pages={3}
        words={withSelection}
      />,
    );

    expect(screen.getByText('12 of 345')).toBeInTheDocument();
    expect(screen.getByText('60 of 1820')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('reports a selection’s own zero distinctly from "no selection" when the stat says so', () => {
    // A real, present-but-empty-looking selection is never what feeds this component --
    // `App.tsx`'s own `hasSelection` gate keeps that case out, so `selection: 0` here is only
    // ever reachable through a genuinely zero-word/zero-character non-empty selection (e.g. a
    // highlighted run of only whitespace). It must still render as "0 of N", not fall back to
    // the no-selection rendering the way a falsy check (`selection ||`) would.
    render(
      <WordCountDialog
        characters={{ documentTotal: 1820, selection: 0 }}
        onClose={vi.fn()}
        pages={3}
        words={{ documentTotal: 345, selection: 0 }}
      />,
    );

    expect(screen.getByText('0 of 345')).toBeInTheDocument();
    expect(screen.getByText('0 of 1820')).toBeInTheDocument();
  });

  it('closes on Escape and on the Close button, both via onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <WordCountDialog
        characters={{ documentTotal: 1820, selection: undefined }}
        onClose={onClose}
        pages={3}
        words={noSelection}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(
      <WordCountDialog
        characters={{ documentTotal: 1820, selection: undefined }}
        onClose={onClose}
        pages={3}
        words={noSelection}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focuses the Close button on mount, so Escape and Tab both work with no prior click', () => {
    render(
      <WordCountDialog
        characters={{ documentTotal: 1820, selection: undefined }}
        onClose={vi.fn()}
        pages={3}
        words={noSelection}
      />,
    );

    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  /**
   * Close is this dialog's only focusable control, so "wraps from the last back to the first" and
   * "wraps Shift+Tab from the first back to the last" are the same control wrapping to itself --
   * unlike `DocumentSettingsDialog`, which has an input ahead of its own Close button to wrap
   * between. What still needs proving is that both of `handleKeyDown`'s Tab branches (plain Tab
   * off the last control, Shift+Tab off the first) actually run and keep focus inside the dialog,
   * rather than falling through to the browser's own default Tab handling, which `event
   * .preventDefault()` is what stops.
   */
  it('wraps Tab from (and Shift+Tab back to) the one focusable control, keeping focus inside the dialog', () => {
    render(
      <WordCountDialog
        characters={{ documentTotal: 1820, selection: undefined }}
        onClose={vi.fn()}
        pages={3}
        words={noSelection}
      />,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
  });

  it('ignores a key other than Escape/Tab entirely', () => {
    const onClose = vi.fn();
    render(
      <WordCountDialog
        characters={{ documentTotal: 1820, selection: undefined }}
        onClose={onClose}
        pages={3}
        words={noSelection}
      />,
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' });

    expect(onClose).not.toHaveBeenCalled();
  });
});
