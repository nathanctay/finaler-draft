import { describe, expect, it } from 'vitest';
import { screenplayToFdx } from '@finaler-draft/fdx';
import { DEFAULT_DOCUMENT_SETTINGS, type Screenplay } from '@finaler-draft/screenplay';

/**
 * Proves the exported document is well-formed XML by actually parsing it, rather than only
 * inspecting the string for expected substrings (`packages/fdx/src/index.test.ts` and
 * `escape.test.ts` do that, at the unit level). This lives here, not in `packages/fdx`, because
 * that package's tests run under plain Node and this needs `DOMParser` -- `apps/web`'s vitest
 * environment is `jsdom`, which already provides it, so this needs no new dependency.
 *
 * `DOMParser` does not throw on malformed XML -- it reports failure by returning a document whose
 * tree contains a `parsererror` element instead (both Chromium and jsdom do this; there is no
 * standard exception to catch). A test that only asserted `parseFromString` "did not throw" would
 * pass on malformed output for the wrong reason -- it would never fail. `expectWellFormed` below
 * checks for that element explicitly, which is what makes this a real proof of well-formedness
 * rather than a vacuous one.
 */
function expectWellFormed(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parserError = doc.getElementsByTagName('parsererror');
  expect(
    parserError,
    `DOMParser reported: ${parserError.item(0)?.textContent ?? '(none)'}`,
  ).toHaveLength(0);
  return doc;
}

function screenplayWithText(text: string): Screenplay {
  return {
    schemaVersion: 1,
    id: 'e1f8e6a8-e7bb-42bd-b2fa-0805d4064201',
    title: 'Hostile Text Fixture',
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    titlePages: [
      {
        id: 'd2df4da9-1c58-421d-86ba-9988a805eea4',
        title: text,
        credit: text,
        authors: [text],
        source: text,
        draftDate: text,
        contact: [text, text],
      },
    ],
    blocks: [
      {
        id: '2175a1b6-8d05-4e6e-bac7-e471e8df33a1',
        type: 'scene_heading',
        text,
        sceneNumber: text,
      },
      { id: 'ba53c2dc-10a6-46d7-a409-9aabbff7cf5d', type: 'action', text },
      { id: '5e4c810d-75d9-4b2e-a1a2-0f7cb30fd77b', type: 'character', text },
      { id: 'c3ca98bb-6720-45b1-85ae-8c851ba2f5be', type: 'parenthetical', text },
      { id: '0f2b5f3c-6d17-4f18-8d95-90b06e93e13a', type: 'dialogue', text },
      { id: 'd01faf47-64e7-4f7c-853a-3c6ace1464ad', type: 'transition', text },
      { id: 'b4f2a758-8f86-465e-9a9e-485612244317', type: 'shot', text },
    ],
    annotations: [],
  };
}

describe('screenplayToFdx: well-formedness under hostile input', () => {
  it('parses without error for ordinary text', () => {
    expectWellFormed(screenplayToFdx(screenplayWithText('An ordinary line.')));
  });

  it('parses without error when every text field is the same hostile string', () => {
    const hostile = `<Paragraph Type="Character">&amp;</Paragraph> & ]]> "quoted" 'stuff' <unclosed`;
    const doc = expectWellFormed(screenplayToFdx(screenplayWithText(hostile)));

    // Round-trips the exact original text back out through the parsed tree -- not just "parsed
    // without an error", but parsed into precisely the text that was authored, proving the
    // escaping neither corrupted the content nor let it be interpreted as markup.
    const actionText = doc.getElementsByTagName('Paragraph')[1]?.getElementsByTagName('Text')[0];
    expect(actionText?.textContent).toBe(hostile);
  });

  it('parses without error for control characters, non-ASCII, and emoji', () => {
    const hostile = 'control:\x00\x07\x1b non-ascii: café 日本語 emoji: 🎬';
    expectWellFormed(screenplayToFdx(screenplayWithText(hostile)));
  });

  it('DOMParser itself reports a parsererror for genuinely malformed XML, proving expectWellFormed can fail', () => {
    // Guards against expectWellFormed becoming the exact accident this test exists to avoid: if
    // the parsererror check above were broken (e.g. checking the wrong tag name), this is the
    // test that would catch it, by feeding DOMParser input this package would never legitimately
    // produce -- an intentionally unclosed tag with no escaping applied at all.
    expect(() => expectWellFormed('<FinalDraft><Content><Paragraph></FinalDraft>')).toThrow();
  });
});
