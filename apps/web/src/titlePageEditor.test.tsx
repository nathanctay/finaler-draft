import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TitlePageView } from './titlePageEditor.js';
import type { TitlePageState } from './titlePageState.js';

const id = '00000000-0000-4000-8000-000000000001';

function emptyState(): TitlePageState {
  return { id, title: '', credit: '', source: '', draftDate: '', authors: [], contact: [] };
}

function populatedState(): TitlePageState {
  return {
    id,
    title: 'THE LAST STOP',
    credit: 'written by',
    source: '',
    draftDate: '',
    authors: ['Morgan Vale'],
    contact: ['morgan@example.test'],
  };
}

/**
 * `TitlePageField` is a `contentEditable` `div`, not an `<input>` (see its own doc comment for
 * why the placeholder convention requires that). jsdom does not implement native contentEditable
 * text insertion the way a real browser does, so a keystroke-level `userEvent.type()` would not
 * change `textContent` here -- setting it directly and firing the same `input` event the real DOM
 * fires on every edit is the standard, documented workaround, and it exercises the exact handler
 * (`onInput`) production code runs.
 */
function typeInto(field: HTMLElement, text: string): void {
  field.textContent = text;
  fireEvent.input(field);
}

describe('TitlePageView', () => {
  it('renders every field, keyed for identification by data-title-page-field', () => {
    render(<TitlePageView onChange={vi.fn()} state={populatedState()} />);

    expect(screen.getByRole('textbox', { name: 'Title page: title' })).toHaveTextContent(
      'THE LAST STOP',
    );
    expect(screen.getByRole('textbox', { name: 'Title page: written by' })).toHaveTextContent(
      'written by',
    );
    expect(screen.getByRole('textbox', { name: 'Title page: author line 1' })).toHaveTextContent(
      'Morgan Vale',
    );
    expect(screen.getByRole('textbox', { name: 'Title page: contact line 1' })).toHaveTextContent(
      'morgan@example.test',
    );
    expect(screen.getByRole('textbox', { name: 'Title page: based on' })).toHaveTextContent('');
    expect(screen.getByRole('textbox', { name: 'Title page: draft date' })).toHaveTextContent('');
  });

  it('reports an edited title back through onChange without touching any other field', () => {
    const onChange = vi.fn();
    render(<TitlePageView onChange={onChange} state={populatedState()} />);

    typeInto(screen.getByRole('textbox', { name: 'Title page: title' }), 'THE LONGER STOP');

    expect(onChange).toHaveBeenCalledWith({ ...populatedState(), title: 'THE LONGER STOP' });
  });

  it('reports an edited credit line back through onChange', () => {
    const onChange = vi.fn();
    render(<TitlePageView onChange={onChange} state={populatedState()} />);

    typeInto(screen.getByRole('textbox', { name: 'Title page: written by' }), 'story by');

    expect(onChange).toHaveBeenCalledWith({ ...populatedState(), credit: 'story by' });
  });

  it('suppresses Enter inside a single-line field rather than inserting a literal newline', () => {
    render(<TitlePageView onChange={vi.fn()} state={populatedState()} />);

    const event = fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title page: title' }), {
      key: 'Enter',
    });

    // fireEvent.keyDown's return value is `!defaultPrevented` -- `false` here proves the
    // component's own keydown handler called `preventDefault()`.
    expect(event).toBe(false);
  });

  it('adds a blank author line and focuses it as an ordinary editable, deletable block', () => {
    const onChange = vi.fn();
    render(<TitlePageView onChange={onChange} state={emptyState()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add author line' }));

    expect(onChange).toHaveBeenCalledWith({ ...emptyState(), authors: [''] });
  });

  it('reports an edited author line back through onChange, leaving the other lines untouched', () => {
    const onChange = vi.fn();
    const state = { ...emptyState(), authors: ['Morgan Vale', 'Iris Kwan'] };
    render(<TitlePageView onChange={onChange} state={state} />);

    typeInto(screen.getByRole('textbox', { name: 'Title page: author line 2' }), 'I. Kwan');

    expect(onChange).toHaveBeenCalledWith({ ...state, authors: ['Morgan Vale', 'I. Kwan'] });
  });

  it('removes an author line by its own remove control, not any other line', () => {
    const onChange = vi.fn();
    const state = { ...emptyState(), authors: ['Morgan Vale', 'Iris Kwan'] };
    render(<TitlePageView onChange={onChange} state={state} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove author line 1' }));

    expect(onChange).toHaveBeenCalledWith({ ...state, authors: ['Iris Kwan'] });
  });

  it('keeps the author and contact lists independent of each other', () => {
    const onChange = vi.fn();
    const state = { ...emptyState(), authors: ['Morgan Vale'], contact: ['morgan@example.test'] };
    render(<TitlePageView onChange={onChange} state={state} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add contact line' }));

    expect(onChange).toHaveBeenCalledWith({
      ...state,
      contact: ['morgan@example.test', ''],
    });
  });

  describe('readOnly', () => {
    it('drops contentEditable from every field, not merely leaving it non-functional', () => {
      render(<TitlePageView onChange={vi.fn()} readOnly state={populatedState()} />);

      expect(screen.getByRole('textbox', { name: 'Title page: title' })).not.toHaveAttribute(
        'contenteditable',
        'true',
      );
      expect(
        screen.getByRole('textbox', { name: 'Title page: author line 1' }),
      ).not.toHaveAttribute('contenteditable', 'true');
    });

    it('ignores an input event a real browser could still fire on a readOnly field', () => {
      // Belt and braces: `contentEditable={false}` (above) is what actually stops a writer's own
      // keystrokes, but `onInput` is also dropped entirely -- this proves the handler itself, not
      // only the DOM attribute, refuses to report a change while read-only.
      const onChange = vi.fn();
      render(<TitlePageView onChange={onChange} readOnly state={populatedState()} />);

      typeInto(screen.getByRole('textbox', { name: 'Title page: title' }), 'Should not land');

      expect(onChange).not.toHaveBeenCalled();
    });

    it('hides the add/remove line controls -- the one mutation surface with no contentEditable layer to gate it', () => {
      const state = { ...emptyState(), authors: ['Morgan Vale'] };
      render(<TitlePageView onChange={vi.fn()} readOnly state={state} />);

      expect(screen.queryByRole('button', { name: 'Add author line' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add contact line' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Remove author line 1' }),
      ).not.toBeInTheDocument();
      // The line itself stays fully visible -- read-only, not hidden.
      expect(screen.getByRole('textbox', { name: 'Title page: author line 1' })).toHaveTextContent(
        'Morgan Vale',
      );
    });
  });
});
