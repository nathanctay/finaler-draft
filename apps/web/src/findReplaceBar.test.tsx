import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FindReplaceBar, type FindReplaceBarProps } from './findReplaceBar.js';

function baseProps(overrides: Partial<FindReplaceBarProps> = {}): FindReplaceBarProps {
  return {
    query: '',
    caseSensitive: false,
    matchCount: 0,
    currentMatchNumber: 0,
    editingAllowed: true,
    replaceDisabledReason: undefined,
    onQueryChange: vi.fn(),
    onCaseSensitiveChange: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onReplace: vi.fn(),
    onReplaceAll: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('FindReplaceBar', () => {
  it('focuses the query field on open, with no match count shown for an empty query', () => {
    render(<FindReplaceBar {...baseProps()} />);
    expect(screen.getByRole('textbox', { name: 'Find' })).toHaveFocus();
    expect(screen.queryByText(/of/)).not.toBeInTheDocument();
    expect(screen.queryByText('No matches')).not.toBeInTheDocument();
  });

  it('reports "No matches" for a non-empty query with nothing found, and "N of M" once something is', () => {
    const { rerender } = render(<FindReplaceBar {...baseProps({ query: 'xyz' })} />);
    expect(screen.getByText('No matches')).toBeInTheDocument();

    rerender(
      <FindReplaceBar {...baseProps({ query: 'xyz', matchCount: 5, currentMatchNumber: 3 })} />,
    );
    expect(screen.getByText('3 of 5')).toBeInTheDocument();
  });

  it('calls back on every keystroke in the query field and every case-sensitivity toggle', async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onCaseSensitiveChange = vi.fn();
    render(<FindReplaceBar {...baseProps({ onQueryChange, onCaseSensitiveChange })} />);

    // The input is controlled by `query`, which this test's mock never feeds back in, so each
    // keystroke's `onChange` reports against the still-empty field rather than accumulating --
    // what matters here is that every keystroke fires its own call with its own character, not
    // that this harness reproduces a real, re-rendering `App.tsx` keeping `value` in sync.
    await user.type(screen.getByRole('textbox', { name: 'Find' }), 'cat');
    expect(onQueryChange.mock.calls.map((call) => call[0])).toEqual(['c', 'a', 't']);

    await user.click(screen.getByRole('checkbox', { name: 'Case-sensitive' }));
    expect(onCaseSensitiveChange).toHaveBeenCalledWith(true);
  });

  it('disables previous/next with no matches, and calls onNext/onPrevious when there are some', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const { rerender } = render(
      <FindReplaceBar {...baseProps({ query: 'cat', onNext, onPrevious })} />,
    );
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();

    rerender(
      <FindReplaceBar
        {...baseProps({ query: 'cat', matchCount: 2, currentMatchNumber: 1, onNext, onPrevious })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('Enter advances to the next match; Shift+Enter retreats to the previous one', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    render(
      <FindReplaceBar
        {...baseProps({ query: 'cat', matchCount: 2, currentMatchNumber: 1, onNext, onPrevious })}
      />,
    );
    const field = screen.getByRole('textbox', { name: 'Find' });
    await user.type(field, '{Enter}');
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).not.toHaveBeenCalled();

    await user.type(field, '{Shift>}{Enter}{/Shift}');
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the bar', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<FindReplaceBar {...baseProps({ onClose })} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refocuses the query field on Mod-f rather than letting it reach the browser', () => {
    render(<FindReplaceBar {...baseProps()} />);
    const field = screen.getByRole('textbox', { name: 'Find' });
    field.blur();
    expect(field).not.toHaveFocus();

    const event = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    field.closest('[role="search"]')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(field).toHaveFocus();
  });

  it('disables Replace and Replace all, carrying the given reason, when editing is not allowed -- even with real matches', () => {
    render(
      <FindReplaceBar
        {...baseProps({
          query: 'cat',
          matchCount: 3,
          currentMatchNumber: 1,
          editingAllowed: false,
          replaceDisabledReason: 'Read-only for this test.',
        })}
      />,
    );
    const replace = screen.getByRole('button', { name: 'Replace' });
    const replaceAll = screen.getByRole('button', { name: 'Replace all' });
    expect(replace).toBeDisabled();
    expect(replaceAll).toBeDisabled();
    expect(replace).toHaveAttribute('title', 'Read-only for this test.');
    expect(replaceAll).toHaveAttribute('title', 'Read-only for this test.');
    // Find itself is unaffected: the query field is never disabled by `editingAllowed`.
    expect(screen.getByRole('textbox', { name: 'Find' })).toBeEnabled();
  });

  it('disables Replace and Replace all with no matches, even when editing is allowed', () => {
    render(<FindReplaceBar {...baseProps({ query: 'xyz', editingAllowed: true })} />);
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Replace all' })).toBeDisabled();
  });

  it('calls onReplace/onReplaceAll with the typed replacement text', async () => {
    const user = userEvent.setup();
    const onReplace = vi.fn();
    const onReplaceAll = vi.fn();
    render(
      <FindReplaceBar
        {...baseProps({
          query: 'cat',
          matchCount: 2,
          currentMatchNumber: 1,
          onReplace,
          onReplaceAll,
        })}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: 'Replace with' }), 'dog');
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    expect(onReplace).toHaveBeenCalledWith('dog');

    await user.click(screen.getByRole('button', { name: 'Replace all' }));
    expect(onReplaceAll).toHaveBeenCalledWith('dog');
  });

  it('closes via the × button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<FindReplaceBar {...baseProps({ onClose })} />);
    await user.click(screen.getByRole('button', { name: 'Close find and replace' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
