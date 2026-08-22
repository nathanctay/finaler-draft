/**
 * Shared screenplay/block builders for tests. Not part of the package's public API and excluded
 * from coverage (see vitest.config.ts) -- this is test infrastructure, not shipped source. Mirrors
 * the shape of `packages/fdx/src/testFixtures.ts`.
 */
import {
  DEFAULT_DOCUMENT_SETTINGS,
  type Screenplay,
  type ScreenplayBlock,
  type TitlePage,
} from '@finaler-draft/screenplay';
import { strFromU8, unzipSync } from 'fflate';

/**
 * Unzips a `screenplayToDocx` result and decodes each part to a UTF-8 string, for tests that
 * assert on a specific part's content. Uses `fflate` -- already this package's production
 * dependency for zipping -- bidirectionally to inspect its own output; this is test
 * infrastructure, not a second library. `progress/docx-export.md`: "tests must unzip your own
 * output, parse each part, and assert the relationships and required elements resolve."
 */
export function unzipDocx(bytes: Uint8Array): Record<string, string> {
  const parts = unzipSync(bytes);
  const decoded: Record<string, string> = {};
  for (const [name, contents] of Object.entries(parts)) {
    decoded[name] = strFromU8(contents);
  }
  return decoded;
}

/**
 * One named part from a `screenplayToDocx` result, or a loud failure if it is missing --
 * `noUncheckedIndexedAccess` (this repo's strict TypeScript setting) types a plain index lookup
 * on `unzipDocx`'s result as `string | undefined`; every test asserting on a specific part's
 * content wants the part itself, and a missing part is a real bug this helper surfaces with a
 * clear message rather than a test author scattering `?? ''` fallbacks that would instead make a
 * missing part look like an empty one.
 */
export function docxPart(bytes: Uint8Array, partName: string): string {
  const part = unzipDocx(bytes)[partName];
  if (part === undefined) {
    throw new Error(`Expected the unzipped docx to contain a "${partName}" part, but it did not.`);
  }
  return part;
}

export function docxDocumentXml(bytes: Uint8Array): string {
  return docxPart(bytes, 'word/document.xml');
}

/**
 * Every top-level `<w:p>...</w:p>` paragraph in a `document.xml` string, optionally filtered to
 * paragraphs referencing a given `w:pStyle`. `document.xml`'s generator never nests one `<w:p>`
 * inside another (table cells hold paragraphs as siblings, not a paragraph inside a paragraph),
 * so a non-greedy match on this one tag pair is sufficient. Exists so tests can assert a property
 * of *one specific paragraph* rather than the whole document -- `progress/fdx-export.md`'s
 * documented lesson about a document-wide assertion passing for the wrong reason once an
 * unrelated part of the document happens to contain the same substring.
 */
export function paragraphsWithStyle(documentXml: string, styleId: string): string[] {
  const allParagraphs = documentXml.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
  return allParagraphs.filter((paragraph) => paragraph.includes(`w:pStyle w:val="${styleId}"`));
}

export function actionBlock(id: string, text: string): ScreenplayBlock {
  return { id, type: 'action', text };
}

export function sceneHeadingBlock(id: string, text: string, sceneNumber?: string): ScreenplayBlock {
  return sceneNumber === undefined
    ? { id, type: 'scene_heading', text }
    : { id, type: 'scene_heading', text, sceneNumber };
}

export function characterBlock(id: string, text: string): ScreenplayBlock {
  return { id, type: 'character', text };
}

export function dialogueBlock(id: string, text: string): ScreenplayBlock {
  return { id, type: 'dialogue', text };
}

export function parentheticalBlock(id: string, text: string): ScreenplayBlock {
  return { id, type: 'parenthetical', text };
}

export function transitionBlock(id: string, text: string): ScreenplayBlock {
  return { id, type: 'transition', text };
}

export function shotBlock(id: string, text: string): ScreenplayBlock {
  return { id, type: 'shot', text };
}

export function pageBreakBlock(id: string): ScreenplayBlock {
  return { id, type: 'page_break' };
}

export function dualDialogueBlock(id: string): ScreenplayBlock {
  return {
    id,
    type: 'dual_dialogue',
    left: {
      id: `${id}-left`,
      blocks: [
        { id: `${id}-left-c`, type: 'character', text: 'ADA' },
        { id: `${id}-left-d`, type: 'dialogue', text: 'You made it.' },
      ],
    },
    right: {
      id: `${id}-right`,
      blocks: [
        { id: `${id}-right-c`, type: 'character', text: 'MILES' },
        { id: `${id}-right-p`, type: 'parenthetical', text: '(breathless)' },
        { id: `${id}-right-d`, type: 'dialogue', text: 'The train was late.' },
      ],
    },
  };
}

export function screenplayWith(
  blocks: readonly ScreenplayBlock[],
  overrides: Partial<Screenplay> = {},
): Screenplay {
  return {
    schemaVersion: 1,
    id: 'e1f8e6a8-e7bb-42bd-b2fa-0805d4064201',
    title: 'Test Screenplay',
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    titlePages: [],
    blocks: [...blocks],
    annotations: [],
    ...overrides,
  };
}

export function titlePageWith(overrides: Partial<TitlePage> = {}): TitlePage {
  return { id: 'd2df4da9-1c58-421d-86ba-9988a805eea4', ...overrides };
}
