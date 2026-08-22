/**
 * Shared screenplay/block builders for tests. Not part of the package's public API and excluded
 * from coverage (see vitest.config.ts) -- this is test infrastructure, not shipped source. Mirrors
 * the shape of `packages/layout/src/testFixtures.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  type Screenplay,
  type ScreenplayBlock,
  type TitlePage,
} from '@finaler-draft/screenplay';

/**
 * A script authored in Final Draft 13 by the project owner and saved from the application itself
 * -- see `packages/fdx/fixtures/README.md` for full provenance. Ground truth for this package's
 * FDX output: an earlier version of this package was built from third-party sources only and
 * produced a document Final Draft rejected outright, so every structural claim this package's
 * tests make about the FDX format is checked against this file directly, not against a
 * transcription of it.
 */
export function readReferenceFixture(): string {
  const path = fileURLToPath(new URL('../fixtures/final-draft-13-reference.fdx', import.meta.url));
  return readFileSync(path, 'utf8');
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
