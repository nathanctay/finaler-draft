import type { Ref } from 'react';
import { OverflowMenu, type OverflowMenuItem } from './components/OverflowMenu.js';

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
 */

/**
 * The five menus plan.md schedules for a later increment, still inert `<span>`s rather than
 * controls. They are listed here rather than written twice because they are identical on every
 * screen that wears the menubar -- and because being a `<span>` is the point: an inert label is not
 * a control, so it has no disabled state to get wrong, and no screen reader announces it as
 * something a reader can operate. The moment one of them becomes a real menu it becomes a prop.
 */
const INERT_MENU_LABELS = ['Edit', 'View', 'Format', 'Tools', 'Help'] as const;

export interface ApplicationMenubarProps {
  /**
   * The dark-canvas toggle. Live on every screen that has a canvas to darken, which is both of
   * them: `.dark` restyles the chrome and the surround, not the manuscript, so it is a view
   * preference rather than a document operation.
   */
  readonly canvasToggle: {
    readonly dark: boolean;
    readonly onToggle: () => void;
  };
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
}

export function ApplicationMenubar({
  canvasToggle,
  fileMenuItems,
  fileMenuRef,
}: ApplicationMenubarProps) {
  return (
    <nav className="menubar" aria-label="Application menu">
      <div className="menu-file" ref={fileMenuRef}>
        <OverflowMenu items={[...fileMenuItems]} label="File menu" triggerContent="File" />
      </div>
      {INERT_MENU_LABELS.map((label) => (
        <span key={label}>{label}</span>
      ))}
      <span className="menubar-spacer" />
      <button type="button" onClick={canvasToggle.onToggle}>
        {canvasToggle.dark ? 'Light canvas' : 'Dark canvas'}
      </button>
    </nav>
  );
}
