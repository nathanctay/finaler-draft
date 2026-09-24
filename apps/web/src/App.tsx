import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  deriveCharacters,
  deriveScenes,
  type DerivedCharacter,
  type DerivedScene,
  type DocumentSettings,
  type Screenplay,
  type ScreenplayBlock,
} from '@finaler-draft/screenplay';
import { PAGE_HEIGHT_IN, PAGE_WIDTH_IN } from '@finaler-draft/screenplay/pageFormat';
import { TRANSIENT_SYNC_AUTH_FAILURE_REASON } from '@finaler-draft/config';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  convertActiveScreenplayBlock,
  createRemotePresenceExtension,
  displayElement,
  findScreenplayBlockPosition,
  getActiveScreenplayBlock,
  editorContentFromScreenplay,
  nonEmptyEditorContent,
  projectLocalScreenplay,
  createLocalScreenplayYDoc,
  createScreenplayEditorInit,
  screenplayElementTypes,
  SCREENPLAY_YJS_FRAGMENT,
  type LocalScreenplayProjection,
  type ScreenplayElementType,
} from './screenplayEditor.js';
import {
  PaginationExtension,
  paginationPluginKey,
  updatePaginationDocumentSettings,
} from './paginationExtension.js';
import { PAGE_GAP_IN, pageStackMinHeightIn } from './pagination.js';
import { SeamCaretExtension } from './seamCaret.js';
import { SmartTypeGhostExtension } from './smartTypeGhost.js';
import { SmartTypeList, SmartTypeListExtension } from './smartTypeList.js';
import { ElementMenu, ElementMenuExtension } from './elementMenu.js';
import { MessageApiError, type PersistedScreenplay } from './api.js';
import { COLLAB_WS_URL } from './collabConfig.js';
import { applyPageGeometryCssVariables } from './pageGeometryCss.js';
import { TitlePageView } from './titlePageEditor.js';
import {
  titlePageFromState,
  titlePageStateFromTitlePage,
  type TitlePageState,
} from './titlePageState.js';
import { DocumentSettingsDialog } from './documentSettingsDialog.js';
import { OverflowMenu } from './components/OverflowMenu.js';
import { ParticipantIndicator } from './components/ParticipantIndicator.js';
import { Toast } from './components/Toast.js';
import {
  applyPinchWheelDelta,
  captureCentredScroll,
  capturePointerAnchoredScroll,
  clampZoomPercent,
  measureAvailableArea,
  resolveZoomPercent,
  restoreCentredScroll,
  restorePointerAnchoredScroll,
  ZOOM_DEFAULT_PERCENT,
  ZOOM_PRESET_PERCENTS,
  ZOOM_STEP_PERCENT,
  type PointerZoomCapture,
  type ZoomMode,
  type ZoomScrollCapture,
} from './zoom.js';

type Panel = 'navigator' | 'inspector';

function ToolButton({
  active,
  children,
  disabled,
  label,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
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

function wordsInProjection(projection: LocalScreenplayProjection): number {
  if (!projection.valid) {
    return 0;
  }

  return projection.screenplay.blocks.reduce((total: number, block: ScreenplayBlock) => {
    if (block.type === 'page_break' || block.type === 'dual_dialogue') {
      return total;
    }
    return total + (block.text.trim() === '' ? 0 : block.text.trim().split(/\s+/u).length);
  }, 0);
}

function activeScene(
  activeBlockId: string | undefined,
  scenes: readonly DerivedScene[],
): DerivedScene | undefined {
  if (!activeBlockId) {
    return scenes[0];
  }

  return scenes.find(
    (scene) =>
      scene.id === activeBlockId ||
      scene.body.some((block: ScreenplayBlock) => block.id === activeBlockId),
  );
}

// Unlike `activeScene`, there is no "current character" to default to when nothing is focused
// yet, so this stays unselected (rather than falling back to `characters[0]`) until the caret is
// somewhere real. `character.blockIds` -- the cue plus its contiguous parenthetical/dialogue run,
// per `deriveCharacters`'s own doc comment -- is what makes this a membership test rather than a
// walk: standing anywhere in a character's speech highlights them, not only on the cue line
// itself, and the boundary is decided once, in the derivation, by the same rule
// `packages/layout`'s `groups.ts` uses for pagination.
function activeCharacter(
  activeBlockId: string | undefined,
  characters: readonly DerivedCharacter[],
): DerivedCharacter | undefined {
  if (!activeBlockId) {
    return undefined;
  }

  return characters.find((character) => character.blockIds.includes(activeBlockId));
}

/**
 * The Navigator's two tabs (`App.tsx`'s `.panel-tabs`). Previously a pair of inert `<span>`s --
 * plan.md's own description: "no click handler, no derived character list, and no
 * click-to-navigate." Modeled as `role="tab"`/`role="tabpanel"` per the WAI-ARIA tabs pattern
 * (arrow keys move focus and switch tabs, only the active tab is in the Tab order, selection is
 * exposed via `aria-selected`) rather than the ad hoc `<span className="selected">` it replaces,
 * per plan.md's design rules: "full keyboard operation, visible focus, semantic controls."
 */
const NAVIGATOR_TABS = [
  { id: 'scenes', label: 'Scenes' },
  { id: 'characters', label: 'Characters' },
] as const;

type NavigatorTabId = (typeof NAVIGATOR_TABS)[number]['id'];

const legacyInitial: PersistedScreenplay = {
  id: '7c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
  projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
  title: 'The Long Way Home',
  screenplay: {
    annotations: [],
    blocks: [
      {
        id: '2175a1b6-8d05-4e6e-bac7-e471e8df33a1',
        type: 'scene_heading',
        text: 'INT. APARTMENT - MORNING',
      },
      {
        id: 'ba53c2dc-10a6-46d7-a409-9aabbff7cf5d',
        type: 'action',
        text: 'Sunlight settles across a drafting table. MARA studies the last page of a script.',
      },
      { id: '5e4c810d-75d9-4e2e-a1a2-0f7cb30fd77b', type: 'character', text: 'MARA' },
      {
        id: '0f2b5f3c-6d17-4f18-8d95-90b06e93e13a',
        type: 'dialogue',
        text: 'If the ending is true, it has to earn its way there.',
      },
      { id: 'd01faf47-64e7-4f7c-853a-3c6ace1464ad', type: 'transition', text: 'CUT TO:' },
      {
        id: '7e00a5b4-e629-42ea-98e7-705ff5ce46b1',
        type: 'scene_heading',
        text: 'EXT. UNION STATION - CONTINUOUS',
      },
      {
        id: 'b4f2a758-8f86-465e-9a9e-485612244317',
        type: 'shot',
        text: 'CLOSE ON the arrival clock as it changes to noon.',
      },
    ],
    id: '7c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
    schemaVersion: 1,
    title: 'The Long Way Home',
    titlePages: [],
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
  } satisfies Screenplay,
};

const unavailableEditorContent = {
  content: [],
  type: 'screenplayDocument' as const,
};

// Bounds how long this tab's first sync is allowed to stay silent (`syncState === 'connecting'`,
// with no `synced` and no `authenticationFailed` at all) before the writer is told something is
// wrong -- the backstop the sync-reporting effect below schedules. Deliberately generous: an
// ordinary handshake, and even a couple of automatic retries after a transient failure, finish in
// well under this, so it only ever fires for a genuinely stuck connection.
const SYNC_TIMEOUT_MS = 20_000;

// How long to wait before retrying after a transient `authenticationFailed` (`apps/collab`'s
// `TransientAuthenticationError`), growing with each consecutive failure so a sustained outage
// becomes a backing-off retry loop rather than a tight one hammering the collab server -- and,
// through it, Postgres -- once per handshake. The sync-reporting effect below resets the count
// the moment a sync actually lands.
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

// `useEditor`'s own React binding (`@tiptap/react`'s `EditorInstanceManager.onRender`) compares
// every option's *object identity* on every render of `<App>` and calls `editor.setOptions(...)`
// whenever any of them differ -- `extensions` specifically by per-element identity, everything
// else (including `editorProps`) by `!==`. An inline object literal here would therefore fail
// that comparison on every single render, not only ones that actually changed anything, forcing a
// full ProseMirror plugin reconfigure each time. Hoisted to a module-level constant so its
// identity never changes: it is fully static (no per-screenplay or per-render data), so there is
// nothing for it to ever need to vary with.
const editorProps = {
  attributes: {
    'aria-label': 'Screenplay editing canvas',
    'aria-multiline': 'true',
    role: 'textbox',
  },
};

/**
 * Set by the route (`routes/projects/$projectId.screenplays.$screenplayId.tsx`) whenever the
 * signed-in account's entitlement -- not this editor's own schema support, which
 * `initialContent` above already governs -- forbids editing *this* screenplay right now
 * (plan.md's "What happens when a subscription lapses": a lapsed account keeps every screenplay
 * readable and exportable, but only one, chosen, screenplay editable). `undefined` means
 * entitlement raises no objection, so every existing caller of `App` -- this file's own demo
 * default and every test that doesn't pass this prop -- keeps its prior, entitlement-unaware
 * behavior exactly.
 *
 * This is deliberately *not* a second read-only mechanism: `editingAllowed` below combines this
 * with `initialContent !== undefined` into the one flag that actually gates the editor, reusing
 * the seam that already exists for "this screenplay can't be edited here" rather than growing a
 * parallel one. `message` and `onMakeEditable` are precomputed by the route, which is the layer
 * that actually holds the account's entitlement snapshot -- `App` has no way to know whether this
 * screenplay is even a candidate the account could choose, so it never guesses.
 */
export interface EntitlementReadOnly {
  /** Why this screenplay can't be edited right now, shown verbatim in the read-only banner. */
  message: string;
  /**
   * Present only when this screenplay is a live candidate this account could make its editable
   * one (an owner/editor role screenplay under the account's own entitlement snapshot, not a
   * reviewer's, and not some other account's screenplay entirely) -- omitted otherwise, which
   * hides the action rather than offering a button that could only ever fail with "not found".
   * Resolves once the account's editable slot has actually changed; rejects (typically a
   * `MessageApiError` carrying the server's own explanation) on a cooldown or any other failure,
   * which the banner surfaces inline rather than silently swallowing.
   */
  onMakeEditable?: (() => Promise<void>) | undefined;
  /**
   * A human-readable local date/time, present only when `onMakeEditable` is also present *and*
   * the account's own switch-slot cooldown is, right now, still active -- computed by the route
   * from the same `cooldownEndsAt` `GET /api/entitlement` already returns (entitlements.ts's
   * `EDITABLE_SLOT_COOLDOWN_MS`, evaluated server-side), never a client-recomputed interval. This
   * is display data, not enforcement: the button still relies on the server's own 409 as the real
   * gate (see `onMakeEditable`'s own doc comment on what a rejection means), and a stale or
   * absent value here only ever costs a possible extra round trip, never a false "you may edit."
   */
  cooldownUntil?: string | undefined;
}

export function App({
  entitlementReadOnly,
  initial = legacyInitial,
}: {
  entitlementReadOnly?: EntitlementReadOnly | undefined;
  initial?: PersistedScreenplay;
}) {
  const [panels, setPanels] = useState<Record<Panel, boolean>>({
    navigator: true,
    inspector: true,
  });
  // Which Navigator tab is showing -- view state, not document state, same category as `zoom` and
  // `showLabels` below: it never travels with the canonical screenplay.
  const [navigatorTab, setNavigatorTab] = useState<NavigatorTabId>('scenes');
  // The writer's actual zoom request -- a fixed percentage, or one of the two fit modes (zoom.ts's
  // own top-of-file comment explains why this, not a bare percentage, is the state that survives:
  // storing only the computed number is what makes fit silently stop fitting after the next
  // resize). `zoomPercent` below is the number this currently *resolves* to; it is derived, not
  // stored independently, and is recomputed by the effect beside it whenever `zoomMode` or the
  // available area changes.
  const [zoomMode, setZoomMode] = useState<ZoomMode>({
    kind: 'fixed',
    percent: ZOOM_DEFAULT_PERCENT,
  });
  const [zoomPercent, setZoomPercent] = useState(ZOOM_DEFAULT_PERCENT);
  // `.editor-region`'s own element -- measured by `measureAvailableArea` (zoom.ts) whenever a fit
  // mode needs to know how much room it has. A ref, not state: the element itself never needs to
  // trigger a re-render on its own account, only the recompute effect below does.
  const editorRegionRef = useRef<HTMLElement>(null);
  // `.pages` itself -- the element CSS `zoom` actually scales, and the element
  // `capturePointerAnchoredScroll` (zoom.ts) measures the pointer against instead of
  // `.editor-region`, so pinch's anchor formula never needs to know about `.editor-region`'s own
  // padding or centring rule. See that function's own top-of-section comment in zoom.ts.
  const pagesRef = useRef<HTMLDivElement>(null);
  // Set synchronously by `requestZoomMode` just before it calls `setZoomMode`, and consumed (and
  // cleared) by the centred-scroll effect once the new zoom has actually rendered -- see
  // `requestZoomMode`'s own comment for why a zoom change (a React state update, not a
  // synchronous ProseMirror dispatch) needs a ref to carry this across the render boundary rather
  // than the single synchronous wrap `paginationExtension.ts`'s
  // `compensateScrollForRepagination` uses for the analogous repagination case. `zoom.ts`'s
  // `captureCentredScroll`/`restoreCentredScroll` are pure DOM (`.editor-region`'s own
  // `scrollTop`/`scrollHeight`/`clientHeight`), never `Editor`/`EditorView` -- a zoom change is
  // not an edit and not a repagination, so it must never reach `compensateScrollForRepagination`
  // or `maybeJumpScrollCaretIntoView` (paginationExtension.ts), and not touching ProseMirror at
  // all is what makes that true by construction rather than by a guard that could later rot.
  const pendingZoomScrollCaptureRef = useRef<ZoomScrollCapture | undefined>(undefined);
  // Pinch-to-zoom's own capture, populated only by `commitPinchZoom` below and never by
  // `requestZoomMode` -- the two are mutually exclusive by construction (every ordinary zoom
  // entry point routes through `requestZoomMode`, and pinch never does), so at most one of this
  // ref and `pendingZoomScrollCaptureRef` above is ever populated at a time, and each is consumed
  // and cleared only by its own matching `useLayoutEffect` below. This is what keeps the two
  // anchoring strategies -- centred for a clicked control, pointer-anchored for a pinch gesture --
  // from ever fighting over the same write; see `restorePointerAnchoredScroll` (zoom.ts) for why
  // they are deliberately different formulas, not a bug to unify.
  const pendingPinchAnchorRef = useRef<PointerZoomCapture | undefined>(undefined);
  // The last `zoomPercent` actually committed, readable synchronously from inside a `wheel`/
  // `pointermove` handler without closing over a stale first-render value the way a plain
  // variable would. Kept current by the `useLayoutEffect` immediately below (before the browser's
  // next paint, and therefore before the next animation frame a pinch gesture's own coalesced
  // handler runs in), the same freshness guarantee `paginationExtension.ts`'s own frame-coalesced
  // recompute relies on for its `documentSettings` read.
  const zoomPercentRef = useRef(ZOOM_DEFAULT_PERCENT);
  const [dark, setDark] = useState(false);
  // View state, not document state: never travels with the canonical screenplay, and defaults
  // off. The label itself renders as a zero-layout-space overlay (see .script-body
  // [data-screenplay-block]::before in styles.css), so toggling this never moves a line on the
  // grid -- both states were proven identical by the e2e measurement suite.
  const [showLabels, setShowLabels] = useState(false);
  // View state, not document state: defaults to discrete pages per plan.md ("Page presentation").
  // Toggling this never touches the pagination plugin's decorations -- see paginationExtension.ts
  // and pagination.ts's buildPaginationDecorations -- so page count and break positions are
  // identical in both modes by construction; only the .page/.page.continuous background rules in
  // styles.css differ.
  const [continuousScroll, setContinuousScroll] = useState(false);
  // Drives .page's minimum height (requirement 3, progress/page-rendering.md): .page is
  // content-sized, so once the last page is only partly full its natural height falls short of
  // the repeating-gradient background's next full page-and-gap cycle, truncating the last page's
  // painted background. Sourced from the pagination plugin's own state (see
  // paginationExtension.ts's PaginationState) so this never triggers a second pagination pass --
  // it rides the same frame-coalesced computation the decorations already use.
  const [pageCount, setPageCount] = useState(0);
  const [activeElement, setActiveElement] = useState<ScreenplayElementType>('scene_heading');
  const [activeBlockId, setActiveBlockId] = useState<string>();
  const [projection, setProjection] = useState<LocalScreenplayProjection>({
    issues: ['Editor is starting.'],
    valid: false,
  });
  // Replaces the old `saveState` (`'saved' | 'saving' | 'failed' | 'conflict'`): there is no
  // longer a save this app makes, or a version to conflict on -- the editor is bound directly to
  // a Yjs document, and `apps/collab`'s Hocuspocus server persists it on its own debounced
  // schedule regardless of what this tab's connection is doing (plan.md's "Collaboration,
  // history, and restoration"; see `progress/collaboration-slice-1.md`). What this reports
  // instead is the state of *this browser's* connection to that server: `'connecting'` until the
  // first sync completes, `'synced'` once this tab's copy matches the server's, and `'offline'`
  // if the socket drops -- Yjs itself keeps queuing local edits during `'offline'` and flushes
  // them the moment the connection recovers, so nothing here needs to retry anything by hand.
  // Permanently `'synced'` when no collaboration server is configured (`COLLAB_WS_URL` unset --
  // see `collabConfig.ts`) or when the schema is unsupported: there is no socket to report on.
  //
  // Two more terminal states the sync-reporting effect below adds, neither reachable before this
  // tab's first sync completes and neither ever set again afterward:
  //
  //  - `'denied'`: `apps/collab`'s `onAuthenticate` resolved a real, deliberate decision that this
  //    actor may not see this document (wrong Origin, no session, or a role lookup that genuinely
  //    found none) -- see `authenticate.ts`'s own `TransientAuthenticationError` comment for why
  //    this is the *other* half of that classification. Retrying would never change the outcome,
  //    so nothing here does; the writer needs a reload (a fresh session/account check), not a
  //    spinner that waits forever.
  //  - `'timedOut'`: this tab's own connection has been sitting in `'connecting'` for longer than
  //    `SYNC_TIMEOUT_MS` with no `synced` and no `authenticationFailed` at all -- a backstop for
  //    whatever the transient-retry loop below does not by itself resolve (a sustained outage
  //    outlasting every retry, or a failure mode neither this comment nor `authenticate.ts`'s
  //    classification anticipated). Unlike `'denied'`, this is not asserted to be permanent: a
  //    `synced` arriving after the timeout still wins and moves this straight to `'synced'`, since
  //    the underlying provider is still trying regardless of what this state says.
  const [syncState, setSyncState] = useState<
    'connecting' | 'synced' | 'offline' | 'denied' | 'timedOut'
  >(COLLAB_WS_URL ? 'connecting' : 'synced');

  // An export that fails *after* the projection was valid -- today, only `@finaler-draft/pdf`
  // rejecting on a character PDF's un-embedded standard Courier cannot encode (Cyrillic, Greek,
  // emoji: all of which paste, save, and export to FDX and DOCX perfectly well). `disabled` does
  // not cover this: the screenplay is genuinely valid, so the menu item is genuinely enabled, and
  // the click genuinely runs. Without this the rejection reached `console.error` alone and the
  // writer saw a click that did nothing -- the same silent failure this scope exists to remove,
  // arriving through a different door.
  const [exportError, setExportError] = useState<string>();
  // The read-only banner's own "Make this one editable" action (below). It describes
  // `entitlementReadOnly.onMakeEditable`'s own outcome, which can fail (a cooldown, or the
  // account no longer being a candidate) independently of anything else on this screen, and the
  // banner is the only place that outcome is ever shown.
  const [makeEditableState, setMakeEditableState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [makeEditableError, setMakeEditableError] = useState<string>();
  // `editorContentFromScreenplay` throws for canonical features this text-block editor cannot
  // faithfully preserve (more than one title page, notes, dual dialogue, page breaks); `undefined`
  // here means "read-only", same meaning `initialContent` carried before the title page split out
  // of it (see the two derived constants below).
  const initialProjection = useMemo(() => {
    try {
      return editorContentFromScreenplay(initial.screenplay);
    } catch {
      return undefined;
    }
  }, [initial.screenplay]);
  const initialContent = initialProjection?.body;
  // Read-only until this tab's own first collaborative sync completes (`syncState ===
  // 'connecting'`), on top of the two reasons above. This closes a real data-loss race, not a
  // cosmetic one: before the provider's first sync lands, `collab.doc` (below) is still genuinely
  // empty, and ProseMirror's own schema fills the resulting empty document with a default
  // `screenplayBlock` -- one whose `id` attribute is that schema's own default, `null`, since
  // nothing in this codebase's block-creation paths runs for a node ProseMirror conjures on its
  // own. `y-prosemirror` never sends a `null`-valued attribute to Yjs at all (confirmed by reading
  // the installed package's own `createTypeFromElementNode`), so a keystroke landing in that block
  // before the real, real-id-bearing seed arrives keeps a block whose id never reaches the server
  // -- `apps/collab`'s projection then rejects the whole document as invalid, and nothing is ever
  // written past the empty seed (`progress/collaboration-slice-1.md`'s "first collaborative save
  // in a fresh process" entry). Gating on `'connecting'` closes the window entirely: there is no
  // moment where a keystroke can reach that not-yet-real block. Deliberately *not* gating on
  // `'offline'` too -- that only means an already-`synced` tab's socket dropped after a real
  // document was already in hand, and Yjs's own queue-and-flush-on-reconnect behavior (this
  // state's own comment above) is exactly what already makes continuing to type during a
  // reconnect safe; the status bar already reports it (`'offline' · reconnecting…` below) without
  // this needing to also lock the writer out of their own manuscript over a transient socket
  // drop.
  //
  // Permanently `'synced'` (never `'connecting'`) whenever there is no real provider to wait on --
  // `COLLAB_WS_URL` unset, or `initialContent === undefined` (unsupported schema) -- per
  // `syncState`'s own initializer and the sync-reporting effect below, both keyed off
  // `collab.provider`'s presence, not its existence being assumed. Every unit test in this file
  // and every isolated render (no collaboration server configured) therefore stays editable
  // exactly as before this change; only a real, in-flight first sync ever makes this `false`.
  //
  // The one flag that actually gates editing: this editor must support the screenplay's canonical
  // features, the account's entitlement must permit editing this specific screenplay, *and* this
  // tab's own first sync must have completed. Any one reason alone is enough to force read-only --
  // there is no case where one of the three overrides another.
  //
  // Written as an explicit allow-list (`'synced'` or `'offline'`), not `syncState !== 'connecting'`,
  // now that `syncState` has two more values (`'denied'`, `'timedOut'`) that must never make this
  // `true`: both mean this tab's first sync has *not* completed, so allowing edits under either
  // would reopen the exact null-id race gating on `'connecting'` alone exists to close.
  const editingAllowed =
    initialContent !== undefined &&
    entitlementReadOnly === undefined &&
    (syncState === 'synced' || syncState === 'offline');
  const editorContent = useMemo(() => {
    if (initialContent === undefined) return initialContent;
    return nonEmptyEditorContent(initialContent);
  }, [initialContent]);
  // The title page lives in its own React state, not in the ProseMirror document: it never
  // paginates with the body and is never numbered (plan.md's "Title page"), and the layout
  // package/pagination plugin structurally cannot see it this way (see screenplayEditor.ts's
  // `projectDocumentScreenplay` comment). `useState`'s lazy initializer runs once, matching every
  // other per-screenplay state here -- `App` remounts a fresh instance per screenplay (see the
  // route-navigation test in App.test.tsx), so `initial` never changes under a mounted instance.
  const [titlePageState, setTitlePageState] = useState<TitlePageState | undefined>(() =>
    initialProjection?.titlePage
      ? titlePageStateFromTitlePage(initialProjection.titlePage)
      : undefined,
  );
  // The live document settings a writer can change from the File menu's dialog (plan.md's
  // "Document settings"). Seeded from the loaded screenplay, same as `titlePageState` above, and
  // for the same reason: `App` remounts a fresh instance per screenplay, so a lazy initializer
  // keyed to `initial` is correct and never needs to react to `initial` changing later. Kept in
  // React state (rather than only inside the pagination plugin -- see `updateDocumentSettings`
  // below) because it also drives the CSS geometry variables and the projection that gets saved,
  // neither of which the plugin knows about.
  const [documentSettings, setDocumentSettings] = useState<DocumentSettings>(
    () => initial.screenplay.documentSettings,
  );
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const latestProjection = useRef<LocalScreenplayProjection | undefined>(undefined);
  // `main.tsx` applies the specification's fixed defaults once at bootstrap, before any
  // screenplay has loaded (see that module's own comment for why). Once one has, its own
  // `documentSettings` -- character indent, parenthetical indent and width, per plan.md's
  // "Document settings" section -- take over, here rather than in `main.tsx`, because those
  // values are document state, not an application-wide default.
  //
  // Keyed on the reactive `documentSettings` state (seeded from `initial.screenplay.documentSettings`,
  // see that state's own comment), not on `initial.screenplay.documentSettings` directly: the two
  // used to diverge in a way that only worked by accident -- `updateDocumentSettings` below calls
  // `applyPageGeometryCssVariables` directly with the newly changed value for the writer to see the
  // effect immediately, but if this effect stayed keyed to the frozen `initial` prop it would never
  // re-fire on a later settings change, leaving no *second* authority correcting a stale value the
  // way `syncEditorState`'s projection effect corrects a stale save. Keying on the live state instead
  // means this effect is what keeps CSS geometry correct-by-construction across any future path that
  // changes `documentSettings`, while `updateDocumentSettings`'s own direct call remains only an
  // optimization against a frame of stale CSS between the state update and this effect's re-run --
  // both calls end up idempotent with the same input the moment React settles.
  useEffect(() => {
    applyPageGeometryCssVariables(documentSettings);
  }, [documentSettings]);
  const togglePanel = (panel: Panel) =>
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));

  // Shared by `syncEditorState` (body edits, via Tiptap's own callbacks) and
  // `updateTitlePageState` (title-page edits, which never touch the ProseMirror document and so
  // never fire a Tiptap callback at all) -- both need to record the latest projection for reads
  // (word count, export, the invalid-projection banner). Neither needs to schedule a save: the
  // editor's document is the Yjs document (`ySyncPlugin`, wired in via `createScreenplayEditorInit`
  // below), so `apps/collab`'s Hocuspocus server already has every keystroke the instant it is
  // typed, on its own persistence schedule -- there is nothing left for this component to flush.
  const applyProjection = (nextProjection: LocalScreenplayProjection) => {
    latestProjection.current = nextProjection;
    setProjection(nextProjection);
  };

  const syncEditorState = (editorInstance: Editor) => {
    const currentBlock = getActiveScreenplayBlock(editorInstance);
    if (currentBlock) {
      setActiveBlockId(currentBlock.id);
      setActiveElement(currentBlock.element);
    }
    const nextProjection = projectLocalScreenplay(editorInstance, {
      documentSettings,
      id: initial.id,
      title: initial.title,
      titlePages: titlePageState ? [titlePageFromState(titlePageState)] : [],
    });
    applyProjection(nextProjection);
  };

  // The pagination plugin recomputes on a requestAnimationFrame coalesce (paginationExtension.ts),
  // dispatching a decoration-only transaction that does not change the document -- Tiptap's `onUpdate` only
  // fires for doc changes, so it would miss that dispatch entirely. `onTransaction` fires for
  // every transaction, including that one, which is what lets pageCount track the plugin's own
  // state rather than becoming a second source of truth for it.
  const syncPageCount = (editorInstance: Editor) => {
    const state = paginationPluginKey.getState(editorInstance.state);
    if (state) {
      setPageCount(state.pageCount);
    }
  };

  // The editor's document is a Yjs document, never a plain ProseMirror one -- "Yjs becomes the
  // source of truth" (plan.md's "Collaboration, history, and restoration"; see
  // `progress/collaboration-slice-1.md`). Built once per mounted screenplay via `useMemo`, the
  // same per-screenplay-instance convention `initialProjection`/`titlePageState` above already
  // use (`App` remounts fresh per screenplay, so `initial.id` is stable for the component's whole
  // life).
  //
  // Two cases:
  //  - No collaboration server configured (`COLLAB_WS_URL` unset -- see `collabConfig.ts`) or the
  //    canonical screenplay has features this editor cannot represent at all
  //    (`initialContent === undefined`): a local, unconnected `Y.Doc`, seeded from the loaded
  //    screenplay in the first case and left empty (matching `unavailableEditorContent`'s
  //    existing read-only meaning) in the second. This is what every unit test in this file
  //    exercises, and what any environment without `apps/collab` deployed yet falls back to.
  //  - Otherwise: a real `HocuspocusProvider` connects to `apps/collab` over `COLLAB_WS_URL`,
  //    authenticating from the same session cookie the browser already attaches to every other
  //    request (plan.md: "Hocuspocus authenticates from a cookie the browser attaches
  //    automatically" -- no token or header is set here). Its document starts empty and is
  //    populated by the provider's own sync the instant the connection completes;
  //    `createScreenplayEditorInit` below reads whatever is already there for the first render,
  //    empty or not, and every update after that reaches the editor through `ySyncPlugin`
  //    automatically, with no action from this component.
  const collab = useMemo(() => {
    if (initialContent === undefined || !COLLAB_WS_URL) {
      return {
        doc: createLocalScreenplayYDoc(editorContent ?? unavailableEditorContent),
        provider: undefined as HocuspocusProvider | undefined,
      };
    }
    const provider = new HocuspocusProvider({ url: COLLAB_WS_URL, name: initial.id });
    return { doc: provider.document, provider };
    // `editorContent`/`initialContent` deliberately omitted: this must only ever run once per
    // mounted screenplay (a fresh `Y.Doc`/`HocuspocusProvider` every render would reconnect and
    // re-seed on every keystroke), and `initial.id` alone already uniquely identifies which
    // screenplay this is for the component's whole lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  // Reports this browser's own connection to `apps/collab`, for the status line below. Yjs keeps
  // queuing local edits while offline and flushes them the moment the connection recovers, so
  // nothing here needs to retry anything by hand for an already-`'synced'` tab's transient socket
  // drop -- this effect only ever *reads* that case, never drives it.
  //
  // It does drive one thing: recovering this tab's own *first* handshake from a transient
  // `authenticationFailed` (`apps/collab`'s `TransientAuthenticationError`, `authenticate.ts`).
  // `@hocuspocus/server` sends its denial over the same still-open socket and never closes the
  // transport (confirmed by reading the installed source), so nothing about the connection itself
  // ever changes on its own -- no `close`, no `disconnect`, nothing for `HocuspocusProviderWebsocket`'s
  // own reconnect-on-close logic to react to. Recovering requires *this* code to close the socket
  // itself (`provider.disconnect()`) and reopen it (`provider.connect()`) once that closes for
  // real -- `connect()` no-ops immediately if `status` still reads `'connected'`, which it does
  // until the asynchronous close actually lands, so the retry waits for the provider's own
  // `'disconnect'` event rather than racing it. A resolved, deliberate denial (any other `reason`,
  // or none) gets none of this: retrying it would never change the outcome, so `syncState` moves
  // straight to the terminal `'denied'` instead.
  useEffect(() => {
    const provider = collab.provider;
    if (!provider) {
      setSyncState('synced');
      return;
    }
    setSyncState(provider.isSynced ? 'synced' : 'connecting');

    // Set for the duration of one disconnect-then-reconnect cycle triggered by a transient
    // failure, so the generic `'status'`/`'disconnect'` handlers below -- which this same cycle's
    // own `provider.disconnect()` call also triggers -- do not report this self-inflicted,
    // pre-first-sync drop as `'offline'`. `'offline'` is only ever correct for a tab that has
    // already synced at least once (this effect's own comment on `editingAllowed`'s allow-list);
    // reporting it here, even briefly, would let `editingAllowed` go `true` before a real document
    // ever arrived -- exactly the null-id race the whole gate exists to close.
    let awaitingTransientRetry = false;
    // Grows on each consecutive transient failure and resets the moment a sync actually lands, so
    // a sustained outage becomes a backing-off retry loop rather than a tight one hammering the
    // collab server (and, through it, Postgres) once per handshake.
    let transientRetryCount = 0;
    let pendingRetryTimeout: ReturnType<typeof setTimeout> | undefined;
    let pendingRetryDisconnectHandler: (() => void) | undefined;
    const clearPendingRetry = () => {
      if (pendingRetryTimeout !== undefined) {
        clearTimeout(pendingRetryTimeout);
        pendingRetryTimeout = undefined;
      }
      if (pendingRetryDisconnectHandler !== undefined) {
        provider.off('disconnect', pendingRetryDisconnectHandler);
        pendingRetryDisconnectHandler = undefined;
      }
    };

    // The backstop for whatever the transient-retry loop above does not itself resolve (a
    // sustained outage outlasting every retry delay, or a failure mode neither this comment nor
    // `authenticate.ts`'s classification anticipated): if this tab is *still* `'connecting'` once
    // `SYNC_TIMEOUT_MS` has passed, tell the writer something is wrong instead of leaving an
    // indefinite spinner with no information. Not asserted to be permanent -- the functional
    // updater only overwrites `'connecting'`, so a `synced` that lands after this fires (the
    // provider is still trying regardless of what this state says) still wins on its own next
    // render via `handleSynced` below.
    const syncTimeout = setTimeout(() => {
      setSyncState((current) => (current === 'connecting' ? 'timedOut' : current));
    }, SYNC_TIMEOUT_MS);

    const handleStatus = ({ status }: { status: string }) => {
      if (status !== 'connected' && !awaitingTransientRetry) setSyncState('offline');
    };
    const handleSynced = () => {
      transientRetryCount = 0;
      setSyncState('synced');
    };
    const handleDisconnect = () => {
      if (!awaitingTransientRetry) setSyncState('offline');
    };
    const handleAuthenticationFailed = ({ reason }: { reason?: string }) => {
      if (reason !== TRANSIENT_SYNC_AUTH_FAILURE_REASON) {
        awaitingTransientRetry = false;
        setSyncState('denied');
        return;
      }
      awaitingTransientRetry = true;
      const delay =
        TRANSIENT_RETRY_DELAYS_MS[
          Math.min(transientRetryCount, TRANSIENT_RETRY_DELAYS_MS.length - 1)
        ];
      transientRetryCount += 1;
      pendingRetryTimeout = setTimeout(() => {
        pendingRetryTimeout = undefined;
        pendingRetryDisconnectHandler = () => {
          provider.off('disconnect', pendingRetryDisconnectHandler!);
          pendingRetryDisconnectHandler = undefined;
          awaitingTransientRetry = false;
          provider.connect();
        };
        provider.on('disconnect', pendingRetryDisconnectHandler);
        provider.disconnect();
      }, delay);
    };
    provider.on('status', handleStatus);
    provider.on('synced', handleSynced);
    provider.on('disconnect', handleDisconnect);
    provider.on('authenticationFailed', handleAuthenticationFailed);
    return () => {
      clearTimeout(syncTimeout);
      clearPendingRetry();
      provider.off('status', handleStatus);
      provider.off('synced', handleSynced);
      provider.off('disconnect', handleDisconnect);
      provider.off('authenticationFailed', handleAuthenticationFailed);
    };
  }, [collab]);

  // Tears down the real WebSocket connection when this screenplay is no longer mounted (in-app
  // navigation to a different screenplay or route) -- `collab` itself only ever changes when
  // `initial.id` does, so this fires at most once per screenplay, not on every render.
  //
  // The teardown itself is deliberately deferred by one macrotask, canceling the deferred call if
  // this effect's setup runs again before it fires, rather than calling `collab.provider?.destroy()`
  // directly in the cleanup. `collab` is built once via `useMemo` specifically so a fresh
  // `Y.Doc`/`HocuspocusProvider` never opens on every render (that `useMemo`'s own comment) --
  // React's `<StrictMode>` (`main.tsx`, dev builds only) intentionally runs every effect's setup,
  // then its cleanup, then its setup again, once, immediately after a component's true initial
  // mount, specifically to surface an effect whose cleanup cannot be undone. Because `collab` does
  // not change across that simulated remount, an undeferred `destroy()` here destroyed the one and
  // only provider before its handshake ever completed, and nothing recreated it -- the editor was
  // permanently stuck reporting `'connecting'` under `pnpm dev` (React's development bundle is the
  // only build StrictMode's double-invoke ever runs in; confirmed directly: `test:system`'s
  // production build, where it does not run, was never affected). A real unmount (navigating to a
  // different screenplay) has no follow-up setup call to cancel this with, so the deferred
  // `destroy()` fires and the connection really tears down -- at most one macrotask later than
  // before, negligible against a WebSocket teardown nothing here awaits. Confirmed against real
  // `pnpm dev`, StrictMode left on: two browser windows opened on the same screenplay converge,
  // and killing `apps/collab` visibly flips both to `'offline'` (`progress/collaboration-slice-1.md`).
  const pendingProviderTeardown = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(pendingProviderTeardown.current);
    return () => {
      pendingProviderTeardown.current = setTimeout(() => {
        collab.provider?.destroy();
      }, 0);
    };
  }, [collab]);

  const editorInit = useMemo(
    () => createScreenplayEditorInit(collab.doc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT)),
    [collab],
  );

  // Same reasoning as `editorProps` above: an inline array literal here is a fresh identity on
  // every render, and `PaginationExtension.configure(...)` in particular returns a brand-new
  // extension instance on every call -- Tiptap's `.configure()` never memoizes -- so this array
  // would fail `useEditor`'s per-element identity comparison every single render regardless of
  // whether anything about it actually changed. Memoized on `[editorInit]` -- itself stable
  // across ordinary re-renders (see `collab` above) -- rather than `[]`:
  // `PaginationExtension.configure({ documentSettings: ... })` still only ever *seeds* the
  // plugin's own `init()` once; a runtime `documentSettings` change reaches the plugin entirely
  // through `updatePaginationDocumentSettings`'s meta-carrying dispatch (paginationExtension.ts),
  // never by reconfiguring this extension.
  const extensions = useMemo(
    () => [
      // Remote cursors and selections (presence.ts, slice 2). Only when a real collaboration
      // server is connected -- there is no `Awareness` to read from a local, unconnected `Y.Doc`,
      // and no other participant who could ever appear in one. Must precede `editorInit.extensions`
      // (`ScreenplayYjsExtension`, which registers `ySyncPlugin`) in this array: Tiptap's
      // `ExtensionManager.plugins` reverses the extension list (then stable-sorts by priority)
      // before flattening it into ProseMirror plugins, so a *later* entry here ends up *earlier* in
      // the final plugin list. `yCursorPlugin`'s own `state.init` synchronously reads
      // `ySyncPluginKey.getState(state)`, which is only populated once `ySyncPlugin` has itself run
      // its own `init` -- confirmed directly (`packages/screenplay-editor/src/presence.test.ts`'s
      // own comment on the identical ordering requirement, and the exact crash the wrong order
      // produces: `TypeError: Cannot read properties of undefined (reading 'doc')`).
      ...(collab.provider?.awareness
        ? [createRemotePresenceExtension(collab.provider.awareness)]
        : []),
      ...editorInit.extensions,
      PaginationExtension.configure({ documentSettings: initial.screenplay.documentSettings }),
      // The caret at a mid-block page seam (seamCaret.ts). Mounted directly after the plugin whose
      // decorations it reads, and like every layer here it is removable on its own: this line, its
      // own file, its own tests, and its two blocks in styles.css are the whole of it. Nothing in
      // pagination knows it exists.
      SeamCaretExtension,
      // SmartType's inline ghost completion (smartTypeGhost.ts). A layer over the screenplay
      // editor rather than part of what a block is, exactly like pagination above -- and
      // self-contained, so stage 3's optional accept-by-list layer attaches here beside it rather
      // than inside it, and either can be removed without touching the other.
      SmartTypeGhostExtension,
      // SmartType's optional candidate list (smartTypeList.tsx), the layer the writer is still
      // deciding whether to keep. It is deliberately removable: this line, the `<SmartTypeList>`
      // below, the import above, its own file and its own block in styles.css are the whole of it,
      // and the ghost above neither reads its state nor knows it exists.
      SmartTypeListExtension,
      // The element menu (elementMenu.tsx): what Enter does at an empty block. Mounted here for
      // the same reason the two above are -- a layer over the screenplay editor, not part of what
      // a block is -- and, like them, carrying its own explicit priority, so this line's position
      // in this array decides nothing about which layer sees Enter first.
      ElementMenuExtension,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorInit, collab],
  );

  const editor = useEditor({
    content: editorInit.content,
    editable: editingAllowed,
    editorProps,
    extensions,
    onCreate: ({ editor: editorInstance }) => {
      syncEditorState(editorInstance);
      syncPageCount(editorInstance);
    },
    onSelectionUpdate: ({ editor: editorInstance }) => syncEditorState(editorInstance),
    onUpdate: ({ editor: editorInstance }) => syncEditorState(editorInstance),
    onTransaction: ({ editor: editorInstance }) => syncPageCount(editorInstance),
  });

  // `useEditor`'s own React binding (`@tiptap/react`'s `EditorInstanceManager.onRender`, read
  // directly from the installed package) does not actually apply a changed `editable` option on
  // a later render: its own `setOptions` call there explicitly spreads
  // `editable: this.editor.isEditable` -- the editor's own current value -- over whatever this
  // render just passed in, so the `editable: editingAllowed` above only ever takes effect once,
  // at construction. Before the sync gate, that never mattered: nothing in this codebase, this
  // effect included, previously changed `editingAllowed` after the editor already existed for any
  // real, exercised case (the "entitlement flips read-only mid-session" test asserts only the
  // toolbar's own React-rendered `disabled` attributes, never whether the underlying
  // `contentEditable` region itself still accepted a keystroke). `editingAllowed` beginning
  // `false` and turning `true` moments later -- the sync gate's entire premise -- is the first
  // case that actually depends on the live editor's editability changing after construction, and
  // without this effect the editor stayed permanently non-editable for the rest of the session:
  // confirmed directly, every real-editor test:system:persistence test that opens a fresh
  // screenplay and types into it failed identically once the sync gate was added and this effect
  // was not yet present.
  useEffect(() => {
    editor?.setEditable(editingAllowed);
  }, [editor, editingAllowed]);

  // Recomputes `zoomPercent` (the number actually applied to `.pages`'s CSS `zoom` below) from
  // `zoomMode` and `.editor-region`'s current available area. Takes `mode` as a parameter rather
  // than closing over `zoomMode` so it has no dependency of its own beyond the two stable refs
  // -- `editorRegionRef` and `setZoomPercent` -- letting every effect below list it as a
  // dependency without re-running on every render the way a freshly defined plain function would
  // force them to.
  const recomputeZoomPercent = useCallback((mode: ZoomMode) => {
    setZoomPercent(
      resolveZoomPercent(
        mode,
        measureAvailableArea(editorRegionRef.current),
        PAGE_WIDTH_IN,
        PAGE_HEIGHT_IN,
      ),
    );
  }, []);

  // The two recompute triggers plan.md's "Zoom controls" names that this codebase actually has:
  // `zoomMode` itself changing (a fresh request) and a panel opening or closing
  // (`panels.navigator`/`panels.inspector` resize `.editor-region` in the same React commit that
  // toggles them). `useLayoutEffect`, not `useEffect`: it must resolve before the browser paints,
  // or a fit mode would visibly flash at its stale percentage for one frame after a panel toggle.
  // There is no third, `overlay`-breakpoint trigger to add a dependency for -- see zoom.ts's own
  // top-of-file comment for why that one is scoped out rather than invented.
  useLayoutEffect(() => {
    recomputeZoomPercent(zoomMode);
  }, [zoomMode, panels.navigator, panels.inspector, recomputeZoomPercent]);

  // The third trigger, window resize, is not a React-driven layout change -- nothing else in this
  // component re-renders just because the window resized -- so it needs its own listener rather
  // than a dependency any effect above could key on. Re-subscribed whenever `zoomMode` changes so
  // the handler always closes over the current request, matching `recomputeZoomPercent`'s own
  // signature rather than reading a second, possibly-stale copy of `zoomMode` out of a ref.
  useEffect(() => {
    const handleResize = () => recomputeZoomPercent(zoomMode);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [zoomMode, recomputeZoomPercent]);

  // Every entry point that changes what the writer is *asking* zoom to do -- the stepper buttons,
  // the preset dropdown, and the keyboard equivalents, all below -- routes through this rather
  // than calling `setZoomMode` directly, so the centred-scroll capture (zoom.ts) never gets
  // forgotten at a new call site. Deliberately NOT used by the resize/panel-toggle recompute
  // above: those are not the writer asking for a new zoom, they are the window or the workspace
  // changing shape around an unchanged request -- see progress/zoom-modes.md for why anchoring
  // scroll through that class of change was scoped out rather than attempted.
  const requestZoomMode = (mode: ZoomMode) => {
    pendingZoomScrollCaptureRef.current = captureCentredScroll(
      editorRegionRef.current,
      zoomPercent,
    );
    setZoomMode(mode);
  };

  // Applies the centred-scroll capture above once the new zoom has actually rendered. Keyed on
  // `zoomPercent` -- the value that actually drives `.pages`'s CSS `zoom` below -- rather than
  // `zoomMode`, since that is the number `restoreCentredScroll`'s own ratio needs.
  // `useLayoutEffect` runs after the DOM commit but before the browser paints, so the writer never
  // sees an intermediate frame at the wrong scroll position -- `restoreCentredScroll` also depends
  // on this: it reads `.editor-region`'s
  // `scrollHeight`/`clientHeight` fresh, which only reflect the new scale once this commit has
  // landed. A resize/panel-toggle recompute never populates `pendingZoomScrollCaptureRef` (only
  // `requestZoomMode` does), so this is naturally a no-op for that class of change, with no extra
  // branch needed to keep it that way.
  //
  // This used to reapply the same computation a second time inside a `requestAnimationFrame`
  // callback, to win against a real-browser drift that landed between this effect returning and
  // the browser's next paint. That drift is now root-caused and fixed at its source
  // (progress/zoom-scroll-drift.md): `useEditor`'s own extensions/`editorProps` used to be fresh
  // object identities on every render, which made `@tiptap/react` call `editor.setOptions(...)`
  // on every render (including a zoom-triggered one) and reconfigure ProseMirror's plugins;
  // `paginationExtension.ts`'s pagination plugin unconditionally re-ran its caret-visibility
  // heuristic (`maybeJumpScrollCaretIntoView`) on that spurious update and overwrote `scrollTop`
  // with a value that had nothing to do with zoom. Fixed by memoizing `extensions`/`editorProps`
  // (App.tsx, above) so that reconfigure stops happening for a render that changed neither, and,
  // as defence in depth, by guarding `maybeJumpScrollCaretIntoView`'s call site on the document or
  // the selection having actually changed (paginationExtension.ts). With both in place, removing
  // the `requestAnimationFrame` reapplication and rerunning the real-browser "zooming keeps the
  // viewport centred" test (page-rendering-persistence.spec.ts) five times in a row was reliably
  // green -- the drift is gone, not merely smaller, so the reapplication is dead weight and has
  // been removed rather than kept out of caution.
  useLayoutEffect(() => {
    const capture = pendingZoomScrollCaptureRef.current;
    pendingZoomScrollCaptureRef.current = undefined;
    restoreCentredScroll(editorRegionRef.current, capture, zoomPercent);
  }, [zoomPercent]);

  // Keeps `zoomPercentRef` current for the pinch handlers below, which read it synchronously from
  // inside a native event listener rather than a React closure -- see that ref's own comment.
  useLayoutEffect(() => {
    zoomPercentRef.current = zoomPercent;
  }, [zoomPercent]);

  // Pinch's own scroll restoration, the pointer-anchored counterpart to the centred-scroll effect
  // above -- run from the identical `useLayoutEffect` timing (after the DOM commit, before paint)
  // for the identical reason: `restorePointerAnchoredScroll` (zoom.ts) reads `.editor-region`'s
  // `scrollHeight`/`scrollWidth`/`clientHeight`/`clientWidth` fresh, which only reflect the new
  // scale once this commit has landed. A no-op whenever `pendingPinchAnchorRef` is empty -- every
  // non-pinch zoom change only ever populates `pendingZoomScrollCaptureRef` above, never this one.
  useLayoutEffect(() => {
    const capture = pendingPinchAnchorRef.current;
    pendingPinchAnchorRef.current = undefined;
    restorePointerAnchoredScroll(editorRegionRef.current, capture, zoomPercent);
  }, [zoomPercent]);

  // The one place a pinch gesture (wheel-with-ctrlKey below, or the two-touch handler further
  // down) actually changes zoom: captures the pointer-anchored scroll state the layout effect
  // above needs, then sets a fixed zoom mode -- "pinch sets a fixed percentage, leaving any fit
  // mode" (plan.md:662), exactly like every other zoom entry point that calls `requestZoomMode`,
  // except this one deliberately does NOT call `requestZoomMode` itself: that function populates
  // `pendingZoomScrollCaptureRef` for centred anchoring, which is the wrong anchor for a gesture
  // whose whole point is to keep the pointer's own position fixed instead (zoom.ts's own comment
  // on `restorePointerAnchoredScroll` explains why the two are intentionally different formulas).
  // A stable identity (`useCallback`, refs and `setZoomMode` only) so both the wheel effect and
  // the touch effect below can list it as their one dependency without re-subscribing their
  // listeners on every render.
  //
  // `prefers-reduced-motion` (plan.md:662, "no animated transition between zoom levels"): already
  // true here by construction, not a special case this needs to add -- `.pages`'s CSS `zoom`
  // (App.tsx's JSX below) has never had a `transition` declared on it for any zoom path, pinch
  // included, so every percent this produces is applied as an instant, un-eased snap exactly like
  // a stepper click or a preset selection already is. There is nothing to gate behind the media
  // query because there is no animation to begin with.
  const commitPinchZoom = useCallback((newPercent: number, clientX: number, clientY: number) => {
    pendingPinchAnchorRef.current = capturePointerAnchoredScroll(
      editorRegionRef.current,
      pagesRef.current,
      zoomPercentRef.current,
      clientX,
      clientY,
    );
    setZoomMode({ kind: 'fixed', percent: newPercent });
  }, []);

  // Trackpad pinch (plan.md:662): "Trackpad pinch arrives as a `wheel` event with `ctrlKey` set."
  // Registered manually via `addEventListener(..., { passive: false })` on `.editor-region`
  // itself, not React's `onWheel` -- React always attaches its own synthetic wheel listener as
  // passive, so `event.preventDefault()` inside an `onWheel` handler is silently ignored by the
  // browser and the page would zoom (or, depending on the browser, simply scroll) underneath this
  // handler regardless of what it does. Scoped to this one element, not `window` or `document`:
  // "so the writer keeps the browser's own zoom on the surrounding interface... Intercepting it
  // globally would take away a control the operating system gives them" (plan.md:662).
  useEffect(() => {
    const region = editorRegionRef.current;
    if (!region) {
      return;
    }
    // A `wheel` event fires far faster than the browser paints -- coalesced to at most one
    // percent update per animation frame, the same pattern `paginationExtension.ts`'s own
    // `scheduleRepagination` uses for the identical reason (see that function's own comment).
    // Every `deltaY` seen before the queued frame runs is summed into one call to
    // `applyPinchWheelDelta`, and the pointer position used is whichever event's was most recent
    // -- both match what a writer perceives as "one continuous gesture", not a sequence of
    // independent small zooms each anchored on a slightly different, already-stale pointer
    // reading.
    let pendingDeltaY = 0;
    let pendingClientX = 0;
    let pendingClientY = 0;
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      const deltaY = pendingDeltaY;
      pendingDeltaY = 0;
      const nextPercent = applyPinchWheelDelta(zoomPercentRef.current, deltaY);
      commitPinchZoom(nextPercent, pendingClientX, pendingClientY);
    };
    const handleWheel = (event: WheelEvent) => {
      // Ordinary wheel scrolling (no `ctrlKey`) is deliberately left completely alone here --
      // no `preventDefault()`, no state read, no branch taken at all -- so the browser's own
      // native scroll of `.editor-region` (`overflow: auto`, styles.css) keeps working exactly
      // as it did before this handler existed.
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      pendingDeltaY += event.deltaY;
      pendingClientX = event.clientX;
      pendingClientY = event.clientY;
      if (frame === undefined) {
        frame = window.requestAnimationFrame(flush);
      }
    };
    region.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      region.removeEventListener('wheel', handleWheel);
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [commitPinchZoom]);

  // Touch's own two-finger pinch (plan.md:662: "touch devices need their own handling"). Pointer
  // Events, not `TouchEvent`, so the same handler naturally ignores mouse/pen input
  // (`event.pointerType !== 'touch'`) without a separate code path -- `.editor-region`'s own
  // `touch-action: pan-x pan-y` (styles.css) is what stops the browser from also trying to
  // recognize this same two-finger gesture as its own native pinch-zoom before these handlers see
  // it, while leaving one-finger touch panning (ordinary scrolling) natively handled and
  // untouched, exactly like the wheel handler above leaves an unmodified wheel event untouched.
  //
  // Tracks every active touch pointer in a plain `Map`, not React state -- this is per-gesture,
  // transient bookkeeping with no reason to trigger a render on its own, the same reasoning
  // `paginationExtension.ts`'s `pendingFrame` local variable already follows for its own
  // per-view, non-rendering state. `previousDistance` is reset to `undefined` by `clearPointer`
  // below on every pointer that goes away (`pointerup`/`pointercancel`/`pointerleave`) --
  // unconditionally, regardless of how many pointers remain afterward -- so any gesture that
  // returns to exactly two active pointers always re-establishes a fresh baseline on its first
  // `pointermove` rather than being zoomed against a stale distance that belonged to a different
  // pair of fingers. A third finger touching down needs no reset of its own: `handlePointerMove`'s
  // own `pointers.size !== 2` guard already withholds every zoom computation for as long as three
  // (or more) pointers are active, so `previousDistance` is simply never read until the count is
  // back to two -- which, since the only way to decrease it is a removal, only ever happens
  // through `clearPointer`'s own reset. (An earlier version of this effect also reset
  // `previousDistance` from `handlePointerDown` whenever the count left two; mutation-testing that
  // branch found no test could distinguish its presence from its absence, and this reasoning is
  // why -- it was dead by construction, not merely untested, and has been removed rather than kept
  // for a defensiveness it never actually added. See progress/pinch-zoom.md.)
  useEffect(() => {
    const region = editorRegionRef.current;
    if (!region) {
      return;
    }
    const pointers = new Map<number, { x: number; y: number }>();
    let previousDistance: number | undefined;
    let pendingRatio = 1;
    let pendingMidX = 0;
    let pendingMidY = 0;
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      const ratio = pendingRatio;
      pendingRatio = 1;
      const nextPercent = clampZoomPercent(zoomPercentRef.current * ratio);
      commitPinchZoom(nextPercent, pendingMidX, pendingMidY);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') {
        return;
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) {
        return;
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size !== 2) {
        return;
      }
      event.preventDefault();
      const [first, second] = Array.from(pointers.values());
      if (!first || !second) {
        return;
      }
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const midX = (first.x + second.x) / 2;
      const midY = (first.y + second.y) / 2;
      // The first sample of a fresh two-finger gesture has nothing to compare against yet -- it
      // only establishes the baseline `previousDistance` a second sample can compute a ratio
      // from, exactly the same "nothing to do yet, wait for the next one" shape the wheel
      // handler's own coalescing has no need for (a `wheel` event already carries its own delta).
      if (previousDistance !== undefined && previousDistance > 0) {
        pendingRatio *= distance / previousDistance;
        pendingMidX = midX;
        pendingMidY = midY;
        if (frame === undefined) {
          frame = window.requestAnimationFrame(flush);
        }
      }
      previousDistance = distance;
    };
    const clearPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') {
        return;
      }
      pointers.delete(event.pointerId);
      previousDistance = undefined;
    };
    region.addEventListener('pointerdown', handlePointerDown);
    region.addEventListener('pointermove', handlePointerMove, { passive: false });
    region.addEventListener('pointerup', clearPointer);
    region.addEventListener('pointercancel', clearPointer);
    region.addEventListener('pointerleave', clearPointer);
    return () => {
      region.removeEventListener('pointerdown', handlePointerDown);
      region.removeEventListener('pointermove', handlePointerMove);
      region.removeEventListener('pointerup', clearPointer);
      region.removeEventListener('pointercancel', clearPointer);
      region.removeEventListener('pointerleave', clearPointer);
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [commitPinchZoom]);

  const updateZoom = (amount: number) => {
    requestZoomMode({ kind: 'fixed', percent: clampZoomPercent(zoomPercent + amount) });
  };

  // The preset dropdown's onChange: a fixed percentage's option value is the bare number
  // (`ZOOM_PRESET_PERCENTS`, zoom.ts), the two fit modes are their own `kind` strings -- see the
  // `<select>` below for the matching `<option value>`s.
  const chooseZoomPreset = (value: string) => {
    if (value === 'fit-page' || value === 'fit-width') {
      requestZoomMode({ kind: value });
      return;
    }
    const percent = Number(value);
    if (Number.isFinite(percent)) {
      requestZoomMode({ kind: 'fixed', percent });
    }
  };

  // Keyboard equivalents for zoom in, zoom out, and reset to 100 percent (plan.md's "Zoom
  // controls"). `event.metaKey || event.ctrlKey` rather than sniffing the platform: both are
  // conventional zoom modifiers depending on OS, and accepting either is simpler and more robust
  // than a `navigator.platform`/`userAgent` check that jsdom's own default does not model
  // consistently with any real browser anyway. Assigned to a ref and read through a
  // stable-identity listener, the same pattern `flushPendingSaveRef` above uses, so the listener
  // is registered exactly once (an empty dependency array) while still calling the *current*
  // render's `updateZoom`/`requestZoomMode` closures rather than a stale first-render copy.
  const handleZoomKeydownRef = useRef<(event: KeyboardEvent) => void>(() => {});
  handleZoomKeydownRef.current = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) {
      return;
    }
    if (event.key === '=' || event.key === '+') {
      event.preventDefault();
      updateZoom(ZOOM_STEP_PERCENT);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      updateZoom(-ZOOM_STEP_PERCENT);
    } else if (event.key === '0') {
      event.preventDefault();
      requestZoomMode({ kind: 'fixed', percent: ZOOM_DEFAULT_PERCENT });
    }
  };
  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => handleZoomKeydownRef.current(event);
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const currentBlock = getActiveScreenplayBlock(editor);
    if (currentBlock) {
      setActiveBlockId(currentBlock.id);
      setActiveElement(currentBlock.element);
    }
    const nextProjection = projectLocalScreenplay(editor, {
      documentSettings,
      id: initial.id,
      title: initial.title,
      titlePages: titlePageState ? [titlePageFromState(titlePageState)] : [],
    });
    latestProjection.current = nextProjection;
    setProjection(nextProjection);
    // `titlePageState` and `documentSettings` are real dependencies (both feed
    // `projectLocalScreenplay` above): this mainly re-seeds `projection` once when `editor` first
    // becomes available (the same moment `onCreate` also does), but including them keeps that
    // honest if either ever changes before then, rather than asserting -- via an exhaustive-deps
    // suppression -- a timing guarantee this effect does not actually need to rely on.
  }, [documentSettings, editor, initial.id, initial.title, titlePageState]);

  // Title-page edits happen in separate React state, never inside the ProseMirror document (see
  // the `titlePageState` comment above), so they never fire `onUpdate`/`onTransaction` the way
  // `syncEditorState` relies on. This is the title-page equivalent, called directly from
  // `TitlePageView`'s `onChange`. Takes `next` directly rather than reading `titlePageState` back
  // out of state, because `setTitlePageState` is asynchronous and the save this triggers must
  // reflect the edit that just happened, not whatever the closure captured before it.
  const updateTitlePageState = (next: TitlePageState) => {
    // `TitlePageView`'s own `readOnly` prop (below) already stops the writer's keystrokes from
    // reaching `onChange` in the first place -- this is the second, independent guard: nothing
    // here trusts that the caller actually honoured `readOnly`.
    if (!editingAllowed) return;
    setTitlePageState(next);
    if (!editor) return;
    const nextProjection = projectLocalScreenplay(editor, {
      documentSettings,
      id: initial.id,
      title: initial.title,
      titlePages: [titlePageFromState(next)],
    });
    applyProjection(nextProjection);
  };

  // The document-settings dialog's own equivalent of `updateTitlePageState` above: settings
  // changes never touch the ProseMirror document either, so nothing here can rely on Tiptap's own
  // update callbacks. Takes `next` directly (not read back out of `documentSettings` state) for
  // the identical reason `updateTitlePageState` does -- `setDocumentSettings` is asynchronous, and
  // both the live repagination and the save this triggers must reflect the edit that just
  // happened.
  //
  // Three independent things read `documentSettings`, updated here explicitly rather than by
  // waiting on the `documentSettings`-keyed `useEffect` above: `updatePaginationDocumentSettings`
  // repaginates the live document in place (no editor remount -- see paginationExtension.ts's own
  // comment on why that matters for undo history) and has no `useEffect` equivalent at all, since it
  // needs the live `Editor` instance, not just the settings value; the projection rebuild is what
  // actually reaches the autosave path with the new value -- the fix for the bug where
  // `documentSettings` was never threaded into `projectDocumentScreenplay` at all, so autosave
  // silently wrote the schema's defaults over whatever a writer had stored -- and likewise has no
  // effect equivalent, since re-running it on every unrelated render would be wrong. Only
  // `applyPageGeometryCssVariables` genuinely has a second authority (the effect above): calling it
  // here too is purely so the writer sees the geometry change the instant they make it, rather than
  // waiting a render for the effect to catch up -- see that effect's own comment.
  //
  // `applyPageGeometryCssVariables` is passed to `updatePaginationDocumentSettings` as its
  // `runBeforeDispatch` argument rather than called as a separate statement after it -- previously
  // it ran as a bare second statement here, which under-compensated the writer's scroll position
  // for a `parentheticalWidthIn` change specifically (progress/repagination-scroll-anchor.md's
  // "known limitations", fixed in this slice; see `updatePaginationDocumentSettings`'s own comment
  // in paginationExtension.ts for why passing it in, not merely reordering the two calls, is what
  // actually fixes it).
  const updateDocumentSettings = (next: DocumentSettings) => {
    // The "Document settings…" menu item is disabled while read-only (below), so this dialog
    // should never be reachable in the first place -- this guard is what actually stops it,
    // rather than only the menu item's own `disabled` attribute.
    if (!editingAllowed) return;
    setDocumentSettings(next);
    if (!editor) return;
    updatePaginationDocumentSettings(editor, next, () => applyPageGeometryCssVariables(next));
    const nextProjection = projectLocalScreenplay(editor, {
      documentSettings: next,
      id: initial.id,
      title: initial.title,
      titlePages: titlePageState ? [titlePageFromState(titlePageState)] : [],
    });
    applyProjection(nextProjection);
  };

  // "Escape to close with focus returned to the trigger" (plan.md's "Document settings" section,
  // via the accessibility list it points to): the trigger is the File menu's own button, not the
  // "Document settings…" menu item that opened this dialog (`OverflowMenu` already unmounts that
  // item the moment it is selected, and closing this dialog is a separate action from opening the
  // File menu). Queried through `fileMenuRef` rather than a ref threaded out of `OverflowMenu`
  // itself, so the shared, independently-tested component stays untouched.
  const closeSettingsDialog = () => {
    setSettingsDialogOpen(false);
    fileMenuRef.current?.querySelector<HTMLButtonElement>('.overflow-menu-trigger')?.focus();
  };

  const scenes = useMemo(
    () => (projection.valid ? deriveScenes(projection.screenplay.blocks) : []),
    [projection],
  );
  const selectedScene = activeScene(activeBlockId, scenes);
  const wordCount = wordsInProjection(projection);

  const selectScene = (scene: DerivedScene) => {
    if (!editor) {
      return;
    }
    const position = findScreenplayBlockPosition(editor, scene.id);
    if (position !== undefined) {
      editor.commands.focus(position + 1, { scrollIntoView: false });
    }
  };

  // packages/screenplay's own doc comment on `deriveCharacters`: "the same derivation feeds
  // SmartType" -- computed here, beside `scenes`, so both live in the one place a future
  // SmartType increment would already be looking.
  const characters = useMemo(
    () => (projection.valid ? deriveCharacters(projection.screenplay.blocks) : []),
    [projection],
  );
  const selectedCharacter = activeCharacter(activeBlockId, characters);

  // Navigates to the character's first cue. `dual_dialogue` blocks are not addressable here --
  // `findScreenplayBlockPosition` walks the ProseMirror document, and this text-block editor
  // cannot open a screenplay containing one (see `initialProjection` above) -- so `position` is
  // simply `undefined` for those and the click harmlessly does nothing, the same failure mode
  // `selectScene` already accepts for content the editor cannot represent.
  const selectCharacter = (character: DerivedCharacter) => {
    if (!editor) {
      return;
    }
    // The cue specifically, not `blockIds[0]`: both happen to agree today (a speech's cue is
    // always its first block), but `cueBlockIds` says "navigate to a cue" without depending on
    // that ordering fact staying true.
    const firstBlockId = character.cueBlockIds[0];
    if (firstBlockId === undefined) {
      return;
    }
    const position = findScreenplayBlockPosition(editor, firstBlockId);
    if (position !== undefined) {
      editor.commands.focus(position + 1, { scrollIntoView: false });
    }
  };

  // A near-empty screenplay is nearly all blank page: `.script-body` is content-sized (see
  // styles.css), so its actual DOM box ends a few lines down while `.page` still paints the full
  // manuscript height beneath it. A click in that gap lands outside the editable content
  // entirely and, unhandled, does nothing -- there is no text there for the browser's native
  // contenteditable click-to-position behavior to find. Redirecting it to the end of the
  // document is the closest point on the page to where the writer actually clicked, in the only
  // direction that makes sense for a click below everything that has been written. A click
  // already inside the editable content is left alone, so ProseMirror's own (more precise)
  // click-to-position handling is never second-guessed.
  const handlePageMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (!editor || editor.view.dom.contains(event.target as Node)) {
      return;
    }
    const contentBottom = editor.view.dom.getBoundingClientRect().bottom;
    if (event.clientY > contentBottom) {
      event.preventDefault();
      editor.commands.focus('end', { scrollIntoView: false });
    }
  };

  const changeElement = (element: ScreenplayElementType) => {
    // `disabled` on the `<select>` below already stops a pointer/keyboard user from reaching
    // this, but `convertActiveScreenplayBlock` dispatches a ProseMirror transaction directly --
    // unlike the DOM-level typing Tiptap's own `editable: false` blocks -- so this guard is the
    // one place that actually stops a read-only screenplay's content from changing this way, not
    // merely a UI affordance mirroring a rule enforced elsewhere.
    if (!editor || !editingAllowed) {
      return;
    }
    convertActiveScreenplayBlock(editor, element);
    editor.commands.focus(undefined, { scrollIntoView: false });
    syncEditorState(editor);
  };

  // The read-only banner's "Make this one editable" button. `entitlementReadOnly.onMakeEditable`
  // is the route's own call through to `PUT /api/entitlement/editable-screenplay`
  // (api.ts's `switchEditableScreenplay`); this only owns the button's own pending/error
  // feedback. On success there is nothing further to do here: the route re-fetches its own entitlement
  // query and this component simply stops receiving `entitlementReadOnly` on the next render,
  // which is what actually makes the editor editable -- this function never flips `editingAllowed`
  // itself.
  const makeEditable = () => {
    if (!entitlementReadOnly?.onMakeEditable) return;
    setMakeEditableState('pending');
    setMakeEditableError(undefined);
    entitlementReadOnly.onMakeEditable().then(
      () => setMakeEditableState('idle'),
      (error: unknown) => {
        setMakeEditableState('error');
        setMakeEditableError(
          error instanceof MessageApiError
            ? error.serverMessage
            : 'Could not make this screenplay editable. Try again.',
        );
      },
    );
  };

  // Shared by all three export menu items below -- FDX, DOCX, and PDF (requirement 2,
  // progress/paste-sanitization.md): an invalid projection used to make an export click silently
  // do nothing, which -- per that scope's own framing -- "is indistinguishable from a broken
  // build", and is the owner's literal "Download PDF did nothing" report. All three are now real
  // disabled controls (OverflowMenu.tsx) instead, with this exact string as the reason a writer
  // sees on hover. It reuses `projection.issues[0]`, the same message the status bar and
  // `.status-attention` below already show, rather than inventing a second wording of "why".
  const exportDisabledReason = projection.valid
    ? undefined
    : `Can't export: ${projection.issues[0] ?? 'Invalid screenplay data.'}`;

  // Shared by all three export menu items' `onSelect` below. Each exporter (and the `pdf-lib`/
  // `fflate` packages it pulls in) is loaded with a dynamic `import()` rather than statically --
  // see `docxDownload.ts`, `fdxDownload.ts`, `pdfDownload.ts` -- so nobody pays for any exporter
  // until they actually export. That makes every one of these three calls async, including FDX
  // and DOCX, which previously ran synchronously with no failure path at all. Routing all three
  // through this one helper means a chunk that fails to load (offline, or a stale hashed chunk
  // 404 after a deploy) surfaces exactly the same way a rejected `screenplayToPdf` already did --
  // in the toast below -- rather than becoming an unhandled promise rejection for FDX/DOCX or
  // silently varying by format.
  const runExport = (label: 'DOCX' | 'FDX' | 'PDF', run: () => Promise<void>) => {
    setExportError(undefined);
    run().catch((error: unknown) => {
      console.error(`${label} export failed:`, error);
      setExportError(
        error instanceof Error ? error.message : `${label} export failed for an unknown reason.`,
      );
    });
  };

  // The sync gate's own banner reason, mutually exclusive with `entitlementReadOnly`'s (a
  // screenplay already blocked by entitlement is not also shown a redundant "connecting" notice --
  // see `editingAllowed`'s own comment on why these are additive reasons but only one banner is
  // ever the "one thing every read-only visit must see" at a time). `initialContent !== undefined`
  // excludes the unsupported-schema case, which never reaches `'connecting'` at all (`syncState`'s
  // initializer and the sync-reporting effect below both key off `collab.provider`'s presence,
  // and that case's `collab` never constructs a real provider).
  const awaitingFirstSync =
    initialContent !== undefined && entitlementReadOnly === undefined && syncState === 'connecting';
  // The sync gate's other two banner reasons, same mutual-exclusion rule as `awaitingFirstSync`
  // above (only one of `entitlementReadOnly`/`awaitingFirstSync`/`syncDenied`/`syncTimedOut` is
  // ever true at a time, since they all key off disjoint `syncState` values or its absence).
  const syncDenied =
    initialContent !== undefined && entitlementReadOnly === undefined && syncState === 'denied';
  const syncTimedOut =
    initialContent !== undefined && entitlementReadOnly === undefined && syncState === 'timedOut';

  // A modifier class, not a hardcoded sixth grid row: `.application`'s `grid-template-rows`
  // (styles.css) is a fixed five-row track list, and `.readonly-banner` is an extra grid child
  // only present when one of the four banner reasons above is true. Without a class marking that,
  // the banner would silently consume the toolbar's row and shove every row after it down by one
  // -- `has-readonly-banner` is what lets styles.css insert an `auto`-sized row for the banner
  // specifically when one exists, leaving the five original rows' sizes untouched otherwise.
  const applicationClassName = [
    'application',
    dark && 'dark',
    (entitlementReadOnly || awaitingFirstSync || syncDenied || syncTimedOut) &&
      'has-readonly-banner',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <main className={applicationClassName}>
      <header className="titlebar">
        {/*
          A plain anchor, not the router's `Link`: App is deliberately rendered as a
          router-agnostic, lazily-loaded unit (see the route component's `lazy(...)` import and
          this file's own standalone test suite, neither of which provide router context), and
          the only way out of a screenplay before this was the browser's own back button. A full
          navigation to /projects is a small cost for a control used rarely and deliberately,
          against the alternative of adding router context to a component that has never needed
          it. The accessible name leads with the visible "Finaler Draft" text per WCAG 2.5.3.
        */}
        <a aria-label="Finaler Draft — back to your projects" className="brand" href="/projects">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </a>
        <div className="document-title">
          <span
            className={projection.valid ? 'save-dot' : 'save-dot attention'}
            aria-label="Local draft"
          />
          {initial.title} <span className="title-type">Screenplay</span>
        </div>
        <span className="account-button" aria-label="Signed-in writer">
          FD
        </span>
      </header>
      <nav className="menubar" aria-label="Application menu">
        {/*
          Only File is a working menu this increment (plan.md schedules activating the other five
          alongside the Characters tab, a separate, out-of-scope item). It reuses OverflowMenu --
          the same accessible popup-menu contract (Enter/Space to open, arrow keys between items,
          Escape closes and returns focus to the trigger) the header's own account menu already
          uses -- rather than a bespoke menu implementation for a single item.
        */}
        <div className="menu-file" ref={fileMenuRef}>
          <OverflowMenu
            items={[
              {
                disabled: !editingAllowed,
                disabledReason: !editingAllowed
                  ? awaitingFirstSync
                    ? 'Read-only: connecting to the collaboration server'
                    : syncDenied
                      ? 'Read-only: access to this screenplay could not be confirmed'
                      : syncTimedOut
                        ? 'Read-only: still trying to connect to the collaboration server'
                        : 'Read-only: this screenplay is not your account’s editable one'
                  : undefined,
                label: 'Document settings…',
                onSelect: () => setSettingsDialogOpen(true),
              },
              {
                // Disabled, not a no-op, when `projection` is invalid: the FDX exporter takes a
                // canonical `Screenplay` (see `packages/fdx`'s own doc comment), which an invalid
                // local projection is not, and `screenplayToFdx` has no licence to guess at one.
                // The `if (projection.valid)` guard inside `onSelect` is still required -- it is
                // what lets TypeScript narrow `projection` to the branch with a `.screenplay` --
                // but it is no longer the only thing standing between a click and nothing
                // happening: `disabled` means that click can no longer reach `onSelect` at all.
                disabled: !projection.valid,
                disabledReason: exportDisabledReason,
                label: 'Download FDX…',
                onSelect: () => {
                  if (projection.valid) {
                    const { screenplay } = projection;
                    runExport('FDX', async () => {
                      const { triggerFdxDownload } = await import('./fdxDownload.js');
                      triggerFdxDownload(screenplay);
                    });
                  }
                },
              },
              {
                // Same reasoning as "Download FDX…" above: `screenplayToDocx` takes a canonical
                // `Screenplay` (see `packages/docx`'s own doc comment), and an invalid local
                // projection is not one.
                disabled: !projection.valid,
                disabledReason: exportDisabledReason,
                label: 'Download DOCX…',
                onSelect: () => {
                  if (projection.valid) {
                    const { screenplay } = projection;
                    runExport('DOCX', async () => {
                      const { triggerDocxDownload } = await import('./docxDownload.js');
                      triggerDocxDownload(screenplay);
                    });
                  }
                },
              },
              {
                // Same disabled-not-a-no-op reasoning as "Download FDX…" above -- this is in fact
                // the owner's exact reported symptom: "Download PDF did nothing when clicked" was
                // this same `if (projection.valid)` guard with no disabled state and no reason,
                // on a document a paste had made invalid (progress/paste-sanitization.md).
                // `triggerPdfDownload` is `async` (`screenplayToPdf` is -- see
                // `@finaler-draft/pdf`'s `index.ts`), so a rejection (most likely
                // `@finaler-draft/pdf`'s WinAnsiEncoding limitation -- a character PDF's
                // un-embedded standard Courier cannot render) must still be caught here or it
                // becomes an unhandled promise rejection; that failure mode is unrelated to and
                // unfixed by `disabled`, which only ever concerns an invalid local projection.
                // `runExport` surfaces it in the toast below, same as FDX and DOCX.
                disabled: !projection.valid,
                disabledReason: exportDisabledReason,
                label: 'Download PDF…',
                onSelect: () => {
                  if (projection.valid) {
                    const { screenplay } = projection;
                    runExport('PDF', async () => {
                      const { triggerPdfDownload } = await import('./pdfDownload.js');
                      await triggerPdfDownload(screenplay);
                    });
                  }
                },
              },
            ]}
            label="File menu"
            triggerContent="File"
          />
        </div>
        <span>Edit</span>
        <span>View</span>
        <span>Format</span>
        <span>Tools</span>
        <span>Help</span>
        <span className="menubar-spacer" />
        <button type="button" onClick={() => setDark((value) => !value)}>
          {dark ? 'Light canvas' : 'Dark canvas'}
        </button>
      </nav>
      {settingsDialogOpen && (
        <DocumentSettingsDialog
          onChange={updateDocumentSettings}
          onClose={closeSettingsDialog}
          settings={documentSettings}
        />
      )}
      {entitlementReadOnly && (
        // Persistent, not dismissible: plan.md's lapse policy means this state does not resolve
        // itself, so nothing here ever offers a way to hide it without actually addressing it.
        // Rendered above the toolbar so it is visible regardless of which panels are open or
        // closed -- the one thing on this screen every read-only visit must see.
        <div className="readonly-banner" role="status">
          <p>{entitlementReadOnly.message}</p>
          {entitlementReadOnly.onMakeEditable && (
            <button
              className="primary-button"
              disabled={
                makeEditableState === 'pending' || entitlementReadOnly.cooldownUntil !== undefined
              }
              onClick={makeEditable}
              type="button"
            >
              Make this one editable
            </button>
          )}
          {entitlementReadOnly.cooldownUntil !== undefined && (
            // Known up front, from the same `cooldownEndsAt` GET /api/entitlement already
            // returns -- the button says so before a click, rather than inviting one that the
            // server has already told this app it will refuse. See the route's own comment for
            // why this is not a client-recomputed cooldown: it is exactly the server's own value,
            // read for display, never for enforcement.
            <p className="readonly-banner-cooldown">
              You can switch to a different screenplay again at {entitlementReadOnly.cooldownUntil}.
            </p>
          )}
          {/* Suppressed once `cooldownUntil` arrives: the failed click's own `onMakeEditable`
              (the route) invalidates entitlement on failure too, so a stale-data race (the button
              was clickable because this app's last fetch predated the cooldown) resolves into the
              same up-front explanation above on the very next render, rather than leaving both a
              raw server error and a redundant cooldown notice on screen at once. */}
          {makeEditableState === 'error' && entitlementReadOnly.cooldownUntil === undefined && (
            <p className="field-error" role="alert">
              {makeEditableError}
            </p>
          )}
        </div>
      )}
      {awaitingFirstSync && (
        // The sync gate's own banner (`editingAllowed`'s comment above): reuses the exact
        // `entitlementReadOnly` banner's markup and class -- the lapse-chooser slice's own
        // pattern for a legibly read-only editor, not a second one invented for this -- but never
        // renders alongside it (`awaitingFirstSync` is already `false` whenever
        // `entitlementReadOnly` is set). No action button: unlike a lapsed entitlement, there is
        // nothing for the writer to do here but wait, and this resolves on its own the moment
        // this tab's first sync completes -- `editingAllowed` flips back to `true` and this banner
        // stops rendering, no dismissal needed. Transient by nature, so it is not given the same
        // "persistent, not dismissible" framing as the entitlement banner's own comment: it is
        // gone within moments on any normal connection, and reappears only if a screenplay is
        // opened for the very first time on a slow one.
        <div className="readonly-banner" role="status">
          <p>
            Connecting to the collaboration server — this screenplay will be editable once it syncs.
          </p>
        </div>
      )}
      {syncDenied && (
        // The sync gate's *terminal* banner (`syncState`'s own comment on `'denied'`): a resolved,
        // deliberate decision that this actor may not see this document -- wrong Origin, no
        // session, or a role lookup that genuinely found none (`apps/collab`'s
        // `authenticateConnection`). Never retried, so unlike `awaitingFirstSync` this does not
        // resolve on its own; a reload is the only way out, since that is the only thing that
        // re-checks the session/account from scratch.
        <div className="readonly-banner" role="status">
          <p>
            This screenplay’s access could not be confirmed for your account. Reload the page to try
            again.
          </p>
        </div>
      )}
      {syncTimedOut && (
        // The backstop banner (`syncState`'s own comment on `'timedOut'`): this tab has been
        // waiting for its first sync for longer than `SYNC_TIMEOUT_MS` with no `synced` and no
        // `authenticationFailed` at all -- covers whatever the transient-retry loop does not
        // itself resolve, or a failure mode neither that loop nor `authenticate.ts`'s
        // classification anticipated. Not asserted permanent like `syncDenied`'s banner: this one
        // still disappears on its own if a `synced` arrives late, since the underlying provider
        // never stopped trying.
        <div className="readonly-banner" role="status">
          <p>
            Still trying to connect to the collaboration server. If this continues, reload the page.
          </p>
        </div>
      )}
      <section className="toolbar" aria-label="Screenplay tools">
        <ToolButton
          disabled={!editingAllowed || !editor?.can().undo()}
          label="Undo local change"
          onClick={() => editor?.commands.undo()}
        >
          ↶
        </ToolButton>
        <ToolButton
          disabled={!editingAllowed || !editor?.can().redo()}
          label="Redo local change"
          onClick={() => editor?.commands.redo()}
        >
          ↷
        </ToolButton>
        <span className="rule" />
        <label className="element-selector">
          <span className="visually-hidden">Active screenplay element</span>
          <select
            aria-label="Active screenplay element"
            disabled={!editingAllowed}
            onChange={(event) => changeElement(event.target.value as ScreenplayElementType)}
            value={activeElement}
          >
            {screenplayElementTypes.map((element) => (
              <option key={element} value={element}>
                {displayElement(element)}
              </option>
            ))}
          </select>
        </label>
        <span className="toolbar-spacer" />
        <div className="zoom-controls">
          <button
            aria-label="Zoom out"
            onClick={() => updateZoom(-ZOOM_STEP_PERCENT)}
            title="Zoom out"
            type="button"
          >
            −
          </button>
          {/* One control, not two (the owner's explicit request, superseding the previous
              side-by-side stepper box and preset box): the current percentage stays the visible,
              announced content in the middle -- the `<output>` below, aria-label and text content
              both unchanged from before this slice -- while clicking anywhere on that number opens
              the same preset `<select>` plan.md's "Zoom controls" asks for ("a preset dropdown ...
              a set of fixed percentages plus 'Fit page' and 'Fit width'. Use a real select, or a
              listbox that behaves like one"). The select is a real, fully keyboard- and
              screen-reader-operable native control, stacked exactly on top of the `<output>` via
              `.zoom-level`'s CSS (styles.css) and made visually transparent rather than removed --
              `opacity: 0`, not `display: none` or `visibility: hidden`, so it stays focusable and
              clickable. Its own value only ever matches one of its own options when `zoomMode` is a
              fit mode or an exact preset percentage -- a percentage reached via the stepper buttons
              or a keyboard shortcut that lands off-preset (e.g. 85%) leaves the select showing no
              option selected, which is honest: it is a jump-to control, not a second display of the
              live percentage (the `<output>` is that, and stays visible underneath regardless of
              which option the select currently considers selected). Because `opacity: 0` also hides
              a focused element's own native focus ring, `.zoom-level:focus-within` (styles.css)
              draws the focus indicator on the visible wrapper instead, so a keyboard user tabbing to
              this control still sees exactly where focus is. */}
          <div className="zoom-level">
            <output aria-label="Zoom level">{Math.round(zoomPercent)}%</output>
            <select
              aria-label="Zoom preset"
              onChange={(event) => chooseZoomPreset(event.target.value)}
              value={zoomMode.kind === 'fixed' ? String(zoomMode.percent) : zoomMode.kind}
            >
              <optgroup label="Fit">
                <option value="fit-width">Fit width</option>
                <option value="fit-page">Fit page</option>
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
          <button
            aria-label="Zoom in"
            onClick={() => updateZoom(ZOOM_STEP_PERCENT)}
            title="Zoom in"
            type="button"
          >
            +
          </button>
        </div>
        <span className="rule" />
        <ToolButton
          active={showLabels}
          label="Toggle element labels"
          onClick={() => setShowLabels((value) => !value)}
        >
          ⌸
        </ToolButton>
        <ToolButton
          active={continuousScroll}
          label="Toggle continuous scroll"
          onClick={() => setContinuousScroll((value) => !value)}
        >
          ⬍
        </ToolButton>
        <ToolButton
          active={panels.navigator}
          label="Toggle navigator"
          onClick={() => togglePanel('navigator')}
        >
          ☷
        </ToolButton>
        <ToolButton
          active={panels.inspector}
          label="Toggle inspector"
          onClick={() => togglePanel('inspector')}
        >
          ☰
        </ToolButton>
      </section>
      <div className="workspace">
        {panels.navigator && (
          <aside className="panel navigator" aria-label="Navigator">
            <div className="panel-heading">
              <span>Navigator</span>
              <button
                aria-label="Close navigator"
                onClick={() => togglePanel('navigator')}
                title="Close navigator"
                type="button"
              >
                ×
              </button>
            </div>
            <div aria-label="Navigator sections" className="panel-tabs" role="tablist">
              {NAVIGATOR_TABS.map((tab) => (
                <button
                  aria-controls={`navigator-panel-${tab.id}`}
                  aria-selected={navigatorTab === tab.id}
                  className={navigatorTab === tab.id ? 'selected' : ''}
                  id={`navigator-tab-${tab.id}`}
                  key={tab.id}
                  onClick={() => setNavigatorTab(tab.id)}
                  onKeyDown={(event) => {
                    // Left/Right rather than Up/Down: `.panel-tabs` lays tabs out horizontally
                    // (see styles.css), and the WAI-ARIA tabs pattern keys arrow direction to the
                    // tablist's own orientation. Moves focus and switches the active tab together
                    // ("automatic activation"), the same immediate-effect convention
                    // `OverflowMenu.tsx`'s Up/Down already uses for its own list.
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
                      return;
                    }
                    event.preventDefault();
                    const currentIndex = NAVIGATOR_TABS.findIndex(
                      (candidate) => candidate.id === navigatorTab,
                    );
                    const delta = event.key === 'ArrowRight' ? 1 : -1;
                    const nextTab =
                      NAVIGATOR_TABS[
                        (currentIndex + delta + NAVIGATOR_TABS.length) % NAVIGATOR_TABS.length
                      ];
                    if (!nextTab) {
                      return;
                    }
                    setNavigatorTab(nextTab.id);
                    document.getElementById(`navigator-tab-${nextTab.id}`)?.focus();
                  }}
                  role="tab"
                  // Roving tabindex: only the selected tab is a Tab stop, matching the WAI-ARIA
                  // tabs pattern -- Tab moves focus in and out of the tablist as a single stop,
                  // and the arrow-key handler above moves focus (and selection) within it.
                  tabIndex={navigatorTab === tab.id ? 0 : -1}
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {navigatorTab === 'scenes' ? (
              <ol
                aria-labelledby="navigator-tab-scenes"
                className="scene-list"
                id="navigator-panel-scenes"
                role="tabpanel"
                tabIndex={0}
              >
                {scenes.map((scene, index) => (
                  <li key={scene.id}>
                    <button
                      className={selectedScene?.id === scene.id ? 'selected' : ''}
                      type="button"
                      onClick={() => selectScene(scene)}
                    >
                      <span>{`${index + 1}. ${scene.heading.text}`}</span>
                      <small>{scene.body.length} blocks</small>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <ol
                aria-labelledby="navigator-tab-characters"
                className="scene-list"
                id="navigator-panel-characters"
                role="tabpanel"
                tabIndex={0}
              >
                {characters.map((character) => (
                  <li key={character.name}>
                    <button
                      className={selectedCharacter?.name === character.name ? 'selected' : ''}
                      type="button"
                      onClick={() => selectCharacter(character)}
                    >
                      <span>{character.name}</span>
                      {/*
                        The bare count is how many times this character speaks -- `cueBlockIds`,
                        the cues alone, not `blockIds`, which is the whole speech attribution and
                        would count parentheticals and every dialogue paragraph besides. It carries
                        no label because neither noun is true: "lines" is wrong for a count of cues,
                        and a count of blocks is not what a writer wants to know about a character.
                      */}
                      <small>
                        {character.extensions.length > 0
                          ? `${character.cueBlockIds.length} · ${character.extensions.join(', ')}`
                          : `${character.cueBlockIds.length}`}
                      </small>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <div className="navigator-footer">
              {navigatorTab === 'scenes'
                ? `${scenes.length} scenes · local draft`
                : `${characters.length} characters · local draft`}
            </div>
          </aside>
        )}
        <section className="editor-region" aria-label="Screenplay editor" ref={editorRegionRef}>
          <div className="ruler" aria-hidden="true">
            <span>1</span>
            <span>2</span>
            <span>3</span>
            <span>4</span>
            <span>5</span>
            <span>6</span>
          </div>
          <div
            className="pages"
            ref={pagesRef}
            style={{ zoom: zoomPercent / 100 } as CSSProperties}
          >
            {/* CSS `zoom` on `.pages`, not `transform: scale()` on `.page`/`TitlePageView`
                individually (this slice's departure from plan.md:683, which names
                `transform-origin: top center` as evidence "scale was the original intent" -- see
                progress/zoom-modes.md for the measurements that justified overriding it).
                `transform` does not affect layout: it repaints a scaled box in place without ever
                telling layout the box got bigger or smaller, so `.pages > * + *`'s `margin-top`
                (styles.css, the title-page-to-content-page gap) stayed a fixed number of unscaled
                pixels regardless of zoom -- shrinking, relative to a zoomed-in page, until the
                title page's scaled rendering overlapped the first content page. CSS `zoom`, applied
                once here to the shared parent rather than to each page individually, scales layout
                itself: every descendant's box -- including the title page's own height and the
                `margin-top` gap between it and `.page` -- grows or shrinks by the same factor
                `.pages`'s `scrollHeight` already reports, so the gap keeps its proportion at every
                zoom level with no separate compensation. Measured directly (a bare zoomed div, not
                argued from spec): at zoom 0.5/1.0/1.5 a fixed 48px `margin-top` rendered as
                24/48/72px and `scrollHeight` scaled exactly in step. */}
            {titlePageState && (
              <TitlePageView
                onChange={updateTitlePageState}
                readOnly={!editingAllowed}
                state={titlePageState}
              />
            )}
            <article
              className={continuousScroll ? 'page continuous' : 'page'}
              style={
                {
                  '--fd-page-gap': `${PAGE_GAP_IN}in`,
                  '--fd-page-stack-min-height': `${pageStackMinHeightIn(pageCount)}in`,
                } as CSSProperties
              }
              aria-label={`${initial.title} screenplay canvas`}
              onMouseDown={handlePageMouseDown}
            >
              <div className="page-number">DRAFT</div>
              <div className={showLabels ? 'script-body show-element-labels' : 'script-body'}>
                <EditorContent editor={editor} />
              </div>
            </article>
          </div>
        </section>
        {panels.inspector && (
          <aside className="panel inspector" aria-label="Inspector">
            <div className="panel-heading">
              <span>Inspector</span>
              <button
                aria-label="Close inspector"
                onClick={() => togglePanel('inspector')}
                title="Close inspector"
                type="button"
              >
                ×
              </button>
            </div>
            <section className="inspector-section">
              <h2>Active element</h2>
              <p className="inspector-value">{displayElement(activeElement)}</p>
              <p className="muted">Element changes keep the local block identity.</p>
            </section>
            <section className="inspector-section">
              <h2>Scope</h2>
              <p className="muted">
                {initialContent
                  ? 'This editor supports screenplay text blocks and a single title page. Notes, dual dialogue, page breaks, more than one title page, imports, exports, and print pagination are not editable here.'
                  : 'This screenplay contains more than one title page, notes, dual dialogue, or page breaks. It is read-only until a compatible editor is available.'}
              </p>
            </section>
          </aside>
        )}
      </div>
      <footer className="statusbar">
        <span aria-label="Active scene">
          {selectedScene ? selectedScene.heading.text : 'No active scene'}
        </span>
        <span className="status-center" aria-live="polite">
          {initialContent === undefined
            ? 'Text editing is unavailable for this screenplay'
            : entitlementReadOnly
              ? 'Read-only · make this screenplay editable to save changes here'
              : syncState === 'connecting'
                ? 'Connecting…'
                : syncState === 'denied'
                  ? 'Access could not be confirmed · reload to try again'
                  : syncState === 'timedOut'
                    ? 'Still trying to connect · reload if this continues'
                    : syncState === 'offline'
                      ? // Yjs keeps every local edit queued and merges it in the instant the
                        // connection recovers -- this is a connectivity report, never a warning
                        // that work could be lost, which is exactly what distinguishes it from
                        // the whole-document-`PUT` save-conflict state this replaces
                        // (progress/collaboration-slice-1.md).
                        'Offline · reconnecting… your edits are safe and will sync automatically'
                      : projection.valid
                        ? `Synced · ${wordCount} words · no print pagination`
                        : `Draft needs attention · ${projection.issues[0] ?? 'Invalid screenplay data.'}`}
        </span>
        {initialContent !== undefined && !projection.valid && (
          // Deliberately not inside `.status-center`, which the narrow-viewport media query
          // hides entirely (styles.css) -- exactly the gap requirement 2 in
          // progress/paste-sanitization.md exists to close: below that width the only place an
          // invalid projection was ever announced (the text this duplicates, a few lines up)
          // disappeared along with everything else in `.status-center`. Gated on
          // `initialContent !== undefined`: the other reason `projection` can be invalid is the
          // unrelated "this screenplay has features this editor can't open" case, which already
          // has its own unambiguous message above and disables editing entirely.
          <span className="status-attention" role="alert">
            {projection.issues[0] ?? 'Invalid screenplay data.'}
          </span>
        )}
        <ParticipantIndicator awareness={collab.provider?.awareness ?? undefined} />
      </footer>
      {exportError !== undefined && (
        // A toast rather than a line in the status bar: this message names the block and element
        // the writer has to go and fix, which the bar has no room for -- it already carries the
        // save state, the word count and the page count, and collapses to 30px below 600px. It is
        // also the wrong home for it in kind: the bar describes the document's ongoing state,
        // while this describes one completed attempt that failed.
        <Toast
          message={exportError}
          onDismiss={() => setExportError(undefined)}
          title="Export failed"
        />
      )}
      {/* SmartType's candidate list (smartTypeList.tsx). Mounted here, at the application root and
          outside `.page`, for the reason the toast above is: it is fixed-position chrome placed in
          viewport coordinates. Rendering it inside the manuscript would put a floating panel in
          the box tree of a page whose every line position is normative. */}
      <SmartTypeList editor={editor} />
      {/* The element menu (elementMenu.tsx). At the application root and outside `.page` for the
          same reason as the list above: it is fixed-position chrome placed in viewport
          coordinates, and a floating panel inside a page whose every line position is normative
          would be a way to move one. */}
      <ElementMenu editor={editor} />
    </main>
  );
}
