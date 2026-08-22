import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OverflowMenu } from './OverflowMenu.js';

describe('OverflowMenu', () => {
  it('carries a real per-instance accessible name and starts closed', () => {
    render(
      <OverflowMenu
        items={[{ label: 'Delete', onSelect: vi.fn() }]}
        label="Screenplay actions for Draft One"
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Screenplay actions for Draft One' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('two instances expose distinct accessible names, not one label repeated', () => {
    render(
      <>
        <OverflowMenu items={[]} label="Screenplay actions for Draft One" />
        <OverflowMenu items={[]} label="Screenplay actions for Draft Two" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Screenplay actions for Draft One' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Screenplay actions for Draft Two' })).toBeVisible();
  });

  it('opens on click, moves focus to the first item, and activating an item closes the menu and calls onSelect', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<OverflowMenu items={[{ label: 'Delete', onSelect }]} label="Screenplay actions" />);

    await user.click(screen.getByRole('button', { name: 'Screenplay actions' }));
    expect(screen.getByRole('button', { name: 'Screenplay actions' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const menuItem = screen.getByRole('menuitem', { name: 'Delete' });
    expect(menuItem).toHaveFocus();

    await user.click(menuItem);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on Enter and on Space from the keyboard, exercising native button activation', async () => {
    const user = userEvent.setup();
    render(<OverflowMenu items={[{ label: 'Delete', onSelect: vi.fn() }]} label="Row actions" />);
    const trigger = screen.getByRole('button', { name: 'Row actions' });

    trigger.focus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    trigger.focus();
    await user.keyboard(' ');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes on Escape and returns focus to the trigger, the specific behaviour the scope calls out', async () => {
    const user = userEvent.setup();
    render(<OverflowMenu items={[{ label: 'Delete', onSelect: vi.fn() }]} label="Row actions" />);
    const trigger = screen.getByRole('button', { name: 'Row actions' });

    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('moves focus between items with ArrowDown and ArrowUp, wrapping at each end', async () => {
    const user = userEvent.setup();
    render(
      <OverflowMenu
        items={[
          { label: 'First', onSelect: vi.fn() },
          { label: 'Second', onSelect: vi.fn() },
        ]}
        label="Row actions"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Row actions' }));
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Second' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Second' })).toHaveFocus();
  });

  it('is reachable and fully operable by keyboard alone, with every item activatable via Tab and Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <OverflowMenu
        items={[
          { label: 'First', onSelect: vi.fn() },
          { label: 'Second', onSelect },
        ]}
        label="Row actions"
      />,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Row actions' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('menuitem', { name: 'Second' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('opens on ArrowDown from the trigger, the standard menu-button convention, and moves focus to the first item', async () => {
    const user = userEvent.setup();
    render(<OverflowMenu items={[{ label: 'Delete', onSelect: vi.fn() }]} label="Row actions" />);
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    trigger.focus();

    await user.keyboard('{ArrowDown}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
  });

  it('closes when focus leaves the menu and trigger entirely', async () => {
    const user = userEvent.setup();
    render(
      <>
        <OverflowMenu items={[{ label: 'Delete', onSelect: vi.fn() }]} label="Row actions" />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Row actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  /**
   * `progress/paste-sanitization.md` requirement 2: a menu item that cannot proceed must say why
   * rather than silently declining to do anything on click -- the App.tsx export items are the
   * motivating case, but the contract belongs here, on the component that owns it.
   */
  it('disabled item never calls onSelect on click, and exposes the reason as its title', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <OverflowMenu
        items={[
          {
            disabled: true,
            disabledReason: "Can't export: the draft has an unresolved issue.",
            label: 'Download FDX…',
            onSelect,
          },
        ]}
        label="Row actions"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Row actions' }));

    const item = screen.getByRole('menuitem', { name: 'Download FDX…' });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', "Can't export: the draft has an unresolved issue.");

    await user.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('an item with no disabled reason carries no title, and remains clickable', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<OverflowMenu items={[{ label: 'Delete', onSelect }]} label="Row actions" />);
    await user.click(screen.getByRole('button', { name: 'Row actions' }));

    const item = screen.getByRole('menuitem', { name: 'Delete' });
    expect(item).not.toBeDisabled();
    expect(item).not.toHaveAttribute('title');

    await user.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
