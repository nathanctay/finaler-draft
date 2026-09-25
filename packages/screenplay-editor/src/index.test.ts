import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  type DocumentSettings,
  type TitlePage,
} from '@finaler-draft/screenplay';
import {
  createLocalScreenplayEditorInit,
  createLocalScreenplayYDoc,
  createScreenplayEditorInit,
  documentSettingsFromYMap,
  DOCUMENT_SETTINGS_YJS_MAP,
  getScreenplayEditorSchema,
  initialScreenplayContent,
  isDocumentSettingsMapSeeded,
  isTitlePageMapSeeded,
  nonEmptyEditorContent,
  projectYDocScreenplay,
  SCREENPLAY_YJS_FRAGMENT,
  seedScreenplayYDoc,
  titlePageFromYMap,
  TITLE_PAGE_YJS_MAP,
  writeDocumentSettingsToYMap,
  writeTitlePageToYMap,
  type EditorContent,
} from './index.js';

/**
 * This file covers the surface that has no other direct test anywhere in the repository: the Yjs
 * seams `createScreenplayEditorInit` builds and `apps/collab` (the Hocuspocus server) relies on to
 * seed and project a document with no live browser `Editor`/DOM involved at all.
 * `editing.test.ts` (this directory's other test file) covers the element-conversion, splitting,
 * leading-space, `projectDocumentScreenplay`, and paste-sanitisation behaviour -- moved here from
 * `apps/web/src/screenplayEditor.test.ts` alongside the code itself, so its coverage is credited to
 * this package rather than to the `apps/web` re-export shim it used to import through. And
 * `apps/collab/src/database.test.ts` already exercises this package's functions indirectly through
 * `createFetch`/`createStore`'s own fake-pool tests -- but nothing anywhere calls
 * `getScreenplayEditorSchema`, `projectYDocScreenplay`, or the undo/redo command wrappers directly
 * and asserts on their own contract, which is what belongs in this file.
 */

const simpleContent: EditorContent = {
  type: 'screenplayDocument',
  content: [
    {
      type: 'screenplayBlock',
      attrs: { element: 'scene_heading', id: '00000000-0000-4000-8000-000000000001' },
      content: [{ type: 'text', text: 'INT. WORKSHOP - NIGHT' }],
    },
    {
      type: 'screenplayBlock',
      attrs: { element: 'action', id: '00000000-0000-4000-8000-000000000002' },
      content: [{ type: 'text', text: 'A line of action.' }],
    },
  ],
};

describe('getScreenplayEditorSchema', () => {
  it('caches a single schema instance across calls, since NodeType identity matters throughout ProseMirror', () => {
    const first = getScreenplayEditorSchema();
    const second = getScreenplayEditorSchema();
    expect(second).toBe(first);
    expect(first.nodes.screenplayBlock).toBeDefined();
    expect(first.nodes.screenplayDocument).toBeDefined();
  });
});

describe('createLocalScreenplayYDoc / createScreenplayEditorInit', () => {
  it('round-trips content through a Y.Doc: what comes back matches what was seeded', () => {
    const ydoc = createLocalScreenplayYDoc(simpleContent);
    const fragment = ydoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT);
    const { content } = createScreenplayEditorInit(fragment);

    expect(content).toMatchObject({
      type: 'screenplayDocument',
      content: [
        { attrs: { element: 'scene_heading' }, content: [{ text: 'INT. WORKSHOP - NIGHT' }] },
        { attrs: { element: 'action' }, content: [{ text: 'A line of action.' }] },
      ],
    });
  });

  it('an empty fragment (no sync yet) projects to an empty document, not a throw', () => {
    const emptyYdoc = new Y.Doc();
    const fragment = emptyYdoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT);
    const { content } = createScreenplayEditorInit(fragment);
    // ProseMirror's own `Node.toJSON()` omits `content` entirely for a childless node rather than
    // serializing an empty array -- this is exactly that shape, not a bug in the projection.
    expect(content).toEqual({ type: 'screenplayDocument' });
  });

  it('builds a real, working Editor from the returned {content, extensions} pair', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      element: mount,
      ...createLocalScreenplayEditorInit(simpleContent),
    });

    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).textContent).toBe('INT. WORKSHOP - NIGHT');
    expect(editor.state.doc.child(0).attrs.element).toBe('scene_heading');
    expect(editor.state.doc.child(1).textContent).toBe('A line of action.');

    editor.destroy();
    mount.remove();
  });

  it('accepts the package own initialScreenplayContent fixture directly, with no cast needed', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      element: mount,
      ...createLocalScreenplayEditorInit(initialScreenplayContent),
    });
    expect(editor.state.doc.childCount).toBe(initialScreenplayContent.content.length);
    editor.destroy();
    mount.remove();
  });
});

describe('undo/redo (ScreenplayYjsExtension, replacing @tiptap/extension-history)', () => {
  it('undoes and redoes a local edit through the same editor.commands.undo()/redo() call sites the old history extension answered', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      element: mount,
      ...createLocalScreenplayEditorInit(simpleContent),
    });

    expect(editor.can().undo()).toBe(false);

    editor.commands.focus('end');
    editor.commands.insertContent('X');
    expect(editor.state.doc.child(1).textContent).toBe('A line of action.X');
    expect(editor.can().undo()).toBe(true);

    const undone = editor.commands.undo();
    expect(undone).toBe(true);
    expect(editor.state.doc.child(1).textContent).toBe('A line of action.');

    const redone = editor.commands.redo();
    expect(redone).toBe(true);
    expect(editor.state.doc.child(1).textContent).toBe('A line of action.X');

    editor.destroy();
    mount.remove();
  });
});

describe('projectYDocScreenplay', () => {
  it('projects a Y.Doc straight to a valid canonical screenplay, the server-side half of the projection this package shares with the browser editor', () => {
    const ydoc = createLocalScreenplayYDoc(simpleContent);
    const projection = projectYDocScreenplay(ydoc, {
      id: '11111111-0000-4000-8000-000000000001',
      title: 'Custom Title',
    });

    expect(projection.valid).toBe(true);
    if (!projection.valid) throw new Error('expected a valid projection');
    expect(projection.screenplay.id).toBe('11111111-0000-4000-8000-000000000001');
    expect(projection.screenplay.title).toBe('Custom Title');
    expect(projection.screenplay.blocks).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'scene_heading',
        text: 'INT. WORKSHOP - NIGHT',
      },
      { id: '00000000-0000-4000-8000-000000000002', type: 'action', text: 'A line of action.' },
    ]);
  });

  it('reports an invalid projection instead of throwing when the fragment holds a node this schema does not recognise', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT);
    fragment.doc!.transact(() => {
      const block = new Y.XmlElement('screenplayBlock');
      block.setAttribute('element', 'not-a-real-element-type');
      block.setAttribute('id', '00000000-0000-4000-8000-000000000099');
      fragment.insert(0, [block]);
    });

    const projection = projectYDocScreenplay(ydoc);
    expect(projection.valid).toBe(false);
  });
});

describe('title page and document settings Y.Maps', () => {
  it('titlePageFromYMap reports no title page for an unseeded map, and isTitlePageMapSeeded agrees', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(TITLE_PAGE_YJS_MAP);
    expect(isTitlePageMapSeeded(map)).toBe(false);
    expect(titlePageFromYMap(map)).toBeUndefined();
  });

  it('writeTitlePageToYMap then titlePageFromYMap round-trips a fully populated title page', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(TITLE_PAGE_YJS_MAP);
    const titlePage: TitlePage = {
      id: '00000000-0000-4000-8000-000000000010',
      title: 'The Long Way Home',
      credit: 'written by',
      source: 'Based on a true story',
      draftDate: 'Third Draft, March 2026',
      authors: ['Mara Quinn'],
      contact: ['mara@example.com', '555-0100'],
    };
    writeTitlePageToYMap(map, titlePage);
    expect(isTitlePageMapSeeded(map)).toBe(true);
    expect(titlePageFromYMap(map)).toEqual(titlePage);
  });

  it('an emptied-out title page (only id) still round-trips as present, not as "no title page"', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(TITLE_PAGE_YJS_MAP);
    writeTitlePageToYMap(map, { id: '00000000-0000-4000-8000-000000000011' });
    expect(isTitlePageMapSeeded(map)).toBe(true);
    expect(titlePageFromYMap(map)).toEqual({ id: '00000000-0000-4000-8000-000000000011' });
  });

  it('writing undefined clears the map back to unseeded', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(TITLE_PAGE_YJS_MAP);
    writeTitlePageToYMap(map, { id: '00000000-0000-4000-8000-000000000012', title: 'Draft' });
    writeTitlePageToYMap(map, undefined);
    expect(isTitlePageMapSeeded(map)).toBe(false);
    expect(titlePageFromYMap(map)).toBeUndefined();
  });

  it('re-writing a title page clears fields the new value no longer has, not merges them', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(TITLE_PAGE_YJS_MAP);
    writeTitlePageToYMap(map, {
      id: '00000000-0000-4000-8000-000000000013',
      title: 'Old Title',
      authors: ['Someone'],
    });
    writeTitlePageToYMap(map, { id: '00000000-0000-4000-8000-000000000013', title: 'New Title' });
    expect(titlePageFromYMap(map)).toEqual({
      id: '00000000-0000-4000-8000-000000000013',
      title: 'New Title',
    });
  });

  it('documentSettingsFromYMap reports no override for an unseeded map, and isDocumentSettingsMapSeeded agrees', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(DOCUMENT_SETTINGS_YJS_MAP);
    expect(isDocumentSettingsMapSeeded(map)).toBe(false);
    expect(documentSettingsFromYMap(map)).toBeUndefined();
  });

  it('writeDocumentSettingsToYMap then documentSettingsFromYMap round-trips exactly', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(DOCUMENT_SETTINGS_YJS_MAP);
    const settings: DocumentSettings = {
      characterIndentIn: 2.9,
      parentheticalIndentIn: 2.4,
      parentheticalWidthIn: 2,
      pageNumberStyle: 'roman',
      sceneNumbersEnabled: true,
      autoMoreContinued: false,
    };
    writeDocumentSettingsToYMap(map, settings);
    expect(isDocumentSettingsMapSeeded(map)).toBe(true);
    expect(documentSettingsFromYMap(map)).toEqual(settings);
  });

  it('documentSettingsFromYMap falls back to the specification default for any individually missing key', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(DOCUMENT_SETTINGS_YJS_MAP);
    // Simulates a partial write, which no code path here is meant to produce -- defensive coverage
    // for the fallback `documentSettingsFromYMap`'s own comment describes, not a reachable app path.
    map.set('sceneNumbersEnabled', true);
    const settings = documentSettingsFromYMap(map);
    expect(settings).toEqual({ ...DEFAULT_DOCUMENT_SETTINGS, sceneNumbersEnabled: true });
  });
});

describe('seedScreenplayYDoc', () => {
  it('seeds the body, title page, and document settings together', () => {
    const titlePage: TitlePage = { id: '00000000-0000-4000-8000-000000000020', title: 'Seeded' };
    const settings: DocumentSettings = {
      ...DEFAULT_DOCUMENT_SETTINGS,
      sceneNumbersEnabled: true,
    };
    const doc = seedScreenplayYDoc(simpleContent, titlePage, settings);

    expect(doc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT).toString()).toContain('INT. WORKSHOP');
    expect(titlePageFromYMap(doc.getMap(TITLE_PAGE_YJS_MAP))).toEqual(titlePage);
    expect(documentSettingsFromYMap(doc.getMap(DOCUMENT_SETTINGS_YJS_MAP))).toEqual(settings);
  });

  it('leaves both maps unseeded when given no title page and no document settings', () => {
    const doc = seedScreenplayYDoc(simpleContent, undefined, undefined);
    expect(isTitlePageMapSeeded(doc.getMap(TITLE_PAGE_YJS_MAP))).toBe(false);
    expect(isDocumentSettingsMapSeeded(doc.getMap(DOCUMENT_SETTINGS_YJS_MAP))).toBe(false);
  });
});

describe('projectYDocScreenplay reading title page and document settings from the Y.Doc', () => {
  it('projects a seeded title page and document settings, not just the body', () => {
    const titlePage: TitlePage = { id: '00000000-0000-4000-8000-000000000030', title: 'On Deck' };
    const settings: DocumentSettings = { ...DEFAULT_DOCUMENT_SETTINGS, autoMoreContinued: false };
    const ydoc = seedScreenplayYDoc(simpleContent, titlePage, settings);

    const projection = projectYDocScreenplay(ydoc, {
      id: '00000000-0000-4000-8000-000000000031',
      title: 'Custom Title',
    });
    expect(projection.valid).toBe(true);
    if (!projection.valid) throw new Error('expected a valid projection');
    expect(projection.screenplay.titlePages).toEqual([titlePage]);
    expect(projection.screenplay.documentSettings).toEqual(settings);
  });

  it('projects an empty titlePages array and the schema default settings when neither map is seeded', () => {
    const ydoc = createLocalScreenplayYDoc(simpleContent);
    const projection = projectYDocScreenplay(ydoc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) throw new Error('expected a valid projection');
    expect(projection.screenplay.titlePages).toEqual([]);
    expect(projection.screenplay.documentSettings).toEqual(DEFAULT_DOCUMENT_SETTINGS);
  });
});

describe('nonEmptyEditorContent', () => {
  it('returns content with at least one block unchanged', () => {
    expect(nonEmptyEditorContent(simpleContent)).toBe(simpleContent);
  });

  it('seeds exactly one empty action block when content has none, so there is somewhere to place the caret', () => {
    const empty: EditorContent = { type: 'screenplayDocument', content: [] };
    const seeded = nonEmptyEditorContent(empty);
    expect(seeded.content).toHaveLength(1);
    expect(seeded.content[0]?.attrs.element).toBe('action');
    expect(seeded.content[0]?.content).toBeUndefined();
    expect(seeded.content[0]?.attrs.id).toBeTruthy();
  });

  it('assigns a fresh id on every call, never reusing one across two empty documents', () => {
    const empty: EditorContent = { type: 'screenplayDocument', content: [] };
    const first = nonEmptyEditorContent(empty);
    const second = nonEmptyEditorContent(empty);
    expect(first.content[0]?.attrs.id).not.toBe(second.content[0]?.attrs.id);
  });
});
