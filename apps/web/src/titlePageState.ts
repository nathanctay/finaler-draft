import type { TitlePage } from '@finaler-draft/screenplay';

/**
 * The title-page editor's local, writer-facing state. Every field is a plain string/array rather
 * than the canonical `TitlePage`'s optional shape, because a controlled `contentEditable` field
 * (titlePageEditor.tsx) needs a concrete value to render even when the underlying canonical field
 * is absent -- an empty string or empty array is exactly "nothing typed here yet," and the
 * placeholder hint (styles.css's `:empty::after` convention, reused there -- see
 * `createDefaultTitlePage`'s doc comment in `@finaler-draft/screenplay`) is what tells the writer
 * that, not the state shape.
 *
 * Kept in its own module, separate from the components in titlePageEditor.tsx: mixing component
 * and non-component exports in one file defeats React Fast Refresh
 * (`react-refresh/only-export-components`, enforced here at `--max-warnings=0`).
 */
export type TitlePageState = {
  id: string;
  title: string;
  credit: string;
  source: string;
  draftDate: string;
  authors: string[];
  contact: string[];
};

/** Loads a canonical title page into editable local state. Absent optional fields become `''`/`[]`. */
export function titlePageStateFromTitlePage(titlePage: TitlePage): TitlePageState {
  return {
    id: titlePage.id,
    title: titlePage.title ?? '',
    credit: titlePage.credit ?? '',
    source: titlePage.source ?? '',
    draftDate: titlePage.draftDate ?? '',
    authors: titlePage.authors ? [...titlePage.authors] : [],
    contact: titlePage.contact ? [...titlePage.contact] : [],
  };
}

/**
 * Projects local editor state back to a canonical `TitlePage`. An empty scalar field or an empty
 * list omits the key entirely rather than writing `''`/`[]` -- "ordinary deletable text blocks"
 * (plan.md): clearing a field's text, or removing every line of a list, deletes it from the
 * canonical document the same way deleting a body block removes it. This is the same convention
 * `createDefaultTitlePage` uses for a freshly created title page's absent `authors`/`contact`, so
 * a title page that has never been touched -- or has been edited back down to nothing -- round-trips
 * to the identical canonical shape either way.
 */
export function titlePageFromState(state: TitlePageState): TitlePage {
  const titlePage: TitlePage = { id: state.id };
  if (state.title !== '') titlePage.title = state.title;
  if (state.credit !== '') titlePage.credit = state.credit;
  if (state.source !== '') titlePage.source = state.source;
  if (state.draftDate !== '') titlePage.draftDate = state.draftDate;
  if (state.authors.length > 0) titlePage.authors = state.authors;
  if (state.contact.length > 0) titlePage.contact = state.contact;
  return titlePage;
}
