import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationMenubar } from './applicationMenubar.js';

/** The five menus plan.md still has to activate. Written out here rather than imported from the
 * component: the module exports components only (a Fast Refresh requirement the lint config enforces),
 * and a test that restates the expected labels is in any case a better check than one that compares the
 * implementation to itself. */
const INERT_MENU_LABELS = ['Edit', 'View', 'Format', 'Tools', 'Help'] as const;

/**
 * The menu bar, now one component rendered by the editor and by the read-only revision comparison
 * both. What matters here is the same pair of properties the toolbar's tests check: the whole bar is
 * present on either screen, and an item that cannot act is really disabled -- a native `disabled`
 * `<button>` carrying its reason, never an enabled-looking item whose handler quietly declines.
 */
function menubar(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Application menu' });
}

async function openFileMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'File menu' }));
  return screen.getByRole('menu');
}

describe('application menubar', () => {
  it('renders the File menu, the five labels still to come, and the canvas toggle', () => {
    render(
      <ApplicationMenubar
        canvasToggle={{ dark: false, onToggle: vi.fn() }}
        fileMenuItems={[{ label: 'Only item', onSelect: vi.fn() }]}
      />,
    );

    expect(within(menubar()).getByRole('button', { name: 'File menu' })).toBeInTheDocument();
    for (const label of INERT_MENU_LABELS) {
      expect(within(menubar()).getByText(label)).toBeInTheDocument();
    }
    expect(within(menubar()).getByRole('button', { name: 'Dark canvas' })).toBeInTheDocument();
  });

  /** The five are labels, not controls: plan.md schedules activating them later, and until then a
   * `<span>` is the honest rendering -- nothing announces them as operable, so there is no disabled
   * state for them to get wrong. */
  it('leaves the five still-to-come menus as inert labels rather than controls', () => {
    render(
      <ApplicationMenubar
        canvasToggle={{ dark: false, onToggle: vi.fn() }}
        fileMenuItems={[{ label: 'Only item', onSelect: vi.fn() }]}
      />,
    );

    for (const label of INERT_MENU_LABELS) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
      expect(within(menubar()).getByText(label).tagName).toBe('SPAN');
    }
  });

  it('names the canvas toggle for the state it moves to, and reports the click', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <ApplicationMenubar
        canvasToggle={{ dark: false, onToggle }}
        fileMenuItems={[{ label: 'Only item', onSelect: vi.fn() }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Dark canvas' }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <ApplicationMenubar
        canvasToggle={{ dark: true, onToggle }}
        fileMenuItems={[{ label: 'Only item', onSelect: vi.fn() }]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Light canvas' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dark canvas' })).toBeNull();
  });

  it('renders the caller’s File items in order and fires the chosen one', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ApplicationMenubar
        canvasToggle={{ dark: false, onToggle: vi.fn() }}
        fileMenuItems={[
          { label: 'First…', onSelect },
          { label: 'Second…', onSelect: vi.fn() },
        ]}
      />,
    );

    const menu = await openFileMenu(user);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['First…', 'Second…']);

    await user.click(within(menu).getByRole('menuitem', { name: 'First…' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  /**
   * The comparison's File menu is mostly this shape: present, named, really disabled, and saying why.
   *
   * The spy is attached to the disabled item deliberately, even though the comparison route itself
   * omits `onSelect` on its disabled items (see `OverflowMenuItem.onSelect`'s own comment): a handler
   * that is never called is the only way to demonstrate that `disabled` -- and not a convention nobody
   * enforces -- is what makes the item unreachable. Swap the real attribute for `aria-disabled` plus a
   * class and this spy fires.
   */
  it('renders a disabled item as a really-disabled control carrying its reason, and never invokes it', async () => {
    const user = userEvent.setup();
    const neverCalled = vi.fn();
    render(
      <ApplicationMenubar
        canvasToggle={{ dark: false, onToggle: vi.fn() }}
        fileMenuItems={[
          {
            disabled: true,
            disabledReason: 'Nothing here to save.',
            label: 'Save…',
            onSelect: neverCalled,
          },
          { label: 'Go…', onSelect: vi.fn() },
        ]}
      />,
    );

    const menu = await openFileMenu(user);
    const save = within(menu).getByRole('menuitem', { name: 'Save…' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Nothing here to save.');

    await user.click(save);
    expect(neverCalled).not.toHaveBeenCalled();
  });

  /** A permanently disabled item legitimately carries no handler at all. Choosing it must stay a
   * no-op rather than a `TypeError`, which is what `OverflowMenu`'s optional call guarantees. */
  it('tolerates a disabled item with no handler at all', async () => {
    const user = userEvent.setup();
    render(
      <ApplicationMenubar
        canvasToggle={{ dark: false, onToggle: vi.fn() }}
        fileMenuItems={[{ disabled: true, disabledReason: 'No.', label: 'Save…' }]}
      />,
    );

    const menu = await openFileMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Save…' }));
    expect(within(menu).getByRole('menuitem', { name: 'Save…' })).toBeDisabled();
  });

  it('attaches the caller’s ref to the File menu wrapper, so focus can be returned to its trigger', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <ApplicationMenubar
        canvasToggle={{ dark: false, onToggle: vi.fn() }}
        fileMenuItems={[{ label: 'Only item', onSelect: vi.fn() }]}
        fileMenuRef={ref}
      />,
    );

    expect(ref.current).toHaveClass('menu-file');
    expect(ref.current?.querySelector('.overflow-menu-trigger')).toBe(
      screen.getByRole('button', { name: 'File menu' }),
    );
  });
});
