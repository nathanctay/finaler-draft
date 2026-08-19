import { useEffect, useRef, type CSSProperties } from 'react';
import type { TitlePageState } from './titlePageState.js';

type TitlePageFieldName = 'title' | 'credit' | 'source' | 'draft-date' | 'author' | 'contact';

/**
 * One editable text field on the title page: a bare `contentEditable` `div`, not a ProseMirror
 * node and not an `<input>`. `<input>`'s `value` is not a DOM child, so CSS `:empty` never matches
 * it regardless of content -- the placeholder convention this reuses (styles.css's
 * `[data-screenplay-block]:empty::after`) only works on an element that is genuinely childless
 * when blank, which a `contentEditable` `div` is and an `<input>` is not.
 *
 * Uncontrolled-but-synced, the same pattern `screenplayEditor.ts`'s ProseMirror nodes use one
 * level up: the DOM is the source of truth for what the writer is actively typing, and the effect
 * below only pushes `value` into the DOM when it disagrees (an external change -- undo, or the
 * writer clearing the field elsewhere -- not the writer's own keystroke, which already updated
 * both `ref.current.textContent` and `value` together via `onChange`).
 */
function TitlePageField({
  ariaLabel,
  className,
  field,
  onChange,
  value,
}: {
  ariaLabel: string;
  className?: string;
  field: TitlePageFieldName;
  onChange: (value: string) => void;
  value: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current && ref.current.textContent !== value) {
      ref.current.textContent = value;
    }
  }, [value]);

  return (
    <div
      aria-label={ariaLabel}
      className={className}
      contentEditable
      data-title-page-field={field}
      onInput={(event) => onChange(event.currentTarget.textContent ?? '')}
      onKeyDown={(event) => {
        // A title-page field is one line, unlike the body's blocks: Enter here has no split
        // target (there is no "next element" convention for a title page), so it is suppressed
        // rather than inserting a literal newline a single-line field was never meant to hold.
        if (event.key === 'Enter') {
          event.preventDefault();
        }
      }}
      ref={ref}
      role="textbox"
      suppressContentEditableWarning
    />
  );
}

function TitlePageLineList({
  addLabel,
  field,
  lineLabel,
  lines,
  listClassName,
  onChange,
  removeLabel,
}: {
  addLabel: string;
  field: TitlePageFieldName;
  lineLabel: (index: number) => string;
  lines: string[];
  listClassName: string;
  onChange: (lines: string[]) => void;
  removeLabel: (index: number) => string;
}) {
  return (
    <div className={listClassName}>
      {lines.map((line, index) => (
        // Index is the only available identity: canonical title-page lines are bare strings with
        // no stable id of their own (unlike a body block), so there is nothing else to key on.
        <div className="title-page-line" key={index}>
          <TitlePageField
            ariaLabel={lineLabel(index)}
            className="title-page-line-field"
            field={field}
            onChange={(value) => {
              const next = [...lines];
              next[index] = value;
              onChange(next);
            }}
            value={line}
          />
          <button
            aria-label={removeLabel(index)}
            className="title-page-line-remove"
            onClick={() => onChange(lines.filter((_, lineIndex) => lineIndex !== index))}
            type="button"
          >
            ×
          </button>
        </div>
      ))}
      <button
        aria-label={addLabel}
        className="title-page-line-add"
        onClick={() => onChange([...lines, ''])}
        type="button"
      >
        + Add line
      </button>
    </div>
  );
}

/**
 * The title page's editing surface: plan.md's default four blocks (title, "written by", author,
 * contact) plus the schema's two remaining optional fields (`source`, `draftDate`), so a title
 * page loaded with those already set (not something this app's own creation flow produces, but
 * schema-legal) is fully editable rather than merely passed through unread.
 *
 * Deliberately outside `packages/layout`'s and the pagination plugin's reach: this renders as its
 * own `article`, a sibling *before* `.page` (see App.tsx), never inside it -- `.page`'s own
 * children stay exactly `.page-number` then `.script-body`, which is what
 * `persistence.spec.ts`'s and `App.test.tsx`'s structural guards check. Title pages never
 * paginate with the body and are never numbered (plan.md); this component has no way to become
 * pagination input even by accident, because it never touches the ProseMirror document at all.
 */
export function TitlePageView({
  onChange,
  state,
  style,
}: {
  onChange: (next: TitlePageState) => void;
  state: TitlePageState;
  style?: CSSProperties;
}) {
  return (
    <article aria-label="Title page" className="title-page" style={style}>
      <div className="title-page-center">
        <TitlePageField
          ariaLabel="Title page: title"
          className="title-page-title"
          field="title"
          onChange={(value) => onChange({ ...state, title: value })}
          value={state.title}
        />
        <TitlePageField
          ariaLabel="Title page: written by"
          className="title-page-credit"
          field="credit"
          onChange={(value) => onChange({ ...state, credit: value })}
          value={state.credit}
        />
        <TitlePageLineList
          addLabel="Add author line"
          field="author"
          lineLabel={(index) => `Title page: author line ${index + 1}`}
          listClassName="title-page-authors"
          lines={state.authors}
          onChange={(authors) => onChange({ ...state, authors })}
          removeLabel={(index) => `Remove author line ${index + 1}`}
        />
        <TitlePageField
          ariaLabel="Title page: based on"
          className="title-page-source"
          field="source"
          onChange={(value) => onChange({ ...state, source: value })}
          value={state.source}
        />
        <TitlePageField
          ariaLabel="Title page: draft date"
          className="title-page-draft-date"
          field="draft-date"
          onChange={(value) => onChange({ ...state, draftDate: value })}
          value={state.draftDate}
        />
      </div>
      <TitlePageLineList
        addLabel="Add contact line"
        field="contact"
        lineLabel={(index) => `Title page: contact line ${index + 1}`}
        listClassName="title-page-contact"
        lines={state.contact}
        onChange={(contact) => onChange({ ...state, contact })}
        removeLabel={(index) => `Remove contact line ${index + 1}`}
      />
    </article>
  );
}
