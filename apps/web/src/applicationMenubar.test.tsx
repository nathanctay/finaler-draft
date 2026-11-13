import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationMenubar } from './applicationMenubar.js';

const ONLY_FILE_ITEM = [{ label: 'Only item', onSelect: vi.fn() }];

/**
 * The menu bar, now one component rendered by the editor and by the read-only revision comparison
 * both. What matters here is the same pair of properties the toolbar's tests check: the whole bar is
 * present on either screen, and an item that cannot act is really disabled -- a native `disabled`
 * `<button>` carrying its reason, never an enabled-looking item whose handler quietly declines.
 * Edit, View, Format, Tools and Help are all real menus built from caller-supplied items exactly
 * like File already was, and a menu given no items (the prop omitted, or passed `[]`) does not
 * render at all -- not as a button, not as a label. There is no longer an inert label-only menu
 * anywhere in this component: Help was the last one, activated this slice
 * (`progress/menus-slice-3.md`).
 */
function menubar(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Application menu' });
}

async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  triggerName: string,
): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: triggerName }));
  return screen.getByRole('menu');
}

describe('application menubar', () => {
  it('renders the File menu alone when no other menu is given items', () => {
    render(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} />);

    expect(within(menubar()).getByRole('button', { name: 'File menu' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit menu' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View menu' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Format menu' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tools menu' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Help menu' })).toBeNull();
    // Not a label either: there is no longer a label-only menu anywhere in this component.
    expect(within(menubar()).queryByText('Help')).toBeNull();
  });

  it('renders the caller’s File items in order and fires the chosen one', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ApplicationMenubar
        fileMenuItems={[
          { label: 'First…', onSelect },
          { label: 'Second…', onSelect: vi.fn() },
        ]}
      />,
    );

    const menu = await openMenu(user, 'File menu');
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

    const menu = await openMenu(user, 'File menu');
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
        fileMenuItems={[{ disabled: true, disabledReason: 'No.', label: 'Save…' }]}
      />,
    );

    const menu = await openMenu(user, 'File menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Save…' }));
    expect(within(menu).getByRole('menuitem', { name: 'Save…' })).toBeDisabled();
  });

  it('attaches the caller’s ref to the File menu wrapper, so focus can be returned to its trigger', () => {
    const ref = createRef<HTMLDivElement>();
    render(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} fileMenuRef={ref} />);

    expect(ref.current).toHaveClass('menu-file');
    expect(ref.current?.querySelector('.overflow-menu-trigger')).toBe(
      screen.getByRole('button', { name: 'File menu' }),
    );
  });

  /** `App.tsx` uses this one to return focus to the Edit menu's trigger once Find and replace's
   * own bar closes (menus slice 4) -- the identical pattern `fileMenuRef` above already proves. */
  it('attaches the caller’s ref to the Edit menu wrapper, so focus can be returned to its trigger', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <ApplicationMenubar
        editMenuItems={[{ label: 'Find and replace…', onSelect: vi.fn() }]}
        editMenuRef={ref}
        fileMenuItems={ONLY_FILE_ITEM}
      />,
    );

    expect(ref.current).toHaveClass('menu-edit');
    expect(ref.current?.querySelector('.overflow-menu-trigger')).toBe(
      screen.getByRole('button', { name: 'Edit menu' }),
    );
  });

  describe('Edit, View, Format, Tools and Help: a menu with no items does not render at all', () => {
    it('renders Edit when given items, and fires the chosen one', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ApplicationMenubar
          editMenuItems={[{ label: 'Undo', onSelect }]}
          fileMenuItems={ONLY_FILE_ITEM}
        />,
      );

      expect(within(menubar()).getByRole('button', { name: 'Edit menu' })).toBeInTheDocument();
      const menu = await openMenu(user, 'Edit menu');
      await user.click(within(menu).getByRole('menuitem', { name: 'Undo' }));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('does not render Edit when the prop is omitted', () => {
      render(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} />);
      expect(screen.queryByRole('button', { name: 'Edit menu' })).toBeNull();
    });

    /** The empty-array case is distinct from "omitted" in TypeScript's eyes and must be proven
     * separately: a caller that always passes an array (built from a list that happens to be
     * empty, e.g. every submenu child disabled and the caller choosing to drop the parent too)
     * must get the identical "cut" behaviour, not a menu with a trigger and nothing inside it. */
    it('does not render Edit when given an empty array either', () => {
      render(<ApplicationMenubar editMenuItems={[]} fileMenuItems={ONLY_FILE_ITEM} />);
      expect(screen.queryByRole('button', { name: 'Edit menu' })).toBeNull();
    });

    it('renders View when given items, and fires the chosen one', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ApplicationMenubar
          fileMenuItems={ONLY_FILE_ITEM}
          viewMenuItems={[{ label: 'Dark canvas', onSelect }]}
        />,
      );

      expect(within(menubar()).getByRole('button', { name: 'View menu' })).toBeInTheDocument();
      const menu = await openMenu(user, 'View menu');
      await user.click(within(menu).getByRole('menuitem', { name: 'Dark canvas' }));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('does not render View when the prop is omitted or empty', () => {
      const { rerender } = render(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} />);
      expect(screen.queryByRole('button', { name: 'View menu' })).toBeNull();

      rerender(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} viewMenuItems={[]} />);
      expect(screen.queryByRole('button', { name: 'View menu' })).toBeNull();
    });

    it('renders Format when given items, and fires the chosen one', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ApplicationMenubar
          fileMenuItems={ONLY_FILE_ITEM}
          formatMenuItems={[{ label: 'Scene Heading', onSelect }]}
        />,
      );

      expect(within(menubar()).getByRole('button', { name: 'Format menu' })).toBeInTheDocument();
      const menu = await openMenu(user, 'Format menu');
      await user.click(within(menu).getByRole('menuitem', { name: 'Scene Heading' }));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('does not render Format when the prop is omitted or empty', () => {
      const { rerender } = render(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} />);
      expect(screen.queryByRole('button', { name: 'Format menu' })).toBeNull();

      rerender(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} formatMenuItems={[]} />);
      expect(screen.queryByRole('button', { name: 'Format menu' })).toBeNull();
    });

    it('renders Tools when given items, and fires the chosen one', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ApplicationMenubar
          fileMenuItems={ONLY_FILE_ITEM}
          toolsMenuItems={[{ label: 'Word count…', onSelect }]}
        />,
      );

      expect(within(menubar()).getByRole('button', { name: 'Tools menu' })).toBeInTheDocument();
      const menu = await openMenu(user, 'Tools menu');
      await user.click(within(menu).getByRole('menuitem', { name: 'Word count…' }));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('does not render Tools when the prop is omitted or empty', () => {
      const { rerender } = render(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} />);
      expect(screen.queryByRole('button', { name: 'Tools menu' })).toBeNull();

      rerender(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} toolsMenuItems={[]} />);
      expect(screen.queryByRole('button', { name: 'Tools menu' })).toBeNull();
    });

    it('attaches the caller’s ref to the Tools menu wrapper, so focus can be returned to its trigger', () => {
      const ref = createRef<HTMLDivElement>();
      render(
        <ApplicationMenubar
          fileMenuItems={ONLY_FILE_ITEM}
          toolsMenuItems={[{ label: 'Word count…', onSelect: vi.fn() }]}
          toolsMenuRef={ref}
        />,
      );

      expect(ref.current).toHaveClass('menu-tools');
      expect(ref.current?.querySelector('.overflow-menu-trigger')).toBe(
        screen.getByRole('button', { name: 'Tools menu' }),
      );
    });

    it('renders Help when given items, and fires the chosen one', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ApplicationMenubar
          fileMenuItems={ONLY_FILE_ITEM}
          helpMenuItems={[{ label: 'Send feedback…', onSelect }]}
        />,
      );

      expect(within(menubar()).getByRole('button', { name: 'Help menu' })).toBeInTheDocument();
      const menu = await openMenu(user, 'Help menu');
      await user.click(within(menu).getByRole('menuitem', { name: 'Send feedback…' }));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('does not render Help when the prop is omitted or empty', () => {
      const { rerender } = render(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} />);
      expect(screen.queryByRole('button', { name: 'Help menu' })).toBeNull();

      rerender(<ApplicationMenubar fileMenuItems={ONLY_FILE_ITEM} helpMenuItems={[]} />);
      expect(screen.queryByRole('button', { name: 'Help menu' })).toBeNull();
    });

    it('attaches the caller’s ref to the Help menu wrapper, so focus can be returned to its trigger', () => {
      const ref = createRef<HTMLDivElement>();
      render(
        <ApplicationMenubar
          fileMenuItems={ONLY_FILE_ITEM}
          helpMenuItems={[{ label: 'Send feedback…', onSelect: vi.fn() }]}
          helpMenuRef={ref}
        />,
      );

      expect(ref.current).toHaveClass('menu-help');
      expect(ref.current?.querySelector('.overflow-menu-trigger')).toBe(
        screen.getByRole('button', { name: 'Help menu' }),
      );
    });

    /** The comparison route's own real shape: File, View and Help real (Help with only one of its
     * two items -- that distinction is the diff route's own test to make, not this component's,
     * which only ever sees whatever items it is handed), Edit, Format and Tools cut entirely --
     * proven together so a reader sees the actual combination this slice ships, not just each
     * menu's presence rule in isolation. */
    it('renders exactly File, View and Help, with Edit, Format and Tools absent, matching the comparison route’s own choice', () => {
      render(
        <ApplicationMenubar
          fileMenuItems={ONLY_FILE_ITEM}
          helpMenuItems={[{ label: 'Send feedback…', onSelect: vi.fn() }]}
          viewMenuItems={[{ label: 'Dark canvas', onSelect: vi.fn() }]}
        />,
      );

      expect(within(menubar()).getByRole('button', { name: 'File menu' })).toBeInTheDocument();
      expect(within(menubar()).getByRole('button', { name: 'View menu' })).toBeInTheDocument();
      expect(within(menubar()).getByRole('button', { name: 'Help menu' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit menu' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Format menu' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Tools menu' })).toBeNull();
    });
  });
});
