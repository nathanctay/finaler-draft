import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  MAPPABLE_BLOCK_TYPES,
  type FdxUnknownType,
  type FdxUnknownTypeResolution,
  type FdxUnknownTypeResolutions,
  type MappableBlockType,
} from '@finaler-draft/fdx';

/**
 * Task 2 of the FDX-import slice (`progress/fdx-import.md`): the owner's own words were "we need
 * to be more descriptive with our error... a modal pops up that says the element that can't be
 * imported and allows the user to skip or manually designate to an element type." This is that
 * modal.
 *
 * It appears in place of the old flat failure whenever `fdxToScreenplay` throws
 * `FdxUnknownTypesError` -- every distinct FDX paragraph `Type` this product does not recognize,
 * named with its occurrence count and an excerpt of its first instance, gathered in a single pass
 * over the document (`@finaler-draft/fdx`'s own doc comment on that error). The writer decides
 * *per type*, not per paragraph: skip it, or map every paragraph of that type to one of the seven
 * canonical leaf element types. **Nothing proceeds until every listed type has a decision** --
 * `allResolved` below gates the one button that can move this forward, and nothing is ever
 * guessed on this component's own initiative; an unresolved type simply cannot be submitted.
 *
 * Cancelling here is exactly as final as cancelling `FdxImportConfirmDialog`: this component makes
 * no API call and holds no screenplay of its own, only the decisions map, so there is nothing to
 * undo. Resolving flows into that *existing* confirmation dialog rather than becoming a second,
 * competing one -- `onResolve` hands the route a complete `FdxUnknownTypeResolutions`, the route
 * calls `fdxToScreenplay` a second time with it, and (because every type reported here is now
 * covered) that second call proceeds to the ordinary parsed-and-ready state
 * `FdxImportConfirmDialog` already shows.
 *
 * Follows `FdxImportConfirmDialog`'s and `DocumentSettingsDialog`'s identical modal shell
 * (`role="dialog"`, `aria-modal="true"`, Tab/Shift+Tab focus trap, Escape cancels) rather than
 * introducing a fourth pattern.
 */
export function FdxUnknownTypesDialog({
  filename,
  onCancel,
  onResolve,
  unknownTypes,
}: {
  filename: string;
  onCancel: () => void;
  /** Called once, only once every type below has a decision, with a complete
   * `FdxUnknownTypeResolutions` covering all of them. */
  onResolve: (resolutions: FdxUnknownTypeResolutions) => void;
  /** Every distinct unrecognised `Type`, as `FdxUnknownTypesError` reported them -- in the order
   * that error listed them (first-seen order in the document). */
  unknownTypes: readonly FdxUnknownType[];
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [decisions, setDecisions] = useState<Record<string, FdxUnknownTypeResolution>>({});

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('select, button')?.focus();
  }, []);

  function focusableElements(): HTMLElement[] {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), select, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusableElements();
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function decisionFor(type: string): FdxUnknownTypeResolution | undefined {
    return decisions[type];
  }

  /** The `<select>`'s own value space: `''` (no decision yet), `'skip'`, or `map:<blockType>`.
   * Encoded as one string rather than two controls per row because a single `<select>` keeps each
   * type's decision atomic -- there is no in-between state where "skip" and a block type are both
   * or neither selected, which two independent controls (a checkbox plus a select, say) would
   * allow. */
  function selectValueFor(type: string): string {
    const decision = decisionFor(type);
    if (decision === undefined) return '';
    return decision.action === 'skip' ? 'skip' : `map:${decision.blockType}`;
  }

  function handleSelectChange(type: string, rawValue: string) {
    setDecisions((current) => {
      if (rawValue === '') {
        const next = { ...current };
        delete next[type];
        return next;
      }
      const next: FdxUnknownTypeResolution =
        rawValue === 'skip'
          ? { action: 'skip' }
          : { action: 'map', blockType: rawValue.slice('map:'.length) as MappableBlockType };
      return { ...current, [type]: next };
    });
  }

  const allResolved = unknownTypes.every((entry) => decisionFor(entry.type) !== undefined);

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog fdx-unknown-types-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Unrecognized content in &ldquo;{filename}&rdquo;</h2>
        <p>
          This file contains {unknownTypes.length}{' '}
          {unknownTypes.length === 1 ? 'element type' : 'element types'} this product does not
          recognize yet. Choose what to do with each one before importing.
        </p>
        <ul className="fdx-unknown-types-list">
          {unknownTypes.map((entry) => (
            <li className="fdx-unknown-type" key={entry.type}>
              <p className="fdx-unknown-type-heading">
                <strong>{entry.type}</strong> &mdash; {entry.count}{' '}
                {entry.count === 1 ? 'occurrence' : 'occurrences'}
              </p>
              {entry.excerpt.length > 0 && (
                <p className="fdx-unknown-type-excerpt muted">&ldquo;{entry.excerpt}&rdquo;</p>
              )}
              <label className="dialog-field">
                <span>{`Action for "${entry.type}"`}</span>
                <select
                  aria-label={`Action for "${entry.type}"`}
                  onChange={(event) => handleSelectChange(entry.type, event.target.value)}
                  value={selectValueFor(entry.type)}
                >
                  <option value="">Choose…</option>
                  <option value="skip">Skip (leave out of the import)</option>
                  {MAPPABLE_BLOCK_TYPES.map((blockType) => (
                    <option key={blockType} value={`map:${blockType}`}>
                      Map to {MAPPABLE_BLOCK_TYPE_LABELS[blockType]}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!allResolved}
            onClick={() => {
              if (!allResolved) return;
              onResolve(decisions);
            }}
            title={allResolved ? undefined : 'Choose an action for every type listed above.'}
            type="button"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

/** Plain-language labels for `MAPPABLE_BLOCK_TYPES`, in the writer-facing dropdown -- matches how
 * this app already names these elements elsewhere (e.g. the element menu), not the schema's own
 * `snake_case` discriminant values. */
const MAPPABLE_BLOCK_TYPE_LABELS: Record<MappableBlockType, string> = {
  action: 'Action',
  scene_heading: 'Scene heading',
  character: 'Character',
  dialogue: 'Dialogue',
  parenthetical: 'Parenthetical',
  transition: 'Transition',
  shot: 'Shot',
};
