import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

/**
 * The application's chrome -- the six-row grid `styles.css`'s `.application` describes -- as one
 * component, so every screen that is "the application" wears it rather than reimplementing it.
 *
 * It exists because the read-only revision comparison view did not. That route rendered its own
 * `<main className="project-screen diff-screen">` with a bare `.project-header` holding one link,
 * so a writer who opened a comparison was dropped out of the editor into a visibly plainer page
 * -- while the manuscript *inside* it was already the real thing (the editor's own `.pages` /
 * `.page` / `.script-body` and the real page geometry). The historical-revision preview has never
 * had that problem, for the simple reason that it *is* the editor (`App.tsx` with
 * `historicalRevision` set). This component is what lets a route be the application's chrome
 * without being the editor.
 *
 * **Layout only.** No `Editor`, no `Y.Doc`, no ProseMirror, no router, no application state: the
 * imports above are the whole dependency list, and they must stay that way. `App.tsx` imports
 * this module; this module imports nothing of `App.tsx`'s, so the dependency runs one way only and
 * the comparison route can render the chrome without pulling Tiptap, `y-prosemirror`, the
 * Hocuspocus provider or the pagination plugin into its own chunk. `scripts/check-bundle-budget.mjs`
 * measures that claim; it is not a convention this file can be trusted to keep on its own.
 *
 * **Why the slots are explicitly placed rather than auto-placed.** `.application` used to be a
 * fixed track list filled by grid auto-placement in document order, which worked only because
 * exactly one screen rendered it and that screen always rendered every row. It also broke once,
 * in production, in the way `styles.css`'s own comment records: an extra child (`.readonly-banner`)
 * silently took the toolbar's 47px row, which shoved the toolbar into the workspace's
 * `minmax(0, 1fr)`, the workspace into the status bar's 30px, and the status bar into an implicit,
 * unstyled row past the end of the list. A comparison view that legitimately has no menubar, no
 * toolbar and a banner of its own cannot be expressed by auto-placement at all without hitting the
 * same failure by construction. Each chrome element now names its own grid area in `styles.css`
 * (`grid-area: titlebar` and friends) and each optional row collapses to `0px` through its own
 * custom property, so a missing row and an unexpected child are both inert rather than cascading.
 * The row-presence modifier classes below are the only thing that decides a row's size, and they
 * are derived from the slots themselves here -- the class and the child it budgets for cannot
 * disagree, which is what the old two-expression arrangement in `App.tsx` could not promise.
 */
export interface ApplicationShellProps {
  /**
   * The `auto`-sized row between the menubar and the toolbar: the entitlement, sync-gate,
   * historical-revision and comparison banners. `auto` rather than a fixed height because the
   * message length, and so the wrapped line count, varies by reason. Pass `undefined` when there
   * is no banner -- the row is then `0px` and nothing is reserved for it.
   */
  readonly banner?: ReactNode;
  /** The editor's dark-canvas modifier. Omitted by screens that offer no canvas to darken. */
  readonly dark?: boolean;
  /** The menu bar. Omitted by a screen with nothing to command. */
  readonly menubar?: ReactNode;
  /**
   * Children that occupy no grid row because they are out of flow: `position: fixed` floats
   * (dialogs, the toast, SmartType's list, the element menu) and screen-hidden print copy. They
   * are rendered last so a stray in-flow child is a visible, measurable defect rather than a
   * silent one -- see `page-rendering-persistence.spec.ts`'s shell-geometry measurement, which
   * asserts that the only in-flow children of `.application` are the named chrome rows.
   */
  readonly outOfFlow?: ReactNode;
  /** The status bar. Omitted by a screen with no document state to report. */
  readonly statusbar?: ReactNode;
  /** Always present: application identity, and a way out of the current document. */
  readonly titlebar: ReactNode;
  /** The editing toolbar. Omitted by a read-only screen. */
  readonly toolbar?: ReactNode;
  /** An extra modifier class on `.application`, for screen-specific rules (e.g. `diff-screen`). */
  readonly variant?: string;
  /** Always present: the one row that scrolls its own content. */
  readonly workspace: ReactNode;
}

export function ApplicationShell({
  banner,
  dark,
  menubar,
  outOfFlow,
  statusbar,
  titlebar,
  toolbar,
  variant,
  workspace,
}: ApplicationShellProps) {
  const className = [
    'application',
    dark === true ? 'dark' : undefined,
    banner === undefined ? undefined : 'has-readonly-banner',
    menubar === undefined ? 'shell-without-menubar' : undefined,
    toolbar === undefined ? 'shell-without-toolbar' : undefined,
    statusbar === undefined ? 'shell-without-statusbar' : undefined,
    variant,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');

  return (
    <main className={className}>
      {titlebar}
      {menubar}
      {banner}
      {toolbar}
      {workspace}
      {statusbar}
      {outOfFlow}
    </main>
  );
}

/**
 * The double-click-to-rename affordance's whole contract with its caller -- "similar to the
 * google docs mechanic" was the owner's own framing of the ask, and Docs commits the rename
 * itself rather than popping a dialog, which is the one thing `RenameDialog` (the 3-dot menu's
 * own `Rename…` item) does not do.
 *
 * Deliberately the *only* thing this module knows about renaming. `ApplicationTitlebar` is
 * rendered both by the router-agnostic, lazily-loaded editor and by the read-only revision-diff
 * route (see this file's own top comment), and must gain no `fetch`, no query client, and no
 * notion of "owner" of its own -- a second enforcement point here would be exactly the kind of
 * authorization duplication `packages/database/src/membership.ts`'s own doc comment warns about,
 * just moved into the UI instead of the server. So every decision that needs to know *who* is
 * renaming or *what counts as valid* is made by the caller, before this component ever sees it:
 * `App.tsx` supplies `rename` only for the screenplay's owner (never for a non-owner, and never
 * for the historical-revision preview), and `maxLength` is a plain number so this file never
 * imports `@finaler-draft/config`'s `RESOURCE_TITLE_MAX_LENGTH` to get it -- the caller already
 * has, for the same reason `RenameDialog` does.
 *
 * What *is* this component's job, because it is pure interaction mechanics with no business
 * meaning of its own: entering and leaving edit mode (double-click, or Enter/Space for a
 * keyboard-only writer -- this project has already rejected mouse-only affordances once, see
 * `progress/download-submenu.md`'s hover-plus-keyboard decision for the Download submenu),
 * pre-filling and selecting the field on entry, Escape discarding the draft, and Enter or a blur
 * (clicking away, including into the manuscript) committing it. "Committing" here means calling
 * `onRename` with the trimmed value -- never for a blank or unchanged one, both of which are
 * silently discarded instead (no network call, no visible error: Docs itself does not show one
 * for an emptied title either, it just will not let the title stay that way) -- and then exiting
 * edit mode immediately, win or lose. There is no local "pending" display state: the titlebar
 * goes straight back to showing whatever `documentTitle` prop it was handed, which is still the
 * *old* title until the caller's own state updates on success. That is also the entire mechanism
 * behind "a server refusal restores the previous title": nothing here was ever changed to begin
 * with, so there is nothing to revert.
 */
export interface TitleRenameCapability {
  /**
   * The input's native `maxLength`, so the browser itself refuses a keystroke past the bound the
   * caller's own validation (and the server's) enforces -- the same mechanism `RenameDialog`'s
   * own input already uses, read from `RESOURCE_TITLE_MAX_LENGTH` by the caller, never restated
   * as a second literal here.
   */
  readonly maxLength: number;
  /**
   * Called with the new title -- already trimmed, already confirmed non-blank and different from
   * `documentTitle` -- once the writer commits. Never called for a blank or unchanged value; see
   * this interface's own top comment for why those are silently discarded instead. Whatever this
   * does with a rejection (network failure, a 403) is entirely the caller's concern: this
   * component awaits it and returns to display mode regardless of the outcome, showing whichever
   * `documentTitle` it is next handed.
   */
  readonly onRename: (title: string) => Promise<void>;
}

/**
 * The title bar itself, shared rather than described twice: the brand mark and the account badge
 * are byte-identical on every screen that wears the chrome, and the document title is the one
 * thing that differs. A screen supplies its own `indicator` (the editor's save dot) only if it has
 * a document state worth a dot; a read-only screen has none and passes nothing. `rename` is the
 * same shape of optional capability -- see `TitleRenameCapability`'s own doc comment -- and is
 * omitted by every caller except the live screenplay editor rendering for its own owner; every
 * other caller (every non-owner viewer, and the read-only revision-diff route, which never
 * supplies it at all) gets back exactly the plain, inert text this element has always rendered.
 */
export function ApplicationTitlebar({
  documentTitle,
  documentType,
  indicator,
  rename,
}: {
  readonly documentTitle: string;
  readonly documentType: string;
  readonly indicator?: ReactNode;
  /** `| undefined` explicitly, not a bare `?:`. `tsconfig` sets `exactOptionalPropertyTypes`, under
   * which `?:` means "may be absent" and not "may be present and undefined" -- and the editor
   * computes this capability conditionally (owner or not), so it genuinely passes `undefined`
   * rather than omitting the prop. Matches `OverflowMenuItem`'s `disabledReason?: string | undefined`
   * for the same reason. */
  readonly rename?: TitleRenameCapability | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(documentTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set just before every programmatic exit from edit mode (a commit or a cancel), and read (and
  // cleared) by `handleBlur` below. Exists because exiting edit mode unmounts the `<input>`, and
  // a browser may fire a genuine `blur` on an element as a side effect of removing it from the
  // document -- without this guard, committing via Enter (or cancelling via Escape) could make
  // `handleBlur` fire straight after and commit a *second* time for the same keystroke. A blur
  // this component did not itself cause by exiting -- the writer actually clicking or tabbing
  // away -- is the only kind `handleBlur` is left to treat as a real commit.
  //
  // **Unverified, and knowingly kept.** Deleting this guard leaves every test in
  // `applicationShell.test.tsx` green: jsdom fires no `blur` when a focused element unmounts, so
  // the sequence it defends against cannot be reproduced there, and whether a given real engine
  // fires one is not something this project has measured. It is retained because a spurious second
  // commit would issue a redundant write with the writer's own value, which is harmless, whereas
  // removing it on the strength of one environment's behaviour is a bet on every other engine
  // agreeing. Do not treat it as covered.
  const exitingRef = useRef(false);

  // Pre-filled and selected on entry, matching the desktop rename convention the brief asked for
  // ("similar to the google docs mechanic"): typing immediately replaces the current title rather
  // than requiring the writer to clear it first.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function beginEditing() {
    if (!rename) return;
    setDraft(documentTitle);
    setEditing(true);
  }

  function exitEditing(commit: boolean) {
    exitingRef.current = true;
    setEditing(false);
    if (!commit) return;
    const trimmed = draft.trim();
    // Both silently discarded, never sent to `onRename` and never shown as an error: a blank
    // title has nothing to save (this interface's own comment on why that mirrors Docs rather
    // than inventing a validation message), and an unchanged one would be a write with nothing
    // for the server to do -- the exact "no-op write" the brief calls out by name.
    if (trimmed.length === 0 || trimmed === documentTitle) return;
    void rename?.onRename(trimmed);
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      exitEditing(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      exitEditing(false);
    }
  }

  // Clicking away -- including into the manuscript, which the brief names as the one path worth
  // double-checking -- commits, exactly as Docs does. This handler does not call
  // `preventDefault`/`stopPropagation` on anything, so the click that caused this blur is never
  // intercepted here: it keeps bubbling to whatever it actually landed on (the editor's own
  // mousedown handling included) precisely as it would if this were a plain, non-interactive
  // title: this handler calls neither `preventDefault` nor `stopPropagation`, so the click that
  // caused the blur keeps bubbling to whatever it actually landed on, the editor's own mousedown
  // handling included, exactly as it would if this were plain non-interactive text.
  //
  // What is and is not proven about that: the commit-on-blur behaviour itself is asserted in
  // `applicationShell.test.tsx`. That a real click landing in the manuscript both commits this
  // *and* reaches the editor is **not** covered by an automated test -- it needs a real browser
  // with a loaded, authorized editor, which means the database-backed persistence harness, and no
  // such case was written. It rests on the no-interception property above, which is a matter of
  // code inspection rather than measurement.
  function handleBlur() {
    if (exitingRef.current) {
      exitingRef.current = false;
      return;
    }
    exitEditing(true);
  }

  function handleTitleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    // Enter or Space, not a native `onClick`: a single mouse click must *not* enter edit mode
    // (only a double-click does, per the brief -- Docs itself requires the same), but a
    // keyboard-only writer has no equivalent of "double-press" and must reach edit mode from one
    // ordinary activation. Handling the keys directly, rather than relying on the button's own
    // synthesized click, is what lets a single click and a single keypress disagree on purpose.
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      beginEditing();
    }
  }

  const titleNode =
    rename && editing ? (
      <input
        aria-label={`${documentType} title`}
        className="document-title-input"
        maxLength={rename.maxLength}
        onBlur={handleBlur}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleInputKeyDown}
        ref={inputRef}
        value={draft}
      />
    ) : rename ? (
      // A `<button>`, not a styled `<div>`, so focusability, keyboard activation and an
      // accessible name all come from the one element rather than being bolted on with
      // `role`/`tabIndex` -- and so its *nature* (that it does something) is discoverable to
      // assistive technology from the accessible name alone, per the brief, rather than only
      // implied by a cursor or hover style a screen reader cannot see.
      <button
        aria-label={`Rename "${documentTitle}"`}
        className="document-title-rename"
        onDoubleClick={beginEditing}
        onKeyDown={handleTitleKeyDown}
        type="button"
      >
        {documentTitle}
      </button>
    ) : (
      documentTitle
    );

  return (
    <header className="titlebar">
      {/*
        A plain anchor, not the router's `Link`: this module is rendered both by the
        router-agnostic, lazily-loaded editor (see the editor route's `lazy(...)` import and
        `App.tsx`'s own standalone test suite, neither of which provides router context) and by
        ordinary routes, and the editor had no way out of a screenplay but the browser's back
        button before this existed. A full navigation to /projects is a small cost for a control
        used rarely and deliberately, against the alternative of requiring router context in the
        chrome itself. The accessible name leads with the visible "Finaler Draft" text per
        WCAG 2.5.3.
      */}
      <a aria-label="Finaler Draft — back to your projects" className="brand" href="/projects">
        <span className="brand-mark">F</span>
        <span>Finaler Draft</span>
      </a>
      <div className="document-title">
        {indicator}
        {titleNode} <span className="title-type">{documentType}</span>
      </div>
      <span className="account-button" aria-label="Signed-in writer">
        FD
      </span>
    </header>
  );
}
