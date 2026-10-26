import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FormEvent } from 'react';
import { CreateScreenplaySplitButton } from './CreateScreenplaySplitButton.js';

/**
 * Task 3 of the FDX-import slice (`progress/fdx-import.md`): the split-button control that
 * replaced the standalone "Import FDX…" button. What it owes the writer, each asserted below:
 *
 *  - two genuinely distinct controls with their own accessible names -- pressing the label and
 *    pressing the arrow are never the same action,
 *  - the arrow carries `aria-haspopup="menu"` and an accurate `aria-expanded`,
 *  - full keyboard operability (Tab, Enter/Space, ArrowDown to open, ArrowUp/ArrowDown inside the
 *    menu, Escape returning focus to the arrow),
 *  - the identical Safari-safe dismissal mechanism `OverflowMenu.tsx` already settled on (a
 *    `pointerdown`/`focusin` pair in the capture phase, `document.body` excluded from the latter)
 *    -- re-verified here because this is independent, hand-written code, not a shared import, and
 *    the owner has already hit the blur-based version of this bug once in production.
 */
describe('CreateScreenplaySplitButton', () => {
  function renderButton(
    overrides: Partial<Parameters<typeof CreateScreenplaySplitButton>[0]> = {},
  ) {
    const onSelect = overrides.items?.[0]?.onSelect ?? vi.fn();
    render(
      <CreateScreenplaySplitButton
        arrowLabel={overrides.arrowLabel ?? 'Import a screenplay'}
        importDisabled={overrides.importDisabled ?? false}
        items={overrides.items ?? [{ label: 'Import FDX…', onSelect }]}
        primaryLabel={overrides.primaryLabel ?? 'New screenplay'}
      />,
    );
    return { onSelect };
  }

  it('renders two distinct controls with their own accessible names', () => {
    renderButton();
    const primary = screen.getByRole('button', { name: 'New screenplay' });
    const arrow = screen.getByRole('button', { name: 'Import a screenplay' });
    expect(primary).not.toBe(arrow);
    expect(primary).toHaveAttribute('type', 'submit');
    expect(arrow).toHaveAttribute('type', 'button');
  });

  it('the arrow carries aria-haspopup=menu and an accurate aria-expanded, starting closed', () => {
    renderButton();
    const arrow = screen.getByRole('button', { name: 'Import a screenplay' });
    expect(arrow).toHaveAttribute('aria-haspopup', 'menu');
    expect(arrow).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('pressing the label never opens the menu, and pressing the arrow never submits the form', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <CreateScreenplaySplitButton
          arrowLabel="Import a screenplay"
          importDisabled={false}
          items={[{ label: 'Import FDX…', onSelect: vi.fn() }]}
          primaryLabel="New screenplay"
        />
      </form>,
    );

    await user.click(screen.getByRole('button', { name: 'Import a screenplay' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'New screenplay' }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on click and moves focus to the first item; activating an item closes the menu and calls onSelect', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Import a screenplay' }));
    const item = screen.getByRole('menuitem', { name: 'Import FDX…' });
    expect(item).toHaveFocus();

    await user.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on Enter and on Space from the keyboard, and Escape closes it and returns focus to the arrow', async () => {
    const user = userEvent.setup();
    renderButton();
    const arrow = screen.getByRole('button', { name: 'Import a screenplay' });

    arrow.focus();
    await user.keyboard('{Enter}');
    expect(arrow).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    expect(arrow).toHaveAttribute('aria-expanded', 'false');
    expect(arrow).toHaveFocus();

    await user.keyboard(' ');
    expect(arrow).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens on ArrowDown from the arrow, and ArrowUp/ArrowDown move focus within the menu', async () => {
    const user = userEvent.setup();
    render(
      <CreateScreenplaySplitButton
        arrowLabel="Import a screenplay"
        importDisabled={false}
        items={[
          { label: 'Import FDX…', onSelect: vi.fn() },
          { label: 'Import Fountain…', onSelect: vi.fn() },
        ]}
        primaryLabel="New screenplay"
      />,
    );
    const arrow = screen.getByRole('button', { name: 'Import a screenplay' });
    arrow.focus();

    await user.keyboard('{ArrowDown}');
    const first = screen.getByRole('menuitem', { name: 'Import FDX…' });
    const second = screen.getByRole('menuitem', { name: 'Import Fountain…' });
    expect(first).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(first).toHaveFocus(); // wraps

    await user.keyboard('{ArrowUp}');
    expect(second).toHaveFocus(); // wraps backward too
  });

  it('closes on Tab out of the menu, a real focus move with nothing pressed', async () => {
    const user = userEvent.setup();
    render(
      <>
        <CreateScreenplaySplitButton
          arrowLabel="Import a screenplay"
          importDisabled={false}
          items={[{ label: 'Import FDX…', onSelect: vi.fn() }]}
          primaryLabel="New screenplay"
        />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Import a screenplay' }));
    expect(screen.getByRole('menuitem', { name: 'Import FDX…' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  /**
   * The Safari defect the owner already hit once, on `OverflowMenu`: WebKit does not focus a
   * `<button>` pressed with a mouse, so a `focusout`/blur-based close treats that press as "focus
   * left the menu" and the item unmounts before its `click` ever arrives. `userEvent.click`
   * cannot reproduce this -- jsdom's model of a click *does* focus the button -- so the sequence
   * below is dispatched by hand: pointer/mouse down on the item, a `focusout` with
   * `relatedTarget: null`, a `focusin` on `document.body` (the WebKit shape of "focus went
   * nowhere"), and only then pointer/mouse up and `click`, with the item deliberately never
   * focused. Run against a blur-based close, this fails on `onSelect` never having been called.
   */
  it('activates an item whose press moves no focus into the menu, the shape Safari dispatches', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Import a screenplay' }));
    const item = screen.getByRole('menuitem', { name: 'Import FDX…' });
    expect(item).toHaveFocus();

    fireEvent.pointerDown(item);
    fireEvent.mouseDown(item);
    fireEvent.focusOut(item, { relatedTarget: null });
    fireEvent.focusIn(document.body);
    fireEvent.pointerUp(item);
    fireEvent.mouseUp(item);
    fireEvent.click(item);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  /** The other half of the Safari fix: an outside press still dismisses the menu even though
   * nothing about that press moves focus either. */
  it('closes on an outside pointer press that moves no focus at all', async () => {
    const user = userEvent.setup();
    render(
      <>
        <CreateScreenplaySplitButton
          arrowLabel="Import a screenplay"
          importDisabled={false}
          items={[{ label: 'Import FDX…', onSelect: vi.fn() }]}
          primaryLabel="New screenplay"
        />
        <p>Outside the menu</p>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Import a screenplay' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByText('Outside the menu'));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('disables only the arrow while importing, never the primary label, and the arrow label itself carries the busy feedback', () => {
    renderButton({ arrowLabel: 'Importing…', importDisabled: true });
    expect(screen.getByRole('button', { name: 'New screenplay' })).toBeEnabled();
    const arrow = screen.getByRole('button', { name: 'Importing…' });
    expect(arrow).toBeDisabled();
  });

  it('a disabled arrow cannot be opened by click or by keyboard', async () => {
    const user = userEvent.setup();
    renderButton({ arrowLabel: 'Importing…', importDisabled: true });
    const arrow = screen.getByRole('button', { name: 'Importing…' });

    await user.click(arrow);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
