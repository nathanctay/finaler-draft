/**
 * Shared screenplay/block builders for tests. Not part of the package's public API and excluded
 * from coverage (see vitest.config.ts) -- this is test infrastructure, not shipped source.
 * Mirrors the shape of `packages/layout/src/testFixtures.ts` and `packages/docx/src/testFixtures.ts`.
 */
import {
  DEFAULT_DOCUMENT_SETTINGS,
  type Screenplay,
  type ScreenplayBlock,
  type TitlePage,
} from '@finaler-draft/screenplay';

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
        { id: `${id}-left-d`, type: 'dialogue', text: 'Hi.' },
      ],
    },
    right: {
      id: `${id}-right`,
      blocks: [
        { id: `${id}-right-c`, type: 'character', text: 'MILES' },
        { id: `${id}-right-d`, type: 'dialogue', text: 'Hey.' },
      ],
    },
  };
}

/** Text that hard-splits into exactly `n` lines at a 60-character budget (action/scene_heading/shot). */
export function textForActionLineCount(n: number): string {
  return 'x'.repeat(60 * (n - 1) + 1);
}

/** Text that hard-splits into exactly `n` lines at the 35-character dialogue budget. */
export function textForDialogueLineCount(n: number): string {
  return 'x'.repeat(35 * (n - 1) + 1);
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
