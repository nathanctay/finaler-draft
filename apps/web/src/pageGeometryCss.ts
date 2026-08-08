import {
  BLANK_LINES_BEFORE,
  BODY_WIDTH_IN,
  ELEMENT_INDENTS,
  LINE_HEIGHT_RATIO,
  MARGIN_LEFT_IN,
  MARGIN_RIGHT_IN,
  MARGIN_TOP_IN,
  PAGE_HEIGHT_IN,
  PAGE_NUMBER_RIGHT_IN,
  PAGE_NUMBER_TOP_IN,
  PAGE_WIDTH_IN,
  TYPEFACE,
  TYPE_SIZE_PT,
  type ScreenplayElementKind,
} from '@finaler-draft/screenplay/pageFormat';

const inches = (value: number): string => `${value}in`;

/**
 * CSS custom properties derived from `@finaler-draft/screenplay/pageFormat`, the single shared
 * source of the screenplay page geometry. This function is the only place in `apps/web` allowed
 * to read the specification's inch and point figures directly; `styles.css` consumes them
 * exclusively through `var(--fd-page-*)` and must never restate a number this module already
 * exports.
 *
 * Values that the specification states "from the physical page edge" (the character, dialogue,
 * parenthetical, and transition indents) are exported in that same page-edge form rather than
 * pre-subtracting the left or right margin. `styles.css` derives the offset relative to the
 * content box with `calc()` against `--fd-page-margin-left` / `--fd-page-margin-right`, so the
 * margin and the indent each have exactly one authority.
 */
export function pageGeometryCssVariables(): Readonly<Record<string, string>> {
  const character = ELEMENT_INDENTS.character;
  const dialogue = ELEMENT_INDENTS.dialogue;
  const parenthetical = ELEMENT_INDENTS.parenthetical;
  const transition = ELEMENT_INDENTS.transition;

  if (
    character.leftIn === undefined ||
    dialogue.leftIn === undefined ||
    dialogue.widthIn === undefined ||
    parenthetical.leftIn === undefined ||
    parenthetical.widthIn === undefined ||
    transition.rightIn === undefined
  ) {
    throw new Error('Screenplay page format element indents are missing an expected value.');
  }

  // One custom property per element, expressing BLANK_LINES_BEFORE as a bare number.
  // styles.css multiplies it by the line-height custom property to get a whole-line margin --
  // this module is the only place that reads the count itself, matching every other geometry
  // figure above.
  const blankLinesBeforeVariables = Object.fromEntries(
    (Object.entries(BLANK_LINES_BEFORE) as Array<[ScreenplayElementKind, number]>).map(
      ([element, lines]) => [
        `--fd-blank-lines-before-${element.replace(/_/g, '-')}`,
        String(lines),
      ],
    ),
  );

  return {
    ...blankLinesBeforeVariables,
    '--fd-page-width': inches(PAGE_WIDTH_IN),
    '--fd-page-height': inches(PAGE_HEIGHT_IN),
    '--fd-page-margin-top': inches(MARGIN_TOP_IN),
    '--fd-page-margin-right': inches(MARGIN_RIGHT_IN),
    '--fd-page-margin-left': inches(MARGIN_LEFT_IN),
    '--fd-body-width': inches(BODY_WIDTH_IN),
    '--fd-type-size': `${TYPE_SIZE_PT}pt`,
    '--fd-line-height': String(LINE_HEIGHT_RATIO),
    '--fd-typeface': `'${TYPEFACE}', monospace`,
    '--fd-page-number-top': inches(PAGE_NUMBER_TOP_IN),
    '--fd-page-number-right': inches(PAGE_NUMBER_RIGHT_IN),
    '--fd-character-indent': inches(character.leftIn),
    '--fd-dialogue-indent': inches(dialogue.leftIn),
    '--fd-dialogue-width': inches(dialogue.widthIn),
    '--fd-parenthetical-indent': inches(parenthetical.leftIn),
    '--fd-parenthetical-width': inches(parenthetical.widthIn),
    '--fd-transition-indent': inches(transition.rightIn),
  };
}

/**
 * Applies the page geometry custom properties to `target` (the document root by default). Call
 * once at application bootstrap, before the first render, so `styles.css` never observes an
 * unset `--fd-page-*` variable.
 */
export function applyPageGeometryCssVariables(
  target: HTMLElement = document.documentElement,
): void {
  const variables = pageGeometryCssVariables();
  for (const [name, value] of Object.entries(variables)) {
    target.style.setProperty(name, value);
  }
}
