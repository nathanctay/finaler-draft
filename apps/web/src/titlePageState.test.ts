import { describe, expect, it } from 'vitest';
import { createDefaultTitlePage, type TitlePage } from '@finaler-draft/screenplay';
import { titlePageFromState, titlePageStateFromTitlePage } from './titlePageState.js';

const id = '00000000-0000-4000-8000-000000000001';

describe('titlePageStateFromTitlePage', () => {
  it('fills absent optional fields with empty strings and empty arrays', () => {
    const titlePage: TitlePage = { id };

    expect(titlePageStateFromTitlePage(titlePage)).toEqual({
      id,
      title: '',
      credit: '',
      source: '',
      draftDate: '',
      authors: [],
      contact: [],
    });
  });

  it('carries every present field through unchanged', () => {
    const titlePage: TitlePage = {
      id,
      title: 'THE LAST STOP',
      authors: ['Morgan Vale'],
      credit: 'Written by',
      source: 'a short story by Iris Kwan',
      draftDate: 'August 2026',
      contact: ['Morgan Vale', 'morgan@example.test'],
    };

    expect(titlePageStateFromTitlePage(titlePage)).toEqual({
      id,
      title: 'THE LAST STOP',
      credit: 'Written by',
      source: 'a short story by Iris Kwan',
      draftDate: 'August 2026',
      authors: ['Morgan Vale'],
      contact: ['Morgan Vale', 'morgan@example.test'],
    });
  });
});

describe('titlePageFromState', () => {
  it('omits every scalar field left blank, keeping only the id', () => {
    const titlePage = titlePageFromState({
      id,
      title: '',
      credit: '',
      source: '',
      draftDate: '',
      authors: [],
      contact: [],
    });

    expect(titlePage).toEqual({ id });
    expect(titlePage).not.toHaveProperty('title');
    expect(titlePage).not.toHaveProperty('credit');
    expect(titlePage).not.toHaveProperty('source');
    expect(titlePage).not.toHaveProperty('draftDate');
    expect(titlePage).not.toHaveProperty('authors');
    expect(titlePage).not.toHaveProperty('contact');
  });

  it('keeps every non-blank field and drops an author/contact list back to blank lines', () => {
    const titlePage = titlePageFromState({
      id,
      title: 'THE LAST STOP',
      credit: 'Written by',
      source: '',
      draftDate: '',
      authors: ['Morgan Vale', ''],
      contact: [],
    });

    // A blank line the writer added but never filled in is still a real line in local state
    // (it is what "Add author line" produces before typing) -- titlePageFromState does not
    // silently drop it, matching "ordinary deletable text blocks": an empty line stays present
    // until the writer explicitly removes it, the same way an empty body block stays present
    // until deleted rather than vanishing on its own.
    expect(titlePage).toEqual({
      id,
      title: 'THE LAST STOP',
      credit: 'Written by',
      authors: ['Morgan Vale', ''],
    });
  });
});

describe('round-tripping through TitlePageState', () => {
  it("reproduces createDefaultTitlePage's own output exactly, before any edit", () => {
    const original = createDefaultTitlePage(id, 'The Last Stop');
    const state = titlePageStateFromTitlePage(original);

    expect(titlePageFromState(state)).toEqual(original);
  });

  it('reproduces a fully populated title page exactly, before any edit', () => {
    const original: TitlePage = {
      id,
      title: 'THE LAST STOP',
      authors: ['Morgan Vale'],
      credit: 'Written by',
      draftDate: 'August 2026',
      contact: ['morgan@example.test'],
    };
    const state = titlePageStateFromTitlePage(original);

    expect(titlePageFromState(state)).toEqual(original);
  });
});
