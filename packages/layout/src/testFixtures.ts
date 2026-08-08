/**
 * Shared screenplay-block builders for tests. Not part of the package's public API and excluded
 * from coverage (see vitest.config.ts) — this is test infrastructure, not shipped source.
 */
import type { ScreenplayBlock } from '@finaler-draft/screenplay';

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
        { id: `${id}-right-d`, type: 'dialogue', text: 'The train was late.' },
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

/**
 * A single action block whose wrapped content is exactly `totalLines` lines, with no other
 * blocks. Since it is the only (and therefore first) content in the document, its blank-before
 * is suppressed, so the paginated body has exactly `totalLines` `AuthoredLine` rows in total —
 * useful for exact page-capacity boundary tests where block-boundary bookkeeping would otherwise
 * complicate the arithmetic.
 */
export function singleActionBlockOfLines(totalLines: number): ScreenplayBlock[] {
  return [actionBlock('a0', textForActionLineCount(totalLines))];
}
