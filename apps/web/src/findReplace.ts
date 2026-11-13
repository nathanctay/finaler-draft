/**
 * Find & replace (menus slice 4): a query over the live document, every match highlighted, the
 * current one distinguished, and a replace path that reaches the real, collaborative document.
 *
 * **Why hand-rolled, not `prosemirror-search`.** `screenplayBlock`'s own content is `text*`
 * (`packages/screenplay-editor/src/index.ts`) with no inline marks anywhere in this schema, so a
 * match can never span a mark boundary and never needs mark-splitting -- the one piece of real
 * complexity a general-purpose search-and-replace library earns its keep on. What is left is
 * "find a substring inside one block's own text, one block at a time, never across a block
 * boundary" (a screenplay line is a unit; a match spanning two has no meaningful replacement),
 * which `doc.descendants` and `String.prototype.indexOf` already do. The owner's own framing: a
 * dependency/licence review is a standing launch blocker, and adding one for something this
 * contained -- on a schema this flat -- is the wrong trade. No regex, no whole-word: the brief is
 * explicit that neither is "trivial to add" here and both are left out rather than half-built.
 *
 * **Why highlights never touch the document.** `smartTypeGhost.ts`'s own header is the precedent
 * this follows to the letter: a `DecorationSet` kept *beside* the document in this plugin's own
 * state, never inside it, is what keeps a match highlight out of every save, every reload, Yjs,
 * and every export -- not a filter bolted on somewhere downstream that a future call site could
 * forget. `projectDocumentScreenplay`'s canonical reading of this document is byte-identical
 * whether a search is active or not, because nothing about a search ever becomes a document node.
 *
 * **The replace workflow this module implements** (the owner's own explicit spec, not the
 * original brief's underspecified "replace the current match"):
 *
 *  1. **Replace advances.** `replaceCurrentMatch` moves `currentIndex` to the next match after the
 *     one it just replaced, so pressing Replace repeatedly walks forward through the document one
 *     occurrence at a time with no Find-next in between.
 *  2. **Skipping works.** `findReplaceNext`/`findReplacePrevious` move `currentIndex` on their
 *     own, with no document edit, so "replace this one, skip the next two, replace the fourth" is
 *     a plain sequence of calls into this module, nothing special.
 *  3. **Replacement text is not eligible for a later match in the same walk.** If the replacement
 *     itself contains the search term (`"foo"` to `"foobar"`), a plain re-scan of the document
 *     would find it again inside the text just inserted -- looping forward forever, or reporting a
 *     match count that grows with every replace. `replacedRanges` (in `FindReplaceState`) is the
 *     fix: every span this module has itself inserted via a replace, in the current search session,
 *     is tracked (and carried forward through every later edit's own mapping) and subtracted from
 *     the match list before anything else sees it -- not just before advancing, but before the
 *     count and the highlights are built, so "17 matches" never silently becomes "18" because the
 *     17th happened to contain the word being searched for. This matches the convention the owner
 *     named as expected: a word processor's "replace and continue" does not re-match text it just
 *     produced. The exclusion is scoped to one search session -- reset the moment the query or the
 *     case-sensitivity changes (a new search has no reason to remember a previous query's own
 *     replace history) -- not a permanent mark on the document; closing Find and reopening it (or
 *     typing a different query) sees the live text exactly as it now reads, self-matches included.
 *     A match is excluded when it *overlaps* a tracked range at all, not only when fully contained
 *     by one -- the simpler, more conservative of the two readings, and the one this module commits
 *     to: text that straddles the boundary between a fresh replacement and whatever sits next to it
 *     is treated as "to do with what was just inserted" rather than parsed apart to ask whether the
 *     overlap is total. `findReplace.test.ts`'s "a replacement containing the search term is not
 *     immediately re-matched, but a later, unrelated occurrence still is" is the test this
 *     paragraph promises.
 *  4. **Wrapping.** Both the plain Next/Previous navigation and the "advance after Replace" above
 *     wrap around at either end of the document rather than stopping -- a deliberate choice, not
 *     the only defensible one, matching the browser-native-find convention this product's own
 *     "Select all" and Edit-menu Undo/Redo already borrow from elsewhere. Replacing the very last
 *     match wraps the next current match back to the first remaining one.
 *
 * **Why `currentIndex` otherwise survives a doc change by mapping, not by re-deriving from
 * scratch.** Typing elsewhere in the document while this bar is open (it is not modal -- see
 * `findReplaceBar.tsx`) must not make the writer lose their place in the result list.
 * `continuedMatchIndex` maps the previous current match's own `from` through the transaction's
 * mapping and looks for a match starting there in the freshly recomputed list; when nothing maps
 * back onto it (the common case for an edit that *is* the current match, handled explicitly by the
 * `'replace'` meta kind instead -- see point 1 above), this falls back to clamping the same
 * numeral index into the shorter list.
 *
 * **Why replace-all is right-to-left on one transaction, not mapped left-to-right.** Replacing in
 * document order would invalidate every later match's `from`/`to` the moment an earlier
 * replacement's length differs from the search term's -- a transaction's own steps compose, but
 * the *literal* positions this module already computed for the matches after the one just
 * replaced are not retroactively updated unless something maps them, and nothing here does.
 * Applying from the highest `from` downward sidesteps the problem instead of solving it: a match
 * at a higher position is replaced before anything at a lower position is touched, so every
 * lower-positioned match's own `from`/`to` is still exactly what `findMatches` said, unchanged by
 * every edit that came after it in the loop. One `Transform.insertText` call per match, all on one
 * `state.tr`, is one `ReplaceStep` each but one Yjs update overall -- see `buildReplaceAllTransaction`.
 * Point 3 above applies here too: every one of replace-all's own inserted spans is tracked the
 * same way a single replace's is, so a replacement that re-introduces the search term does not
 * leave Replace All reporting leftover matches it did not actually replace.
 */
import { Extension, type Editor } from '@tiptap/core';
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { yUndoPluginKey } from 'y-prosemirror';

/** One match (or one excluded span -- the shape is identical, an ordinary ProseMirror range):
 * `from`/`to` straddle nothing but the text itself, never a block boundary, per this module's own
 * top comment. */
export interface FindReplaceMatch {
  readonly from: number;
  readonly to: number;
}

/**
 * `currentIndex` is `-1` exactly when `matches` (already filtered against `replacedRanges`, see
 * this module's top comment, point 3) is empty -- there is no "current match" to have.
 * `query === ''` is the bar's closed/empty state; `findMatches` answers `[]` for it without
 * walking the document at all, so an idle bar costs nothing per keystroke typed anywhere else.
 */
export interface FindReplaceState {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly matches: readonly FindReplaceMatch[];
  readonly currentIndex: number;
  /** Spans this module has itself produced by a replace, in the active search session -- carried
   * forward through every later transaction's own mapping, and subtracted from every freshly
   * found match before it is exposed anywhere (the count, the highlights, navigation). Reset on a
   * new search (a changed query or case-sensitivity) or on close. See this module's top comment,
   * point 3. */
  readonly replacedRanges: readonly FindReplaceMatch[];
  readonly decorations: DecorationSet;
}

type FindReplaceMeta =
  | { readonly kind: 'search'; readonly query: string; readonly caseSensitive: boolean }
  | { readonly kind: 'navigate'; readonly index: number }
  | {
      readonly kind: 'replace';
      /** The exact span(s) this replace just inserted, in the post-edit document's own
       * coordinates -- always already correct with no further mapping needed; see
       * `replaceCurrentMatch`/`replaceAllMatches`'s own comments for why. */
      readonly ranges: readonly FindReplaceMatch[];
      /** Where to resume "current match" search from, for a single replace's own advance-to-next
       * (point 1 above) -- `undefined` for replace-all, which has no single place to resume from
       * and expects the filter in point 3 to leave nothing matching regardless. */
      readonly anchor: number | undefined;
    }
  | { readonly kind: 'clear' };

export const findReplacePluginKey = new PluginKey<FindReplaceState>('findReplace');

function emptyFindReplaceState(): FindReplaceState {
  return {
    query: '',
    caseSensitive: false,
    matches: [],
    currentIndex: -1,
    replacedRanges: [],
    decorations: DecorationSet.empty,
  };
}

/**
 * Every non-overlapping occurrence of `query` in `doc`, one `screenplayBlock` at a time, in
 * document order. `node.textContent` is exactly the block's own text -- no marks to walk, no
 * child text nodes to stitch together by hand, because `screenplayBlock` has only ever been built
 * with the one plain text node this schema allows (this module's own top comment). Returning
 * `false` from the `descendants` callback for a `screenplayBlock` skips recursing into its own
 * text-node children (there is nothing there `textContent` has not already read), while leaving
 * every sibling block's own traversal untouched.
 *
 * An empty `query` answers `[]` immediately, before touching `doc` at all -- the idle common case
 * this module's own header names -- and a query longer than any block's own text can only ever
 * answer `[]` too, no special case required.
 *
 * This answers "every occurrence of the search term", full stop -- it knows nothing about which
 * spans a previous replace produced. Subtracting those (point 3 of this module's top comment) is
 * the plugin's own job, in `apply`, so this function stays a pure, independently testable
 * statement of "what matches" with no session state folded into it.
 */
export function findMatches(
  doc: ProseMirrorNode,
  query: string,
  caseSensitive: boolean,
): readonly FindReplaceMatch[] {
  if (query === '') {
    return [];
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: FindReplaceMatch[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'screenplayBlock') {
      return true;
    }
    const text = node.textContent;
    const haystack = caseSensitive ? text : text.toLowerCase();
    const contentStart = pos + 1;
    let searchFrom = 0;
    for (;;) {
      const index = haystack.indexOf(needle, searchFrom);
      if (index === -1) {
        break;
      }
      matches.push({ from: contentStart + index, to: contentStart + index + query.length });
      // Non-overlapping: the next search starts after the match just found rather than one
      // character into it, matching every ordinary "find" implementation's own convention (a
      // query of "aa" against "aaa" reports one match, not two overlapping ones).
      searchFrom = index + needle.length;
    }
    return false;
  });
  return matches;
}

/** Whether `match` overlaps any of `ranges` at all -- the conservative half of the choice this
 * module's top comment (point 3) commits to: a match that merely straddles the boundary of a
 * tracked range is excluded exactly as one fully inside it is, rather than parsed apart to ask how
 * much of it is "really" the inserted text. Half-open interval overlap, matching how `from`/`to`
 * are used everywhere else here. */
function overlapsAny(match: FindReplaceMatch, ranges: readonly FindReplaceMatch[]): boolean {
  return ranges.some((range) => match.from < range.to && match.to > range.from);
}

/** The match a freshly-typed (or freshly-case-toggled) query should land on: the first one at or
 * after `from`, wrapping to the first match in the document if `from` is past every match. Mirrors
 * the convention a browser's own in-page find uses -- search forward from where the writer already
 * is -- and, reused with `from` set to "just after the text a replace just inserted", is also what
 * implements this module's own "Replace advances, wrapping at the end" (point 1 and point 4 of the
 * top comment): the two are the same operation, "resume forward from a position", with a different
 * starting point. */
function nearestMatchIndex(matches: readonly FindReplaceMatch[], from: number): number {
  if (matches.length === 0) {
    return -1;
  }
  const atOrAfter = matches.findIndex((match) => match.from >= from);
  return atOrAfter === -1 ? 0 : atOrAfter;
}

/**
 * Carries `previous.currentIndex` across a document change that is *not* one of this module's own
 * replace calls -- ordinary typing elsewhere in the document while the bar stays open, since it is
 * not modal. `tr.mapping.map` with a `-1` bias anchors the previous current match's own start to
 * whatever now stands immediately before the edit point, so:
 *  - the mapped position is still exactly some match's own `from` (the edit did not touch this
 *    match) -- that match is still "current";
 *  - it is not (this match itself changed, or vanished some other way not covered by the explicit
 *    `'replace'` handling below) -- clamp the same numeral index into the new, possibly-shorter
 *    list, landing on whatever is now at that position.
 */
function continuedMatchIndex(
  previous: FindReplaceState,
  matches: readonly FindReplaceMatch[],
  tr: Transaction,
): number {
  if (matches.length === 0) {
    return -1;
  }
  const previousMatch = previous.matches[previous.currentIndex];
  if (!previousMatch) {
    return 0;
  }
  const mappedFrom = tr.mapping.map(previousMatch.from, -1);
  const sameMatch = matches.findIndex((match) => match.from === mappedFrom);
  return sameMatch !== -1 ? sameMatch : Math.min(previous.currentIndex, matches.length - 1);
}

/** One inline decoration per match, the current one carrying an extra class
 * (`styles.css`'s `.find-match-current`) so it paints distinctly from the rest -- never a second,
 * independent "where is the current match" fact that could drift from `currentIndex` itself. */
function buildFindDecorations(
  doc: ProseMirrorNode,
  matches: readonly FindReplaceMatch[],
  currentIndex: number,
): DecorationSet {
  if (matches.length === 0) {
    return DecorationSet.empty;
  }
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class: index === currentIndex ? 'find-match find-match-current' : 'find-match',
      }),
    ),
  );
}

/**
 * The find/replace ProseMirror plugin: state only (query, matches, current index, the replaced-
 * range exclusion list, decorations). No keymap of its own -- `Mod-f` to open the surface is
 * `FindReplaceExtension`'s own binding, below, because opening the bar is a React-level concern
 * (`App.tsx`'s `findReplaceOpen` state), not a document-level one.
 */
function createFindReplacePlugin(): Plugin<FindReplaceState> {
  return new Plugin<FindReplaceState>({
    key: findReplacePluginKey,
    props: {
      decorations(state) {
        return findReplacePluginKey.getState(state)?.decorations;
      },
    },
    state: {
      init() {
        return emptyFindReplaceState();
      },
      apply(tr, previous, _oldState, newState) {
        const meta = tr.getMeta(findReplacePluginKey) as FindReplaceMeta | undefined;
        if (meta?.kind === 'clear') {
          return emptyFindReplaceState();
        }
        // A plain navigate (next/previous) never changes the document -- its own transaction
        // carries no steps -- so the match list itself cannot have changed; only which one is
        // "current" has. Recomputing from scratch here would be correct but wasteful, and would
        // also throw away the `DecorationSet` identity for every match *except* the one that
        // moved, for no reason.
        if (meta?.kind === 'navigate' && !tr.docChanged) {
          return {
            ...previous,
            currentIndex: meta.index,
            decorations: buildFindDecorations(newState.doc, previous.matches, meta.index),
          };
        }
        const query = meta?.kind === 'search' ? meta.query : previous.query;
        const caseSensitive = meta?.kind === 'search' ? meta.caseSensitive : previous.caseSensitive;
        // Nothing this plugin tracks changed: most transactions in this editor (every keystroke's
        // worth of pagination's own frame-coalesced redecoration, SmartType's vocabulary refresh)
        // touch neither the document nor this plugin's own query/case-sensitivity. Returning the
        // previous state object keeps its `DecorationSet` reference stable rather than rebuilding
        // an identical one, the same discipline `smartTypeGhost.ts`'s own `apply` applies.
        if (!tr.docChanged && meta?.kind !== 'search') {
          return previous;
        }
        // A new search forgets any previous search's own replace history (point 3 of the top
        // comment); otherwise carry the existing exclusion spans forward through this
        // transaction's own mapping, and add whatever this transaction's own `'replace'` meta
        // just inserted, in the coordinates it already reports (no further mapping needed -- see
        // `replaceCurrentMatch`/`replaceAllMatches`).
        const replacedRanges: readonly FindReplaceMatch[] =
          meta?.kind === 'search'
            ? []
            : [
                ...previous.replacedRanges.map((range) => ({
                  from: tr.mapping.map(range.from, 1),
                  to: tr.mapping.map(range.to, -1),
                })),
                ...(meta?.kind === 'replace' ? meta.ranges : []),
              ];
        const matches = findMatches(newState.doc, query, caseSensitive).filter(
          (match) => !overlapsAny(match, replacedRanges),
        );
        const currentIndex =
          meta?.kind === 'search'
            ? nearestMatchIndex(matches, newState.selection.from)
            : meta?.kind === 'replace'
              ? // Single replace: resume forward from just after what it inserted (point 1), which
                // wraps to the first remaining match when that was the last one (point 4). Replace
                // all has no `anchor` -- point 3's filter is expected to leave nothing standing, and
                // if it somehow does not, settling on whatever is first is a reasonable default for
                // a case this module does not expect to hit in practice.
                nearestMatchIndex(matches, meta.anchor ?? 0)
              : continuedMatchIndex(previous, matches, tr);
        return {
          query,
          caseSensitive,
          matches,
          replacedRanges,
          currentIndex,
          decorations: buildFindDecorations(newState.doc, matches, currentIndex),
        };
      },
    },
  });
}

/** Sets (or replaces) the active query and case-sensitivity, recomputing matches immediately --
 * called on every keystroke in the bar's own query field and every toggle of its checkbox, so the
 * highlighted set and the "N of M" count are never behind what the writer is looking at. Also
 * resets the replaced-range exclusion list: a new search has no reason to remember a previous
 * query's own replace history (this module's top comment, point 3). */
/**
 * The text to seed the query with when the bar is opened, or `undefined` to leave the query alone.
 *
 * Standard editor behaviour, and what the owner asked for: select a word, press `Mod-f`, and the
 * search is already that word. Three cases, each decided deliberately:
 *
 *  - **An empty (collapsed) selection seeds nothing.** There is no text to search for, and opening
 *    the bar should not blank a query the writer may still be working with.
 *  - **A selection inside one block seeds its text, untrimmed.** Not trimmed because trimming would
 *    silently search for something other than what the writer highlighted -- selecting two spaces
 *    and searching for two spaces is a legitimate thing to want.
 *  - **A selection spanning block boundaries seeds nothing.** This is the case worth explaining: a
 *    match in this module never spans blocks (a screenplay line is a unit), so seeding a
 *    cross-block selection would produce a query that *cannot* match by construction -- the bar
 *    would open reporting "no results" for text the writer can plainly see is in the document.
 *    Leaving the query untouched is the honest outcome. `textBetween` is called with a `\n` block
 *    separator precisely so this case is detectable rather than silently flattened.
 */
export function findReplaceQuerySeed(state: EditorState): string | undefined {
  const { from, to } = state.selection;
  if (from === to) {
    return undefined;
  }
  const selected = state.doc.textBetween(from, to, '\n');
  if (selected === '' || selected.includes('\n')) {
    return undefined;
  }
  return selected;
}

export function setFindReplaceQuery(view: EditorView, query: string, caseSensitive: boolean): void {
  const meta: FindReplaceMeta = { kind: 'search', query, caseSensitive };
  view.dispatch(view.state.tr.setMeta(findReplacePluginKey, meta));
}

/** Clears the query, the match list, the replaced-range memory and every highlight -- the bar's
 * Close/Escape action. Leaves the document and the selection untouched: closing the bar is not an
 * edit. */
export function clearFindReplace(view: EditorView): void {
  const meta: FindReplaceMeta = { kind: 'clear' };
  view.dispatch(view.state.tr.setMeta(findReplacePluginKey, meta));
}

/** Moves `currentIndex` forward one match, wrapping to the first (point 4 of the top comment). A
 * no-op with no matches. Never edits the document -- this is exactly what makes "skip this one"
 * possible (point 2): Replace always acts on whatever `currentIndex` already is, and this is the
 * only thing that moves it with no replace attached. */
export function findReplaceNext(view: EditorView): void {
  const state = findReplacePluginKey.getState(view.state);
  if (!state || state.matches.length === 0) {
    return;
  }
  const index = (state.currentIndex + 1) % state.matches.length;
  const meta: FindReplaceMeta = { kind: 'navigate', index };
  view.dispatch(view.state.tr.setMeta(findReplacePluginKey, meta));
}

/** Moves `currentIndex` back one match, wrapping to the last. A no-op with no matches. */
export function findReplacePrevious(view: EditorView): void {
  const state = findReplacePluginKey.getState(view.state);
  if (!state || state.matches.length === 0) {
    return;
  }
  const index = (state.currentIndex - 1 + state.matches.length) % state.matches.length;
  const meta: FindReplaceMeta = { kind: 'navigate', index };
  view.dispatch(view.state.tr.setMeta(findReplacePluginKey, meta));
}

/**
 * Replaces the current match's text with `replacement`, through the real editor's own
 * transaction -- `tr.insertText` is a `ReplaceStep`, dispatched via `editor.view.dispatch`, which
 * is what reaches Yjs (`ySyncPlugin` turns every dispatched transaction into a `Y.Doc` update),
 * the local undo stack, and the canonical projection every other mutation in this app already
 * goes through (`changeElement`, `cutSelection` in App.tsx). Nothing here writes to a `Y.Doc`
 * directly or bypasses the editor in any way.
 *
 * Then advances: the `'replace'` meta attached to the same transaction carries the exact span just
 * inserted (`[match.from, match.from + replacement.length)` -- already correct in the transaction's
 * own resulting coordinates, since nothing before `match.from` moved) and an `anchor` of that
 * span's own end, which the plugin's `apply` resolves to "the next match after here, wrapping" --
 * this module's top comment, points 1 and 4. The inserted span is also what the plugin subtracts
 * from every later rescan, so a replacement that happens to contain the search term is not
 * immediately offered back as a fresh match (point 3).
 *
 * `undoManager.stopCapturing()` first, for the identical reason `acceptSmartTypeGhost` calls it:
 * `y-prosemirror`'s `yUndoPlugin` groups transactions into one undo step by wall-clock proximity
 * (~500ms), and a Replace the writer explicitly clicked for is not "the same edit" as whatever
 * they were typing a moment before it -- without this, one Undo could swallow both. Each one-at-a-
 * time Replace is therefore its own undo step, deliberately -- the owner's own instruction: these
 * are separate writer actions, and coalescing them would be wrong in the other direction from
 * Replace All's single step below.
 *
 * A no-op (returns `false`) when there is no current match, so a caller can use the return value
 * to decide whether anything happened without separately re-reading plugin state.
 */
export function replaceCurrentMatch(editor: Editor, replacement: string): boolean {
  const state = findReplacePluginKey.getState(editor.state);
  const match = state?.matches[state.currentIndex];
  if (!match) {
    return false;
  }
  yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
  const tr = editor.state.tr.insertText(replacement, match.from, match.to);
  const meta: FindReplaceMeta = {
    kind: 'replace',
    ranges: [{ from: match.from, to: match.from + replacement.length }],
    anchor: match.from + replacement.length,
  };
  tr.setMeta(findReplacePluginKey, meta);
  editor.view.dispatch(tr);
  return true;
}

/**
 * Builds the one transaction that replaces every current match with `replacement`, right-to-left
 * -- see this module's top comment for why descending order needs no position mapping at all:
 * every match still to be replaced sits at a strictly lower position than every match already
 * replaced, so its own `from`/`to`, exactly as `findMatches` reported them, are never invalidated
 * by an edit this same loop already made.
 *
 * Exported on its own (separate from `replaceAllMatches` below) so a test can assert the
 * transaction's own shape -- one `tr`, `matches.length` steps -- without a live `Editor`/`EditorView`
 * to dispatch it through.
 */
export function buildReplaceAllTransaction(
  tr: Transaction,
  matches: readonly FindReplaceMatch[],
  replacement: string,
): Transaction {
  const descending = [...matches].sort((a, b) => b.from - a.from);
  for (const match of descending) {
    tr.insertText(replacement, match.from, match.to);
  }
  return tr;
}

/**
 * Where every one of `matches`' own replacement text ends up, in the *final* document, once every
 * one of them has been replaced with `replacement` -- deliberately computed independently of
 * `buildReplaceAllTransaction`'s own right-to-left application order, and not by querying the
 * transaction it produces.
 *
 * Right-to-left is correct *for performing the edits*: each `insertText` call uses a literal,
 * un-mapped position that is still valid at the moment it runs, because only higher positions
 * (already edited) could lie after it, never before. But "still valid to apply at" is not the same
 * question as "where does this land once every other replacement in the batch has also landed" --
 * a match processed early (a higher original position) is still shifted rightward by every
 * lower-positioned replacement that gets applied after it, exactly as it would be if the whole
 * batch had been applied left-to-right instead. Reusing the per-match positions
 * `buildReplaceAllTransaction` itself used (`match.from`, with no shift) for this purpose was tried
 * first and is wrong for every match except the lowest-positioned one -- caught directly by
 * `findReplace.test.ts`'s "replace all does not loop or report leftover matches when the
 * replacement re-introduces the search term", which failed by finding a leftover self-match at a
 * position this module's own tracking had not actually covered.
 *
 * The fix is a closed-form, left-to-right walk that needs no document and no transaction at all:
 * matches are already known to be non-overlapping and the same length (`query.length`, since every
 * one matched the identical search term), so the *i*-th match in document order is shifted right by
 * exactly `i` times the one constant length delta every earlier replacement in the batch
 * contributes. This is independent of whichever order the edits are actually dispatched in, which
 * is exactly why it does not need to agree with `buildReplaceAllTransaction`'s own loop direction.
 */
function finalReplacedRanges(
  matches: readonly FindReplaceMatch[],
  replacement: string,
): readonly FindReplaceMatch[] {
  const ascending = [...matches].sort((a, b) => a.from - b.from);
  const ranges: FindReplaceMatch[] = [];
  let shift = 0;
  for (const match of ascending) {
    const from = match.from + shift;
    ranges.push({ from, to: from + replacement.length });
    shift += replacement.length - (match.to - match.from);
  }
  return ranges;
}

/**
 * Replaces every current match with `replacement` in one dispatched transaction -- one Yjs
 * update, one local undo step, regardless of how many matches there are. See
 * `buildReplaceAllTransaction` for why right-to-left needs no mapping, and this module's top
 * comment for the owner's own framing of "one Undo reverses the whole batch".
 *
 * Each match's own final inserted span -- `finalReplacedRanges`, **not** the per-match positions
 * `buildReplaceAllTransaction` itself applies the edits at (see that function's own comment for
 * why those two are different questions) -- is recorded via the same `'replace'` meta a single
 * replace uses, with no `anchor`: every original match is being replaced in this one call, so
 * point 3's filter is expected to leave nothing left to be "current" afterward; there is no single
 * position to resume from the way a one-at-a-time Replace has.
 *
 * Returns the number of matches replaced (`0` with nothing to do, which this still dispatches
 * nothing for -- an empty transaction would be a no-op write with nothing to show for it).
 */
export function replaceAllMatches(editor: Editor, replacement: string): number {
  const state = findReplacePluginKey.getState(editor.state);
  if (!state || state.matches.length === 0) {
    return 0;
  }
  yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
  const tr = buildReplaceAllTransaction(editor.state.tr, state.matches, replacement);
  const ranges = finalReplacedRanges(state.matches, replacement);
  const meta: FindReplaceMeta = { kind: 'replace', ranges, anchor: undefined };
  tr.setMeta(findReplacePluginKey, meta);
  editor.view.dispatch(tr);
  return state.matches.length;
}

export interface FindReplaceExtensionOptions {
  /** Called on `Mod-f` inside the editor -- opens the bar (`App.tsx`'s own `findReplaceOpen`
   * state). Defaults to a no-op so an unconfigured instance (every test that only needs the
   * plugin's own matching/decoration behaviour, and `keyboardShortcuts.test.ts`'s binding-name
   * resolution) never throws. */
  onOpen: (seed: string | undefined) => void;
}

/**
 * Mounted in `App.tsx` beside `PaginationExtension`/`SmartTypeGhostExtension` -- a layer over the
 * screenplay editor, not part of what a `screenplayBlock` *is*, exactly like those two (see either
 * one's own header for the same reasoning). Holds the find/replace plugin and the one keyboard
 * binding this feature owns; `Mod-f` was unbound anywhere in this editor before this slice
 * (confirmed against `packages/screenplay-editor`'s own keymaps and this app's other extensions),
 * so claiming it adds no collision -- see `keyboardShortcuts.ts` for where it is also documented
 * for the writer, and that file's own test for the mechanism that would fail if this binding's name
 * or this extension's own name ever drifted apart.
 */
export const FindReplaceExtension = Extension.create<FindReplaceExtensionOptions>({
  name: 'findReplace',
  addOptions() {
    return { onOpen: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-f': () => {
        // The seed is read here, from the editor's own state at the moment the shortcut fires,
        // rather than in `App.tsx`: by the time React has re-rendered the bar and focused its
        // input, the selection a writer had when they pressed the key is no longer what the view
        // reports. See `findReplaceQuerySeed` for which selections seed and which do not.
        this.options.onOpen(findReplaceQuerySeed(this.editor.state));
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [createFindReplacePlugin()];
  },
});
