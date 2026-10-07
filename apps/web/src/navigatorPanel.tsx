/**
 * The Navigator -- the workspace's left panel -- as one presentational component, rendered by the
 * editor (`App.tsx`) and by the read-only revision comparison alike.
 *
 * It exists for the reason `applicationToolbar.tsx` does: the comparison had no navigator, and the
 * owner's objection was that its absence is what made the comparison read as "a free floating thing,
 * not like part of the greater product." An *empty* navigator would have been as wrong as a missing
 * one, which is why the comparison fills it with something only a comparison knows -- which scenes
 * changed, and a way to jump to one (`diffNavigator.ts`).
 *
 * **Presentational.** Every entry, its label, its selected state and its click handler arrive as
 * props. Nothing here derives scenes, resolves a caret, or scrolls anything: the editor moves the
 * caret through Tiptap, the comparison scrolls a row into view, and this component knows about
 * neither. No Tiptap, no ProseMirror, no Yjs; the import list above is the whole dependency set and
 * must stay that way (see `applicationToolbar.tsx`'s comment on the one-way dependency rule).
 *
 * **The tabs are the WAI-ARIA tabs pattern**, moved here unchanged from `App.tsx`:
 * `role="tab"`/`role="tabpanel"`, Left/Right arrows moving focus and selection together (automatic
 * activation, keyed to the tablist's horizontal orientation per the pattern), a roving `tabIndex` so
 * the tablist is one Tab stop, and `aria-selected` carrying selection. The element ids
 * (`navigator-tab-*`, `navigator-panel-*`) are the pattern's wiring and are unchanged, because
 * `App.test.tsx` asserts them and because only ever one navigator is mounted at a time.
 */

/**
 * Generic in the tab id so a caller's own union survives the round trip: `App.tsx` keeps
 * `'scenes' | 'characters'` in state and gets that exact type back from `onChangeTab`, with no cast
 * at the boundary and no way to pass an id that is not one of this panel's own tabs.
 */
export interface NavigatorTab<TabId extends string = string> {
  readonly id: TabId;
  readonly label: string;
}

/**
 * How an entry differs between the two sides of a comparison. Rendered as a glyph *and* a word, never
 * as a colour alone -- the same accessibility contract the manuscript's own marks hold themselves to
 * (see the comparison route's `GUTTER_GLYPH`): the glyph is `aria-hidden` ornament, the word is
 * visually hidden and read aloud, and `data-navigator-status` is what the stylesheet colours and what
 * a test can assert without reading a computed colour.
 *
 * The editor's own navigator passes no status at all: a scene in the live document is not "added" or
 * "removed" relative to anything, so there is nothing truthful for it to mark.
 */
export type NavigatorEntryStatus = 'added' | 'removed' | 'moved' | 'changed';

const STATUS_GLYPH: Record<NavigatorEntryStatus, string> = {
  added: '+',
  removed: '-',
  changed: '~',
  moved: '⇄',
};

const STATUS_WORD: Record<NavigatorEntryStatus, string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  moved: 'Moved',
};

export interface NavigatorEntry {
  /** React key and nothing else -- never rendered, and never assumed to be a block id. */
  readonly key: string;
  readonly onSelect: () => void;
  /** The entry's own line: the editor's `1. INT. KITCHEN - DAY`, or a character's name. */
  readonly primary: string;
  /** The small trailing figure: the editor's block count, or a comparison's changed-line count. */
  readonly secondary: string;
  readonly selected: boolean;
  readonly status?: NavigatorEntryStatus | undefined;
}

export interface NavigatorPanelProps<TabId extends string = string> {
  readonly activeTabId: TabId;
  /** The entries of the active tab's panel, already in the order they should read. */
  readonly entries: readonly NavigatorEntry[];
  /** The panel's own bottom line -- a census of what the list above holds. */
  readonly footer: string;
  /**
   * Shown in place of the list when the active tab has nothing to list, so an empty tab says why it
   * is empty rather than looking broken.
   *
   * Optional, and omitted by the editor deliberately: the editor's own navigator has always rendered
   * a bare empty `<ol>` for a screenplay with no scenes (or no speaking characters), and this
   * extraction is required to leave the editor's rendered output exactly as it was. The comparison
   * supplies one, because "no scene in this comparison changed" is a real and reassuring answer that
   * an empty box does not give.
   */
  readonly emptyMessage?: string | undefined;
  readonly onChangeTab: (tabId: TabId) => void;
  readonly onClose: () => void;
  readonly tabs: readonly NavigatorTab<TabId>[];
}

export function NavigatorPanel<TabId extends string>({
  activeTabId,
  entries,
  footer,
  emptyMessage,
  onChangeTab,
  onClose,
  tabs,
}: NavigatorPanelProps<TabId>) {
  return (
    <aside className="panel navigator" aria-label="Navigator">
      <div className="panel-heading">
        <span>Navigator</span>
        <button
          aria-label="Close navigator"
          onClick={onClose}
          title="Close navigator"
          type="button"
        >
          ×
        </button>
      </div>
      <div aria-label="Navigator sections" className="panel-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            aria-controls={`navigator-panel-${tab.id}`}
            aria-selected={activeTabId === tab.id}
            className={activeTabId === tab.id ? 'selected' : ''}
            id={`navigator-tab-${tab.id}`}
            key={tab.id}
            onClick={() => onChangeTab(tab.id)}
            onKeyDown={(event) => {
              // Left/Right rather than Up/Down: `.panel-tabs` lays tabs out horizontally (see
              // styles.css), and the WAI-ARIA tabs pattern keys arrow direction to the tablist's own
              // orientation. Moves focus and switches the active tab together ("automatic
              // activation"), the same immediate-effect convention `OverflowMenu.tsx`'s Up/Down
              // already uses for its own list.
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
                return;
              }
              event.preventDefault();
              const currentIndex = tabs.findIndex((candidate) => candidate.id === activeTabId);
              const delta = event.key === 'ArrowRight' ? 1 : -1;
              const nextTab = tabs[(currentIndex + delta + tabs.length) % tabs.length];
              if (!nextTab) {
                return;
              }
              onChangeTab(nextTab.id);
              document.getElementById(`navigator-tab-${nextTab.id}`)?.focus();
            }}
            role="tab"
            // Roving tabindex: only the selected tab is a Tab stop, matching the WAI-ARIA tabs
            // pattern -- Tab moves focus in and out of the tablist as a single stop, and the
            // arrow-key handler above moves focus (and selection) within it.
            tabIndex={activeTabId === tab.id ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <ol
        aria-labelledby={`navigator-tab-${activeTabId}`}
        className="scene-list"
        id={`navigator-panel-${activeTabId}`}
        role="tabpanel"
        tabIndex={0}
      >
        {entries.length === 0 && emptyMessage !== undefined ? (
          <li className="navigator-empty">{emptyMessage}</li>
        ) : (
          entries.map((entry) => (
            <li key={entry.key}>
              <button
                className={entry.selected ? 'selected' : ''}
                data-navigator-status={entry.status}
                type="button"
                onClick={entry.onSelect}
              >
                {entry.status !== undefined && (
                  <>
                    <span className="visually-hidden">{`${STATUS_WORD[entry.status]}. `}</span>
                    <span aria-hidden="true" className="navigator-status-glyph">
                      {STATUS_GLYPH[entry.status]}
                    </span>
                  </>
                )}
                <span>{entry.primary}</span>
                <small>{entry.secondary}</small>
              </button>
            </li>
          ))
        )}
      </ol>
      <div className="navigator-footer">{footer}</div>
    </aside>
  );
}
