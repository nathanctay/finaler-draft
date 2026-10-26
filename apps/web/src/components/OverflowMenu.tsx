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
   *
   * Ignored on a submenu-parent item (one that sets `submenuItems`) -- see that field's own comment
   * for why its disabled state is derived from its children instead of read from here.
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
   *
   * Never called on a submenu-parent item -- choosing *it* opens `submenuItems` instead; only its
   * children's own `onSelect` ever runs.
   */
  onSelect?: (() => void) | undefined;
  /**
   * Accessible-name override, rendered as the button's `aria-label` instead of letting `label`'s own
   * text be read. Exists for a submenu child whose visible `label` is deliberately short (e.g.
   * "FDX…") and therefore ambiguous read on its own, outside the structural context of having just
   * arrow-navigated out of its parent's menu item and into its submenu -- a screen reader feature
   * that jumps straight to an item by name (a rotor, a "list all items" gesture) would otherwise
   * announce bare "FDX…". See the Download item in `App.tsx` for the concrete case.
   */
  ariaLabel?: string | undefined;
  /**
   * Turns this item into a submenu parent rather than a selectable action. Hovering it, or pressing
   * Enter/Space/ArrowRight while it has focus, opens a nested `role="menu"` holding these items
   * instead of calling `onSelect` -- a submenu parent has none; choosing *it* does nothing, only one
   * of its children does. Only one level deep is rendered: an item inside `submenuItems` that itself
   * sets `submenuItems` is treated as an ordinary leaf, matching the one real caller (the File menu's
   * "Download", holding FDX/DOCX/PDF with no further nesting).
   *
   * This item's own `disabled`/`disabledReason` are ignored and recomputed from these children
   * instead: every child disabled makes the parent disabled too, carrying the first disabled
   * child's reason, so a writer is never invited to open a submenu with nothing usable inside it;
   * any child still enabled leaves the parent enabled. Deriving it here, once, removes the second
   * place (the parent's own flag) that an "all children disabled" fact could otherwise drift out of
   * sync with -- see `App.tsx`'s three download items, which already share one `disabled` expression
   * and one reason among themselves.
   */
  submenuItems?: readonly OverflowMenuItem[];
}

/**
 * Close delay for a submenu left by the pointer. A writer's cursor travelling from the "Download"
 * row toward its flyout moves diagonally, not along either element's own edge, and crosses space
 * that belongs to neither box along the way -- a zero-delay close would drop the submenu the instant
 * that gap is crossed, making it unusable with a mouse. 200ms comfortably covers that diagonal at an
 * ordinary, unhurried pointer speed (in the same range -- roughly 150-300ms -- that desktop menu
 * implementations commonly use for the same reason) without the menu feeling sluggish to dismiss when
 * the writer genuinely moves elsewhere.
 */
export const SUBMENU_CLOSE_DELAY_MS = 200;

/** Shared by the top-level list's and a submenu's own arrow-key handling: given the ordered set of
 * focusable items in whichever scope is moving, step from whatever currently has focus and wrap. */
function moveFocusAmong(items: readonly HTMLElement[], delta: 1 | -1) {
  if (items.length === 0) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  const nextIndex = (currentIndex + delta + items.length) % items.length;
  items[nextIndex]?.focus();
}

/**
 * The smallest accessible popup menu that satisfies plan.md's "Deleting and restoring" section:
 * a real accessible name on the trigger, `aria-haspopup`/`aria-expanded`, Enter/Space to open
 * (free from a real `<button>`'s own native activation, not reimplemented here), Escape to close
 * with focus returned to the trigger, and full keyboard operability. Used for both the per-row
 * overflow menu (Delete) and the header's account menu (Deleted items, Sign out) -- two
 * unrelated item sets behind the identical interaction contract, which is exactly what this
 * component factors out. One level of submenu (`OverflowMenuItem.submenuItems`) is also supported,
 * added for the File menu's "Download" -- see that field's own comment.
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
   * ArrowDown, Escape, selecting an item, an outside pointer press, or focus moving to a control
   * outside the menu) -- optional, and a no-op for every caller that doesn't need it. Added for the
   * account menu (routes/projects/index.tsx), which defers fetching billing/entitlement state until
   * the menu is actually opened once rather than on every page load: that state is only ever shown inside this menu, so there is no reason to
   * pay for it before a writer has expressed any interest in it.
   */
  onOpenChange?: (open: boolean) => void;
  triggerContent?: string;
}) {
  const [open, setOpen] = useState(false);
  // Which top-level item's submenu, if any, is currently shown -- `null` when none is. Keyed by
  // label rather than index for the same reason items are already keyed by label when rendered: it
  // is stable across re-renders of the same logical list.
  const [openSubmenuLabel, setOpenSubmenuLabel] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  // Every submenu-parent button, by label, so a submenu closed from the keyboard (ArrowLeft/Escape)
  // or from the pointer leaving while focus was inside it can return focus to its own trigger without
  // threading a ref out through the `.map()` below. A `Map` rather than one ref: nothing restricts
  // this component to a single submenu-parent item across all its callers, even though the one real
  // caller today (File > Download) only ever has one.
  const submenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  // Incremented, never read for its value, by every keyboard-driven open (Enter/Space/ArrowRight on
  // the parent) -- a hover-driven open never touches it. The effect below that moves focus into the
  // submenu is keyed on *this*, not on `openSubmenuLabel`, which is the fix for a real bug a mouse
  // click surfaces: a real click is preceded by the browser's own hover (mouseenter fires before
  // mousedown/click), so by the time the click handler asks to open-with-focus, `openSubmenuLabel`
  // already equals this item's label from that earlier hover -- a `setOpenSubmenuLabel` call with an
  // unchanged value is not a state change, so an effect keyed on `openSubmenuLabel` alone would never
  // re-run and the focus move would be silently dropped. A counter that increments on *every*
  // keyboard-driven open, hover-opened-first or not, always changes and always fires the effect.
  const [submenuFocusRequestId, setSubmenuFocusRequestId] = useState(0);
  const submenuCloseTimerRef = useRef<number | null>(null);
  // Guards the mount-time run of the `onOpenChange` effect below -- see that effect's own
  // comment for why a synthesized initial `false` must not be reported as a transition.
  const isFirstRender = useRef(true);

  /**
   * Every top-level item a keyboard can actually land on while moving between the parent menu's own
   * rows. Two things make an item ineligible, both load-bearing:
   *
   * `:not(:disabled)` -- a disabled `<button>` cannot take focus at all, so a menu whose *first* item
   * is disabled used to swallow both the opening focus move and every arrow key -- `focus()` was a
   * no-op, which left focus on the trigger, which left `indexOf(document.activeElement)` at `-1`,
   * which sent ArrowDown back to the same unfocusable item. The whole menu was then keyboard-inert
   * while looking open. Nothing had exercised that before: every caller's first item was enabled.
   * The read-only revision comparison's File menu is the first whose first item never is ("Document
   * settings…" has no meaning on a stored snapshot), and the editor's own File menu has had the same
   * latent fault all along for a read-only screenplay, where `editingAllowed` disables that same
   * first item.
   *
   * `el.closest('[role="menu"]') === menuRef.current` -- added for the submenu. A plain
   * `querySelectorAll('[role="menuitem"]:not(:disabled)')` scoped to `menuRef` is **not** scoped to
   * direct children: once "Download"'s submenu is open, its FDX/DOCX/PDF buttons are also descendants
   * of `menuRef` (nested two levels down, inside the submenu's own `role="menu"` div), so they would
   * match the same query and get swept into this *parent* menu's arrow-key order -- including while
   * the writer's focus never left the top-level rows. Filtering to only the menuitems whose nearest
   * `role="menu"` ancestor is this component's own list (`menuRef.current`, not the nested submenu
   * div) excludes them regardless of how many wrapper elements sit between a top-level item and
   * `menuRef`, which a direct-child selector would not survive.
   */
  function focusableItems(): HTMLElement[] {
    const candidates = menuRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    return Array.from(candidates ?? []).filter(
      (el) => el.closest('[role="menu"]') === menuRef.current,
    );
  }

  /** The open submenu's own items. No equivalent scoping concern: a submenu never nests a further
   * one (`submenuItems`' own doc comment), so every menuitem under `submenuRef` belongs to it. */
  function focusableSubmenuItems(): HTMLElement[] {
    return Array.from(
      submenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
  }

  function cancelScheduledSubmenuClose() {
    if (submenuCloseTimerRef.current !== null) {
      window.clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  }

  /**
   * Opens (or keeps open) `label`'s submenu. `focusFirstItem` is `true` only for the keyboard paths
   * (ArrowRight, Enter/Space -- i.e. a real `<button>` click, which is how Enter/Space on the parent
   * surfaces here) and `false` for a hover preview, which must not steal focus from wherever it
   * already is -- see `submenuFocusRequestId`'s own comment for both halves of that.
   */
  function openSubmenu(submenuLabel: string, { focusFirstItem }: { focusFirstItem: boolean }) {
    cancelScheduledSubmenuClose();
    setOpenSubmenuLabel(submenuLabel);
    if (focusFirstItem) setSubmenuFocusRequestId((id) => id + 1);
  }

  /** Closes `label`'s submenu immediately -- a keyboard Escape/ArrowLeft, or a selection inside it.
   * `returnFocus` moves focus back to the submenu's own trigger button; the hover-close timeout
   * below handles returning focus itself, conditionally, so it does not call this with `true`. */
  function closeSubmenu(submenuLabel: string, { returnFocus }: { returnFocus: boolean }) {
    cancelScheduledSubmenuClose();
    setOpenSubmenuLabel(null);
    if (returnFocus) submenuTriggerRefs.current.get(submenuLabel)?.focus();
  }

  /**
   * Starts (or restarts) the close delay described above `SUBMENU_CLOSE_DELAY_MS`. If focus is still
   * inside the submenu when the delay elapses -- the writer moved the mouse away but had been
   * navigating by keyboard -- focus is returned to the submenu's own trigger first, rather than left
   * to fall wherever the browser puts it once the focused button is removed from the document
   * (`document.body`, in every engine this project supports).
   */
  function scheduleSubmenuClose(submenuLabel: string) {
    cancelScheduledSubmenuClose();
    submenuCloseTimerRef.current = window.setTimeout(() => {
      submenuCloseTimerRef.current = null;
      if (submenuRef.current?.contains(document.activeElement)) {
        submenuTriggerRefs.current.get(submenuLabel)?.focus();
      }
      setOpenSubmenuLabel(null);
    }, SUBMENU_CLOSE_DELAY_MS);
  }

  // Opening moves focus into the menu, which is what lets Tab and the arrow-key handling below
  // reach every item without a mouse. Closing (by any route -- Escape, selecting an item, or
  // losing focus) never moves focus on its own; only Escape's own handler returns it to the
  // trigger, matching the specific requirement in plan.md and the scope. Closing also resets any
  // open submenu: without this, reopening the menu later could render it already open from a
  // previous visit, with no `Enter`/hover behind it this time.
  useEffect(() => {
    if (!open) {
      setOpenSubmenuLabel(null);
      return;
    }
    focusableItems()[0]?.focus();
  }, [open]);

  // Moves focus to the submenu's first enabled item, following a keyboard-driven open only --
  // deliberately keyed on `submenuFocusRequestId` alone, not `openSubmenuLabel` (see that state's
  // own comment for why). `openSubmenu` calls both setters in the same event handler, which React
  // batches into one render, so this still runs after the submenu's own DOM exists -- the state
  // updates commit together, and effects run after the commit that applies both.
  useEffect(() => {
    if (submenuFocusRequestId === 0) return;
    focusableSubmenuItems()[0]?.focus();
  }, [submenuFocusRequestId]);

  // Clears a pending hover-close timer if this component unmounts (or the menu closes) while one is
  // outstanding -- otherwise it would fire later and call `setOpenSubmenuLabel` on a menu that may by
  // then be closed for an unrelated reason, or gone entirely.
  useEffect(() => {
    return () => cancelScheduledSubmenuClose();
  }, []);

  /**
   * Dismissal by anything other than the keyboard or an item's own activation. This was an `onBlur`
   * on the wrapper that closed whenever `relatedTarget` was not inside it, and that made every item
   * of every `OverflowMenu` in the application inert in Safari -- the owner's "none of the dropdown
   * buttons seem to work, whether its the 'manage subscriptions' link or the delete or share
   * buttons". WebKit does not focus a `<button>` that is pressed with a mouse, so pressing an item
   * blurred whatever had focus with `relatedTarget === null`, `contains(null)` answered `false`, the
   * menu closed on `focusout`, and the item unmounted before its `click` was ever dispatched. Focus
   * is simply the wrong signal: "where did focus go" is a browser-specific answer, and on one major
   * engine the answer for a click on a menu item is "nowhere".
   *
   * Two document-level listeners replace it, neither of which asks where focus went:
   *
   * - `pointerdown` outside this menu closes it. This is the signal that actually means "the writer
   *   is interacting with something else", it is identical in every engine, and it fires *before*
   *   `click`, so a press on a different menu's trigger dismisses this one before that trigger's own
   *   handler opens it. A press *inside* the wrapper -- including on the trigger itself, and on the
   *   submenu, which renders inside this same wrapper (`containerRef`) rather than in a portal -- is
   *   left alone, so the trigger's own `onClick` stays the single thing that toggles it shut, and a
   *   press on a submenu item reaches that item's own `click` before anything here can close the menu
   *   out from under it.
   * - `focusin` on a control outside this menu closes it, which is what keeps Tab-ing out of the
   *   menu dismissing it (the behaviour the blur handler also provided, and the one thing worth
   *   keeping from it). Focus landing on `document.body` is excluded: that means focus went
   *   *nowhere*, which is exactly what WebKit does to a pressed button, and is the defect above
   *   wearing a different event name. An outside press is what dismisses the menu in that case.
   *
   * Both are registered in the capture phase so a descendant calling `stopPropagation` cannot leave
   * a menu stuck open, and only while `open` -- a closed menu has nothing to listen for.
   */
  useEffect(() => {
    if (!open) return;

    function isInsideMenu(target: EventTarget | null): boolean {
      return containerRef.current?.contains(target as Node | null) ?? false;
    }
    function handlePointerDown(event: Event) {
      if (!isInsideMenu(event.target)) setOpen(false);
    }
    function handleFocusIn(event: FocusEvent) {
      if (event.target === document.body) return;
      if (!isInsideMenu(event.target)) setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
    };
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
    moveFocusAmong(focusableItems(), delta);
  }

  return (
    <div className="overflow-menu" ref={containerRef}>
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
          {items.map((item) => {
            if (item.submenuItems) {
              const children = item.submenuItems;
              // Every child disabled -> the parent is too, carrying the first disabled child's
              // reason (in practice there is exactly one shared reason -- see `submenuItems`' own
              // doc comment). An empty `submenuItems` is treated as "nothing to disable for" rather
              // than vacuously disabled -- `Array.prototype.every` on `[]` is `true`, which would
              // otherwise render a parent with nothing wrong and no reason to give.
              const allChildrenDisabled =
                children.length > 0 && children.every((child) => child.disabled);
              const disabledReason = allChildrenDisabled
                ? children.find((child) => child.disabledReason)?.disabledReason
                : undefined;
              const isSubmenuOpen = openSubmenuLabel === item.label;
              return (
                <div className="overflow-menu-submenu-group" key={item.label}>
                  <button
                    aria-disabled={allChildrenDisabled}
                    aria-expanded={isSubmenuOpen}
                    aria-haspopup="menu"
                    className="overflow-menu-submenu-trigger"
                    disabled={allChildrenDisabled}
                    onClick={() => {
                      if (allChildrenDisabled) return;
                      openSubmenu(item.label, { focusFirstItem: true });
                    }}
                    onKeyDown={(event) => {
                      if (allChildrenDisabled) return;
                      if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        openSubmenu(item.label, { focusFirstItem: true });
                      }
                    }}
                    onMouseEnter={() => {
                      if (allChildrenDisabled) return;
                      openSubmenu(item.label, { focusFirstItem: false });
                    }}
                    onMouseLeave={() => scheduleSubmenuClose(item.label)}
                    ref={(el) => {
                      if (el) submenuTriggerRefs.current.set(item.label, el);
                      else submenuTriggerRefs.current.delete(item.label);
                    }}
                    role="menuitem"
                    title={allChildrenDisabled ? disabledReason : undefined}
                    type="button"
                  >
                    {item.label}{' '}
                    <span aria-hidden="true" className="overflow-menu-disclosure">
                      ›
                    </span>
                  </button>
                  {isSubmenuOpen && (
                    <div
                      className="overflow-menu-list overflow-menu-submenu"
                      // Entering the floated submenu itself also has to cancel the close timer the
                      // trigger's own `onMouseLeave` just started -- the pointer's path from the
                      // trigger to here necessarily leaves the trigger's box first.
                      onMouseEnter={() => cancelScheduledSubmenuClose()}
                      onMouseLeave={() => scheduleSubmenuClose(item.label)}
                      onKeyDown={(event) => {
                        // Caught here, before the outer list's own handler, so ArrowUp/ArrowDown
                        // move only within this submenu rather than escaping into the parent menu's
                        // rows, and so Escape/ArrowLeft close only this submenu rather than the
                        // whole menu. `stopPropagation` is what keeps the outer handler from acting
                        // on the same keystroke a second time (a plain return would still let it
                        // bubble up to `menuRef`'s listener).
                        if (event.key === 'Escape' || event.key === 'ArrowLeft') {
                          event.preventDefault();
                          event.stopPropagation();
                          closeSubmenu(item.label, { returnFocus: true });
                        } else if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          event.stopPropagation();
                          moveFocusAmong(focusableSubmenuItems(), 1);
                        } else if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          event.stopPropagation();
                          moveFocusAmong(focusableSubmenuItems(), -1);
                        }
                      }}
                      ref={submenuRef}
                      role="menu"
                    >
                      {children.map((child) => (
                        <button
                          aria-disabled={child.disabled}
                          aria-label={child.ariaLabel}
                          disabled={child.disabled}
                          key={child.label}
                          onClick={() => {
                            closeSubmenu(item.label, { returnFocus: false });
                            setOpen(false);
                            child.onSelect?.();
                          }}
                          role="menuitem"
                          title={child.disabled ? child.disabledReason : undefined}
                          type="button"
                        >
                          {child.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <button
                aria-disabled={item.disabled}
                aria-label={item.ariaLabel}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
