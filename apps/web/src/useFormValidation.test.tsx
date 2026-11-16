import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describedBy, useFormValidation } from './useFormValidation.js';

const titleSchema = z.string().trim().min(1, 'Enter a title.').max(5, 'At most 5 characters.');
const nameSchema = z.string().trim().min(1, 'Enter a name.');

describe('useFormValidation', () => {
  it('computes an error from the current value without requiring it to be shown', () => {
    const { result } = renderHook(() => useFormValidation({ title: titleSchema }, { title: '' }));
    expect(result.current.fields.title.error).toBe('Enter a title.');
    // Not yet touched and no submit attempted -- the error exists but is not shown, matching the
    // "on blur, or on submit" timing this hook's own top comment documents.
    expect(result.current.fields.title.showError).toBe(false);
    expect(result.current.fields.title.inputProps['aria-invalid']).toBe(false);
    expect(result.current.fields.title.inputProps['aria-describedby']).toBeUndefined();
  });

  it('reveals the error once the field has been edited and then marked touched via its onBlur', () => {
    const { rerender, result } = renderHook(
      ({ value }) => useFormValidation({ title: titleSchema }, { title: value }),
      { initialProps: { value: 'Draft One' } },
    );
    // A value change is required before blur reveals anything -- see the hook's own "Blur alone
    // is not enough" comment. Starting at a non-blank value and editing down to blank reproduces
    // "the writer cleared a real title and tabbed away," not "a blur nothing changed caused."
    rerender({ value: '' });
    act(() => result.current.fields.title.inputProps.onBlur());
    rerender({ value: '' });
    expect(result.current.fields.title.showError).toBe(true);
    expect(result.current.fields.title.inputProps['aria-invalid']).toBe(true);
    expect(result.current.fields.title.inputProps['aria-describedby']).toBe(
      result.current.fields.title.errorProps.id,
    );
  });

  it('does not reveal an error on blur alone, with no edit ever having happened', () => {
    // The regression this guards: a dialog that autofocuses its first field on mount
    // (`sharingDialog.tsx`) blurs that field the instant the writer clicks anything else in the
    // dialog, with no edit ever having occurred. That must not reveal a message about a field the
    // writer has not interacted with.
    const { rerender, result } = renderHook(
      ({ value }) => useFormValidation({ title: titleSchema }, { title: value }),
      { initialProps: { value: '' } },
    );
    act(() => result.current.fields.title.inputProps.onBlur());
    rerender({ value: '' });
    expect(result.current.fields.title.showError).toBe(false);
  });

  it('clears the shown error the instant the value becomes valid, with no separate reset step', () => {
    const { rerender, result } = renderHook(
      ({ value }) => useFormValidation({ title: titleSchema }, { title: value }),
      { initialProps: { value: 'Draft One' } },
    );
    rerender({ value: '' });
    act(() => result.current.fields.title.inputProps.onBlur());
    rerender({ value: '' });
    expect(result.current.fields.title.showError).toBe(true);

    rerender({ value: 'Draft' });
    expect(result.current.fields.title.error).toBeUndefined();
    expect(result.current.fields.title.showError).toBe(false);
  });

  it('treats a whitespace-only value the same as blank, matching the schema it is given', () => {
    const { result } = renderHook(() =>
      useFormValidation({ title: titleSchema }, { title: '   ' }),
    );
    expect(result.current.fields.title.error).toBe('Enter a title.');
  });

  it('rejects a value past the schema max, with that schema’s own message', () => {
    const { result } = renderHook(() =>
      useFormValidation({ title: titleSchema }, { title: 'x'.repeat(6) }),
    );
    expect(result.current.fields.title.error).toBe('At most 5 characters.');
  });

  it('validateOnSubmit marks every field as submitted, revealing every invalid one at once', () => {
    const { result } = renderHook(() =>
      useFormValidation({ name: nameSchema, title: titleSchema }, { name: '', title: '' }),
    );
    let valid = true;
    act(() => {
      valid = result.current.validateOnSubmit();
    });
    expect(valid).toBe(false);
    expect(result.current.fields.title.showError).toBe(true);
    expect(result.current.fields.name.showError).toBe(true);
  });

  it('validateOnSubmit returns true, with nothing shown, once every field is valid', () => {
    const { result } = renderHook(() =>
      useFormValidation(
        { name: nameSchema, title: titleSchema },
        { name: 'Writer', title: 'Draft' },
      ),
    );
    let valid = false;
    act(() => {
      valid = result.current.validateOnSubmit();
    });
    expect(valid).toBe(true);
    expect(result.current.fields.title.showError).toBe(false);
    expect(result.current.fields.name.showError).toBe(false);
  });

  it('reset clears touched and submitted state back to showing nothing', () => {
    const { result } = renderHook(() => useFormValidation({ title: titleSchema }, { title: '' }));
    act(() => {
      result.current.validateOnSubmit();
    });
    expect(result.current.fields.title.showError).toBe(true);

    act(() => result.current.reset());
    expect(result.current.fields.title.showError).toBe(false);
  });

  it('does not require hooks to run in a fixed loop: a field set that differs between renders is fine', () => {
    // `routes/sign-in.tsx` has four field keys in sign-up mode and two in sign-in mode on the same
    // mounted component. This is not calling a hook conditionally -- `useFormValidation` itself is
    // always called -- it is this hook internally handling a `schemas` object whose own key set
    // varies, which is the scenario this test proves does not throw or desync.
    const { rerender, result } = renderHook(
      ({ withName }: { withName: boolean }) =>
        withName
          ? useFormValidation(
              { name: nameSchema, title: titleSchema },
              { name: '', title: 'Draft' },
            )
          : useFormValidation({ title: titleSchema }, { title: 'Draft' }),
      { initialProps: { withName: false } },
    );
    expect(Object.keys(result.current.fields)).toEqual(['title']);
    rerender({ withName: true });
    expect(Object.keys(result.current.fields)).toEqual(['name', 'title']);
  });

  /**
   * Focus-on-invalid-submit needs a real, rendered DOM element behind the `ref` callback, which
   * `renderHook` alone has no node for -- hence a small real component here, rather than stretching
   * the pure-hook tests above to cover it.
   */
  function FocusProbe() {
    const { fields, validateOnSubmit } = useFormValidation(
      { name: nameSchema, title: titleSchema },
      { name: '', title: '' },
    );
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          validateOnSubmit();
        }}
      >
        <input aria-label="Name" {...fields.name.inputProps} />
        <input aria-label="Title" {...fields.title.inputProps} />
        <button type="submit">Submit</button>
      </form>
    );
  }

  it('focuses the first invalid field, in schema-declaration order, on a failed submit', () => {
    render(<FocusProbe />);
    fireEvent.submit(screen.getByRole('button', { name: 'Submit' }).closest('form')!);
    // "name" is declared before "title" in FocusProbe's schemas object, and both are blank, so
    // name -- not title -- must be the one that ends up focused.
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  describe('describedBy', () => {
    it('joins present ids with a space', () => {
      expect(describedBy('hint', 'error')).toBe('hint error');
    });

    it('omits an absent id rather than leaving a gap', () => {
      expect(describedBy('hint', undefined)).toBe('hint');
      expect(describedBy(undefined, 'error')).toBe('error');
    });

    it('returns undefined, never an empty string, when nothing is present', () => {
      expect(describedBy(undefined, undefined)).toBeUndefined();
    });
  });
});
