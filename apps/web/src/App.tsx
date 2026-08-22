import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  deriveScenes,
  screenplayToPlainText,
  type DerivedScene,
  type DocumentSettings,
  type Screenplay,
  type ScreenplayBlock,
} from '@finaler-draft/screenplay';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import {
  convertActiveScreenplayBlock,
  findScreenplayBlockPosition,
  getActiveScreenplayBlock,
  editorContentFromScreenplay,
  projectLocalScreenplay,
  screenplayElementTypes,
  screenplayExtensions,
  type LocalScreenplayProjection,
  type ScreenplayElementType,
} from './screenplayEditor.js';
import {
  PaginationExtension,
  paginationPluginKey,
  updatePaginationDocumentSettings,
} from './paginationExtension.js';
import { PAGE_GAP_IN, pageStackMinHeightIn } from './pagination.js';
import { ApiError, api, type PersistedScreenplay } from './api.js';
import { applyPageGeometryCssVariables } from './pageGeometryCss.js';
import { TitlePageView } from './titlePageEditor.js';
import {
  titlePageFromState,
  titlePageStateFromTitlePage,
  type TitlePageState,
} from './titlePageState.js';
import { DocumentSettingsDialog } from './documentSettingsDialog.js';
import { OverflowMenu } from './components/OverflowMenu.js';
import { Toast } from './components/Toast.js';
import { triggerDocxDownload } from './docxDownload.js';
import { triggerFdxDownload } from './fdxDownload.js';
import { triggerPdfDownload } from './pdfDownload.js';

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

function displayElement(element: ScreenplayElementType): string {
  return element
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');
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

const legacyInitial: PersistedScreenplay = {
  id: '7c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
  projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
  title: 'The Long Way Home',
  version: 1,
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

export function App({ initial = legacyInitial }: { initial?: PersistedScreenplay }) {
  const [panels, setPanels] = useState<Record<Panel, boolean>>({
    navigator: true,
    inspector: true,
  });
  const [zoom, setZoom] = useState(100);
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
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed' | 'conflict'>('saved');

  // An export that fails *after* the projection was valid -- today, only `@finaler-draft/pdf`
  // rejecting on a character PDF's un-embedded standard Courier cannot encode (Cyrillic, Greek,
  // emoji: all of which paste, save, and export to FDX and DOCX perfectly well). `disabled` does
  // not cover this: the screenplay is genuinely valid, so the menu item is genuinely enabled, and
  // the click genuinely runs. Without this the rejection reached `console.error` alone and the
  // writer saw a click that did nothing -- the same silent failure this scope exists to remove,
  // arriving through a different door.
  const [exportError, setExportError] = useState<string>();
  // Feedback for the conflict state's "Copy my version" button (below). Not part of `saveState`:
  // it describes the clipboard action's own outcome, which can succeed or fail independently of
  // -- and without ever changing -- the save conflict it is trying to rescue the writer from.
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
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
  const editorContent = useMemo(() => {
    if (initialContent === undefined || initialContent.content.length > 0) {
      return initialContent;
    }
    return {
      content: [
        {
          attrs: { element: 'action' as const, id: crypto.randomUUID() },
          type: 'screenplayBlock' as const,
        },
      ],
      type: 'screenplayDocument' as const,
    };
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
  const inFlight = useRef(false);
  const latestProjection = useRef<LocalScreenplayProjection | undefined>(undefined);
  const savedWire = useRef(JSON.stringify(initial.screenplay));
  const failedEditSequence = useRef<number | undefined>(undefined);
  const editSequence = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const versionRef = useRef(initial.version);
  const saveStateRef = useRef(saveState);
  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);
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
  const updateZoom = (amount: number) =>
    setZoom((current) => Math.min(150, Math.max(70, current + amount)));
  const togglePanel = (panel: Panel) =>
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));

  // Shared by `syncEditorState` (body edits, via Tiptap's own callbacks) and
  // `updateTitlePageState` (title-page edits, which never touch the ProseMirror document and so
  // never fire a Tiptap callback at all) -- both need to record the latest projection and, when
  // the edit actually changed something, schedule a save from it.
  const applyProjection = (nextProjection: LocalScreenplayProjection, changed: boolean) => {
    latestProjection.current = nextProjection;
    setProjection(nextProjection);
    if (changed) {
      editSequence.current += 1;
      scheduleSave(nextProjection);
    }
  };

  const syncEditorState = (editorInstance: Editor, changed = false) => {
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
    applyProjection(nextProjection, changed);
  };

  const scheduleSave = (nextProjection: LocalScreenplayProjection) => {
    if (!nextProjection.valid || saveStateRef.current === 'conflict') return;
    const wire = JSON.stringify(nextProjection.screenplay);
    if (wire === savedWire.current) {
      window.clearTimeout(timer.current);
      if (!inFlight.current) setSaveState('saved');
      return;
    }
    if (saveStateRef.current === 'failed') {
      if (failedEditSequence.current === editSequence.current) return;
      failedEditSequence.current = undefined;
      saveStateRef.current = 'saved';
      setSaveState('saved');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveLatest(), 600);
  };

  // `keepalive` is only ever passed by the flush effect below, and only `true` for `pagehide`
  // specifically -- see that effect's own comment for why unmount and `visibilitychange` must
  // NOT set it. Every guard above still applies unchanged, including the conflict guard: this
  // must never resume saving into a version the server has already rejected, on the way out any
  // more than on the ordinary debounced path (requirement 4, progress/save-conflict-recovery.md).
  const saveLatest = async ({ keepalive = false }: { keepalive?: boolean } = {}) => {
    if (
      inFlight.current ||
      saveStateRef.current === 'conflict' ||
      saveStateRef.current === 'failed'
    )
      return;
    const nextProjection = latestProjection.current;
    if (!nextProjection?.valid) return;
    const wire = JSON.stringify(nextProjection.screenplay);
    if (wire === savedWire.current) return;
    inFlight.current = true;
    saveStateRef.current = 'saving';
    setSaveState('saving');
    try {
      const result = await api.saveScreenplay(
        initial.id,
        versionRef.current,
        nextProjection.screenplay,
        { keepalive },
      );
      versionRef.current = result.version;
      savedWire.current = wire;
      saveStateRef.current = 'saved';
      setSaveState('saved');
      const current = latestProjection.current;
      if (current?.valid && JSON.stringify(current.screenplay) !== wire) scheduleSave(current);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        saveStateRef.current = 'conflict';
        setSaveState('conflict');
      } else {
        failedEditSequence.current = editSequence.current;
        saveStateRef.current = 'failed';
        setSaveState('failed');
      }
    } finally {
      inFlight.current = false;
    }
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

  const editor = useEditor({
    content: editorContent ?? unavailableEditorContent,
    editable: initialContent !== undefined,
    editorProps: {
      attributes: {
        'aria-label': 'Screenplay editing canvas',
        'aria-multiline': 'true',
        role: 'textbox',
      },
    },
    extensions: [
      ...screenplayExtensions,
      PaginationExtension.configure({ documentSettings: initial.screenplay.documentSettings }),
    ],
    onCreate: ({ editor: editorInstance }) => {
      syncEditorState(editorInstance);
      syncPageCount(editorInstance);
    },
    onSelectionUpdate: ({ editor: editorInstance }) => syncEditorState(editorInstance),
    onUpdate: ({ editor: editorInstance }) => syncEditorState(editorInstance, true),
    onTransaction: ({ editor: editorInstance }) => syncPageCount(editorInstance),
  });

  // A pending debounced save (`scheduleSave`'s 600 ms `setTimeout`) is the last line of defence
  // against losing an edit that never got the chance to autosave (requirement 5,
  // progress/save-conflict-recovery.md -- the audit's "smaller sibling" finding). Three exits skip
  // that debounce entirely: this component unmounting (in-app navigation to a different
  // screenplay or route, via this effect's own cleanup), `visibilitychange` to `hidden` (tab
  // switch, backgrounding), and `pagehide` (navigation away, tab close). The first two are NOT the
  // page going away -- the app is still fully alive, mid-navigation or merely backgrounded -- so
  // they flush with an ordinary `fetch` (`keepalive: false`), which completes normally and has no
  // size limit. `pagehide` is the one genuine "the page may be gone before the response arrives"
  // case, so it alone passes `keepalive: true`: `fetch`'s `keepalive` is what lets that request
  // outlive the page, unlike a plain `fetch`, which the browser may abort mid-flight once the page
  // is truly gone. `navigator.sendBeacon` cannot replace it there -- the save is an authenticated
  // `PUT` with a JSON body and a content-type header, which `sendBeacon` has no way to express.
  //
  // The distinction matters because `keepalive: true` is capped at a 64 KB total request body by
  // the Fetch spec, and a real screenplay routinely exceeds that (measured on this branch:
  // canonical JSON for 500 blocks is already ~67 KB); a save over the cap throws, which
  // `saveLatest`'s own `catch` turns into `saveState: 'failed'`, never `'saved'` -- so a `pagehide`
  // flush can honestly fail large documents, but unmount and `visibilitychange` never pay that
  // cap at all, which is the case that matters for every in-app exit a writer actually takes.
  // `saveLatest` itself still refuses to run while `saveStateRef.current === 'conflict'` (see that
  // function's own comment), so none of these three can ever resume saving into a version the
  // server already rejected on the way out.
  //
  // `flushPendingSaveRef` exists only so the listeners below can be registered once, with an
  // empty dependency array, while still invoking the *current* render's `saveLatest` closure.
  // `saveLatest` is a plain function redefined every render, not memoized -- putting it directly
  // in this effect's dependency array would re-attach these listeners on every render for no
  // benefit (every code path it reaches reads current values through refs, never through this
  // closure), and omitting it would violate `react-hooks/exhaustive-deps`. Assigning to a ref
  // during render, rather than through a second effect, is deliberate: it needs to be current by
  // the time this effect's listeners can fire, which a same-render `useEffect` cannot guarantee
  // relative to another effect, and the assignment itself has no rendering side effect of its
  // own.
  const flushPendingSaveRef = useRef<(options: { keepalive: boolean }) => void>(() => {});
  flushPendingSaveRef.current = ({ keepalive }) => {
    window.clearTimeout(timer.current);
    void saveLatest({ keepalive });
  };

  useEffect(() => {
    const flushOrdinary = () => flushPendingSaveRef.current({ keepalive: false });
    const flushKeepalive = () => flushPendingSaveRef.current({ keepalive: true });
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushOrdinary();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', flushKeepalive);
    return () => {
      flushOrdinary();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', flushKeepalive);
    };
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

  // The conflict state's rescue action (requirement 2, progress/save-conflict-recovery.md): the
  // writer's own unsaved manuscript, as readable screenplay-formatted text, not the canonical
  // JSON `nextProjection.screenplay` actually is -- pasting JSON into an email or a document
  // would not read as a screenplay to anyone. `screenplayToPlainText` (`@finaler-draft/screenplay`)
  // does that formatting; this only owns getting the result onto the clipboard and reporting
  // whether that succeeded. `latestProjection.current` (not the `projection` state variable) is
  // read directly for the same reason `saveLatest` reads it: it is guaranteed current the instant
  // this runs, with no risk of a stale closure over a `projection` from an earlier render.
  //
  // The Clipboard API can reject -- a browser permission denial, a document that never gained
  // focus, an insecure context -- and `navigator.clipboard` can even be entirely absent in an
  // older or locked-down browser. Reporting only success would repeat exactly the defect this
  // scope exists to fix: a writer trusting an action that silently did nothing. `copyStatus`
  // drives a real, honest message either way (see the footer below); nothing here ever claims the
  // work is safe unless the clipboard write actually resolved.
  const copyMyVersion = async () => {
    const current = latestProjection.current;
    if (!current?.valid) {
      setCopyStatus('failed');
      return;
    }
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(screenplayToPlainText(current.screenplay));
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  // The conflict state's clean exit (requirement 3, progress/save-conflict-recovery.md): discards
  // this browser's unsaved copy and re-fetches the server's version. A full reload, not a
  // targeted refetch of the `staleTime: Infinity` query in
  // routes/projects/$projectId.screenplays.$screenplayId.tsx -- that query is deliberately
  // "consumed once" per that route's own comment, with no invalidation path threaded down to this
  // component, and reconstructing one just for this would add a second way to force a refetch
  // where a full reload already does the job honestly: a real, visible navigation a writer can
  // tell discarded something, not a quiet in-place swap.
  const reloadFromServer = () => {
    window.location.reload();
  };

  // Title-page edits happen in separate React state, never inside the ProseMirror document (see
  // the `titlePageState` comment above), so they never fire `onUpdate`/`onTransaction` the way
  // `syncEditorState` relies on. This is the title-page equivalent, called directly from
  // `TitlePageView`'s `onChange`. Takes `next` directly rather than reading `titlePageState` back
  // out of state, because `setTitlePageState` is asynchronous and the save this triggers must
  // reflect the edit that just happened, not whatever the closure captured before it.
  const updateTitlePageState = (next: TitlePageState) => {
    setTitlePageState(next);
    if (!editor) return;
    const nextProjection = projectLocalScreenplay(editor, {
      documentSettings,
      id: initial.id,
      title: initial.title,
      titlePages: [titlePageFromState(next)],
    });
    applyProjection(nextProjection, true);
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
  const updateDocumentSettings = (next: DocumentSettings) => {
    setDocumentSettings(next);
    if (!editor) return;
    updatePaginationDocumentSettings(editor, next);
    applyPageGeometryCssVariables(next);
    const nextProjection = projectLocalScreenplay(editor, {
      documentSettings: next,
      id: initial.id,
      title: initial.title,
      titlePages: titlePageState ? [titlePageFromState(titlePageState)] : [],
    });
    applyProjection(nextProjection, true);
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
    if (!editor) {
      return;
    }
    convertActiveScreenplayBlock(editor, element);
    editor.commands.focus(undefined, { scrollIntoView: false });
    syncEditorState(editor);
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

  return (
    <main className={dark ? 'application dark' : 'application'}>
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
                    triggerFdxDownload(projection.screenplay);
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
                    triggerDocxDownload(projection.screenplay);
                  }
                },
              },
              {
                // Same disabled-not-a-no-op reasoning as "Download FDX…" above -- this is in fact
                // the owner's exact reported symptom: "Download PDF did nothing when clicked" was
                // this same `if (projection.valid)` guard with no disabled state and no reason,
                // on a document a paste had made invalid (progress/paste-sanitization.md). Unlike
                // FDX/DOCX, `triggerPdfDownload` is `async` (`screenplayToPdf` is -- see
                // `@finaler-draft/pdf`'s `index.ts`), so a rejection (most likely
                // `@finaler-draft/pdf`'s WinAnsiEncoding limitation -- a character PDF's
                // un-embedded standard Courier cannot render) must still be caught here or it
                // becomes an unhandled promise rejection; that failure mode is unrelated to and
                // unfixed by `disabled`, which only ever concerns an invalid local projection.
                // No user-facing error surface exists yet for an export failure past that point;
                // logged so it is at least visible during development, and flagged as a known
                // limitation in progress/pdf-export.md rather than silently inventing one.
                disabled: !projection.valid,
                disabledReason: exportDisabledReason,
                label: 'Download PDF…',
                onSelect: () => {
                  if (projection.valid) {
                    setExportError(undefined);
                    triggerPdfDownload(projection.screenplay).catch((error: unknown) => {
                      console.error('PDF export failed:', error);
                      setExportError(
                        error instanceof Error
                          ? error.message
                          : 'PDF export failed for an unknown reason.',
                      );
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
      <section className="toolbar" aria-label="Screenplay tools">
        <ToolButton
          disabled={!editor?.can().undo()}
          label="Undo local change"
          onClick={() => editor?.commands.undo()}
        >
          ↶
        </ToolButton>
        <ToolButton
          disabled={!editor?.can().redo()}
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
            onClick={() => updateZoom(-10)}
            title="Zoom out"
            type="button"
          >
            −
          </button>
          <output aria-label="Zoom level">{zoom}%</output>
          <button aria-label="Zoom in" onClick={() => updateZoom(10)} title="Zoom in" type="button">
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
            <div className="panel-tabs">
              <span className="selected">Scenes</span>
              <span>Characters</span>
            </div>
            <ol className="scene-list">
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
            <div className="navigator-footer">{`${scenes.length} scenes · local draft`}</div>
          </aside>
        )}
        <section className="editor-region" aria-label="Screenplay editor">
          <div className="ruler" aria-hidden="true">
            <span>1</span>
            <span>2</span>
            <span>3</span>
            <span>4</span>
            <span>5</span>
            <span>6</span>
          </div>
          <div className="pages">
            {titlePageState && (
              // The title page is manuscript content (plan.md's "Title page"), so it scales with
              // zoom the same way `.page` does below -- the one crossing plan.md's "Manuscript and
              // interface are separate type systems" allows. The zoom style is passed directly
              // rather than lifted onto a shared wrapper: `.page`'s own inline style already
              // carries `--fd-page-stack-min-height` (read directly off `.page` by
              // App.test.tsx/page-rendering-persistence.spec.ts), which a wrapper would have had to
              // keep carrying anyway, so nothing is gained by moving it and something would be put
              // at risk.
              <TitlePageView
                onChange={updateTitlePageState}
                state={titlePageState}
                style={{ transform: `scale(${zoom / 100})` } as CSSProperties}
              />
            )}
            <article
              className={continuousScroll ? 'page continuous' : 'page'}
              style={
                {
                  transform: `scale(${zoom / 100})`,
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
            : saveState === 'conflict'
              ? // No claim of preservation: nothing preserves this browser's edits (there is no
                // localStorage, sessionStorage, or IndexedDB anywhere in apps/web/src -- see
                // audit/CONSOLIDATED.md item A2 and requirement 1 in
                // progress/save-conflict-recovery.md). This says only what is actually true --
                // something else changed this screenplay, this copy has not been saved, and
                // saving is paused -- and points at the two real actions below rather than an
                // instruction ("reload") that would destroy the very work it used to claim to
                // protect.
                'Save conflict · this screenplay changed elsewhere; this copy is unsaved and saving is paused'
              : saveState === 'failed'
                ? 'Save failed · make another edit to retry'
                : saveState === 'saving'
                  ? 'Saving…'
                  : projection.valid
                    ? `Saved · validated locally · ${wordCount} words · no print pagination`
                    : `Draft needs attention · ${projection.issues[0] ?? 'Invalid screenplay data.'}`}
        </span>
        {initialContent !== undefined && !projection.valid && (
          // Deliberately not inside `.status-center`, which the narrow-viewport media query
          // hides entirely (styles.css) -- exactly the gap requirement 2 in
          // progress/paste-sanitization.md exists to close: below that width the only place an
          // invalid projection was ever announced (the text this duplicates, a few lines up)
          // disappeared along with everything else in `.status-center`, leaving a writer on a
          // narrow window with no signal at all that `scheduleSave` (below) is refusing to run.
          // Gated on `initialContent !== undefined`: the other reason `projection` can be invalid
          // is the unrelated "this screenplay has features this editor can't open" case, which
          // already has its own unambiguous message above and disables editing entirely, so there
          // is no save being silently skipped there for this banner to announce.
          <span className="status-attention" role="alert">
            Not saving · {projection.issues[0] ?? 'Invalid screenplay data.'}
          </span>
        )}

        {saveState === 'conflict' && (
          // Deliberately not inside `.status-center`, which the small-viewport media query hides
          // entirely (styles.css) -- these are the writer's only way to rescue or leave a
          // conflict, so they must stay reachable at every viewport width the rest of the
          // statusbar collapses at. Copy is offered before Reload, and Reload is unambiguous
          // about what it discards: requirement 3, progress/save-conflict-recovery.md.
          <span className="status-conflict-actions">
            <button
              className="status-conflict-button"
              onClick={() => void copyMyVersion()}
              type="button"
            >
              Copy my version
            </button>
            <button className="status-conflict-button" onClick={reloadFromServer} type="button">
              Reload (discards this copy)
            </button>
            {copyStatus === 'copied' && (
              <span className="status-conflict-feedback" role="status">
                Copied to clipboard.
              </span>
            )}
            {copyStatus === 'failed' && (
              <span
                className="status-conflict-feedback status-conflict-feedback-error"
                role="alert"
              >
                Copy failed · select the manuscript text and copy it manually.
              </span>
            )}
          </span>
        )}
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
    </main>
  );
}
