import { OverflowMenu, type OverflowMenuItem } from './components/OverflowMenu.js';
import type { Ref } from 'react';

/**
 * The application's menu bar -- the 31px row `styles.css`'s `.application` budgets for -- as one
 * presentational component, rendered by the editor (`App.tsx`) and by the read-only revision
 * comparison alike. See `applicationToolbar.tsx`'s own comment for why both screens now wear the
 * whole frame rather than the comparison wearing a reduced one, and for the one-way dependency rule
 * (`App.tsx` imports this; this imports nothing of `App.tsx`'s) that keeps the editor out of the
 * comparison's chunk.
 *
 * `OverflowMenu` is the only thing it imports beyond React: the same accessible popup-menu contract
 * (Enter/Space to open, arrow keys between items, Escape closes and returns focus to the trigger)
 * the account menu and the per-row overflow menus already use, and the component that already
 * renders a disabled item as a real, native-`disabled` `<button>` with its reason as the tooltip
 * rather than an enabled-looking one whose `onSelect` quietly declines -- see its own doc comment.
 * That is what lets the comparison's File menu be honest about what it cannot do without this module
 * inventing a second disabled-item convention.
 *
 * **Edit, View and Format became real menus this slice** (`progress/menus-slice-1.md`); Tools and
 * Help are later slices and stay the inert labels below. Each of the three new menus takes its
 * items the identical way File already did -- a plain array, built and gated entirely by the
 * caller -- rather than this module inventing a second shape for "menu with items" versus "menu
 * that is still a label". **A menu with no items is not rendered at all**, not rendered disabled
 * and not rendered as a label: the owner's rule is that an empty menu gets cut, which is what lets
 * the read-only revision comparison render View (it has real view preferences to offer: Navigator,
 * Inspector, dark canvas, zoom) while omitting Edit and Format outright (nothing on a stored
 * snapshot answers to either verb) instead of filling either with a wall of disabled items sharing
 * one repeated reason -- see that route's own comment on why that would be noise, not explanation,
 * unlike the File menu's disabled items, each of which explains one specific thing a reader might
 * have come looking for.
 */

/**
 * The two menus plan.md still schedules for a later increment, still inert `<span>`s rather than
 * controls. Listed here rather than written twice because they are identical on every screen that
 * wears the menubar -- and because being a `<span>` is the point: an inert label is not a control,
 * so it has no disabled state to get wrong, and no screen reader announces it as something a reader
 * can operate. The moment one of them becomes a real menu it becomes a prop, exactly as Edit, View
 * and Format already did.
 */
const INERT_MENU_LABELS = ['Tools', 'Help'] as const;

export interface ApplicationMenubarProps {
  /**
   * The Edit menu's items. Omitted (or empty) on the read-only revision comparison -- see this
   * module's own top comment -- so this is optional where `fileMenuItems` is not: File always has
   * at least "Document settings…", permanently disabled or not, on every screen that renders this
   * component at all.
   */
  readonly editMenuItems?: readonly OverflowMenuItem[] | undefined;
  /** The File menu's items, in order. Each one's own `disabled`/`disabledReason` decides whether it
   * can be chosen on this screen. */
  readonly fileMenuItems: readonly OverflowMenuItem[];
  /**
   * Attached to the `.menu-file` wrapper. `App.tsx` uses it to return focus to the File menu's
   * trigger after one of its dialogs closes -- queried through the wrapper rather than threaded out
   * of `OverflowMenu`, so the shared, independently-tested component stays untouched. A screen with
   * no dialog to return focus from passes nothing.
   */
  readonly fileMenuRef?: Ref<HTMLDivElement>;
  /** The Format menu's items. Omitted (or empty) on the read-only revision comparison -- nothing
   * about a stored snapshot's element types is this route's to change. */
  readonly formatMenuItems?: readonly OverflowMenuItem[] | undefined;
  /** The View menu's items. Present on every screen that renders this component: a comparison has
   * its own zoom state and its own dark-canvas preference (the route's own comment explains why
   * those genuinely apply to a stored snapshot), so View is never empty. */
  readonly viewMenuItems?: readonly OverflowMenuItem[] | undefined;
}

/** `undefined` and `[]` are the same instruction -- cut the menu -- so both routes through this
 * module ("prop omitted" and "prop passed empty") render identically rather than one of them
 * leaving a triggerable menu with nothing inside it. */
function hasItems(
  items: readonly OverflowMenuItem[] | undefined,
): items is readonly OverflowMenuItem[] {
  return items !== undefined && items.length > 0;
}

export function ApplicationMenubar({
  editMenuItems,
  fileMenuItems,
  fileMenuRef,
  formatMenuItems,
  viewMenuItems,
}: ApplicationMenubarProps) {
  return (
    <nav className="menubar" aria-label="Application menu">
      <div className="menubar-menu menu-file" ref={fileMenuRef}>
        <OverflowMenu items={[...fileMenuItems]} label="File menu" triggerContent="File" />
      </div>
      {hasItems(editMenuItems) && (
        <div className="menubar-menu menu-edit">
          <OverflowMenu items={[...editMenuItems]} label="Edit menu" triggerContent="Edit" />
        </div>
      )}
      {hasItems(viewMenuItems) && (
        <div className="menubar-menu menu-view">
          <OverflowMenu items={[...viewMenuItems]} label="View menu" triggerContent="View" />
        </div>
      )}
      {hasItems(formatMenuItems) && (
        <div className="menubar-menu menu-format">
          <OverflowMenu items={[...formatMenuItems]} label="Format menu" triggerContent="Format" />
        </div>
      )}
      {INERT_MENU_LABELS.map((label) => (
        <span className="menubar-inert" key={label}>
          {label}
        </span>
      ))}
    </nav>
  );
}
