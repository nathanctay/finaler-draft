/**
 * Groups the canonical block sequence into the units page-breaking reasons about: a scene
 * heading (kept with at least two lines of whatever follows), a speech (a character cue plus its
 * contiguous parentheticals and dialogue, split only through the dialogue lines it contains), a
 * plain group with no keep-together rule (action, shot, transition), and an author-inserted
 * forced break. This is the layer that turns "zero blank lines before" (`BLANK_LINES_BEFORE`)
 * into "these blocks are one contiguous speech" for pagination purposes.
 */

import { BLANK_LINES_BEFORE } from '@finaler-draft/screenplay/pageFormat';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  type DocumentSettings,
  type ScreenplayBlock,
} from '@finaler-draft/screenplay';
import type { AuthoredLine, BlankLine } from './model.js';
import { UnsupportedBlockError } from './model.js';
import { wrapBlock } from './wrap.js';

export type SimpleGroup = {
  readonly kind: 'simple';
  readonly lines: readonly (BlankLine | AuthoredLine)[];
};

export type SceneHeadingGroup = {
  readonly kind: 'sceneHeading';
  readonly lines: readonly (BlankLine | AuthoredLine)[];
};

export type SpeechUnit = {
  readonly element: 'parenthetical' | 'dialogue';
  readonly lines: readonly AuthoredLine[];
};

export type SpeechGroup = {
  readonly kind: 'speech';
  readonly leadingBlank: readonly BlankLine[];
  /** `undefined` only for a malformed speech with no character cue — see `buildGroups`. */
  readonly characterBlockId: string | undefined;
  readonly characterText: string | undefined;
  readonly characterLines: readonly AuthoredLine[];
  readonly units: readonly SpeechUnit[];
};

export type ForcedBreak = { readonly kind: 'forcedBreak' };

export type Group = SimpleGroup | SceneHeadingGroup | SpeechGroup | ForcedBreak;

function blanksBefore(count: number): BlankLine[] {
  return Array.from({ length: count }, () => ({ kind: 'blank' as const }));
}

type OpenSpeech = {
  leadingBlank: BlankLine[];
  characterBlockId: string | undefined;
  characterText: string | undefined;
  characterLines: AuthoredLine[];
  units: SpeechUnit[];
};

/**
 * Builds the ordered group sequence from canonical blocks. Throws `UnsupportedBlockError` on
 * `dual_dialogue` immediately, before any page-breaking is attempted — plan.md records its column
 * geometry as unsettled, and a wrong guess that silently produces plausible page numbers is worse
 * than a refusal.
 *
 * `documentSettings` defaults to the specification's current fixed values, so every existing
 * caller keeps producing identical output unchanged. Only `characterIndentIn` and
 * `parentheticalWidthIn` are actually read here (passed straight through to `wrapBlock`); the
 * rest of `DocumentSettings` (page-number style, scene numbers, `(MORE)`/`CONT'D`) belongs to
 * later stages of pagination or to rendering, not to grouping.
 */
export function buildGroups(
  blocks: readonly ScreenplayBlock[],
  documentSettings: DocumentSettings = DEFAULT_DOCUMENT_SETTINGS,
): Group[] {
  const groups: Group[] = [];
  let openSpeech: OpenSpeech | undefined;

  const closeSpeech = (): void => {
    if (openSpeech !== undefined) {
      groups.push({
        kind: 'speech',
        leadingBlank: openSpeech.leadingBlank,
        characterBlockId: openSpeech.characterBlockId,
        characterText: openSpeech.characterText,
        characterLines: openSpeech.characterLines,
        units: openSpeech.units,
      });
      openSpeech = undefined;
    }
  };

  const openOrphanSpeech = (): OpenSpeech => {
    // A parenthetical or dialogue block with no preceding character cue in the same contiguous
    // run. Schema-legal (nothing requires a character block first) but not real screenplay
    // convention. Without a character block there is no name to build a CONT'D heading from, so
    // this degenerate speech is never split — see placeSpeechGroup's plain-reflow fallback.
    const speech: OpenSpeech = {
      leadingBlank: [],
      characterBlockId: undefined,
      characterText: undefined,
      characterLines: [],
      units: [],
    };
    openSpeech = speech;
    return speech;
  };

  for (const block of blocks) {
    switch (block.type) {
      case 'page_break': {
        closeSpeech();
        groups.push({ kind: 'forcedBreak' });
        break;
      }
      case 'dual_dialogue': {
        throw new UnsupportedBlockError(
          block.id,
          block.type,
          'dual_dialogue has no specified column geometry in plan.md and cannot be paginated. ' +
            'Resolve the column layout before pagination can support this block.',
        );
      }
      case 'scene_heading': {
        closeSpeech();
        const lines = [
          ...blanksBefore(BLANK_LINES_BEFORE.scene_heading),
          ...wrapBlock(block.id, 'scene_heading', block.text, documentSettings),
        ];
        groups.push({ kind: 'sceneHeading', lines });
        break;
      }
      case 'action':
      case 'shot':
      case 'transition': {
        closeSpeech();
        const lines = [
          ...blanksBefore(BLANK_LINES_BEFORE[block.type]),
          ...wrapBlock(block.id, block.type, block.text, documentSettings),
        ];
        groups.push({ kind: 'simple', lines });
        break;
      }
      case 'character': {
        closeSpeech();
        openSpeech = {
          leadingBlank: blanksBefore(BLANK_LINES_BEFORE.character),
          characterBlockId: block.id,
          characterText: block.text,
          characterLines: wrapBlock(block.id, 'character', block.text, documentSettings),
          units: [],
        };
        break;
      }
      case 'parenthetical': {
        const speech = openSpeech ?? openOrphanSpeech();
        speech.units.push({
          element: 'parenthetical',
          lines: wrapBlock(block.id, 'parenthetical', block.text, documentSettings),
        });
        break;
      }
      case 'dialogue': {
        const speech = openSpeech ?? openOrphanSpeech();
        speech.units.push({
          element: 'dialogue',
          lines: wrapBlock(block.id, 'dialogue', block.text, documentSettings),
        });
        break;
      }
    }
  }

  closeSpeech();
  return groups;
}
