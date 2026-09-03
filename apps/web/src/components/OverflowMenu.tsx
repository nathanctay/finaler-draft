import { useEffect, useRef, useState } from 'react';

export interface OverflowMenuItem {
  /**
   * A disabled item renders as a real, native-`disabled` `<button>` rather than an enabled-looking
   * one whose `onSelect` quietly declines to do anything -- see `progress/paste-sanitization.md`
   * requirement 2. A disabled control reads unambiguously as "unavailable"; a click that no-ops
   * reads as a broken build, which is exactly the defect this exists to stop. `disabledReason` is
   * meant to be supplied whenever `disabled` is true -- it is surfaced as the button's `title` (a
   * plain tooltip is enough here -- this is the same "say why" bar the export items already have
   * to clear, not a new interaction pattern).
   */
  disabled?: boolean;
  disabledReason?: string | undefined;
  label: string;
  onSelect: () => void;
}

/**
 * The smallest accessible popup menu that satisfies plan.md's "Deleting and restoring" section:
 * a real accessible name on the trigger, `aria-haspopup`/`aria-expanded`, Enter/Space to open
 * (free from a real `<button>`'s native activation, not reimplemented here), Escape to close
 * with focus returned to the trigger, and full keyboard operability. Used for both the per-row
 * overflow menu (Delete) and the header's account menu (Deleted items, Sign out) -- two
 * unrelated item sets behind the identical interaction contract, which is exactly what this
 * component factors out.
 *
 * `label` must be a real, per-instance accessible name (e.g. "Screenplay actions for Draft One"),
 * not a single generic string reused identically across every row -- an assistive-technology
 * user navigating a list of identically-labelled buttons cannot tell them apart.
 */
export function OverflowMenu({
  items,
  label,
  onOpenChange,
  triggerContent = '⋯',
}: {
  items: OverflowMenuItem[];
  label: string;
  /**
   * Notified on every open/close transition, from every path that changes it (the trigger toggle,
   * ArrowDown, Escape, selecting an item, or losing focus) -- optional, and a no-op for every
   * caller that doesn't need it. Added for the account menu (routes/projects/index.tsx), which
   * defers fetching billing/entitlement state until the menu is actually opened once rather than
   * on every page load: that state is only ever shown inside this menu, so there is no reason to
   * pay for it before a writer has expressed any interest in it.
   */
  onOpenChange?: (open: boolean) => void;
  triggerContent?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Guards the mount-time run of the `onOpenChange` effect below -- see that effect's own
  // comment for why a synthesized initial `false` must not be reported as a transition.
  const isFirstRender = useRef(true);

  // Opening moves focus into the menu, which is what lets Tab and the arrow-key handling below
  // reach every item without a mouse. Closing (by any route -- Escape, selecting an item, or
  // losing focus) never moves focus on its own; only Escape's own handler returns it to the
  // trigger, matching the specific requirement in plan.md and the scope.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Reports transitions, not the initial render. `onOpenChange` was previously called from
  // inside `setOpen`'s own updater function -- a real bug (the owner hit it directly): state
  // updater functions must be pure, since React can and does invoke them during render (batching,
  // Strict Mode's double-invocation, or a bailout recomputation), and calling a *different*
  // component's setter from inside one produces exactly the "Cannot update a component while
  // rendering a different component" warning React logs rather than throws -- which is why the
  // bug shipped with every existing test green; none of them asserted on the absence of that
  // warning, only on the menu's own visible behaviour, which was never wrong.
  //
  // An effect keyed on `open` is the correct, standard fix, but it runs after the *first* render
  // too, and would otherwise synthesize an `onOpenChange(false)` call nothing actually caused --
  // this component starts closed by construction, not because something closed it. `isFirstRender`
  // suppresses exactly that one synthetic call. The alternative (let it fire on mount) would make
  // every caller either tolerate a spurious "closed" notification before any user interaction, or
  // defensively guard against it themselves; suppressing it here, once, is the correct place for
  // that concern to live, and matches how comparable browser/React `onChange`-shaped callbacks
  // conventionally behave -- they report a change, not the starting value.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  function closeAndReturnFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveFocus(delta: 1 | -1) {
    const menuItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (menuItems.length === 0) return;
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLElement);
    const nextIndex = (currentIndex + delta + menuItems.length) % menuItems.length;
    menuItems[nextIndex]?.focus();
  }

  return (
    <div
      className="overflow-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="overflow-menu-trigger"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={triggerRef}
        type="button"
      >
        {triggerContent}
      </button>
      {open && (
        <div
          className="overflow-menu-list"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeAndReturnFocus();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              moveFocus(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(-1);
            }
          }}
          ref={menuRef}
          role="menu"
        >
          {items.map((item) => (
            <button
              aria-disabled={item.disabled}
              disabled={item.disabled}
              key={item.label}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              role="menuitem"
              title={item.disabled ? item.disabledReason : undefined}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
