import type { ReactNode } from 'react';

/**
 * The Inspector -- the workspace's right panel -- as one presentational component, rendered by the
 * editor (`App.tsx`) and by the read-only revision comparison alike. See `applicationToolbar.tsx`'s
 * comment for why both screens now wear the whole frame, and for the one-way dependency rule that
 * keeps the editor out of the comparison's chunk.
 *
 * It is deliberately thinner than `NavigatorPanel`: the two screens' inspectors hold genuinely
 * different *content* -- the editor's active element and editing scope, the comparison's two sides,
 * change counts and legend -- and only the panel's frame is shared. What that frame guarantees is
 * what a reader notices: the same `.panel.inspector` shell, the same `.panel-heading` with the same
 * `Close inspector` affordance in the same place, and the same `.inspector-section` + `<h2>` rhythm
 * for every section inside it. A screen that wrote its own sections by hand would drift from that
 * rhythm one heading at a time, which is exactly what the extraction exists to prevent.
 *
 * Sections carry arbitrary `ReactNode` content rather than a narrower shape on purpose: the editor's
 * sections are paragraphs, the comparison's include a definition list and the diff legend, and
 * inventing a union that covers both would be a worse abstraction than passing the content.
 */

export interface InspectorSection {
  /** React key, and nothing else: never rendered. */
  readonly key: string;
  readonly content: ReactNode;
  readonly heading: string;
}

export interface InspectorPanelProps {
  readonly onClose: () => void;
  readonly sections: readonly InspectorSection[];
}

export function InspectorPanel({ onClose, sections }: InspectorPanelProps) {
  return (
    <aside className="panel inspector" aria-label="Inspector">
      <div className="panel-heading">
        <span>Inspector</span>
        <button
          aria-label="Close inspector"
          onClick={onClose}
          title="Close inspector"
          type="button"
        >
          ×
        </button>
      </div>
      {sections.map((section) => (
        <section className="inspector-section" key={section.key}>
          <h2>{section.heading}</h2>
          {section.content}
        </section>
      ))}
    </aside>
  );
}
