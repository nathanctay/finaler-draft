import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Edit > Find and replace… (menus slice 4). Deliberately **not** `DocumentSettingsDialog`'s own
 * modal shell -- every other dialog in this app (`word-count`, `feedback`, `keyboard-shortcuts`,
 * …) covers the screen behind a `.dialog-overlay` because what it shows has no relationship to the
 * manuscript underneath. This one's entire job is the opposite: the brief requires "every match
 * visibly highlighted in the document", which an overlay that blocks the document would make
 * impossible to honour. So this is a small, non-modal, floating panel -- `position: fixed`,
 * `.find-replace-bar` in styles.css, the same vocabulary `.toast`/`.smarttype-list` already use for
 * "chrome that floats over the canvas without pretending to be part of it" -- that leaves the
 * manuscript beneath it fully visible and fully scrollable while it is open. There is no focus
 * trap and no `role="dialog"`/`aria-modal`: a writer can click back into the document, keep typing,
 * and reopen this bar's query field later, exactly as a browser's own in-page find behaves.
 *
 * All of the actual searching lives in `findReplace.ts` -- this component is purely presentational,
 * following the same division every other dialog in this app already uses (`WordCountDialog`,
 * `FeedbackDialog`): `App.tsx` owns the live `editor`, reads `findReplacePluginKey`'s state after
 * every transaction, and hands this component plain values and callbacks. Nothing here touches
 * ProseMirror, Tiptap, or Yjs directly.
 */
export interface FindReplaceBarProps {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly matchCount: number;
  /** 1-based position of the current match among `matchCount`, or `0` when there is none (no
   * query, or a query with no matches) -- the same "0 means nothing to report" convention
   * `WordCountDialog`'s own `selection` field uses. */
  readonly currentMatchNumber: number;
  /** Read-only writers (a reviewer, or a lapsed entitlement) may still search -- gating this would
   * break the one thing Find is for even when nothing may be changed. Only Replace and Replace all
   * are gated, exactly like the File menu's export items: a real, named `disabledReason`, not a
   * dead control. */
  readonly editingAllowed: boolean;
  /** Shown as both replace controls' `title` whenever `editingAllowed` is `false`; `undefined`
   * otherwise. Supplied by the caller rather than computed here, matching every other
   * `disabledReason` in this app (`App.tsx`'s own `readOnlyMenuReason`) -- one sentence, written
   * once, not re-derived per control that needs it. */
  readonly replaceDisabledReason: string | undefined;
  readonly onQueryChange: (query: string) => void;
  readonly onCaseSensitiveChange: (caseSensitive: boolean) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onReplace: (replacement: string) => void;
  readonly onReplaceAll: (replacement: string) => void;
  readonly onClose: () => void;
}

function matchCountLabel(query: string, matchCount: number, currentMatchNumber: number): string {
  if (query === '') {
    return '';
  }
  if (matchCount === 0) {
    return 'No matches';
  }
  return `${currentMatchNumber} of ${matchCount}`;
}

export function FindReplaceBar({
  caseSensitive,
  currentMatchNumber,
  editingAllowed,
  matchCount,
  onCaseSensitiveChange,
  onClose,
  onNext,
  onPrevious,
  onQueryChange,
  onReplace,
  onReplaceAll,
  query,
  replaceDisabledReason,
}: FindReplaceBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const queryInputRef = useRef<HTMLInputElement>(null);
  const [replacement, setReplacement] = useState('');

  // Opens with the query field already focused -- a writer who chose "Find and replace…" from
  // the menu, or pressed Mod-f, means to type a query immediately, the same "focus the first
  // useful control" convention every other dialog here follows (`WordCountDialog` focuses its
  // Close button only because it has nothing more useful to offer; this has somewhere better).
  useEffect(() => {
    queryInputRef.current?.focus();
  }, []);

  const hasMatches = matchCount > 0;
  const replaceDisabled = !editingAllowed || !hasMatches;
  const replaceTitle = !editingAllowed ? replaceDisabledReason : undefined;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    // `Mod-f` pressed again while this bar already has focus would otherwise fall straight
    // through to the browser's own native in-page find (this bar's own query input is a plain
    // DOM `<input>`, outside the ProseMirror `contenteditable` region that `FindReplaceExtension`'s
    // keymap binding actually intercepts) -- opening a second find UI on top of this one. There is
    // nothing to *do* beyond refocusing the field that is already open and already focused in the
    // overwhelmingly common case; what matters is that the browser's own popup never appears.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      queryInputRef.current?.focus();
    }
  }

  function handleQueryKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter/Shift+Enter advances/retreats through matches, the same convention a browser's own
    // in-page find uses, so a writer who only ever touches the keyboard never needs the
    // next/previous buttons at all. The query field never submits a form -- there is none -- so
    // this is the only place Enter needs handling.
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.shiftKey) {
      onPrevious();
    } else {
      onNext();
    }
  }

  return (
    <div
      aria-label="Find and replace"
      className="find-replace-bar"
      onKeyDown={handleKeyDown}
      ref={barRef}
      role="search"
    >
      <div className="find-replace-row">
        <input
          aria-label="Find"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleQueryKeyDown}
          placeholder="Find"
          ref={queryInputRef}
          type="text"
          value={query}
        />
        <span aria-live="polite" className="find-replace-count">
          {matchCountLabel(query, matchCount, currentMatchNumber)}
        </span>
        <button
          aria-label="Previous match"
          disabled={!hasMatches}
          onClick={onPrevious}
          type="button"
        >
          ‹
        </button>
        <button aria-label="Next match" disabled={!hasMatches} onClick={onNext} type="button">
          ›
        </button>
        <label className="find-replace-case">
          <input
            checked={caseSensitive}
            onChange={(event) => onCaseSensitiveChange(event.target.checked)}
            type="checkbox"
          />
          <span>Case-sensitive</span>
        </label>
        <button aria-label="Close find and replace" onClick={onClose} type="button">
          ×
        </button>
      </div>
      <div className="find-replace-row">
        <input
          aria-label="Replace with"
          disabled={!editingAllowed}
          onChange={(event) => setReplacement(event.target.value)}
          placeholder="Replace"
          title={replaceTitle}
          type="text"
          value={replacement}
        />
        <button
          disabled={replaceDisabled}
          onClick={() => onReplace(replacement)}
          title={replaceTitle}
          type="button"
        >
          Replace
        </button>
        <button
          disabled={replaceDisabled}
          onClick={() => onReplaceAll(replacement)}
          title={replaceTitle}
          type="button"
        >
          Replace all
        </button>
      </div>
    </div>
  );
}
