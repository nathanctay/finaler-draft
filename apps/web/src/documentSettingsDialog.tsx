import { useEffect, useId, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@finaler-draft/screenplay';
import {
  MARGIN_LEFT_IN,
  MARGIN_RIGHT_IN,
  PAGE_WIDTH_IN,
} from '@finaler-draft/screenplay/pageFormat';

/**
 * plan.md's "Document settings": "The parenthetical indent shows an inline warning when it is set
 * more than half an inch from the character indent in either direction. A warning, not a block --
 * the writer may have a reason." This is that threshold; the schema itself (see
 * `packages/screenplay`'s `documentSettingsSchema`) enforces only the physical-page sanity floors,
 * never this relationship -- it is presentation guidance, not a validation rule.
 *
 * The threshold is measured against the *default* gap between the two indents, not against zero
 * (i.e. not "the parenthetical is within half an inch of the character indent"). The owner
 * resolved this: `DEFAULT_DOCUMENT_SETTINGS` itself places the character indent at 3.7in and the
 * parenthetical at 3.1in -- a 0.6in gap that plan.md's "Element indents" section presents as
 * correct ("Roughly half an inch inside the character indent, which 3.7 minus 3.1 satisfies").
 * Reading "Document settings"' threshold literally as an absolute distance from the character
 * indent would put that same specification-endorsed default 0.1in past its own warning boundary,
 * which cannot be the intended reading. The warning's real intent -- "the parenthetical has
 * drifted away from the character cue" -- is about drift from the *default relationship* between
 * the two, not drift from the character indent itself. `DEFAULT_PARENTHETICAL_GAP_IN` is derived
 * from `DEFAULT_DOCUMENT_SETTINGS` rather than written as a literal `0.6`, so this tracks the
 * specification's own values and does not silently go stale if those defaults ever move.
 */
const PARENTHETICAL_WARNING_THRESHOLD_IN = 0.5;
const DEFAULT_PARENTHETICAL_GAP_IN =
  DEFAULT_DOCUMENT_SETTINGS.characterIndentIn - DEFAULT_DOCUMENT_SETTINGS.parentheticalIndentIn;

/** Loose UI guidance only, not the schema's own bounds (see `packages/screenplay`'s private
 * `MAX_ADJUSTABLE_INDENT_IN`/room floors) -- the schema remains the sole source of truth for what
 * is actually accepted, and a value this dialog lets a writer type but the schema rejects simply
 * fails validation the same way any other invalid canonical value already does in this app
 * (blocking autosave with "Draft needs attention"), rather than this dialog silently clamping it. */
const INDENT_MIN_IN = MARGIN_LEFT_IN;
const INDENT_MAX_IN = PAGE_WIDTH_IN - MARGIN_RIGHT_IN;

function parseInches(raw: string): number | undefined {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The document-settings dialog (plan.md's "Document settings"), reached from the File menu (see
 * `App.tsx`). Every field applies live, the instant it changes -- there is no separate "Apply" or
 * "Save" step, matching the rest of this app's autosave-everything convention (the title page's
 * fields work the same way). `onChange` is called with the complete next `DocumentSettings` on
 * every edit; `App.tsx` is what turns that into a live repagination
 * (`updatePaginationDocumentSettings`), updated CSS geometry (`applyPageGeometryCssVariables`),
 * and a scheduled autosave, none of which this component knows or needs to know about.
 *
 * A plain, hand-built modal (`role="dialog"`, `aria-modal="true"`) rather than the native
 * `<dialog>` element's `showModal()`: this codebase's test environment (jsdom) does not implement
 * `HTMLDialogElement.showModal`/`close` at all, and `OverflowMenu.tsx` already establishes the
 * pattern of a hand-built accessible popup elsewhere in this app, so this follows the same
 * approach rather than introducing a second one. Escape closes and returns focus to the trigger
 * (`onClose`'s caller, `App.tsx`, does the focus return); Tab/Shift+Tab cycle within the dialog's
 * own focusable controls rather than escaping into the (still-visible, but inert while this is
 * open) editor behind it.
 */
export function DocumentSettingsDialog({
  onChange,
  onClose,
  settings,
}: {
  onChange: (next: DocumentSettings) => void;
  onClose: () => void;
  settings: DocumentSettings;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, []);

  function focusableElements(): HTMLElement[] {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, input, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const elements = focusableElements();
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleIndentChange(
    field: 'characterIndentIn' | 'parentheticalIndentIn' | 'parentheticalWidthIn',
  ) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const value = parseInches(event.target.value);
      if (value !== undefined) {
        onChange({ ...settings, [field]: value });
      }
    };
  }

  // The current gap, measured the same direction as DEFAULT_PARENTHETICAL_GAP_IN
  // (character indent minus parenthetical indent) so the two are directly comparable. Drift is
  // symmetric -- a parenthetical that moved closer to the character indent than the default gap
  // warns exactly as a parenthetical that moved farther away does.
  const parentheticalGapIn = settings.characterIndentIn - settings.parentheticalIndentIn;
  const parentheticalGapDriftIn = Math.abs(parentheticalGapIn - DEFAULT_PARENTHETICAL_GAP_IN);
  const showParentheticalWarning = parentheticalGapDriftIn > PARENTHETICAL_WARNING_THRESHOLD_IN;

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog document-settings-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Document settings</h2>

        <label className="dialog-field">
          <span>Character indent (in)</span>
          <input
            aria-label="Character indent, in inches"
            max={INDENT_MAX_IN}
            min={INDENT_MIN_IN}
            onChange={handleIndentChange('characterIndentIn')}
            step={0.1}
            type="number"
            value={settings.characterIndentIn}
          />
        </label>

        <label className="dialog-field">
          <span>Parenthetical indent (in)</span>
          <input
            aria-label="Parenthetical indent, in inches"
            max={INDENT_MAX_IN}
            min={INDENT_MIN_IN}
            onChange={handleIndentChange('parentheticalIndentIn')}
            step={0.1}
            type="number"
            value={settings.parentheticalIndentIn}
          />
        </label>

        {showParentheticalWarning && (
          <p className="dialog-warning" role="status">
            The parenthetical indent has drifted more than half an inch from its usual position
            relative to the character indent.
          </p>
        )}

        <label className="dialog-field">
          <span>Parenthetical width (in)</span>
          <input
            aria-label="Parenthetical width, in inches"
            min={0}
            onChange={handleIndentChange('parentheticalWidthIn')}
            step={0.1}
            type="number"
            value={settings.parentheticalWidthIn}
          />
        </label>

        {/*
          plan.md: "'Arabic numerals' is unfamiliar phrasing to many writers; label it in plain
          language such as 'Numbers' and 'Roman numerals' rather than by numeral-system name."
          Page-number *position* is deliberately not offered here -- see this scope's progress
          log for why plan.md's own "Document settings" and "Page numbering" sections disagree on
          whether position is adjustable, and why position was resolved as fixed top-right.
        */}
        <fieldset className="dialog-field dialog-fieldset">
          <legend>Page numbers</legend>
          <label>
            <input
              checked={settings.pageNumberStyle === 'arabic'}
              name="page-number-style"
              onChange={() => onChange({ ...settings, pageNumberStyle: 'arabic' })}
              type="radio"
            />
            Numbers
          </label>
          <label>
            <input
              checked={settings.pageNumberStyle === 'roman'}
              name="page-number-style"
              onChange={() => onChange({ ...settings, pageNumberStyle: 'roman' })}
              type="radio"
            />
            Roman numerals
          </label>
        </fieldset>

        <label className="dialog-field dialog-field-checkbox">
          <input
            checked={settings.sceneNumbersEnabled}
            onChange={(event) =>
              onChange({ ...settings, sceneNumbersEnabled: event.target.checked })
            }
            type="checkbox"
          />
          Number scenes
        </label>

        <label className="dialog-field dialog-field-checkbox">
          <input
            checked={settings.autoMoreContinued}
            onChange={(event) => onChange({ ...settings, autoMoreContinued: event.target.checked })}
            type="checkbox"
          />
          Automatically insert (MORE) and CONT&apos;D
        </label>

        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
