import type { ReactNode } from 'react';

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
 * The title bar itself, shared rather than described twice: the brand mark and the account badge
 * are byte-identical on every screen that wears the chrome, and the document title is the one
 * thing that differs. A screen supplies its own `indicator` (the editor's save dot) only if it has
 * a document state worth a dot; a read-only screen has none and passes nothing.
 */
export function ApplicationTitlebar({
  documentTitle,
  documentType,
  indicator,
}: {
  readonly documentTitle: string;
  readonly documentType: string;
  readonly indicator?: ReactNode;
}) {
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
        {documentTitle} <span className="title-type">{documentType}</span>
      </div>
      <span className="account-button" aria-label="Signed-in writer">
        FD
      </span>
    </header>
  );
}
