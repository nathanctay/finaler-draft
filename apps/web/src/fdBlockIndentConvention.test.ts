import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the convention `styles.css` documents just above its indent rules (see that file's own
 * comment beginning "Every indent below is specified from the physical page edge"): any rule
 * selecting `.script-body [data-screenplay-block][data-screenplay-element='X']` that shifts the
 * block's content box left with `margin-left` must ALSO declare `--fd-block-indent` in that same
 * rule, so `.page-break-widget` (styles.css's own rule immediately below, keyed off
 * `var(--fd-block-indent, ...)`) can cancel the inherited offset when a page-break widget is
 * nested inside that element instead of rendered as `.script-body`'s direct sibling. Without the
 * custom property, a widget nested in that element renders at the wrong indent -- exactly the
 * defect PR #16 fixed for `dialogue`, `character`, and `parenthetical` (see `apps/web/e2e/
 * page-rendering.spec.ts`'s "a mid-block break nested in X renders at the identical cue-line
 * indent... as a block-boundary break" test, which loops a hardcoded four-host list and so cannot
 * catch a fifth element added later without also being edited).
 *
 * `scene_heading`, `action`, and `shot` set no left offset at all (no `margin-left`, so nothing to
 * cancel) and `transition` offsets with `margin-right` (a right-aligned shift that never moves the
 * content box's left edge), so none of those four are required to declare the property -- only a
 * rule that actually sets `margin-left` is checked.
 *
 * This is deliberately not a CSS parser (the project has no stylelint and adding one is out of
 * scope): a small brace-depth scanner is enough to split the stylesheet into individual rules
 * (including rules nested inside an `@media` block, descended into recursively since CSS nests at
 * most one level in this file), read each rule's own selector and declaration body, and check the
 * two properties against each other within that one rule -- matching how the convention itself is
 * written today (`--fd-block-indent` and `margin-left` always sit in the same rule, never split
 * across two rules that happen to share a selector).
 */

const STYLES_CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'styles.css');

type CssRule = { selector: string; body: string };

/**
 * Splits CSS text into leaf rules: `{selector, body}` pairs whose body contains no further
 * nested `{`. A rule whose body DOES contain nested braces is an at-rule wrapping other rules
 * (the only case in this file is `@media`) -- its own header is discarded (an at-rule condition
 * is not a selector) and its body is scanned again for the leaf rules nested inside it.
 */
function extractLeafRules(css: string): CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: { header: string; open: number; body?: string }[] = [];
  let depth = 0;
  let headerStart = 0;

  for (let i = 0; i < withoutComments.length; i += 1) {
    const char = withoutComments[i];
    if (char === '{') {
      if (depth === 0) {
        blocks.push({ header: withoutComments.slice(headerStart, i).trim(), open: i });
      }
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const currentBlock = blocks[blocks.length - 1];
        if (!currentBlock) {
          throw new Error('fdBlockIndentConvention: unmatched "}" while scanning styles.css.');
        }
        currentBlock.body = withoutComments.slice(currentBlock.open + 1, i);
        headerStart = i + 1;
      }
    }
  }

  if (depth !== 0) {
    throw new Error('fdBlockIndentConvention: unbalanced braces while scanning styles.css.');
  }

  const rules: CssRule[] = [];
  for (const block of blocks) {
    if (block.body === undefined) {
      throw new Error(`fdBlockIndentConvention: rule "${block.header}" never closed.`);
    }
    if (block.body.includes('{')) {
      // An at-rule (only `@media` in this file) wrapping further rules -- recurse into its body
      // rather than treating the at-rule condition itself as a selector.
      rules.push(...extractLeafRules(block.body));
    } else {
      rules.push({ selector: block.header, body: block.body });
    }
  }
  return rules;
}

const DATA_SCREENPLAY_ELEMENT_PATTERN = /\[data-screenplay-element=(['"])([^'"]+)\1\]/;

/**
 * Every `data-screenplay-element` value named by a rule's selector that is itself scoped under
 * `.script-body` -- a rule's selector can be a comma-separated list sharing one declaration body
 * (styles.css does this for the `scene_heading`/`character` bold-weight rule), and each part is
 * checked independently since each names its own element.
 */
function scriptBodyElementNames(selector: string): string[] {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.includes('.script-body'))
    .map((part) => DATA_SCREENPLAY_ELEMENT_PATTERN.exec(part)?.[2])
    .filter((name): name is string => name !== undefined);
}

describe('the --fd-block-indent convention (styles.css)', () => {
  it('requires every .script-body element rule that sets margin-left to also declare --fd-block-indent', () => {
    const css = readFileSync(STYLES_CSS_PATH, 'utf8');
    const rules = extractLeafRules(css);

    const violations: string[] = [];
    for (const rule of rules) {
      const setsLeftOffset = /\bmargin-left\s*:/.test(rule.body);
      if (!setsLeftOffset) {
        continue;
      }
      const declaresBlockIndent = /--fd-block-indent\s*:/.test(rule.body);
      if (declaresBlockIndent) {
        continue;
      }
      for (const elementName of scriptBodyElementNames(rule.selector)) {
        violations.push(elementName);
      }
    }

    // Named explicitly so the failure message tells the next person exactly which element rule
    // to fix, and why -- a bare `toHaveLength(0)` on `violations` would report only a count.
    expect(
      violations,
      `The following [data-screenplay-element] rule(s) set margin-left without also declaring ` +
        `--fd-block-indent, which will misplace a page-break widget nested inside that element ` +
        `(see PR #16 and this file's own doc comment): ${violations.join(', ') || '(none)'}`,
    ).toEqual([]);
  });

  // Proves the scanner actually looks at declarations, not just selector text: `scene_heading`
  // carries no margin-left at all, so a rule that names it must never be flagged regardless of
  // whether --fd-block-indent happens to be present.
  it('does not flag an element rule that sets no margin-left in the first place', () => {
    const css = readFileSync(STYLES_CSS_PATH, 'utf8');
    const rules = extractLeafRules(css);

    const sceneHeadingRules = rules.filter((rule) =>
      scriptBodyElementNames(rule.selector).includes('scene_heading'),
    );
    expect(sceneHeadingRules.length).toBeGreaterThan(0);
    for (const rule of sceneHeadingRules) {
      expect(rule.body).not.toMatch(/\bmargin-left\s*:/);
    }
  });

  // Confirms the four elements this scope's own risk note calls out are handled the way the
  // stylesheet's comments say they are, so a future edit to any of these four is also caught by
  // the guard above rather than only by this fixed list.
  it('reflects the current, known-correct state of each documented element', () => {
    const css = readFileSync(STYLES_CSS_PATH, 'utf8');
    const rules = extractLeafRules(css);

    const bodyFor = (elementName: string): string[] =>
      rules
        .filter((rule) => scriptBodyElementNames(rule.selector).includes(elementName))
        .map((rule) => rule.body);

    for (const elementName of ['character', 'dialogue', 'parenthetical']) {
      const bodies = bodyFor(elementName);
      const marginLeftBody = bodies.find((body) => /\bmargin-left\s*:/.test(body));
      expect(marginLeftBody, `${elementName} is expected to declare margin-left`).toBeDefined();
      expect(marginLeftBody).toMatch(/--fd-block-indent\s*:/);
    }

    for (const elementName of ['scene_heading', 'action', 'shot']) {
      for (const body of bodyFor(elementName)) {
        expect(body).not.toMatch(/\bmargin-left\s*:/);
      }
    }

    const transitionBodies = bodyFor('transition');
    const marginRightBody = transitionBodies.find((body) => /\bmargin-right\s*:/.test(body));
    expect(marginRightBody, 'transition is expected to declare margin-right').toBeDefined();
    expect(marginRightBody).not.toMatch(/\bmargin-left\s*:/);
    expect(marginRightBody).not.toMatch(/--fd-block-indent\s*:/);
  });
});
