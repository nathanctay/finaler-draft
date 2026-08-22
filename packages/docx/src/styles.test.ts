import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@finaler-draft/screenplay';
import { ELEMENT_INDENTS } from '@finaler-draft/screenplay/pageFormat';
import { alignmentFor, indentFor, renderStylesXml } from './styles.js';

describe('indentFor: known figures, not round-trips through this same formula', () => {
  it('scene_heading/action/shot sit exactly at the page margins (0 twips either side)', () => {
    // Their ELEMENT_INDENTS edges (1.5in left, 1.0in right) are literally MARGIN_LEFT_IN and
    // MARGIN_RIGHT_IN -- re-based onto the margin frame, that is zero indent on both sides.
    for (const element of ['scene_heading', 'action', 'shot'] as const) {
      expect(indentFor(element, DEFAULT_DOCUMENT_SETTINGS)).toEqual({
        leftTwips: 0,
        rightTwips: 0,
      });
    }
  });

  it('character indents 2.2in from the margin at the default setting (3.7in - 1.5in)', () => {
    expect(indentFor('character', DEFAULT_DOCUMENT_SETTINGS)).toEqual({
      leftTwips: 3168, // 2.2in * 1440
      rightTwips: 0,
    });
  });

  it('character honors a custom documentSettings value, not the fixed default', () => {
    const settings: DocumentSettings = { ...DEFAULT_DOCUMENT_SETTINGS, characterIndentIn: 4.0 };
    expect(indentFor('character', settings)).toEqual({
      leftTwips: 3600, // (4.0 - 1.5) * 1440
      rightTwips: 0,
    });
  });

  it('dialogue indents 1.0in left / 1.5in right from the margins', () => {
    expect(indentFor('dialogue', DEFAULT_DOCUMENT_SETTINGS)).toEqual({
      leftTwips: 1440, // (2.5 - 1.5) * 1440
      rightTwips: 2160, // (2.5 - 1.0) * 1440
    });
  });

  it('transition has no indent on either side -- jc="right" positions it, not w:ind', () => {
    expect(indentFor('transition', DEFAULT_DOCUMENT_SETTINGS)).toEqual({
      leftTwips: 0,
      rightTwips: 0,
    });
  });

  it('parenthetical at the default settings matches the fixed-spec numbers exactly', () => {
    // DEFAULT_DOCUMENT_SETTINGS.parentheticalIndentIn/parentheticalWidthIn are themselves derived
    // from ELEMENT_INDENTS.parenthetical (packages/screenplay/src/index.ts), so this is a
    // consistency check between the two packages' independent readings of the same spec values.
    expect(indentFor('parenthetical', DEFAULT_DOCUMENT_SETTINGS)).toEqual({
      leftTwips: 2304, // (3.1 - 1.5) * 1440
      rightTwips: 3456, // (8.5 - (3.1 + 2.0) - 1.0) * 1440
    });
  });

  it('parenthetical honors custom documentSettings for both left and width', () => {
    const settings: DocumentSettings = {
      ...DEFAULT_DOCUMENT_SETTINGS,
      parentheticalIndentIn: 3.5,
      parentheticalWidthIn: 1.5,
    };
    expect(indentFor('parenthetical', settings)).toEqual({
      leftTwips: 2880, // (3.5 - 1.5) * 1440
      rightTwips: 3600, // (8.5 - (3.5 + 1.5) - 1.0) * 1440
    });
  });

  // The strongest available check on the parenthetical right-edge derivation (no `rightIn` is
  // given for it in ELEMENT_INDENTS, only `leftIn`/`widthIn`): apply the identical
  // `PAGE_WIDTH_IN - (leftIn + widthIn)` formula to `dialogue`, which the specification *does*
  // give both `rightIn` and `widthIn` for independently, and confirm it reproduces `dialogue`'s
  // own stated `rightIn` exactly. This is the same style of check `packages/fdx`'s progress log
  // used: find the case where the source states the answer and confirm the formula reproduces it.
  it('the right-edge-from-width formula reproduces a value the specification states directly', () => {
    const dialogue = ELEMENT_INDENTS.dialogue;
    const leftIn = dialogue.leftIn;
    const widthIn = dialogue.widthIn;
    const statedRightIn = dialogue.rightIn;
    if (leftIn === undefined || widthIn === undefined || statedRightIn === undefined) {
      throw new Error('ELEMENT_INDENTS.dialogue is missing a field this cross-check depends on.');
    }
    const derivedRightIn = 8.5 - (leftIn + widthIn); // PAGE_WIDTH_IN inlined to keep this test
    // independent of a constant the implementation also imports.
    expect(derivedRightIn).toBe(statedRightIn);
  });
});

describe('alignmentFor', () => {
  it('right-aligns only transition', () => {
    expect(alignmentFor('transition')).toBe('right');
    for (const element of [
      'scene_heading',
      'action',
      'character',
      'dialogue',
      'parenthetical',
      'shot',
    ] as const) {
      expect(alignmentFor(element)).toBe('left');
    }
  });
});

describe('renderStylesXml', () => {
  const xml = renderStylesXml(DEFAULT_DOCUMENT_SETTINGS);

  it('declares the WordprocessingML namespace on the root element', () => {
    expect(xml).toContain(
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    );
  });

  it('sets Courier Prime and 24 half-points (12pt) as the document default font', () => {
    expect(xml).toContain(
      '<w:rFonts w:ascii="Courier Prime" w:hAnsi="Courier Prime" w:cs="Courier Prime"/>',
    );
    expect(xml).toContain('<w:sz w:val="24"/>');
    expect(xml).toContain('<w:szCs w:val="24"/>');
  });

  it('defines Normal as the default paragraph style with no basedOn (it is the base)', () => {
    const normalStyle = xml.match(
      /<w:style w:type="paragraph" w:styleId="Normal"[^>]*>[\s\S]*?<\/w:style>/,
    );
    expect(normalStyle).not.toBeNull();
    expect(normalStyle?.[0]).toContain('w:default="1"');
    expect(normalStyle?.[0]).not.toContain('w:basedOn');
  });

  it('defines one named style per screenplay element, based on Normal', () => {
    for (const styleId of [
      'SceneHeading',
      'Action',
      'Character',
      'Parenthetical',
      'Dialogue',
      'Transition',
      'Shot',
    ]) {
      const style = xml.match(
        new RegExp(`<w:style w:type="paragraph" w:styleId="${styleId}">[\\s\\S]*?</w:style>`),
      );
      expect(style, `expected a ${styleId} style`).not.toBeNull();
      expect(style?.[0]).toContain('<w:basedOn w:val="Normal"/>');
    }
  });

  it('applies w:caps to exactly Scene Heading, Character, Transition, and Shot', () => {
    const capsStyles = ['SceneHeading', 'Character', 'Transition', 'Shot'];
    const noCapsStyles = ['Action', 'Parenthetical', 'Dialogue'];
    for (const styleId of capsStyles) {
      const style = xml.match(
        new RegExp(`<w:style w:type="paragraph" w:styleId="${styleId}">[\\s\\S]*?</w:style>`),
      );
      expect(style?.[0], `${styleId} should have w:caps`).toContain('<w:caps/>');
    }
    for (const styleId of noCapsStyles) {
      const style = xml.match(
        new RegExp(`<w:style w:type="paragraph" w:styleId="${styleId}">[\\s\\S]*?</w:style>`),
      );
      expect(style?.[0], `${styleId} should not have w:caps`).not.toContain('<w:caps/>');
    }
  });

  it('centers TitlePage by default', () => {
    const titlePageStyle = xml.match(
      /<w:style w:type="paragraph" w:styleId="TitlePage">[\s\S]*?<\/w:style>/,
    );
    expect(titlePageStyle?.[0]).toContain('<w:jc w:val="center"/>');
  });

  it('reflects a custom documentSettings value in the emitted Character/Parenthetical indents', () => {
    const custom = renderStylesXml({ ...DEFAULT_DOCUMENT_SETTINGS, characterIndentIn: 4.0 });
    const characterStyle = custom.match(
      /<w:style w:type="paragraph" w:styleId="Character">[\s\S]*?<\/w:style>/,
    );
    expect(characterStyle?.[0]).toContain('w:left="3600"'); // (4.0 - 1.5) * 1440
  });
});

/**
 * The line grid has to be stated in the document, not inherited. Word applies its own line height
 * and paragraph spacing to anything a document leaves unspecified, and `pageFormat`'s
 * six-lines-per-inch grid is normative for this product -- so without this, a run of blank lines
 * renders far taller than its line count implies. That is not a title-page detail: it changes every
 * vertical measurement in the document, and it is what made the first Word-opened export show a
 * title roughly two inches lower than the model puts it.
 */
describe('renderStylesXml: the line grid is stated, not inherited', () => {
  it('pins a line to exactly one sixth of an inch and zeroes paragraph spacing', () => {
    const xml = renderStylesXml(DEFAULT_DOCUMENT_SETTINGS);

    // 240 twentieths of a point is 12pt is 1/6in, derived from LINES_PER_INCH rather than assumed
    // from the type size, which is 12pt for an unrelated reason.
    expect(xml).toContain('<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="exact"/>');

    // `exact` is the part that actually pins it: `auto` would let the font's natural leading set
    // the height, which is what the default behaviour already did.
    expect(xml).toContain('w:lineRule="exact"');

    // It must live in docDefaults so every paragraph inherits it, including the blank ones that
    // carry no style of their own.
    const defaults = xml.slice(xml.indexOf('<w:docDefaults>'), xml.indexOf('</w:docDefaults>'));
    expect(defaults).toContain('<w:pPrDefault>');
    expect(defaults).toContain('w:lineRule="exact"');
  });
});
