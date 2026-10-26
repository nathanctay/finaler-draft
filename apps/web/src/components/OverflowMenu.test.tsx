import { StrictMode, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OverflowMenu, SUBMENU_CLOSE_DELAY_MS, type OverflowMenuItem } from './OverflowMenu.js';

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

  it('closes when the keyboard moves focus out of the menu and trigger entirely', async () => {
    const user = userEvent.setup();
    render(
      <>
        <OverflowMenu items={[{ label: 'Delete', onSelect: vi.fn() }]} label="Row actions" />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Row actions' }));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

    // Tab past the last item. Nothing was pressed, so only the focus listener can notice this --
    // which is why dismissal on a real focus move has to survive the Safari fix below.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  /**
   * The Safari defect the owner hit: *every* item of *every* `OverflowMenu` was inert in Safari --
   * "manage subscriptions", Delete, Share, all of them -- because this component closed on blur and
   * treated `relatedTarget === null` as "focus left the menu". WebKit does not focus a `<button>`
   * that is pressed with a mouse, so pressing an item blurred whatever was focused with no new focus
   * target at all, the menu closed on `focusout`, and the item unmounted before its `click` ever
   * arrived.
   *
   * `userEvent.click` cannot express this: jsdom's and user-event's model of a click *does* focus the
   * button, which is precisely the browser behaviour Safari does not have, so every existing test in
   * this file passed with the bug present. The sequence below is dispatched by hand instead -- pointer
   * and mouse events on the item, a `focusout` carrying `relatedTarget: null` from the element that
   * *was* focused, a `focusin` on `document.body` for the WebKit variant that surfaces the cleared
   * focus that way, and only then `click`. The clicked button is deliberately never focused.
   *
   * Run against the blur-based close this replaces, this test fails on `onSelect` never having been
   * called -- the menu is already gone by the time `click` is dispatched.
   */
  it('activates an item whose press moves no focus into the menu, the shape Safari dispatches', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<OverflowMenu items={[{ label: 'Delete', onSelect }]} label="Row actions" />);

    await user.click(screen.getByRole('button', { name: 'Row actions' }));
    const item = screen.getByRole('menuitem', { name: 'Delete' });
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
        <OverflowMenu items={[{ label: 'Delete', onSelect: vi.fn() }]} label="Row actions" />
        <p>Outside the menu</p>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Row actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByText('Outside the menu'));

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

  /**
   * A menu whose first item is disabled must still be keyboard-operable. A disabled `<button>` cannot
   * take focus, so the opening focus move has to land on the first *enabled* item instead -- otherwise
   * focus stays on the trigger, the arrow keys compute their next index from an element that is not in
   * the list, and the whole menu is inert while looking open.
   *
   * The read-only revision comparison's File menu is the first caller whose first item is never
   * enabled; the editor's own File menu has had the same shape all along whenever a screenplay is
   * read-only.
   */
  it('moves opening focus past a disabled first item, to the first one that can take it', async () => {
    const user = userEvent.setup();
    render(
      <OverflowMenu
        items={[
          { disabled: true, disabledReason: 'Not here.', label: 'Unavailable…' },
          { label: 'Available…', onSelect: vi.fn() },
        ]}
        label="Actions"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem', { name: 'Available…' })).toHaveFocus();
  });

  it('skips disabled items when the arrow keys move between them', async () => {
    const user = userEvent.setup();
    render(
      <OverflowMenu
        items={[
          { label: 'First…', onSelect: vi.fn() },
          { disabled: true, disabledReason: 'Not here.', label: 'Unavailable…' },
          { label: 'Last…', onSelect: vi.fn() },
        ]}
        label="Actions"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem', { name: 'First…' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Last…' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'First…' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Last…' })).toHaveFocus();
  });

  /** With nothing inside it able to take focus, focus stays on the trigger -- so Escape has to be
   * handled there too, or such a menu cannot be dismissed from the keyboard at all. */
  it('closes on Escape even when every item is disabled and focus never left the trigger', async () => {
    const user = userEvent.setup();
    render(
      <OverflowMenu
        items={[
          { disabled: true, disabledReason: 'Not here.', label: 'One…' },
          { disabled: true, disabledReason: 'Not here either.', label: 'Two…' },
        ]}
        label="Actions"
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('notifies onOpenChange on every open/close transition', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <OverflowMenu
        items={[{ label: 'Delete', onSelect: vi.fn() }]}
        label="Row actions"
        onOpenChange={onOpenChange}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Row actions' });

    await user.click(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(onOpenChange).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);

    // Opening again is a real transition too -- routes/projects/index.tsx relies on this firing
    // every time the menu opens, not only the first time.
    await user.click(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(onOpenChange).toHaveBeenCalledTimes(3);
  });

  it('works with no onOpenChange at all -- every other caller in this codebase omits it', async () => {
    const user = userEvent.setup();
    render(<OverflowMenu items={[{ label: 'Delete', onSelect: vi.fn() }]} label="Row actions" />);
    await user.click(screen.getByRole('button', { name: 'Row actions' }));
    expect(screen.getByRole('menu')).toBeVisible();
  });

  it('does not call onOpenChange on mount -- it reports transitions, not the starting (closed) state', () => {
    const onOpenChange = vi.fn();
    render(
      <OverflowMenu
        items={[{ label: 'Delete', onSelect: vi.fn() }]}
        label="Row actions"
        onOpenChange={onOpenChange}
      />,
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  // Regression test for a real bug the owner hit running this branch: `onOpenChange` used to be
  // invoked from inside `setOpen`'s own updater function, which is impure (React can and does
  // invoke updater functions during render) and produced "Cannot update a component (X) while
  // rendering a different component (OverflowMenu)" -- logged by React, not thrown, which is
  // exactly why every other test in this file passed with the bug present: none of them asserted
  // on the absence of that warning, only on the menu's own visible behaviour. This harness mirrors
  // the real trigger exactly -- routes/projects/index.tsx's account menu passes an `onOpenChange`
  // that itself calls a *different* component's `setState`.
  it('does not warn about updating a different component during render when onOpenChange itself calls setState', async () => {
    function Harness() {
      const [opened, setOpened] = useState(false);
      return (
        <>
          <OverflowMenu
            items={[{ label: 'Delete', onSelect: vi.fn() }]}
            label="Row actions"
            onOpenChange={(open) => {
              if (open) setOpened(true);
            }}
          />
          <span>{opened ? 'opened at least once' : 'never opened'}</span>
        </>
      );
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    // StrictMode, matching main.tsx's real wrapping (development builds only -- the shape the
    // owner actually ran): its double-invocation of state updater functions is what surfaces an
    // impure updater as this exact warning rather than as silently-wrong-but-passing behaviour.
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );

    await user.click(screen.getByRole('button', { name: 'Row actions' }));

    expect(screen.getByText('opened at least once')).toBeVisible();
    const reactRenderWarning = consoleError.mock.calls.some(
      ([message]) => typeof message === 'string' && message.includes('Cannot update a component'),
    );
    expect(reactRenderWarning).toBe(false);
    consoleError.mockRestore();
  });

  /**
   * The File menu's "Download" submenu (`OverflowMenuItem.submenuItems`), added for the owner's
   * ask: "move the download options in the file dropdown to a sub dropdown... 'Download >' and if
   * you hover over it you get the download options." Each `it` names the specific contract it
   * guards, matching this file's existing style, rather than one combined interaction test.
   */
  describe('submenu', () => {
    function downloadItems(): OverflowMenuItem[] {
      return [
        { label: 'First', onSelect: vi.fn() },
        {
          label: 'Download',
          submenuItems: [
            { label: 'FDX…', onSelect: vi.fn() },
            { label: 'DOCX…', onSelect: vi.fn() },
          ],
        },
        { label: 'Last', onSelect: vi.fn() },
      ];
    }

    it('carries aria-haspopup and an accurate aria-expanded on the parent, and role="menu" on the submenu', async () => {
      const user = userEvent.setup();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));

      const downloadItem = screen.getByRole('menuitem', { name: 'Download' });
      expect(downloadItem).toHaveAttribute('aria-haspopup', 'menu');
      expect(downloadItem).toHaveAttribute('aria-expanded', 'false');

      await user.click(downloadItem);
      expect(downloadItem).toHaveAttribute('aria-expanded', 'true');
      // Two `role="menu"` elements now exist: the File menu itself and the submenu nested inside
      // it -- `getAllByRole` rather than `getByRole`, which would throw on finding more than one.
      expect(screen.getAllByRole('menu')).toHaveLength(2);
    });

    it('opens on hover without moving focus away from wherever it already is', async () => {
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      fireEvent.click(screen.getByRole('button', { name: 'File menu' }));
      expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Download' }));
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toBeVisible();
      // Hovering only previews the submenu -- committing to it (and moving focus inside) is a
      // keyboard act, not a pointer one. Stealing focus here would yank it out from under a writer
      // who is navigating the rest of the menu by keyboard while merely passing the mouse over
      // "Download" on the way to somewhere else.
      expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();
    });

    it('opens on ArrowRight from the parent and moves focus to the submenu’s first enabled item', async () => {
      const user = userEvent.setup();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      screen.getByRole('menuitem', { name: 'Download' }).focus();

      await user.keyboard('{ArrowRight}');
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toHaveFocus();
    });

    it('opens on Enter from the parent (native button activation) and moves focus into the submenu', async () => {
      const user = userEvent.setup();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      screen.getByRole('menuitem', { name: 'Download' }).focus();

      await user.keyboard('{Enter}');
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toHaveFocus();
    });

    it('closes the submenu on ArrowLeft and returns focus to the parent, leaving the outer menu open', async () => {
      const user = userEvent.setup();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      await user.click(screen.getByRole('menuitem', { name: 'Download' }));
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toHaveFocus();

      await user.keyboard('{ArrowLeft}');
      expect(screen.queryByRole('menuitem', { name: 'FDX…' })).not.toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Download' })).toHaveFocus();
      // The outer File menu is still open -- ArrowLeft/Escape inside a submenu is scoped to that
      // submenu, not a second way to dismiss the whole thing.
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('closes the submenu on Escape and returns focus to the parent, leaving the outer menu open', async () => {
      const user = userEvent.setup();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      await user.click(screen.getByRole('menuitem', { name: 'Download' }));
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toHaveFocus();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menuitem', { name: 'FDX…' })).not.toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Download' })).toHaveFocus();
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('still closes everything and returns focus to the trigger on Escape from the parent menu, submenu untouched', async () => {
      // The pre-existing contract (tested above, on a menu with no submenu at all) must survive
      // the addition of one: Escape pressed while focus is on an ordinary row -- never having
      // entered "Download"'s submenu -- closes the whole File menu, exactly as before.
      const user = userEvent.setup();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      const trigger = screen.getByRole('button', { name: 'File menu' });
      await user.click(trigger);
      expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it('moves focus between the submenu’s own items with ArrowDown/ArrowUp, wrapping, without escaping into the parent menu’s rows', async () => {
      const user = userEvent.setup();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      await user.click(screen.getByRole('menuitem', { name: 'Download' }));
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toHaveFocus();

      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'DOCX…' })).toHaveFocus();
      // Wraps back to the submenu's own first item, not out to "Last" in the parent menu -- which
      // is exactly what a `focusableItems()` that is not scoped to the parent's own rows would do.
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toHaveFocus();
      await user.keyboard('{ArrowUp}');
      expect(screen.getByRole('menuitem', { name: 'DOCX…' })).toHaveFocus();
    });

    /**
     * The scoping trap called out in this slice's own brief: `focusableItems()` queries
     * `[role="menuitem"]:not(:disabled)` under `menuRef`, which is not scoped to *direct* children.
     * Once the submenu is open, its two items are also descendants of `menuRef`, so an
     * unscoped query would sweep them into the parent menu's own ArrowDown/ArrowUp order --
     * even though focus never left the parent's rows. This test opens the submenu by hover (so it
     * exists in the DOM) while keeping focus on an ordinary top-level row, then arrows through the
     * *parent* menu: with the scoping fix, the cycle is exactly First -> Download -> Last -> First
     * (three stops). Revert the `el.closest('[role="menu"]') === menuRef.current` filter in
     * `focusableItems()` back to the plain query and this fails on the second assertion, landing on
     * "FDX…" instead of "Last" -- the submenu's own first child inserted into the parent's cycle.
     */
    it('never lands on a submenu item while arrowing through the parent menu, even while the submenu is open', async () => {
      const user = userEvent.setup();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Download' }));
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'Download' })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();
    });

    it('closes the submenu once the pointer leaves it for longer than the close delay', () => {
      vi.useFakeTimers();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      fireEvent.click(screen.getByRole('button', { name: 'File menu' }));

      const downloadItem = screen.getByRole('menuitem', { name: 'Download' });
      fireEvent.mouseEnter(downloadItem);
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toBeVisible();

      fireEvent.mouseLeave(downloadItem);
      // Short of the delay: still open -- this is the whole point of the delay (diagonal travel
      // toward the submenu must survive a brief moment outside both elements' boxes). The timer
      // callback calls `setOpenSubmenuLabel`, a state update made outside any React-managed event
      // handler -- `act()` around `advanceTimersByTime` is what makes the resulting re-render
      // commit before the assertion reads the DOM, rather than leaving it pending.
      act(() => {
        vi.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS - 1);
      });
      expect(screen.queryByRole('menuitem', { name: 'FDX…' })).toBeInTheDocument();

      // Past the delay, with the pointer never having returned: closed.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByRole('menuitem', { name: 'FDX…' })).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it('cancels the close delay when the pointer re-enters the submenu itself before it elapses', () => {
      vi.useFakeTimers();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      fireEvent.click(screen.getByRole('button', { name: 'File menu' }));

      const downloadItem = screen.getByRole('menuitem', { name: 'Download' });
      fireEvent.mouseEnter(downloadItem);
      const submenuList = screen.getByRole('menuitem', { name: 'FDX…' }).closest('[role="menu"]');
      if (!submenuList) throw new Error('Submenu list not found.');

      fireEvent.mouseLeave(downloadItem);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.mouseEnter(submenuList);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      // Still open: entering the submenu itself cancelled the timer the trigger's own
      // `mouseLeave` started, which is what makes the diagonal path from trigger to flyout work.
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toBeInTheDocument();
      vi.useRealTimers();
    });

    /**
     * A writer who opened the submenu by keyboard, then moved the mouse away without ever pressing
     * a key, leaves focus inside a submenu that the hover-close timer is about to remove from the
     * document. Without this, the browser's own fallback for a focused element disappearing (focus
     * moving to `document.body`) would apply instead -- a writer back on the keyboard afterward
     * would find nothing focused at all, inside a File menu that still looks open.
     */
    it('returns focus to the parent trigger if the close delay elapses while focus is still inside the submenu', () => {
      vi.useFakeTimers();
      render(<OverflowMenu items={downloadItems()} label="File menu" />);
      fireEvent.click(screen.getByRole('button', { name: 'File menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
      const downloadItem = screen.getByRole('menuitem', { name: 'Download' });
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toHaveFocus();

      const submenuList = screen.getByRole('menuitem', { name: 'FDX…' }).closest('[role="menu"]');
      if (!submenuList) throw new Error('Submenu list not found.');
      fireEvent.mouseLeave(submenuList);
      act(() => {
        vi.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS);
      });

      expect(screen.queryByRole('menuitem', { name: 'FDX…' })).not.toBeInTheDocument();
      expect(downloadItem).toHaveFocus();
      vi.useRealTimers();
    });

    it('derives the parent’s disabled state from its children: disabled, with the shared reason, only when every child is', async () => {
      const user = userEvent.setup();
      const allDisabled: OverflowMenuItem[] = [
        {
          label: 'Download',
          submenuItems: [
            { disabled: true, disabledReason: "Can't export: reason.", label: 'FDX…' },
            { disabled: true, disabledReason: "Can't export: reason.", label: 'DOCX…' },
          ],
        },
      ];
      render(<OverflowMenu items={allDisabled} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      const downloadItem = screen.getByRole('menuitem', { name: 'Download' });
      expect(downloadItem).toBeDisabled();
      expect(downloadItem).toHaveAttribute('title', "Can't export: reason.");
    });

    it('leaves the parent enabled when only some children are disabled', async () => {
      const user = userEvent.setup();
      const someDisabled: OverflowMenuItem[] = [
        {
          label: 'Download',
          submenuItems: [
            { disabled: true, disabledReason: "Can't export: reason.", label: 'FDX…' },
            { label: 'DOCX…', onSelect: vi.fn() },
          ],
        },
      ];
      render(<OverflowMenu items={someDisabled} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      const downloadItem = screen.getByRole('menuitem', { name: 'Download' });
      expect(downloadItem).not.toBeDisabled();
      expect(downloadItem).not.toHaveAttribute('title');
    });

    it('uses ariaLabel as the submenu child’s accessible name, independent of its shorter visible label', async () => {
      const user = userEvent.setup();
      const items: OverflowMenuItem[] = [
        {
          label: 'Download',
          submenuItems: [{ ariaLabel: 'Download FDX…', label: 'FDX…', onSelect: vi.fn() }],
        },
      ];
      render(<OverflowMenu items={items} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      await user.click(screen.getByRole('menuitem', { name: 'Download' }));

      const item = screen.getByRole('menuitem', { name: 'Download FDX…' });
      expect(item).toHaveAttribute('aria-label', 'Download FDX…');
      expect(item).not.toHaveTextContent('Download FDX…');
      expect(item).toHaveTextContent('FDX…');
    });

    it('selecting a submenu item closes the whole menu (not only the submenu) and calls its onSelect', async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      const items: OverflowMenuItem[] = [
        { label: 'Download', submenuItems: [{ label: 'FDX…', onSelect }] },
      ];
      render(<OverflowMenu items={items} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      await user.click(screen.getByRole('menuitem', { name: 'Download' }));

      await user.click(screen.getByRole('menuitem', { name: 'FDX…' }));
      expect(onSelect).toHaveBeenCalledOnce();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    /**
     * The Safari shape again (see the top-level version of this test above), now inside the
     * submenu: a press on a submenu item must not close the menu before that item's `click`
     * dispatches. The submenu renders inside this component's existing `containerRef` wrapper
     * rather than in a portal, so the capture-phase `pointerdown` dismissal listener must still
     * treat a press inside it as "inside the menu" -- this is the thing to verify rather than
     * assume, called out explicitly in this slice's brief.
     */
    it('activates a submenu item whose press moves no focus into it, the shape Safari dispatches', async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      const items: OverflowMenuItem[] = [
        { label: 'Download', submenuItems: [{ label: 'FDX…', onSelect }] },
      ];
      render(<OverflowMenu items={items} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      await user.click(screen.getByRole('menuitem', { name: 'Download' }));
      const item = screen.getByRole('menuitem', { name: 'FDX…' });
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

    it('a pointerdown inside the open submenu does not dismiss the menu the way an outside press does', async () => {
      const user = userEvent.setup();
      const items: OverflowMenuItem[] = [
        { label: 'Download', submenuItems: [{ label: 'FDX…', onSelect: vi.fn() }] },
      ];
      render(<OverflowMenu items={items} label="File menu" />);
      await user.click(screen.getByRole('button', { name: 'File menu' }));
      await user.click(screen.getByRole('menuitem', { name: 'Download' }));
      const item = screen.getByRole('menuitem', { name: 'FDX…' });

      fireEvent.pointerDown(item);
      expect(screen.getByRole('menuitem', { name: 'FDX…' })).toBeInTheDocument();
      expect(screen.getAllByRole('menu')).toHaveLength(2);
    });
  });
});
