import type { ReactNode } from 'react';
import { ZOOM_PRESET_PERCENTS } from './zoomPresets.js';

/**
 * The application's toolbar -- the 47px row `styles.css`'s `.application` budgets for -- as one
 * presentational component, rendered by the editor (`App.tsx`) and by the read-only revision
 * comparison alike.
 *
 * It exists because the comparison did not have one, and the owner's objection to that was the point
 * of this pass: "There is no toolbar, even if theres not much in the toolbar that could actually be
 * used here. Theres no scene/character navigator. Theres no inspector. It still just feels like a
 * free floating thing, not like part of the greater product." The previous pass had argued the
 * opposite -- that "a menubar of disabled labels advertises a crippled editor" -- and deliberately
 * left both rows out. The owner considered that and decided the *absence* is what breaks the sense of
 * one product, which is also how Google Docs' and Word's own version-history views behave: full
 * chrome, with what cannot apply greyed out.
 *
 * **Presentational, and editor-free.** Every piece of state and every handler arrives as a prop.
 * Nothing here imports Tiptap, ProseMirror, Yjs, the Hocuspocus provider or the pagination plugin,
 * and nothing here may: `App.tsx` imports this module, this module imports nothing of `App.tsx`'s,
 * and `scripts/check-bundle-budget.mjs` plus the comparison route's own bundle grep are what hold
 * that claim rather than this paragraph. That one-way dependency is why the comparison can render
 * the editor's own toolbar without the editor's own 144 kB arriving with it.
 *
 * **Why the element vocabulary is a prop and not an import.** `screenplayElementTypes` and
 * `displayElement` live in `@finaler-draft/screenplay-editor`, whose entry point pulls in
 * `@tiptap/core` and `@tiptap/pm`. Importing them here would put the editor's schema -- and
 * ProseMirror with it -- into the comparison's chunk, which is exactly the thing that must stay at
 * zero. The editor passes its real list; see `elementSelector` below for what the comparison passes
 * and why.
 *
 * **Disabled means disabled.** Every control that cannot act on the screen rendering it carries the
 * real `disabled` attribute on a real control, never a styled lookalike: a control that looks live
 * and silently does nothing is the defect `progress/paste-sanitization.md` requirement 2 exists to
 * stop, and it is also the one thing assistive technology and the eye must never be told different
 * answers about. There is no `aria-disabled` anywhere in this module and there must not be.
 */

/**
 * An icon-only toolbar button. Moved here from `App.tsx` unchanged -- same class names, same
 * `aria-pressed`, same `title`-from-accessible-name (App.test.tsx asserts that tooltip for every
 * icon-only control) -- so the editor's buttons and the comparison's are one implementation.
 */
export function ToolButton({
  active,
  children,
  disabled,
  label,
  onClick,
}: {
  // `| undefined` spelled out on every optional prop: `exactOptionalPropertyTypes` is on, and every
  // caller below forwards a `ToolbarAction`'s own possibly-undefined handler straight through.
  active?: boolean | undefined;
  children: ReactNode;
  disabled?: boolean | undefined;
  label: string;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={`tool-button${active ? ' active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

/** A control that either acts or is disabled, with nothing in between. `onClick` is optional only
 * because a disabled control has nothing to call; a control that is *not* disabled and has no
 * handler would be the silent no-op this component exists to make impossible, so callers pass one
 * whenever `disabled` is false. */
export interface ToolbarAction {
  readonly disabled: boolean;
  readonly onClick?: (() => void) | undefined;
}

/** A two-state control: the same as `ToolbarAction` plus whether the state it toggles is currently
 * on, which is what `aria-pressed` and `.tool-button.active` report. */
export interface ToolbarToggle extends ToolbarAction {
  readonly active: boolean;
}

export interface ToolbarElementOption {
  readonly label: string;
  readonly value: string;
}

/**
 * The element `<select>`'s state.
 *
 * `activeElement` is `undefined` on a screen with no caret, which is the comparison's case: there is
 * no block the reader is standing in, so naming any element as the active one would be false. The
 * component then renders a single disabled placeholder option reading "No active element" -- a real
 * disabled `<select>` that says what is true, rather than a greyed-out "Scene Heading" that does
 * not. The editor's own seven options are never listed on the comparison for the same reason they
 * could not be imported: they are unreachable behind a permanently disabled control, so carrying
 * them would buy nothing and cost the chunk.
 */
export interface ToolbarElementSelector {
  readonly activeElement: string | undefined;
  readonly disabled: boolean;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly options: readonly ToolbarElementOption[];
}

/**
 * The zoom control's state. The option list itself is this module's (`ZOOM_PRESET_PERCENTS`, from
 * `zoomPresets.ts`) rather than a prop, so both screens offer the identical presets by construction.
 *
 * `fitModesDisabled` is the one difference between the two screens' zoom controls, and it is a real
 * `disabled` on each `<option>`: "Fit page" and "Fit width" are computed from `.editor-region`'s
 * measured available area against the page's real dimensions (`zoom.ts`'s `resolveZoomPercent`), and
 * the comparison has no such recompute lifecycle -- adding one would be a second zoom mechanism, not
 * a shared control. The options stay present and named so the control's structure is the same on
 * both screens, and are genuinely unselectable where they cannot work.
 *
 * `presetValue` is the `<select>`'s value: the editor passes its `ZoomMode`'s percent or fit-mode
 * kind, the comparison its current percentage. It legitimately matches no option when a stepper or
 * keyboard shortcut lands off-preset -- see the control's own comment in the JSX below.
 */
export interface ToolbarZoom {
  readonly fitModesDisabled: boolean;
  readonly onChoosePreset: (value: string) => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly percent: number;
  readonly presetValue: string;
}

export interface ApplicationToolbarProps {
  readonly continuousScroll: ToolbarToggle;
  readonly elementLabels: ToolbarToggle;
  readonly elementSelector: ToolbarElementSelector;
  readonly inspector: ToolbarToggle;
  readonly navigator: ToolbarToggle;
  readonly redo: ToolbarAction;
  readonly undo: ToolbarAction;
  readonly zoom: ToolbarZoom;
}

export function ApplicationToolbar({
  continuousScroll,
  elementLabels,
  elementSelector,
  inspector,
  navigator,
  redo,
  undo,
  zoom,
}: ApplicationToolbarProps) {
  return (
    <section className="toolbar" aria-label="Screenplay tools">
      <ToolButton disabled={undo.disabled} label="Undo local change" onClick={undo.onClick}>
        ↶
      </ToolButton>
      <ToolButton disabled={redo.disabled} label="Redo local change" onClick={redo.onClick}>
        ↷
      </ToolButton>
      <span className="rule" />
      <label className="element-selector">
        <span className="visually-hidden">Active screenplay element</span>
        <select
          aria-label="Active screenplay element"
          disabled={elementSelector.disabled}
          onChange={(event) => elementSelector.onChange?.(event.target.value)}
          value={elementSelector.activeElement ?? ''}
        >
          {elementSelector.activeElement === undefined && (
            // `disabled` on the option as well as on the select: the placeholder is not a choice,
            // and it must not become one if some future screen renders this selector enabled while
            // still having no active element.
            <option disabled value="">
              No active element
            </option>
          )}
          {elementSelector.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <span className="toolbar-spacer" />
      <div className="zoom-controls">
        <button aria-label="Zoom out" onClick={zoom.onZoomOut} title="Zoom out" type="button">
          −
        </button>
        {/* One control, not two: the current percentage stays the visible, announced content in the
            middle -- the `<output>` below -- while clicking anywhere on that number opens the same
            preset `<select>` plan.md's "Zoom controls" asks for ("a preset dropdown ... a set of
            fixed percentages plus 'Fit page' and 'Fit width'. Use a real select, or a listbox that
            behaves like one"). The select is a real, fully keyboard- and screen-reader-operable
            native control, stacked exactly on top of the `<output>` via `.zoom-level`'s CSS and made
            visually transparent rather than removed -- `opacity: 0`, not `display: none` or
            `visibility: hidden`, so it stays focusable and clickable. Its own value only ever
            matches one of its own options when the caller's zoom is a fit mode or an exact preset
            percentage -- a percentage reached via the stepper buttons or a keyboard shortcut that
            lands off-preset (e.g. 85%) leaves the select showing no option selected, which is
            honest: it is a jump-to control, not a second display of the live percentage (the
            `<output>` is that, and stays visible underneath regardless of which option the select
            currently considers selected). Because `opacity: 0` also hides a focused element's own
            native focus ring, `.zoom-level:focus-within` draws the focus indicator on the visible
            wrapper instead, so a keyboard user tabbing to this control still sees where focus is. */}
        <div className="zoom-level">
          <output aria-label="Zoom level">{Math.round(zoom.percent)}%</output>
          <select
            aria-label="Zoom preset"
            onChange={(event) => zoom.onChoosePreset(event.target.value)}
            value={zoom.presetValue}
          >
            <optgroup label="Fit">
              <option disabled={zoom.fitModesDisabled} value="fit-width">
                Fit width
              </option>
              <option disabled={zoom.fitModesDisabled} value="fit-page">
                Fit page
              </option>
            </optgroup>
            <optgroup label="Percent">
              {ZOOM_PRESET_PERCENTS.map((percent) => (
                <option key={percent} value={percent}>
                  {percent}%
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <button aria-label="Zoom in" onClick={zoom.onZoomIn} title="Zoom in" type="button">
          +
        </button>
      </div>
      <span className="rule" />
      <ToolButton
        active={elementLabels.active}
        disabled={elementLabels.disabled}
        label="Toggle element labels"
        onClick={elementLabels.onClick}
      >
        ⌸
      </ToolButton>
      <ToolButton
        active={continuousScroll.active}
        disabled={continuousScroll.disabled}
        label="Toggle continuous scroll"
        onClick={continuousScroll.onClick}
      >
        ⬍
      </ToolButton>
      <ToolButton
        active={navigator.active}
        disabled={navigator.disabled}
        label="Toggle navigator"
        onClick={navigator.onClick}
      >
        ☷
      </ToolButton>
      <ToolButton
        active={inspector.active}
        disabled={inspector.disabled}
        label="Toggle inspector"
        onClick={inspector.onClick}
      >
        ☰
      </ToolButton>
    </section>
  );
}
