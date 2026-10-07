/**
 * Word-level text diff: which **words** inside one block's text differ between two revisions,
 * rather than only whether the text differs at all.
 *
 * `diff.ts` answers "did this block's text change" (`ScreenplayBlockDiffEntry.textChanged`, a
 * boolean). That is the right granularity for deciding whether a block is interesting; it is far
 * too coarse for *reading* a change in place. A writer who fixed one word in a twelve-line speech
 * would see the entire speech marked, which is indistinguishable from having rewritten it -- the
 * reader then has to compare the two texts by eye, which is exactly the work an inline diff exists
 * to do for them. This module narrows that to the words that actually moved, which is what both
 * reference tools (Google Docs' suggested edits, GitHub's unified diff) do and the single largest
 * readability win available in the diff view.
 *
 * **Word-level, deliberately not character-level.** Screenplay text is prose. Marking prose by
 * character turns `Saturday` to `Sunday` into `S`+`a`+`t`...-style confetti that reads as noise
 * rather than as "this word changed"; word granularity is the unit a reader of prose actually
 * perceives. There is no character-level mode here and none is wanted.
 *
 * **Algorithm.** Myers' greedy longest-common-subsequence / shortest-edit-script algorithm (Eugene
 * W. Myers, "An O(ND) Difference Algorithm and Its Variations", Algorithmica 1/2 (1986)) over
 * *tokens*, preceded by common-prefix/common-suffix elimination. Time is `O((N + M) * D)` and space
 * `O(D^2)`, where `N`/`M` are the two token counts **after** trimming and `D` is the token edit
 * distance between what remains -- so cost scales with the size of the *change*, not the size of
 * the text. The prefix/suffix trim is what makes the dominant real case trivial: a one-word edit
 * anywhere in a block reduces to `N = M = 1`, `D = 2`, regardless of how long the block is. A plain
 * `O(N * M)` dynamic-programming LCS table would instead have paid for the whole block every time,
 * which at `MAX_AUTHORED_TEXT_LENGTH` (20,000 code units -- thousands of tokens) is millions of
 * cells to report a single corrected typo.
 *
 * Pure and synchronous, with no screenplay-schema dependency at all: it is string in, segments out.
 * That is why it sits in its own module rather than inside `diff.ts` -- `diff.ts` is about block
 * identity and ordering, this is about one pair of strings, and the two are independently testable
 * precisely because they do not know about each other. `diff.ts` is deliberately left unchanged by
 * this module's existence: it still reports `textChanged`, and a *renderer* pairs that flag with
 * this function. Nothing about move detection or scene grouping is touched.
 */

/**
 * `'equal'` content is present in both texts; `'removed'` only in `before`; `'added'` only in
 * `after`. A segment is never empty, and two adjacent segments never share a kind (runs are
 * coalesced), so the segment list is a canonical representation of one comparison -- two equal
 * comparisons always produce identical lists, which is what makes this directly assertable in a
 * test without normalising first.
 */
export type TextDiffSegmentKind = 'equal' | 'removed' | 'added';

export interface TextDiffSegment {
  readonly kind: TextDiffSegmentKind;
  readonly text: string;
}

/**
 * The largest token edit distance this module will search for before giving up and reporting the
 * comparison as a wholesale replacement (one `'removed'` segment carrying all of `before`, one
 * `'added'` segment carrying all of `after`).
 *
 * Myers' greedy variant stores one frontier per `d` it advances through, which is the `O(D^2)`
 * space term above. Unbounded, a pathological pair -- two different 20,000-code-unit action blocks,
 * thousands of tokens each with almost nothing in common -- would ask for tens of millions of
 * frontier entries to tell a reader something they can already see: that the block was rewritten.
 * The cap turns that case into the answer it deserves at a fixed, small cost. It is not a
 * correctness compromise for ordinary text: `D` is at most `N + M` after trimming, so any
 * comparison whose two trimmed token counts sum to no more than this bound is answered exactly, and
 * a trimmed sum that large means essentially nothing was shared in the first place. A whole
 * *rewritten line* of dialogue or action -- tens of tokens -- is far inside the bound and is
 * reported precisely, word by word.
 */
export const MAX_WORD_DIFF_EDIT_DISTANCE = 256;

/**
 * Splits text into word tokens, each carrying its own **trailing** whitespace, preserving every code
 * unit: `tokenizeWords(text).join('') === text` for every input, which is what lets a renderer
 * concatenate segments back into the writer's exact text without ever re-spacing it. Any leading
 * whitespace run becomes a token of its own (there is no preceding word to attach it to), and text
 * made entirely of whitespace is a single token.
 *
 * Attaching trailing whitespace to the word rather than making whitespace runs tokens in their own
 * right is a readability decision, measured against the alternative. With separate whitespace tokens,
 * two consecutive rewritten words share the space between them -- that space is identical on both
 * sides, so it is reported `'equal'`, and the rendered line breaks a single rewritten phrase into two
 * struck fragments with an unmarked gap between them. Carrying the space with its word instead marks
 * a rewritten phrase as one continuous span, which is both what a reader expects and what GitHub's
 * own word-level diff does. The cost is that changing only the spacing between two words marks the
 * preceding word -- invisible in practice, and far cheaper than fragmenting every multi-word edit.
 */
export function tokenizeWords(text: string): string[] {
  if (text.length === 0) return [];
  const tokens: string[] = [];
  const leading = /^\s+/u.exec(text);
  const wordWithTrailingSpace = /\S+\s*/gu;
  if (leading) {
    tokens.push(leading[0]);
    wordWithTrailingSpace.lastIndex = leading[0].length;
  }
  let match = wordWithTrailingSpace.exec(text);
  while (match !== null) {
    tokens.push(match[0]);
    match = wordWithTrailingSpace.exec(text);
  }
  return tokens;
}

/** Appends `text` to `segments`, merging into the previous segment when it carries the same kind,
 * so the output never contains two adjacent segments of one kind (this module's own canonical-form
 * guarantee). Empty text is dropped rather than producing a zero-length segment. */
function pushSegment(segments: TextDiffSegment[], kind: TextDiffSegmentKind, text: string): void {
  if (text.length === 0) return;
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) {
    segments[segments.length - 1] = { kind, text: last.text + text };
    return;
  }
  segments.push({ kind, text });
}

/** One step of the edit script Myers' backtrack produces, in forward order. */
type TokenEdit =
  | { readonly kind: 'equal'; readonly token: string }
  | { readonly kind: 'removed'; readonly token: string }
  | { readonly kind: 'added'; readonly token: string };

/**
 * Myers' greedy forward pass plus backtrack, over two already-trimmed token arrays. Returns the
 * edit script in forward order, or `undefined` when the edit distance exceeds
 * `MAX_WORD_DIFF_EDIT_DISTANCE` (see that constant's own comment for why a cap exists and why it
 * costs ordinary text nothing).
 *
 * `frontier[k]` is the furthest `x` (index into `before`) reachable on diagonal `k = x - y` using
 * exactly `d` edits; the loop advances `d` until the far corner `(N, M)` is reached. One snapshot
 * of the frontier is kept per `d` -- only the `[-d, d]` window each `d` can actually occupy, which
 * is what makes the space term `O(D^2)` rather than `O(D * (N + M))` -- and the backtrack walks
 * those snapshots from the end to recover which single edit was taken at each `d`, with the
 * "snake" of equal tokens between two edits recovered by walking the diagonal.
 */
function myersTokenEdits(
  before: readonly string[],
  after: readonly string[],
): TokenEdit[] | undefined {
  const n = before.length;
  const m = after.length;
  const maxDistance = Math.min(n + m, MAX_WORD_DIFF_EDIT_DISTANCE);
  // Indexed by `k + origin`: `|k| <= d <= maxDistance` throughout, and the extra cell at each end
  // makes the `k - 1` / `k + 1` neighbour reads at `|k| === maxDistance` in-bounds rather than
  // relying on an out-of-range typed-array read. Never-written diagonals read as `0`, which is the
  // boundary convention Myers' greedy pass itself is stated in terms of (an unreachable diagonal
  // contributes nothing, and `0` is the only `x` the search can start from).
  const origin = maxDistance + 1;
  const frontier = new Int32Array(2 * origin + 1);
  const snapshots: Int32Array[] = [];

  for (let d = 0; d <= maxDistance; d++) {
    // Snapshotted before this `d`'s own writes, so `snapshots[d]` is the state the backtrack needs
    // to decide which predecessor diagonal the single edit at depth `d` came from. Only the
    // `[-d, d]` window is kept -- the `O(D^2)` space term, rather than `O(D * (N + M))`.
    snapshots.push(frontier.slice(origin - d, origin + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const left = frontier[k - 1 + origin]!;
      const right = frontier[k + 1 + origin]!;
      // Moving "down" (an insertion from `after`) when the neighbouring diagonals say that reaches
      // further, otherwise "right" (a deletion from `before`). The boundary cases `k === -d` and
      // `k === d` have only one legal predecessor.
      const x = k === -d || (k !== d && left < right) ? right : left + 1;
      let currentX = x;
      let currentY = currentX - k;
      while (currentX < n && currentY < m && before[currentX] === after[currentY]) {
        currentX++;
        currentY++;
      }
      frontier[k + origin] = currentX;
      if (currentX >= n && currentY >= m) {
        return backtrackTokenEdits(before, after, snapshots);
      }
    }
  }
  return undefined;
}

/** Walks `snapshots` backward to recover the forward-order edit script -- see `myersTokenEdits`. */
function backtrackTokenEdits(
  before: readonly string[],
  after: readonly string[],
  snapshots: readonly Int32Array[],
): TokenEdit[] {
  const reversed: TokenEdit[] = [];
  let x = before.length;
  let y = after.length;
  for (let d = snapshots.length - 1; d >= 0; d--) {
    const snapshot = snapshots[d]!;
    // `snapshot` covers diagonals `[-d, d]`, stored at `diagonal + d`. A diagonal outside that
    // window was unreachable at this depth and reads as `0` -- the same convention the forward pass
    // above relies on, and what makes the `d === 0` step terminate at the origin without a special
    // case: `previousX` is then `0`, so the trailing `while` walks the leading snake back to
    // `(0, 0)` and the `d > 0` guard emits no edit.
    const at = (diagonal: number): number =>
      diagonal < -d || diagonal > d ? 0 : snapshot[diagonal + d]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      reversed.push({ kind: 'equal', token: before[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === previousX) {
        reversed.push({ kind: 'added', token: after[previousY]! });
      } else {
        reversed.push({ kind: 'removed', token: before[previousX]! });
      }
      x = previousX;
      y = previousY;
    }
  }
  return reversed.reverse();
}

/**
 * The word-level comparison of one block's text across two revisions, as an ordered list of
 * segments whose `'equal'` and `'added'` parts concatenate back to `after` and whose `'equal'` and
 * `'removed'` parts concatenate back to `before`. Identical inputs produce a single `'equal'`
 * segment (or, for two empty strings, no segments at all) -- never a mark.
 *
 * At each point the two texts diverge, the `'removed'` segment precedes the `'added'` one, so a
 * replacement always reads "old text, then new text" in document order rather than depending on
 * which order Myers' backtrack happened to recover the two edits in. That is the ordering both
 * reference tools use and the one a reader scanning a line left to right expects.
 */
export function diffWords(before: string, after: string): TextDiffSegment[] {
  if (before === after) {
    return before.length === 0 ? [] : [{ kind: 'equal', text: before }];
  }

  const beforeTokens = tokenizeWords(before);
  const afterTokens = tokenizeWords(after);

  // Common prefix/suffix elimination. Everything shared at either end is `'equal'` by inspection
  // and never needs to enter the search -- this is what reduces a one-word edit in a long block to
  // a one-token-against-one-token problem.
  let prefix = 0;
  while (
    prefix < beforeTokens.length &&
    prefix < afterTokens.length &&
    beforeTokens[prefix] === afterTokens[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < beforeTokens.length - prefix &&
    suffix < afterTokens.length - prefix &&
    beforeTokens[beforeTokens.length - 1 - suffix] === afterTokens[afterTokens.length - 1 - suffix]
  ) {
    suffix++;
  }

  const beforeMiddle = beforeTokens.slice(prefix, beforeTokens.length - suffix);
  const afterMiddle = afterTokens.slice(prefix, afterTokens.length - suffix);

  const segments: TextDiffSegment[] = [];
  pushSegment(segments, 'equal', beforeTokens.slice(0, prefix).join(''));

  const edits = myersTokenEdits(beforeMiddle, afterMiddle);
  if (edits === undefined) {
    // Past the edit-distance cap: report the trimmed middle as a wholesale replacement. The shared
    // prefix and suffix are still reported as equal, so even this degraded answer never claims more
    // changed than actually did.
    pushSegment(segments, 'removed', beforeMiddle.join(''));
    pushSegment(segments, 'added', afterMiddle.join(''));
  } else {
    // Buffered so every divergence emits its removals before its additions, whatever order the
    // backtrack recovered them in -- see this function's own comment.
    let pendingRemoved = '';
    let pendingAdded = '';
    const flush = (): void => {
      pushSegment(segments, 'removed', pendingRemoved);
      pushSegment(segments, 'added', pendingAdded);
      pendingRemoved = '';
      pendingAdded = '';
    };
    for (const edit of edits) {
      if (edit.kind === 'equal') {
        flush();
        pushSegment(segments, 'equal', edit.token);
      } else if (edit.kind === 'removed') {
        pendingRemoved += edit.token;
      } else {
        pendingAdded += edit.token;
      }
    }
    flush();
  }

  pushSegment(segments, 'equal', beforeTokens.slice(beforeTokens.length - suffix).join(''));
  return segments;
}

/** `true` when `segments` marks anything at all -- the one-line question a renderer asks to decide
 * whether a block needs any marking, rather than re-scanning the list at every call site. */
export function textDiffHasMarks(segments: readonly TextDiffSegment[]): boolean {
  return segments.some((segment) => segment.kind !== 'equal');
}
