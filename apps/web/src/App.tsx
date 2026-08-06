import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { deriveScenes, type DerivedScene } from '@finaler-draft/screenplay';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import {
  convertActiveScreenplayBlock,
  findScreenplayBlockPosition,
  getActiveScreenplayBlock,
  initialScreenplayContent,
  projectLocalScreenplay,
  screenplayElementTypes,
  screenplayExtensions,
  type LocalScreenplayProjection,
  type ScreenplayElementType,
} from './screenplayEditor.js';

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

  return projection.screenplay.blocks.reduce((total, block) => {
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
    (scene) => scene.id === activeBlockId || scene.body.some((block) => block.id === activeBlockId),
  );
}

export function App() {
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
  const updateZoom = (amount: number) =>
    setZoom((current) => Math.min(150, Math.max(70, current + amount)));
  const togglePanel = (panel: Panel) =>
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));

  const syncEditorState = (editorInstance: Editor) => {
    const currentBlock = getActiveScreenplayBlock(editorInstance);
    if (currentBlock) {
      setActiveBlockId(currentBlock.id);
      setActiveElement(currentBlock.element);
    }
    setProjection(projectLocalScreenplay(editorInstance));
  };

  const editor = useEditor({
    content: initialScreenplayContent,
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
    onUpdate: ({ editor: editorInstance }) => syncEditorState(editorInstance),
  });

  useEffect(() => {
    if (editor) {
      syncEditorState(editor);
    }
  }, [editor]);

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
          The Long Way Home <span className="title-type">Local screenplay</span>
        </div>
        <span className="account-button" aria-label="Local prototype user">
          MT
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
            style={{ fontSize: `${zoom}%` }}
            aria-label="The Long Way Home editable screenplay canvas"
          >
            <div className="page-number">LOCAL</div>
            <div className="script-title">THE LONG WAY HOME</div>
            <div className="script-meta">Editable local screenplay draft</div>
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
                This local editor supports screenplay text blocks. Notes, dual dialogue, page
                breaks, title pages, imports, exports, and print pagination are not editable here.
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
          {projection.valid
            ? `Local draft · validated locally · ${wordCount} words · no print pagination`
            : `Local draft needs attention · ${projection.issues[0] ?? 'Invalid screenplay data.'}`}
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
