import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  deriveScenes,
  type DerivedScene,
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
import { ApiError, api, type PersistedScreenplay } from './api.js';

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
  const [activeElement, setActiveElement] = useState<ScreenplayElementType>('scene_heading');
  const [activeBlockId, setActiveBlockId] = useState<string>();
  const [projection, setProjection] = useState<LocalScreenplayProjection>({
    issues: ['Editor is starting.'],
    valid: false,
  });
  const [version, setVersion] = useState(initial.version);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed' | 'conflict'>('saved');
  const initialContent = useMemo(() => {
    try {
      return editorContentFromScreenplay(initial.screenplay);
    } catch {
      return undefined;
    }
  }, [initial.screenplay]);
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
  const updateZoom = (amount: number) =>
    setZoom((current) => Math.min(150, Math.max(70, current + amount)));
  const togglePanel = (panel: Panel) =>
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));

  const syncEditorState = (editorInstance: Editor, changed = false) => {
    const currentBlock = getActiveScreenplayBlock(editorInstance);
    if (currentBlock) {
      setActiveBlockId(currentBlock.id);
      setActiveElement(currentBlock.element);
    }
    const nextProjection = projectLocalScreenplay(editorInstance, initial.id, initial.title);
    latestProjection.current = nextProjection;
    setProjection(nextProjection);
    if (changed) {
      editSequence.current += 1;
      scheduleSave(nextProjection);
    }
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

  const saveLatest = async () => {
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
      );
      versionRef.current = result.version;
      setVersion(result.version);
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
    extensions: screenplayExtensions,
    onCreate: ({ editor: editorInstance }) => syncEditorState(editorInstance),
    onSelectionUpdate: ({ editor: editorInstance }) => syncEditorState(editorInstance),
    onUpdate: ({ editor: editorInstance }) => syncEditorState(editorInstance, true),
  });

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!editor) return;
    const currentBlock = getActiveScreenplayBlock(editor);
    if (currentBlock) {
      setActiveBlockId(currentBlock.id);
      setActiveElement(currentBlock.element);
    }
    const nextProjection = projectLocalScreenplay(editor, initial.id, initial.title);
    latestProjection.current = nextProjection;
    setProjection(nextProjection);
  }, [editor, initial.id, initial.title]);

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

  const changeElement = (element: ScreenplayElementType) => {
    if (!editor) {
      return;
    }
    convertActiveScreenplayBlock(editor, element);
    editor.commands.focus(undefined, { scrollIntoView: false });
    syncEditorState(editor);
  };

  return (
    <main className={dark ? 'application dark' : 'application'}>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        <div className="document-title">
          <span
            className={projection.valid ? 'save-dot' : 'save-dot attention'}
            aria-label="Local draft"
          />
          {initial.title} <span className="title-type">Screenplay · v{version}</span>
        </div>
        <span className="account-button" aria-label="Signed-in writer">
          FD
        </span>
      </header>
      <nav className="menubar" aria-label="Application menu">
        <span>File</span>
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
                type="button"
                onClick={() => togglePanel('navigator')}
                aria-label="Close navigator"
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
          <article
            className="page"
            style={{ transform: `scale(${zoom / 100})` }}
            aria-label={`${initial.title} screenplay canvas`}
          >
            <div className="page-number">DRAFT</div>
            <div className="script-title">{initial.title.toUpperCase()}</div>
            <div className="script-meta">
              {initialContent ? 'Autosaved screenplay draft' : 'Read-only screenplay'}
            </div>
            <div className="script-body">
              <EditorContent editor={editor} />
            </div>
          </article>
        </section>
        {panels.inspector && (
          <aside className="panel inspector" aria-label="Inspector">
            <div className="panel-heading">
              <span>Inspector</span>
              <button
                type="button"
                onClick={() => togglePanel('inspector')}
                aria-label="Close inspector"
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
                  ? 'This editor supports screenplay text blocks. Notes, dual dialogue, page breaks, title pages, imports, exports, and print pagination are not editable here.'
                  : 'This screenplay contains title pages, notes, dual dialogue, or page breaks. It is read-only until a compatible editor is available.'}
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
              ? 'Save conflict · your local edits are preserved; reload before saving again'
              : saveState === 'failed'
                ? 'Save failed · make another edit to retry'
                : saveState === 'saving'
                  ? 'Saving…'
                  : projection.valid
                    ? `Saved · validated locally · ${wordCount} words · no print pagination`
                    : `Draft needs attention · ${projection.issues[0] ?? 'Invalid screenplay data.'}`}
        </span>
        <div className="zoom-controls">
          <button type="button" aria-label="Zoom out" onClick={() => updateZoom(-10)}>
            −
          </button>
          <output aria-label="Zoom level">{zoom}%</output>
          <button type="button" aria-label="Zoom in" onClick={() => updateZoom(10)}>
            +
          </button>
        </div>
      </footer>
    </main>
  );
}
