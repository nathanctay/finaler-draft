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
  /**
   * Omitted only by an item that is permanently disabled on the screen rendering it -- the read-only
   * revision comparison's File menu, where "Save named revision…" and the three exports have no
   * meaning at all and so have nothing to call. Required in spirit everywhere else: an *enabled*
   * item with no `onSelect` would be exactly the click-that-does-nothing this component's `disabled`
   * handling exists to make unnecessary. It is optional rather than required-with-a-no-op because a
   * no-op handler on an unreachable code path is worse than no handler: it reads as a forgotten
   * implementation, and nothing would ever call it to prove otherwise.
   */
  onSelect?: (() => void) | undefined;
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

  /**
   * Every item a keyboard can actually land on. `:not(:disabled)` is load-bearing rather than tidy: a
   * disabled `<button>` cannot take focus at all, so a menu whose *first* item is disabled used to
   * swallow both the opening focus move and every arrow key -- `focus()` was a no-op, which left focus
   * on the trigger, which left `indexOf(document.activeElement)` at `-1`, which sent ArrowDown back to
   * the same unfocusable item. The whole menu was then keyboard-inert while looking open.
   *
   * Nothing had exercised that before: every caller's first item was enabled. The read-only revision
   * comparison's File menu is the first whose first item never is (`Document settings…` has no meaning
   * on a stored snapshot), and the editor's own File menu has had the same latent fault all along for a
   * read-only screenplay, where `editingAllowed` disables that same first item.
   */
  function focusableItems(): HTMLElement[] {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
  }

  // Opening moves focus into the menu, which is what lets Tab and the arrow-key handling below
  // reach every item without a mouse. Closing (by any route -- Escape, selecting an item, or
  // losing focus) never moves focus on its own; only Escape's own handler returns it to the
  // trigger, matching the specific requirement in plan.md and the scope.
  useEffect(() => {
    if (!open) return;
    focusableItems()[0]?.focus();
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
    const menuItems = focusableItems();
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
            return;
          }
          // Escape from the trigger as well as from the list. Focus is normally inside the menu by the
          // time a writer presses Escape, and the list's own handler catches it there -- but a menu with
          // no enabled item at all has nowhere inside it to put focus, which would otherwise leave such
          // a menu open with no keyboard way to dismiss it.
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
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
