import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FdxUnknownType } from '@finaler-draft/fdx';
import { FdxUnknownTypesDialog } from './fdxUnknownTypesDialog.js';

/**
 * Task 2 of the FDX-import slice (`progress/fdx-import.md`): the modal that names every FDX
 * paragraph type this product does not recognize and lets the writer resolve each one -- skip it,
 * or map it to a canonical element type -- rather than the import simply failing. What this owes
 * the writer, each asserted below:
 *
 *  - every distinct unrecognised type, with its occurrence count and an excerpt, so the writer can
 *    tell what the content actually is without opening the original file,
 *  - a decision control *per type*, not per paragraph,
 *  - a Continue button that cannot be pressed -- and is not even reachable by Tab, since it is a
 *    real `disabled` control -- until every listed type has a decision,
 *  - exactly one call to `onResolve`, with a complete resolutions map, once that holds,
 *  - and the same modal-shell contract (initial focus, Escape, Tab trap) every other dialog in
 *    this app keeps.
 */
function renderDialog(overrides: Partial<Parameters<typeof FdxUnknownTypesDialog>[0]> = {}): {
  onCancel: ReturnType<typeof vi.fn>;
  onResolve: ReturnType<typeof vi.fn>;
} {
  const onCancel = overrides.onCancel ?? vi.fn();
  const onResolve = overrides.onResolve ?? vi.fn();
  const unknownTypes: readonly FdxUnknownType[] = overrides.unknownTypes ?? [
    { type: 'Weird Type One', count: 3, excerpt: 'First weird line.' },
    { type: 'Weird Type Two', count: 1, excerpt: 'Second kind of line.' },
  ];
  render(
    <FdxUnknownTypesDialog
      filename={overrides.filename ?? 'Driskill Hotel.fdx'}
      onCancel={onCancel as () => void}
      onResolve={onResolve as () => void}
      unknownTypes={unknownTypes}
    />,
  );
  return {
    onCancel: onCancel as ReturnType<typeof vi.fn>,
    onResolve: onResolve as ReturnType<typeof vi.fn>,
  };
}

describe('FdxUnknownTypesDialog', () => {
  it('names the file and every distinct unrecognised type with its count', () => {
    renderDialog();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Driskill Hotel.fdx');
    expect(screen.getByText('Weird Type One')).toBeVisible();
    expect(screen.getByText(/3\s*occurrences/u)).toBeVisible();
    expect(screen.getByText('Weird Type Two')).toBeVisible();
    expect(screen.getByText(/1\s*occurrence\b/u)).toBeVisible();
  });

  it("shows an excerpt of each type's first instance", () => {
    renderDialog();
    expect(screen.getByText(/First weird line\./u)).toBeVisible();
    expect(screen.getByText(/Second kind of line\./u)).toBeVisible();
  });

  it('shows no excerpt line for a type whose first instance had no text', () => {
    renderDialog({ unknownTypes: [{ type: 'Weird Empty', count: 1, excerpt: '' }] });
    expect(screen.getByText('Weird Empty')).toBeVisible();
    expect(document.querySelector('.fdx-unknown-type-excerpt')).not.toBeInTheDocument();
  });

  it('offers a select per type, with Skip and every canonical element type as options', () => {
    renderDialog();
    const select = screen.getByLabelText('Action for "Weird Type One"');
    const optionLabels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionLabels).toEqual([
      'Choose…',
      'Skip (leave out of the import)',
      'Map to Action',
      'Map to Scene heading',
      'Map to Character',
      'Map to Dialogue',
      'Map to Parenthetical',
      'Map to Transition',
      'Map to Shot',
    ]);
  });

  it('keeps Continue disabled until every listed type has a decision, then enables it', async () => {
    const user = userEvent.setup();
    renderDialog();
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Action for "Weird Type One"'), 'skip');
    expect(continueButton).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Action for "Weird Type Two"'), 'map:dialogue');
    expect(continueButton).toBeEnabled();
  });

  it('reverting a decision back to "Choose…" disables Continue again', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.selectOptions(screen.getByLabelText('Action for "Weird Type One"'), 'skip');
    await user.selectOptions(screen.getByLabelText('Action for "Weird Type Two"'), 'map:dialogue');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    await user.selectOptions(screen.getByLabelText('Action for "Weird Type One"'), '');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('calls onResolve exactly once with a complete, correctly-shaped resolutions map', async () => {
    const user = userEvent.setup();
    const { onCancel, onResolve } = renderDialog();
    await user.selectOptions(screen.getByLabelText('Action for "Weird Type One"'), 'skip');
    await user.selectOptions(
      screen.getByLabelText('Action for "Weird Type Two"'),
      'map:scene_heading',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({
      'Weird Type One': { action: 'skip' },
      'Weird Type Two': { action: 'map', blockType: 'scene_heading' },
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog on open, so a keyboard can reach it at all', () => {
    renderDialog();
    expect(screen.getByLabelText('Action for "Weird Type One"')).toHaveFocus();
  });

  it('cancels on Escape without ever calling onResolve', async () => {
    const user = userEvent.setup();
    const { onCancel, onResolve } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('traps Tab inside the dialog in both directions, skipping the disabled Continue button', async () => {
    const user = userEvent.setup();
    renderDialog();
    const firstSelect = screen.getByLabelText('Action for "Weird Type One"');
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    // Continue starts real-`disabled`, so the last *reachable* control is Cancel, not Continue --
    // forward Tab from Cancel wraps to the first select.
    cancel.focus();
    await user.tab();
    expect(firstSelect).toHaveFocus();

    // And backward from the first select wraps to Cancel.
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });
});
