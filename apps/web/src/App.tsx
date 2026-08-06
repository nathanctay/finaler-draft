import { useState, type ReactNode } from 'react';

type Panel = 'navigator' | 'inspector';

const screenplay: ReadonlyArray<readonly [kind: string, text: string]> = [
  ['SCENE HEADING', 'INT. APARTMENT — MORNING'],
  ['ACTION', 'Sunlight settles across a drafting table. MARA studies the last page of a script.'],
  ['CHARACTER', 'MARA'],
  ['DIALOGUE', 'If the ending is true, it has to earn its way there.'],
  ['CHARACTER', 'JON (O.S.)'],
  ['DIALOGUE', 'That sounds like a rewrite.'],
  ['ACTION', 'Mara smiles despite herself and turns to the empty chair.'],
];

function ToolButton({
  active,
  children,
  label,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={`tool-button${active ? ' active' : ''}`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function App() {
  const [panels, setPanels] = useState<Record<Panel, boolean>>({
    navigator: true,
    inspector: true,
  });
  const [zoom, setZoom] = useState(100);
  const [dark, setDark] = useState(false);
  const [selectedScene, setSelectedScene] = useState('1. Apartment');
  const updateZoom = (amount: number) =>
    setZoom((current) => Math.min(150, Math.max(70, current + amount)));
  const togglePanel = (panel: Panel) =>
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));

  return (
    <main className={dark ? 'application dark' : 'application'}>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        <div className="document-title">
          <span className="save-dot" aria-label="Saved" /> The Long Way Home{' '}
          <span className="title-type">Screenplay</span>
        </div>
        <button className="account-button" type="button" aria-label="Open account menu">
          MT
        </button>
      </header>
      <nav className="menubar" aria-label="Application menu">
        <button type="button">File</button>
        <button type="button">Edit</button>
        <button type="button">View</button>
        <button type="button">Format</button>
        <button type="button">Tools</button>
        <button type="button">Help</button>
        <span className="menubar-spacer" />
        <button type="button" onClick={() => setDark((value) => !value)}>
          {dark ? 'Light canvas' : 'Dark canvas'}
        </button>
      </nav>
      <section className="toolbar" aria-label="Formatting tools">
        <ToolButton label="Undo">↶</ToolButton>
        <ToolButton label="Redo">↷</ToolButton>
        <span className="rule" />
        <button className="element-selector" type="button">
          Scene Heading <span>⌄</span>
        </button>
        <span className="rule" />
        <ToolButton label="Bold">
          <strong>B</strong>
        </ToolButton>
        <ToolButton label="Italic">
          <em>I</em>
        </ToolButton>
        <ToolButton label="Underline">
          <u>U</u>
        </ToolButton>
        <span className="rule" />
        <ToolButton label="Align left">≡</ToolButton>
        <ToolButton label="Add note">▤</ToolButton>
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
              <button className="selected" type="button">
                Scenes
              </button>
              <button type="button">Characters</button>
            </div>
            <ol className="scene-list">
              {['1. Apartment', '2. The station', '3. Westbound', '4. The arrival'].map((scene) => (
                <li key={scene}>
                  <button
                    className={selectedScene === scene ? 'selected' : ''}
                    type="button"
                    onClick={() => setSelectedScene(scene)}
                  >
                    <span>{scene}</span>
                    <small>{scene === '1. Apartment' ? '1 ⅛' : '—'}</small>
                  </button>
                </li>
              ))}
            </ol>
            <div className="navigator-footer">4 scenes · 6 pages</div>
          </aside>
        )}
        <section className="editor-region" aria-label="Screenplay editor">
          <div className="ruler">
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
            aria-label="The Long Way Home screenplay, page 1"
          >
            <div className="page-number">1.</div>
            <div className="script-title">THE LONG WAY HOME</div>
            <div className="script-meta">
              Written by
              <br />
              Morgan Taylor
            </div>
            <div className="script-body">
              {screenplay.map(([kind, text]) => (
                <div
                  key={`${kind}-${text}`}
                  className={`script-line ${kind.toLowerCase().replace(' ', '-')}`}
                >
                  <span className="element-hint">{kind}</span>
                  <p>{text}</p>
                </div>
              ))}
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
              <h2>Scene</h2>
              <label>
                Scene heading
                <input value="INT. APARTMENT — MORNING" readOnly />
              </label>
              <label>
                Color
                <select defaultValue="None">
                  <option>None</option>
                  <option>Blue</option>
                  <option>Yellow</option>
                </select>
              </label>
            </section>
            <section className="inspector-section">
              <h2>Notes</h2>
              <button className="add-note" type="button">
                + Add script note
              </button>
              <p className="muted">Notes stay separate from the screenplay.</p>
            </section>
          </aside>
        )}
      </div>
      <footer className="statusbar">
        <span aria-label="Active scene">{selectedScene}</span>
        <span className="status-center">Page 1 of 6 · 1 ⅛ pages · 168 words</span>
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
