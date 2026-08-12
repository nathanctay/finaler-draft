import { useEffect, useRef, useState } from 'react';

export interface OverflowMenuItem {
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
  triggerContent = '⋯',
}: {
  items: OverflowMenuItem[];
  label: string;
  triggerContent?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Opening moves focus into the menu, which is what lets Tab and the arrow-key handling below
  // reach every item without a mouse. Closing (by any route -- Escape, selecting an item, or
  // losing focus) never moves focus on its own; only Escape's own handler returns it to the
  // trigger, matching the specific requirement in plan.md and the scope.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

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
              key={item.label}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              role="menuitem"
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
