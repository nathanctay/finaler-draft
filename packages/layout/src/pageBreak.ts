/**
 * Page breaking: fills `Group`s (see `groups.ts`) into pages, applying plan.md's break rules.
 *
 * Capacity: every page fills to `LINES_PER_PAGE_MAX` (55), never `LINES_PER_PAGE_MIN` (54) or the
 * 57 lines the full 0.5–1.5 in bottom-margin range would nominally allow. 55 is deliberate, not a
 * default: page count is contractual, and the one-page-per-minute heuristic is calibrated against
 * roughly 55 lines — filling to 57 would make a 110-page script measure as roughly 106 pages.
 * `LINES_PER_PAGE_MIN` falls out of the keep-together rules pulling content to the next page
 * rather than being an enforced floor.
 *
 * A page this engine produces can still end up short of `LINES_PER_PAGE_MIN`, and that is a
 * legitimate layout outcome, not a defect: the keep-together rules (a scene heading, a character
 * cue, or a parenthetical that must move whole rather than split or end a page) sometimes pull
 * enough content to the next page that the bottom margin widens past the 0.5–1.5 in preferred
 * range. This engine fails only on unsupported input (`dual_dialogue` — see `groups.ts`), never
 * on a valid but unwelcome margin; `Page.bottomMarginIn` exposes the number so callers can decide
 * what, if anything, to do about it, rather than this engine refusing to produce the page.
 *
 * The asymmetric dialogue-split minimum in `findDialogueSplitIndex` (>= 2 dialogue lines before
 * the break, >= 1 after — not a symmetric >= 2-and->= 2) is what keeps the worst case as narrow
 * as it is. Three cases, by how much "before" content a split's page-foot reservation has to
 * share room with the required 2-line dialogue minimum and the generated `(MORE)` line:
 *
 *   | Before the dialogue split | Lines abandoned when forced to move whole | Resulting margin |
 *   | -------------------------- | ------------------------------------------ | ----------------- |
 *   | cue only                   | cue(1) + blank(1) + 2 dialogue = 4          | 51 lines, 1.500 in |
 *   | cue + one parenthetical    | cue(1) + blank(1) + paren(1) + 2 dialogue = 5 | 50 lines, 1.667 in |
 *
 * A symmetric 2-and-2 minimum would widen the first case to 50 lines (a 3-dialogue-line speech
 * could never split at all) for no typographic benefit, which is why it was rejected rather than
 * used to make a floor hold.
 */

import {
  LINES_PER_INCH,
  LINES_PER_PAGE_MAX,
  MARGIN_TOP_IN,
  PAGE_HEIGHT_IN,
} from '@finaler-draft/screenplay/pageFormat';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@finaler-draft/screenplay';
import type { AuthoredLine, GeneratedLine, LayoutResult, Page, PageLine } from './model.js';
import type { Group, SceneHeadingGroup, SimpleGroup, SpeechGroup } from './groups.js';

function bottomMarginInFor(lineCount: number): number {
  return PAGE_HEIGHT_IN - MARGIN_TOP_IN - lineCount / LINES_PER_INCH;
}

class PageBuilder {
  private readonly pages: Page[] = [];
  private current: PageLine[] = [];

  get room(): number {
    return LINES_PER_PAGE_MAX - this.current.length;
  }

  get isFreshPage(): boolean {
    return this.current.length === 0;
  }

  push(line: PageLine): void {
    this.current.push(line);
  }

  pushMany(lines: readonly PageLine[]): void {
    for (const line of lines) {
      this.current.push(line);
    }
  }

  /** Closes the current page if it has content. A break with nothing placed yet is a no-op. */
  breakPage(): void {
    if (this.current.length === 0) {
      return;
    }
    const lineCount = this.current.length;
    this.pages.push({
      pageNumber: this.pages.length + 1,
      lines: this.current,
      lineCount,
      bottomMarginIn: bottomMarginInFor(lineCount),
    });
    this.current = [];
  }

  finish(): LayoutResult {
    this.breakPage();
    return { pages: this.pages };
  }
}

/** Drops a group's leading blank line if it would land at the top of a page (space-before suppression). */
function effectiveLines<T extends PageLine>(builder: PageBuilder, lines: readonly T[]): T[] {
  if (builder.isFreshPage && lines[0]?.kind === 'blank') {
    return lines.slice(1);
  }
  return lines.slice();
}

/**
 * Fills lines onto pages with no keep-together rule, breaking plainly wherever capacity runs
 * out. Used both for ordinary action/shot/transition reflow and as the pathological fallback for
 * groups whose own keep-together rule cannot be satisfied even on an empty page.
 *
 * One rule still applies even in plain reflow: a blank spacer line is never stranded as the last
 * row of a page while the content it introduces is pushed to the next page. That blank would
 * serve no purpose sitting alone at the foot — the element it precedes no longer follows it on
 * this page — and the next page drops it anyway via space-before suppression once it becomes that
 * page's first line. Deferring it converts a wasted, meaningless row into a properly suppressed
 * one instead of just leaving a blank line dangling at the bottom of the page.
 */
function placeLinesPlain(builder: PageBuilder, lines: readonly PageLine[]): void {
  let remaining = lines;
  while (remaining.length > 0) {
    if (builder.isFreshPage && remaining[0]?.kind === 'blank') {
      remaining = remaining.slice(1);
      continue;
    }
    const room = builder.room;
    if (room <= 0) {
      builder.breakPage();
      continue;
    }
    let take = Math.min(room, remaining.length);
    if (take < remaining.length && remaining[take - 1]?.kind === 'blank') {
      take -= 1;
    }
    if (take === 0) {
      builder.breakPage();
      continue;
    }
    builder.pushMany(remaining.slice(0, take));
    remaining = remaining.slice(take);
  }
}

function placeSimpleGroup(builder: PageBuilder, group: SimpleGroup): void {
  placeLinesPlain(builder, effectiveLines(builder, group.lines));
}

/**
 * A scene heading never ends a page: it requires at least two lines of whatever follows to land
 * on the same page, or it moves to the next page and takes them with it. The heading's own lines
 * are never split across pages (plan.md gives no rule for that); `hasFollowingContent` is false
 * only when nothing follows at all (end of document, or immediately before a forced break), in
 * which case the heading simply ends the page like any other content.
 */
function placeSceneHeadingGroup(
  builder: PageBuilder,
  group: SceneHeadingGroup,
  hasFollowingContent: boolean,
): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lines = effectiveLines(builder, group.lines);
    const room = builder.room;
    const fits = lines.length <= room && (!hasFollowingContent || room - lines.length >= 2);
    if (fits) {
      builder.pushMany(lines);
      return;
    }
    builder.breakPage();
  }
  // Pathological: a heading long enough that it still lacks room even on an empty page. No rule
  // governs splitting a heading; fall back to plain reflow so every line still lands somewhere.
  placeLinesPlain(builder, effectiveLines(builder, group.lines));
}

/**
 * Finds the largest valid split point in a speech's flattened lines. `maxBefore` is the room
 * available for authored content before the cut -- callers derive it from the page's remaining
 * room via `maxContentRoom` below, which subtracts one line for the generated `(MORE)` marker
 * only when `autoMoreContinued` is on. The name is deliberately not `maxBeforeMore` any more: with
 * the setting off, nothing here is reserved for a `(MORE)` line at all (see `maxContentRoom`'s own
 * comment).
 *
 * The minimum is asymmetric: >= 2 dialogue lines before the break (the page foot), >= 1 dialogue
 * line after it (the continuation head) — see this file's top-of-file comment for why 2-and-1
 * rather than 2-and-2 is what keeps the worst-case margin as narrow as it is. The cut may only
 * fall between two `dialogue` lines: a `character` or `parenthetical` line adjacent to the cut makes it
 * invalid, which is what makes "a character cue never ends a page" and "a parenthetical never
 * ends a page, and is never split" fall out of this one search rather than needing separate code.
 */
function findDialogueSplitIndex(
  lines: readonly AuthoredLine[],
  maxBefore: number,
): number | undefined {
  const upperBound = Math.min(lines.length - 1, maxBefore);
  for (let cut = upperBound; cut >= 1; cut -= 1) {
    const before = lines[cut - 1];
    const after = lines[cut];
    if (before?.element !== 'dialogue' || after?.element !== 'dialogue') {
      continue;
    }
    let dialogueBefore = 0;
    for (let i = 0; i < cut; i += 1) {
      if (lines[i]?.element === 'dialogue') {
        dialogueBefore += 1;
      }
    }
    if (dialogueBefore < 2) {
      continue;
    }
    let dialogueAfter = 0;
    for (let i = cut; i < lines.length; i += 1) {
      if (lines[i]?.element === 'dialogue') {
        dialogueAfter += 1;
      }
    }
    if (dialogueAfter >= 1) {
      return cut;
    }
  }
  return undefined;
}

/**
 * The room a dialogue split's page-foot content may use, given the page's actual remaining room.
 * When `autoMoreContinued` is on, one line of that room is reserved for the generated `(MORE)`
 * marker the caller pushes immediately after the cut. When it is off, no `(MORE)` line is ever
 * emitted, so nothing needs to be reserved for it: plan.md ("(MORE) and CONT'D") is explicit that
 * "the engine must not reserve the line the (MORE) would have occupied: the outgoing page fills
 * to capacity." Reserving it unconditionally -- the previous behavior -- left that line's room
 * unused whenever the setting was off instead of giving it to one more line of real dialogue.
 */
function maxContentRoom(room: number, autoMoreContinued: boolean): number {
  return autoMoreContinued ? room - 1 : room;
}

function moreLine(sourceBlockId: string): GeneratedLine {
  return { kind: 'generated', reason: 'more', sourceBlockId, text: '(MORE)' };
}

function continuedLine(sourceBlockId: string, characterText: string | undefined): GeneratedLine {
  return {
    kind: 'generated',
    reason: 'continued',
    sourceBlockId,
    text: `${characterText ?? ''} (CONT'D)`,
  };
}

/**
 * Places the remainder of a speech after a dialogue split, splitting again if it still doesn't
 * fit. `autoMoreContinued` gates whether the generated `(MORE)`/`CONT'D` marker lines themselves
 * are emitted (plan.md: "A document setting to suppress automatic `(MORE)` and `CONT'D`
 * entirely... Default on") *and* whether a line of room is reserved for the `(MORE)` that would
 * otherwise follow the cut (`maxContentRoom`) -- with the setting off, the outgoing page fills to
 * capacity with one more line of real dialogue instead of leaving that room unused. Which lines
 * land where can therefore differ by up to one line's worth of content between the two settings,
 * but the page's own total room usage does not: see paginate.test.ts's page-break-position
 * property test for the guarantee this keeps.
 */
function placeSpeechContinuation(
  builder: PageBuilder,
  characterBlockId: string,
  characterText: string | undefined,
  remaining: readonly AuthoredLine[],
  allowFreshBreak: boolean,
  autoMoreContinued: boolean,
): void {
  if (remaining.length === 0) {
    return;
  }
  if (remaining.length <= builder.room) {
    builder.pushMany(remaining);
    return;
  }

  const maxBefore = maxContentRoom(builder.room, autoMoreContinued);
  const cut = maxBefore >= 1 ? findDialogueSplitIndex(remaining, maxBefore) : undefined;
  if (cut !== undefined) {
    builder.pushMany(remaining.slice(0, cut));
    if (autoMoreContinued) {
      builder.push(moreLine(characterBlockId));
    }
    builder.breakPage();
    if (autoMoreContinued) {
      builder.push(continuedLine(characterBlockId, characterText));
    }
    placeSpeechContinuation(
      builder,
      characterBlockId,
      characterText,
      remaining.slice(cut),
      true,
      autoMoreContinued,
    );
    return;
  }

  if (allowFreshBreak) {
    builder.breakPage();
    if (autoMoreContinued) {
      builder.push(continuedLine(characterBlockId, characterText));
    }
    placeSpeechContinuation(
      builder,
      characterBlockId,
      characterText,
      remaining,
      false,
      autoMoreContinued,
    );
    return;
  }

  // Pathological: even a fresh continuation page, past its own CONT'D header, cannot satisfy a
  // valid split. Place plainly so every line still lands somewhere rather than looping forever.
  placeLinesPlain(builder, remaining);
}

/**
 * Places a speech (character cue + contiguous parentheticals/dialogue). Tries the whole speech
 * first; if it doesn't fit, looks for a valid dialogue split; if none exists (or the speech has
 * no character cue to attribute a `(MORE)`/`CONT'D` pair to — see `buildGroups`'s orphan-speech
 * handling), the whole speech moves to the next page.
 */
function placeSpeechGroup(
  builder: PageBuilder,
  group: SpeechGroup,
  autoMoreContinued: boolean,
  allowFreshBreak = true,
): void {
  const contentLines: AuthoredLine[] = [
    ...group.characterLines,
    ...group.units.flatMap((unit) => unit.lines),
  ];
  const withBlank: PageLine[] = [...group.leadingBlank, ...contentLines];
  const effective = effectiveLines(builder, withBlank);

  if (effective.length <= builder.room) {
    builder.pushMany(effective);
    return;
  }

  const hasBlank = effective[0]?.kind === 'blank';
  const effectiveContent = (hasBlank ? effective.slice(1) : effective) as AuthoredLine[];
  const roomForContent = builder.room - (hasBlank ? 1 : 0);
  const maxBefore = maxContentRoom(roomForContent, autoMoreContinued);

  if (group.characterBlockId !== undefined && maxBefore >= 1) {
    const cut = findDialogueSplitIndex(effectiveContent, maxBefore);
    if (cut !== undefined) {
      if (hasBlank) {
        const blank = group.leadingBlank[0];
        if (blank !== undefined) {
          builder.push(blank);
        }
      }
      builder.pushMany(effectiveContent.slice(0, cut));
      if (autoMoreContinued) {
        builder.push(moreLine(group.characterBlockId));
      }
      builder.breakPage();
      if (autoMoreContinued) {
        builder.push(continuedLine(group.characterBlockId, group.characterText));
      }
      placeSpeechContinuation(
        builder,
        group.characterBlockId,
        group.characterText,
        effectiveContent.slice(cut),
        true,
        autoMoreContinued,
      );
      return;
    }
  }

  if (allowFreshBreak) {
    builder.breakPage();
    placeSpeechGroup(builder, group, autoMoreContinued, false);
    return;
  }

  // Pathological: doesn't fit even on an empty page and cannot be split (or has no character
  // cue). Place plainly so every line still lands somewhere.
  placeLinesPlain(builder, effectiveLines(builder, withBlank));
}

/**
 * `documentSettings` defaults to the specification's current fixed values (`autoMoreContinued:
 * true`), so every existing caller keeps producing identical output unchanged. Only
 * `autoMoreContinued` is read here; the rest of `DocumentSettings` belongs to grouping
 * (`buildGroups`) or to rendering, not to page breaking.
 */
export function layoutGroups(
  groups: readonly Group[],
  documentSettings: DocumentSettings = DEFAULT_DOCUMENT_SETTINGS,
): LayoutResult {
  const builder = new PageBuilder();
  const { autoMoreContinued } = documentSettings;

  for (let index = 0; index < groups.length; index += 1) {
    // Non-null: the `for` bound above already guarantees `index` is in range.
    const group = groups[index] as Group;
    switch (group.kind) {
      case 'forcedBreak': {
        builder.breakPage();
        break;
      }
      case 'simple': {
        placeSimpleGroup(builder, group);
        break;
      }
      case 'sceneHeading': {
        const next = groups[index + 1];
        const hasFollowingContent = next !== undefined && next.kind !== 'forcedBreak';
        placeSceneHeadingGroup(builder, group, hasFollowingContent);
        break;
      }
      case 'speech': {
        placeSpeechGroup(builder, group, autoMoreContinued);
        break;
      }
    }
  }

  return builder.finish();
}
