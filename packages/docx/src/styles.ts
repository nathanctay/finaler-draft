import type { DocumentSettings } from '@finaler-draft/screenplay';
import {
  ELEMENT_INDENTS,
  MARGIN_LEFT_IN,
  MARGIN_RIGHT_IN,
  PAGE_WIDTH_IN,
  TYPEFACE,
  TYPE_SIZE_PT,
  type ScreenplayElementKind,
} from '@finaler-draft/screenplay/pageFormat';
import { escapeXmlText } from '@finaler-draft/xml-escape';
import {
  LINE_HEIGHT_PT,
  halfPointsFromPoints,
  twentiethsOfPointFromPoints,
  twipsFromInches,
} from './units.js';

/**
 * One named paragraph style per canonical screenplay element (`progress/docx-export.md` item 4:
 * "Element semantics as named paragraph styles, one per screenplay element, so a reader can see
 * in Word that a block *is* a scene heading rather than inferring it from indentation"), plus
 * `Normal` (the base every other style chains to via `w:basedOn` -- Word's own generated
 * documents always define one, and a dangling `w:basedOn` reference is exactly the class of
 * "trimmed section" mistake `progress/fdx-export.md` warns against) and `TitlePage` (centered by
 * default; the title page's own paragraphs are built in `documentXml.ts`).
 *
 * Display names match the `Type` strings `packages/fdx` already writes ("Scene Heading",
 * "Character", ...) -- not an OOXML requirement, a deliberate consistency choice so both exports
 * present the same element vocabulary to a reader who opens both.
 */
export type ParagraphStyleId =
  | 'Normal'
  | 'SceneHeading'
  | 'Action'
  | 'Character'
  | 'Parenthetical'
  | 'Dialogue'
  | 'Transition'
  | 'Shot'
  | 'TitlePage';

export const STYLE_ID_FOR_ELEMENT: Readonly<Record<ScreenplayElementKind, ParagraphStyleId>> = {
  scene_heading: 'SceneHeading',
  action: 'Action',
  character: 'Character',
  dialogue: 'Dialogue',
  parenthetical: 'Parenthetical',
  transition: 'Transition',
  shot: 'Shot',
};

const DISPLAY_NAME_FOR_ELEMENT: Readonly<Record<ScreenplayElementKind, string>> = {
  scene_heading: 'Scene Heading',
  action: 'Action',
  character: 'Character',
  dialogue: 'Dialogue',
  parenthetical: 'Parenthetical',
  transition: 'Transition',
  shot: 'Shot',
};

/**
 * Elements displayed uppercase while the stored/exported text stays exactly as authored --
 * `<w:caps/>` (a display-only transform, ECMA-376 Part 1 section 17.3.2's run-properties
 * vocabulary; the precise sub-clause for `caps` itself was not independently pinned during this
 * package's research, unlike `sz`/`ind`/`pgSz`/`pageBreakBefore`/`jc` above it -- flagged here
 * rather than left uncited among the confirmed ones). Mirrors `packages/fdx`'s confirmed
 * `Style="AllCaps"` convention on the identical four element types, verified there against a
 * genuine Final Draft reference file: uppercase scene headings and character cues are screenplay
 * semantics, not decoration, and a display transform is the only way to apply them without
 * altering the text a writer actually typed.
 */
const ALL_CAPS_ELEMENTS: ReadonlySet<ScreenplayElementKind> = new Set([
  'scene_heading',
  'character',
  'transition',
  'shot',
]);

function requiredIndentValue(element: ScreenplayElementKind, field: 'leftIn' | 'rightIn'): number {
  const value = ELEMENT_INDENTS[element][field];
  if (value === undefined) {
    throw new Error(
      `ELEMENT_INDENTS.${element}.${field} is unset; the DOCX indent derivation is stale.`,
    );
  }
  return value;
}

export type ParagraphIndent = { leftTwips: number; rightTwips: number };
export type ParagraphAlignment = 'left' | 'right';

/**
 * Converts one element's horizontal placement from `packages/screenplay/pageFormat`'s frame --
 * inches measured from the physical page edge, per that module's own comment -- into
 * WordprocessingML's frame for `w:ind`: inches measured from the section's own margins (ECMA-376
 * Part 1 section 17.3.1.12, confirmed against the datypic ECMA-376 mirror). Converting straight
 * across without re-basing would double-count the margin -- e.g. `character`'s 3.7in-from-the-edge
 * indent would render as 3.7in *inside* a 1.5in left margin, landing at 5.2in from the edge, a
 * document that opens fine and is wrong.
 *
 * `parenthetical` has no `rightIn` in `ELEMENT_INDENTS` (only `leftIn`/`widthIn`, both from this
 * screenplay's own `documentSettings` since they're the two adjustable values plan.md names) --
 * its right-hand physical edge is derived as `PAGE_WIDTH_IN - (leftIn + widthIn)`. This formula
 * is checked directly against `dialogue`, which the specification gives both `rightIn` *and*
 * `widthIn` for independently: the derivation reproduces `dialogue`'s given `rightIn` (2.5in)
 * exactly (see `styles.test.ts`), which is the strongest available confirmation without a second
 * independent source for `parenthetical` itself.
 */
export function indentFor(
  element: ScreenplayElementKind,
  documentSettings: DocumentSettings,
): ParagraphIndent {
  switch (element) {
    case 'scene_heading':
    case 'action':
    case 'shot': {
      const leftIn = requiredIndentValue(element, 'leftIn');
      const rightIn = requiredIndentValue(element, 'rightIn');
      return {
        leftTwips: twipsFromInches(leftIn - MARGIN_LEFT_IN),
        rightTwips: twipsFromInches(rightIn - MARGIN_RIGHT_IN),
      };
    }
    case 'character':
      return {
        leftTwips: twipsFromInches(documentSettings.characterIndentIn - MARGIN_LEFT_IN),
        rightTwips: 0,
      };
    case 'dialogue': {
      const leftIn = requiredIndentValue('dialogue', 'leftIn');
      const rightIn = requiredIndentValue('dialogue', 'rightIn');
      return {
        leftTwips: twipsFromInches(leftIn - MARGIN_LEFT_IN),
        rightTwips: twipsFromInches(rightIn - MARGIN_RIGHT_IN),
      };
    }
    case 'parenthetical': {
      const leftIn = documentSettings.parentheticalIndentIn;
      const rightPhysicalIn = PAGE_WIDTH_IN - (leftIn + documentSettings.parentheticalWidthIn);
      return {
        leftTwips: twipsFromInches(leftIn - MARGIN_LEFT_IN),
        rightTwips: twipsFromInches(rightPhysicalIn - MARGIN_RIGHT_IN),
      };
    }
    case 'transition':
      // No fixed left edge in the specification (`ELEMENT_INDENTS.transition` has no `leftIn`),
      // same one-sided-indent case `packages/fdx` hit and resolved the same way: the element
      // shares the body's ordinary left margin, and `w:jc="right"` -- not the indent -- is what
      // actually positions right-aligned text.
      return { leftTwips: 0, rightTwips: 0 };
  }
}

export function alignmentFor(element: ScreenplayElementKind): ParagraphAlignment {
  return element === 'transition' ? 'right' : 'left';
}

function paragraphPropertiesXml(indent: ParagraphIndent, alignment: ParagraphAlignment): string {
  return (
    `      <w:pPr>\n` +
    `        <w:ind w:left="${indent.leftTwips}" w:right="${indent.rightTwips}"/>\n` +
    `        <w:jc w:val="${alignment}"/>\n` +
    `      </w:pPr>\n`
  );
}

function elementStyleXml(
  element: ScreenplayElementKind,
  documentSettings: DocumentSettings,
): string {
  const styleId = STYLE_ID_FOR_ELEMENT[element];
  const name = DISPLAY_NAME_FOR_ELEMENT[element];
  const indent = indentFor(element, documentSettings);
  const alignment = alignmentFor(element);
  const rPr = ALL_CAPS_ELEMENTS.has(element)
    ? '      <w:rPr>\n        <w:caps/>\n      </w:rPr>\n'
    : '';
  return (
    `    <w:style w:type="paragraph" w:styleId="${styleId}">\n` +
    `      <w:name w:val="${name}"/>\n` +
    `      <w:basedOn w:val="Normal"/>\n` +
    `      <w:qFormat/>\n` +
    paragraphPropertiesXml(indent, alignment) +
    rPr +
    `    </w:style>\n`
  );
}

const ELEMENT_ORDER: readonly ScreenplayElementKind[] = [
  'scene_heading',
  'action',
  'character',
  'dialogue',
  'parenthetical',
  'transition',
  'shot',
];

/**
 * `word/styles.xml`'s full content. `w:docDefaults` sets the screenplay typeface and type size
 * (`TYPEFACE`, `TYPE_SIZE_PT` -- "not adjustable, ever, per specification") as the run-property
 * default every style and any unstyled run inherits, so nothing in this document falls back to
 * Word's own Calibri/11pt defaults (`progress/docx-export.md` item 4: "Indents, the typeface and
 * the type size come from `packages/screenplay/pageFormat` and `documentSettings`, never from
 * Word's defaults"). `Normal` is `w:default="1"` and carries no formatting of its own -- every
 * element style is based on it and overrides only what differs, per section 17.7's `w:styles`
 * root (`docDefaults`, then `style*`, confirmed structurally against the datypic ECMA-376 mirror
 * during this package's checkpoint-1 research).
 */
export function renderStylesXml(documentSettings: DocumentSettings): string {
  const fontHalfPoints = halfPointsFromPoints(TYPE_SIZE_PT);
  const elementStyles = ELEMENT_ORDER.map((element) =>
    elementStyleXml(element, documentSettings),
  ).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n` +
    `  <w:docDefaults>\n` +
    `    <w:rPrDefault>\n` +
    `      <w:rPr>\n` +
    `        <w:rFonts w:ascii="${escapeXmlText(TYPEFACE)}" w:hAnsi="${escapeXmlText(TYPEFACE)}" w:cs="${escapeXmlText(TYPEFACE)}"/>\n` +
    `        <w:sz w:val="${fontHalfPoints}"/>\n` +
    `        <w:szCs w:val="${fontHalfPoints}"/>\n` +
    `      </w:rPr>\n` +
    `    </w:rPrDefault>\n` +
    // The line grid, stated explicitly rather than inherited. `pageFormat`'s six-lines-per-inch
    // grid is normative for this product, and a document that does not say so gets whatever line
    // height and paragraph spacing Word's own defaults supply -- which is how the title page ended
    // up rendering far taller than its line count implied. `w:lineRule="exact"` is what pins a line
    // to a fixed height instead of letting the font's natural leading set it; `before`/`after` are
    // zeroed because vertical space between screenplay elements is expressed in whole blank lines
    // (`BLANK_LINES_BEFORE`), never in paragraph spacing, so any spacing here would be added on top
    // of a gap the model has already accounted for.
    `    <w:pPrDefault>\n` +
    `      <w:pPr>\n` +
    `        <w:spacing w:before="0" w:after="0"` +
    ` w:line="${twentiethsOfPointFromPoints(LINE_HEIGHT_PT)}" w:lineRule="exact"/>\n` +
    `      </w:pPr>\n` +
    `    </w:pPrDefault>\n` +
    `  </w:docDefaults>\n` +
    `  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">\n` +
    `    <w:name w:val="Normal"/>\n` +
    `    <w:qFormat/>\n` +
    `  </w:style>\n` +
    elementStyles +
    `  <w:style w:type="paragraph" w:styleId="TitlePage">\n` +
    `    <w:name w:val="Title Page"/>\n` +
    `    <w:basedOn w:val="Normal"/>\n` +
    `    <w:qFormat/>\n` +
    `    <w:pPr>\n` +
    `      <w:jc w:val="center"/>\n` +
    `    </w:pPr>\n` +
    `  </w:style>\n` +
    `</w:styles>\n`
  );
}
