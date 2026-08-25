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
import { characterWrapBudgetFor, wrapBlockText } from './wrap.js';

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

/**
 * Builds the `CONT'D` heading, wrapped through the identical `characterWrapBudgetFor` budget and
 * `wrapBlockText` algorithm every authored character cue uses (`wrap.ts`), instead of emitting
 * exactly one `GeneratedLine` unconditionally the way this function used to.
 *
 * `documentSettingsSchema` caps `characterIndentIn` at `MAX_ADJUSTABLE_INDENT_IN -
 * MIN_CHARACTER_CUE_ROOM_IN` (6.5in, `packages/screenplay/src/index.ts`), which was reasoned
 * about as "room for at least ten characters" for an AUTHORED cue -- but the ` (CONT'D)` this
 * function appends is nine characters by itself, before a single character of the name it
 * follows. At that legal-but-extreme indent (or any indent long enough combined with a long
 * character name) the DOM wraps the heading onto a second line while the old single-`push` model
 * still counted it as one, so the model's page-fill arithmetic silently drifted from what the
 * screen actually painted, compounding on every later page.
 *
 * Reusing the exact function and budget every other character-indented line already wraps at,
 * rather than adding a second, independent bound sized for this one case, is what keeps the model
 * and the DOM in agreement by construction for any character-name length and any legal indent --
 * with only one place (`wrap.ts`) that has to know what the character-cue budget is, matching
 * this file's own top-of-file convention of deriving every capacity figure from one source. The
 * `element` argument to `wrapBlockText` is `'character'` because that is what this text visually
 * is (plan.md: `(MORE)`/`CONT'D` render at the character indent), even though the returned lines
 * are `GeneratedLine`s, not `AuthoredLine`s -- see `GeneratedLine`'s own doc comment in model.ts
 * for why it deliberately carries no `element` field of its own.
 */
function continuedLines(
  sourceBlockId: string,
  characterText: string | undefined,
  characterIndentIn: number,
): GeneratedLine[] {
  const budget = characterWrapBudgetFor(characterIndentIn);
  const text = `${characterText ?? ''} (CONT'D)`;
  return wrapBlockText(sourceBlockId, 'character', text, budget).map((line) => ({
    kind: 'generated',
    reason: 'continued',
    sourceBlockId,
    text: line.text,
  }));
}

/**
 * Whether `lines` contains at least one row of real spoken content, as opposed to rows that
 * render as blank space. `wrapBlockText` always produces at least one `AuthoredLine` per block,
 * even an empty one, "so a block is addressable... regardless of whether it currently holds any
 * characters" -- an empty dialogue block is therefore an ordinary `authored` line with `text:
 * ''`, still occupying its row, just with nothing printed on it.
 *
 * Trimming, rather than an exact `=== ''` check, is deliberate: a writer can leave a dialogue
 * block holding only spaces, and nothing stops that from reaching this engine.
 * `screenplayTextSchema` (`packages/screenplay/src/index.ts`) is a bare length-capped
 * `z.string()` with no whitespace rule. Plan.md's "A line cannot begin with a space" (the
 * "Element indents" section, among the not-yet-shipped Final Draft 13 editor rules) would reject
 * this at authoring time once it ships, but it is documented there as future editor behavior, not
 * schema validation, and this engine cannot assume every document it is asked to paginate was
 * authored through an editor that enforces it. A whitespace-only block wraps to a line whose
 * `text` is that whitespace, not `''` (`wrapBlockText` only drops whitespace that causes a wrap;
 * whitespace that fits on an otherwise-empty line is kept verbatim) -- so `text.trim() === ''` is
 * what actually catches it, while `text === ''` alone would not.
 */
function hasSpokenContent(lines: readonly AuthoredLine[]): boolean {
  return lines.some((line) => line.text.trim() !== '');
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
 *
 * A second, independent gate sits alongside `autoMoreContinued`: even with the setting on, a
 * given split's markers are emitted only when BOTH the page-foot side and the continuation-head
 * side of that split have real spoken content (`hasSpokenContent`). plan.md never specified what
 * happens when a speech is split at a point where one side is entirely empty dialogue blocks --
 * an empty block is still a member of the speech it sits in, and the split logic below correctly
 * treats it as such -- but a lone `(MORE)` under a cue that hasn't spoken yet, or a `CONT'D`
 * heading over a page that goes on to say nothing, both misrepresent the split as one this
 * document setting exists to announce. This gate does not move the split itself: `maxContentRoom`
 * still reserves a line for `(MORE)` whenever `autoMoreContinued` is on, regardless of whether
 * this particular split turns out to need it. Making the reservation itself content-aware would
 * require knowing which side of the split is empty before the split has been found -- the room
 * available for the "before" side depends on the reservation, and the reservation would depend on
 * the very split that room search produces. Reserving unconditionally on the setting, as before,
 * sidesteps that circularity at the cost of an occasional unused row of headroom on the outgoing
 * page when the markers end up suppressed; see paginate.test.ts for a fixture that checks exactly
 * that row is unused rather than silently absorbed by something else.
 */
function placeSpeechContinuation(
  builder: PageBuilder,
  characterBlockId: string,
  characterText: string | undefined,
  remaining: readonly AuthoredLine[],
  allowFreshBreak: boolean,
  autoMoreContinued: boolean,
  characterIndentIn: number,
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

    // See `hasSpokenContent`'s doc comment above `placeSpeechContinuation`: markers require real
    // content on both sides of THIS split, independently of any split found elsewhere in the
    // speech's continuation chain.
    const emitMarkers =
      autoMoreContinued &&
      hasSpokenContent(remaining.slice(0, cut)) &&
      hasSpokenContent(remaining.slice(cut));

    if (emitMarkers) {
      builder.push(moreLine(characterBlockId));
    }
    builder.breakPage();
    if (emitMarkers) {
      builder.pushMany(continuedLines(characterBlockId, characterText, characterIndentIn));
    }
    placeSpeechContinuation(
      builder,
      characterBlockId,
      characterText,
      remaining.slice(cut),
      true,
      autoMoreContinued,
      characterIndentIn,
    );
    return;
  }

  if (allowFreshBreak) {
    builder.breakPage();
    // No split happens on this path -- `remaining` moves to the fresh page whole, so only the
    // "after" side (all of `remaining`) exists to check; there is no "before" side of this
    // particular move to be empty. Reaching this branch at all already requires `remaining` not
    // to fit even a fresh page's own room, which -- at this file's current constants -- makes an
    // entirely-empty `remaining` here a case no fixture in paginate.test.ts can construct through
    // `paginateScreenplay`'s public surface (an all-empty `remaining` short enough to trigger
    // this branch would first have to fail the "fits in room" check just above, and a fresh
    // page's room is never small enough for that). The gate is kept anyway, for the same reason
    // the cut branch above has one: this function must not announce a continuation of nothing,
    // regardless of which of its branches produces the break.
    if (autoMoreContinued && hasSpokenContent(remaining)) {
      builder.pushMany(continuedLines(characterBlockId, characterText, characterIndentIn));
    }
    placeSpeechContinuation(
      builder,
      characterBlockId,
      characterText,
      remaining,
      false,
      autoMoreContinued,
      characterIndentIn,
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
 * handling), the whole speech moves to the next page. A found split still places every line of
 * the speech on one page or the other regardless of content; whether that split additionally
 * gets a `(MORE)`/`CONT'D` pair is decided separately, by `hasSpokenContent` — see its doc
 * comment above `placeSpeechContinuation`.
 */
function placeSpeechGroup(
  builder: PageBuilder,
  group: SpeechGroup,
  autoMoreContinued: boolean,
  characterIndentIn: number,
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

      // `group.characterLines.length` is the fixed offset into `effectiveContent` where the
      // speech's own dialogue/parenthetical content starts, after the character cue's lines --
      // see `hasSpokenContent`'s doc comment above `placeSpeechContinuation` for why the cue
      // itself must be excluded from the "before" check: a cue followed only by an empty
      // dialogue block has real text (the character's name) but has not spoken, and that is
      // exactly the foot-of-page case this gate exists to catch.
      const emitMarkers =
        autoMoreContinued &&
        hasSpokenContent(effectiveContent.slice(group.characterLines.length, cut)) &&
        hasSpokenContent(effectiveContent.slice(cut));

      if (emitMarkers) {
        builder.push(moreLine(group.characterBlockId));
      }
      builder.breakPage();
      if (emitMarkers) {
        builder.pushMany(
          continuedLines(group.characterBlockId, group.characterText, characterIndentIn),
        );
      }
      placeSpeechContinuation(
        builder,
        group.characterBlockId,
        group.characterText,
        effectiveContent.slice(cut),
        true,
        autoMoreContinued,
        characterIndentIn,
      );
      return;
    }
  }

  if (allowFreshBreak) {
    builder.breakPage();
    placeSpeechGroup(builder, group, autoMoreContinued, characterIndentIn, false);
    return;
  }

  // Pathological: doesn't fit even on an empty page and cannot be split (or has no character
  // cue). Place plainly so every line still lands somewhere.
  placeLinesPlain(builder, effectiveLines(builder, withBlank));
}

/**
 * `documentSettings` defaults to the specification's current fixed values (`autoMoreContinued:
 * true`, `characterIndentIn` at its specification default), so every existing caller keeps
 * producing identical output unchanged. Only `autoMoreContinued` and `characterIndentIn` are read
 * here -- the former gates whether `(MORE)`/`CONT'D` are emitted at all, the latter is needed to
 * wrap the generated `CONT'D` heading at the same budget the DOM renders it at (see
 * `continuedLines`); the rest of `DocumentSettings` belongs to grouping (`buildGroups`) or to
 * rendering, not to page breaking.
 */
export function layoutGroups(
  groups: readonly Group[],
  documentSettings: DocumentSettings = DEFAULT_DOCUMENT_SETTINGS,
): LayoutResult {
  const builder = new PageBuilder();
  const { autoMoreContinued, characterIndentIn } = documentSettings;

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
        placeSpeechGroup(builder, group, autoMoreContinued, characterIndentIn);
        break;
      }
    }
  }

  return builder.finish();
}
