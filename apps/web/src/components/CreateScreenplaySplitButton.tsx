import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { OverflowMenuItem } from './OverflowMenu.js';

/**
 * Task 3 of the FDX-import slice (`progress/fdx-import.md`): the owner's own words were "Rather
 * than just sitting below the create line, we should have an arrow on the right side of the
 * 'create screenplay' button that drops an import menu down... there should also be a vertical
 * divider between the words and the arrow." This is that control -- the primary label submits
 * the surrounding form exactly as the old plain "New screenplay" button did, and the arrow opens
 * a menu of import formats (`items`), positioned directly below the whole unit, with "Import
 * FDX…" as its first entry and room for more import formats to be added later as additional
 * items.
 *
 * **Two distinct controls in one visual unit, not one button with two jobs**: the primary button
 * is a real `type="submit"` button with its own accessible name (`primaryLabel`); the arrow is a
 * separate `type="button"` with its own accessible name (`arrowLabel`, which must say what it
 * does -- never "Create screenplay" -- and changes to a busy label while `importDisabled` is
 * true, carrying the same feedback the old standalone "Importing…" button label used to). Pressing
 * one never triggers the other.
 *
 * **Deliberately does not import anything from `OverflowMenu.tsx` except its `OverflowMenuItem`
 * type.** A separate branch is changing that component and its `.overflow-menu-*` CSS rules, so
 * this slice cannot touch either without creating a merge conflict -- see this file's own
 * `progress/fdx-import.md` entry. The *mechanism* below (two document-level listeners in the
 * capture phase, `pointerdown` and `focusin`, with `document.body` excluded from the latter) is
 * independent, hand-written code that happens to follow the identical approach `OverflowMenu.tsx`
 * already settled on, for the identical reason recorded in that file's own long comment: a
 * `focusout`/blur-based close made every menu in this app inert in Safari, because WebKit does
 * not focus a `<button>` pressed with a mouse, so an item's own press blurred whatever had focus
 * with nothing to blame, the menu closed on `focusout`, and the item unmounted before its `click`
 * was ever dispatched. `pointerdown` is the signal that actually means "the writer pressed
 * something else," identical across engines and fired before `click`; `focusin` on anything
 * outside this control closes it too (the one part of the old blur-based behaviour worth keeping,
 * for Tab-ing away), except when the target is `document.body` itself, which is what a WebKit
 * press that focuses nothing looks like from a `focusin` listener's perspective, and which an
 * outside press -- not this listener -- is what actually dismisses in that case.
 */
export function CreateScreenplaySplitButton({
  arrowLabel,
  importDisabled,
  items,
  primaryLabel,
}: {
  /**
   * The arrow's own accessible name. Must describe what the arrow does (opening the import menu),
   * never restate `primaryLabel` -- the two controls do different things and must be
   * distinguishable to assistive technology. Pass a different string while `importDisabled` is
   * true (e.g. "Importing…") to carry the busy feedback the old standalone import button's own
   * changing label used to give; this component does not invent that text on its own.
   */
  arrowLabel: string;
  /**
   * Disables the arrow (and therefore the menu it opens) without disabling the primary button --
   * mirrors exactly what the old standalone "Import FDX…" button's own `disabled` already did
   * (`parseFdx.isPending || resolveUnknownTypes.isPending || commitImport.isPending`). No new
   * authorization or entitlement rule is introduced here: this is the same condition, moved.
   */
  importDisabled: boolean;
  items: OverflowMenuItem[];
  primaryLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function focusableItems(): HTMLElement[] {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
  }

  useEffect(() => {
    if (!open) return;
    focusableItems()[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function isInside(target: EventTarget | null): boolean {
      return containerRef.current?.contains(target as Node | null) ?? false;
    }
    function handlePointerDown(event: Event) {
      if (!isInside(event.target)) setOpen(false);
    }
    function handleFocusIn(event: FocusEvent) {
      if (event.target === document.body) return;
      if (!isInside(event.target)) setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
    };
  }, [open]);

  function closeAndReturnFocus() {
    setOpen(false);
    arrowRef.current?.focus();
  }

  function moveFocus(delta: 1 | -1) {
    const menuItems = focusableItems();
    if (menuItems.length === 0) return;
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLElement);
    const nextIndex = (currentIndex + delta + menuItems.length) % menuItems.length;
    menuItems[nextIndex]?.focus();
  }

  return (
    <div className="split-button" ref={containerRef}>
      <button className="primary-button split-button-primary" type="submit">
        {primaryLabel}
      </button>
      <span aria-hidden="true" className="split-button-divider" />
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={arrowLabel}
        className="primary-button split-button-arrow"
        disabled={importDisabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
            return;
          }
          // Escape from the arrow itself as well as from the list -- see OverflowMenu.tsx's
          // identical trigger-level handler for why: a menu with no enabled item has nowhere
          // inside it to put focus, which would otherwise leave such a menu open with no keyboard
          // way to dismiss it.
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        ref={arrowRef}
        type="button"
      >
        ▾
      </button>
      {open && (
        <div
          className="split-button-menu"
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
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
                item.onSelect?.();
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
