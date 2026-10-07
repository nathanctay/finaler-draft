import { deriveCharacters, type DerivedCharacter } from '@finaler-draft/screenplay';
import type { RevisionDiffResult, ScreenplayBlockDiffEntry } from './api.js';

/**
 * The comparison view's Navigator model: **which scenes changed, which characters' lines changed,
 * and where in the comparison to jump to see it.**
 *
 * It exists because the comparison grew the editor's Navigator panel in this pass, and an empty panel
 * would have been as wrong as a missing one. The content is not a copy of the editor's: the editor's
 * navigator is a table of contents, while a comparison's reader wants the subset that moved. The diff
 * engine already computes scene-level `added`/`removed`/`moved`/`changed` (`ScreenplaySceneDiffEntry`),
 * so this is the natural way to navigate a long comparison, and genuinely more useful here than the
 * same list is in the editor.
 *
 * **Why a web-app module, and not part of `@finaler-draft/screenplay`.** Same boundary
 * `inlineScreenplayDiff.ts` draws and for the same reason: `diffScreenplays` is the authority on
 * *what changed* and is untouched by this. What belongs here is *what the reader is offered* -- which
 * single status word a scene that both moved and changed is marked with, whether a character with no
 * changed line is worth a row, which block a jump lands on. Those are presentation decisions, they
 * differ per view, and keeping them out of the domain package is what lets the diff engine stay one
 * verified answer.
 *
 * **Pure.** Same input, same model, every time -- which is what lets the marking and the jump targets
 * be asserted directly rather than inferred from rendered DOM.
 */

/** A scene's or character's single marked status. A comparison row carries exactly one, because a
 * reader scanning a 235px panel reads one marker per line, not a set. */
export type DiffNavigatorStatus = 'added' | 'removed' | 'moved' | 'changed' | 'unchanged';

export interface DiffNavigatorScene {
  /** The scene heading block's own stable id -- the React key, and the thing the view scrolls to
   * (`[data-diff-block-id]` is on every rendered manuscript row). */
  readonly blockId: string;
  /**
   * Lines inside this scene's own *body* that the diff reports as a content change -- added, removed,
   * or edited. Zero for a scene that only moved, and for an unchanged one.
   *
   * The heading is not one of them: `ScreenplaySceneDiffEntry.blocks` is the diff of `DerivedScene.body`,
   * which `deriveScenes` defines as the blocks *after* the heading. So a newly added two-block scene
   * counts 1, and a heading-only edit counts 0 while still marking the scene `'changed'` (through
   * `headingTextChanged`). That is the right split for a panel whose row already shows the heading: the
   * number answers "how much inside this scene do I have to read", and the heading is on screen either
   * way.
   */
  readonly changedLineCount: number;
  readonly headingText: string;
  /**
   * `true` whenever the whole scene relocated, independently of `status`. Carried separately because
   * a scene can both move and have its contents changed, and `status` can only say one thing: see
   * `sceneStatus` for which one wins and why.
   */
  readonly moved: boolean;
  /** 1-based position among the newer document's scenes -- the spine's own numbering. `undefined` for
   * a scene that exists only on the older side, which has no position in the newer document and must
   * not be given a borrowed one. */
  readonly position: number | undefined;
  readonly status: DiffNavigatorStatus;
}

export interface DiffNavigatorCharacter {
  /** The block to jump to: this character's first line that the diff reports as changed. */
  readonly blockId: string;
  readonly changedLineCount: number;
  /** Canonical uppercase, exactly as `DerivedCharacter.name` gives it -- the same grouping the
   * editor's own Navigator lists, so `MARA` and `MARA (V.O.)` are one row here too. */
  readonly name: string;
  /** Narrower than `DiffNavigatorStatus` on purpose: a character is listed only because something of
   * theirs changed, so `'unchanged'` is unreachable, and a character is never "moved" -- a speech that
   * relocated with its scene is not a change to that character's lines (see `isContentChange`). */
  readonly status: 'added' | 'removed' | 'changed';
}

export interface DiffNavigatorModel {
  /**
   * Characters whose own lines changed, and only those -- never a plain cast list.
   *
   * The decision, and why: a comparison's reader is asking "what happened to the script", and a
   * complete cast list answers nothing about that. It would also be the one panel in this view that
   * said nothing a comparison knows -- the editor already lists the cast, from the live document,
   * where it is useful for navigation. "Whose lines changed" is a question only a diff can answer,
   * it is how a writer actually thinks about a revision ("what did they do to MARA?"), and it is
   * derivable from data already on this screen: `deriveCharacters` over both sides, intersected with
   * the diff's own interesting-block set. A character whose speech merely *moved* with its scene is
   * not listed, because nothing of theirs changed.
   */
  readonly characters: readonly DiffNavigatorCharacter[];
  /** How many scenes carry any status other than `'unchanged'` -- the panel's footer census. */
  readonly changedSceneCount: number;
  /** Every scene on either side, in the newer document's order with removed scenes interleaved where
   * they used to sit -- the order `diffScreenplays` already returns them in. Unchanged scenes are
   * included: this is the document's skeleton, and a list of only the changed scenes would stop being
   * a way to navigate the comparison. */
  readonly scenes: readonly DiffNavigatorScene[];
}

/**
 * Whether a block's diff entry is a *content* change, as opposed to a relocation.
 *
 * Move is deliberately excluded. A scene that was dragged elsewhere with nothing inside it touched
 * reports every one of its blocks as `moved` in the document-wide block list -- correctly, their
 * document positions changed -- and counting those as changed lines would tell a reader that forty
 * lines changed when none did. The scene-level `moved` flag states the relocation once, which is the
 * same reasoning `ScreenplaySceneDiffEntry.blocks` and `inlineScreenplayDiff.ts`'s
 * `movedSceneAfterBlockIds` are both built on.
 */
function isContentChange(entry: ScreenplayBlockDiffEntry): boolean {
  if (entry.status !== 'matched') return true;
  return entry.textChanged || entry.elementTypeChanged;
}

/**
 * The one status a scene row is marked with.
 *
 * `'changed'` outranks `'moved'` when a scene both relocated and had its contents edited, because the
 * edit is the thing a reader has to go and read; the relocation is still reported, through the
 * separate `moved` flag the view renders beside the count. Read the other way round, `'moved'` means
 * exactly what the manuscript's own scene-move markers mean -- the scene is intact and only its
 * position changed -- which is the property that makes a two-line marker an adequate report of it.
 */
function sceneStatus(
  status: 'added' | 'removed' | 'matched',
  moved: boolean,
  changedLineCount: number,
  headingTextChanged: boolean,
): DiffNavigatorStatus {
  if (status === 'added') return 'added';
  if (status === 'removed') return 'removed';
  if (changedLineCount > 0 || headingTextChanged) return 'changed';
  if (moved) return 'moved';
  return 'unchanged';
}

type ScreenplayBlocks = RevisionDiffResult['newerScreenplay']['blocks'];

/** One side's scene headings, in document order: the id the diff keys scenes by, and the display text.
 * `deriveScenes`' own rule -- blocks before the first heading belong to no scene -- falls out of this
 * for free, because a block that is not a heading is not here. */
function sceneHeadings(blocks: ScreenplayBlocks): { id: string; text: string }[] {
  return blocks
    .filter((block) => block.type === 'scene_heading')
    .map((block) => ({ id: block.id, text: 'text' in block ? block.text : '' }));
}

/** The first of `blockIds` that is in `marked`, in document order -- the line a jump should land on,
 * or `undefined` when none of this character's lines is marked at all. */
function firstMarked(blockIds: readonly string[], marked: ReadonlySet<string>): string | undefined {
  return blockIds.find((id) => marked.has(id));
}

function countMarked(blockIds: readonly string[], marked: ReadonlySet<string>): number {
  return blockIds.reduce((total, id) => (marked.has(id) ? total + 1 : total), 0);
}

/**
 * Characters whose lines changed, in the newer document's cue order, with characters who exist only
 * on the older side appended in theirs.
 *
 * Counted on the side each kind of change exists on, so nothing is counted twice: an added or changed
 * line has an id on the newer side and is counted against the newer character who speaks it; a
 * removed line exists only on the older side and is counted against the older character. A character
 * present on both sides can accumulate from both, which is correct -- replacing one of their speeches
 * with another is two changes to that character's lines.
 */
function changedCharacters(
  before: readonly DerivedCharacter[],
  after: readonly DerivedCharacter[],
  markedAfter: ReadonlySet<string>,
  markedBefore: ReadonlySet<string>,
): DiffNavigatorCharacter[] {
  const beforeByName = new Map(before.map((character) => [character.name, character]));
  const afterByName = new Map(after.map((character) => [character.name, character]));
  const characters: DiffNavigatorCharacter[] = [];

  for (const character of after) {
    const previous = beforeByName.get(character.name);
    const changedLineCount =
      countMarked(character.blockIds, markedAfter) +
      (previous ? countMarked(previous.blockIds, markedBefore) : 0);
    if (changedLineCount === 0) continue;
    const blockId =
      firstMarked(character.blockIds, markedAfter) ??
      (previous ? firstMarked(previous.blockIds, markedBefore) : undefined);
    if (blockId === undefined) continue;
    characters.push({
      blockId,
      changedLineCount,
      name: character.name,
      status: previous ? 'changed' : 'added',
    });
  }

  for (const character of before) {
    if (afterByName.has(character.name)) continue;
    const changedLineCount = countMarked(character.blockIds, markedBefore);
    const blockId = firstMarked(character.blockIds, markedBefore);
    if (changedLineCount === 0 || blockId === undefined) continue;
    characters.push({ blockId, changedLineCount, name: character.name, status: 'removed' });
  }

  return characters;
}

export function buildDiffNavigator(result: RevisionDiffResult): DiffNavigatorModel {
  const { diff, newerScreenplay, olderScreenplay } = result;

  /*
   * The skeleton comes from the two documents, not from `diff.scenes`.
   *
   * `diffScreenplays` deliberately returns only the scenes with something to report -- its own
   * comment: "a scene untouched on either side contributes nothing to the diff... what keeps a
   * feature-length script's diff proportional to the actual amount of change." That is right for a
   * diff and wrong for a navigator: a panel listing only the changed scenes is a change report, not a
   * way to move around the comparison, and a reader who clicks "scene 7" has to be able to find scene
   * 6 too. So every scene on either side is listed here and the diff's entries are looked up against
   * that list; a scene with no entry is, by that function's own contract, untouched.
   */
  const newerHeadings = sceneHeadings(newerScreenplay.blocks);
  const olderHeadings = sceneHeadings(olderScreenplay.blocks);
  const newerIndexById = new Map(newerHeadings.map((heading, index) => [heading.id, index]));
  const entryById = new Map(
    diff.scenes.filter((scene) => scene.area === 'scene').map((scene) => [scene.id, scene]),
  );

  /*
   * Scenes that exist only on the older side, grouped by the newer-side row they should be listed in
   * front of: one past the nearest preceding scene that still exists, or the very top when there is
   * none. The same anchoring rule `inlineScreenplayDiff.ts` uses for a removed *line*, applied at
   * scene granularity -- and for the same reason: a raw older-side index means nothing in the newer
   * document's order, while "right after the scene it used to follow" survives any amount of other
   * editing around it.
   */
  const removedByAnchor = new Map<number, { id: string; text: string }[]>();
  let nearestSurvivor: number | undefined;
  for (const heading of olderHeadings) {
    const newerIndex = newerIndexById.get(heading.id);
    if (newerIndex !== undefined) {
      nearestSurvivor = newerIndex;
      continue;
    }
    const anchor = nearestSurvivor === undefined ? 0 : nearestSurvivor + 1;
    const group = removedByAnchor.get(anchor);
    if (group) group.push(heading);
    else removedByAnchor.set(anchor, [heading]);
  }

  const toScene = (
    heading: { id: string; text: string },
    position: number | undefined,
  ): DiffNavigatorScene => {
    const entry = entryById.get(heading.id);
    const changedLineCount = entry === undefined ? 0 : entry.blocks.filter(isContentChange).length;
    return {
      blockId: heading.id,
      changedLineCount,
      headingText: heading.text,
      moved: entry?.moved ?? false,
      position,
      status:
        entry === undefined
          ? 'unchanged'
          : sceneStatus(entry.status, entry.moved, changedLineCount, entry.headingTextChanged),
    };
  };

  const scenes: DiffNavigatorScene[] = [];
  for (const [index, heading] of newerHeadings.entries()) {
    for (const removed of removedByAnchor.get(index) ?? []) {
      scenes.push(toScene(removed, undefined));
    }
    scenes.push(toScene(heading, index + 1));
  }
  for (const removed of removedByAnchor.get(newerHeadings.length) ?? []) {
    scenes.push(toScene(removed, undefined));
  }

  // The document-wide block diff, not the per-scene one: a character's speech is attributed across
  // the whole document (`DerivedCharacter.blockIds`), and a line that moved from one scene to another
  // is reported as removed-here/added-there by the scene-local diffs while the document-wide entry
  // correctly says it survived. Asking the document-wide list is what keeps "whose lines changed"
  // from counting a relocation as two edits.
  //
  // The two sets are disjoint by construction, which is what makes the per-character counts below a
  // count of changes rather than of sides: a line that exists on the newer side at all (added, or
  // matched-and-edited) is counted there, against the character who speaks it now; only a line that
  // exists *solely* on the older side is counted against the older character. A matched-and-edited
  // line is in `markedAfter` alone, so it is one change, not two.
  const markedAfter = new Set(
    diff.blocks
      .filter((entry) => isContentChange(entry) && entry.status !== 'removed')
      .map((entry) => entry.id),
  );
  const markedBefore = new Set(
    diff.blocks.filter((entry) => entry.status === 'removed').map((entry) => entry.id),
  );

  return {
    characters: changedCharacters(
      deriveCharacters(olderScreenplay.blocks),
      deriveCharacters(newerScreenplay.blocks),
      markedAfter,
      markedBefore,
    ),
    changedSceneCount: scenes.filter((scene) => scene.status !== 'unchanged').length,
    scenes,
  };
}
