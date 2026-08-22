import { describe, expect, it } from 'vitest';
import type { ScreenplayBlock } from '@finaler-draft/screenplay';
import { minimalScreenplayFixture, screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { screenplayToDocx } from './index.js';
import {
  actionBlock,
  characterBlock,
  dialogueBlock,
  docxDocumentXml,
  docxPart,
  dualDialogueBlock,
  pageBreakBlock,
  paragraphsWithStyle,
  parentheticalBlock,
  sceneHeadingBlock,
  screenplayWith,
  shotBlock,
  titlePageWith,
  transitionBlock,
  unzipDocx,
} from './testFixtures.js';

describe('screenplayToDocx: OPC package structure', () => {
  it('contains exactly the five required parts, nothing more', () => {
    const bytes = screenplayToDocx(minimalScreenplayFixture);
    const parts = unzipDocx(bytes);
    expect(Object.keys(parts).sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'word/document.xml',
        'word/styles.xml',
        'word/_rels/document.xml.rels',
      ].sort(),
    );
  });

  it('[Content_Types].xml declares overrides for document.xml and styles.xml', () => {
    const bytes = screenplayToDocx(minimalScreenplayFixture);
    const contentTypes = docxPart(bytes, '[Content_Types].xml');
    expect(contentTypes).toContain(
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    );
    expect(contentTypes).toContain(
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    );
  });

  it('_rels/.rels points the package root at word/document.xml', () => {
    const rootRels = docxPart(screenplayToDocx(minimalScreenplayFixture), '_rels/.rels');
    expect(rootRels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"',
    );
    expect(rootRels).toContain('Target="word/document.xml"');
  });

  it('word/_rels/document.xml.rels points the document part at styles.xml', () => {
    const documentRels = docxPart(
      screenplayToDocx(minimalScreenplayFixture),
      'word/_rels/document.xml.rels',
    );
    expect(documentRels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"',
    );
    expect(documentRels).toContain('Target="styles.xml"');
  });

  it('document.xml declares the WordprocessingML namespace on its root element', () => {
    const documentXml = docxDocumentXml(screenplayToDocx(minimalScreenplayFixture));
    expect(documentXml).toContain(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    );
  });

  it('sets the page size and margins from pageFormat, in twips', () => {
    const documentXml = docxDocumentXml(screenplayToDocx(minimalScreenplayFixture));
    // 8.5in / 11in Letter, 1.5in left / 1.0in right / 1.0in top / 1.0in nominal bottom margin.
    expect(documentXml).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
    expect(documentXml).toContain(
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="2160" w:gutter="0"/>',
    );
  });
});

describe('screenplayToDocx: determinism', () => {
  it('produces byte-identical output for the same screenplay called twice', () => {
    // The property the fixed zip mtime exists to protect: a future server-side export of a
    // historical revision must produce identical bytes for identical input, not merely
    // output that looks the same on each call.
    const first = screenplayToDocx(screenplayFixture);
    const second = screenplayToDocx(screenplayFixture);
    expect(Buffer.from(second)).toEqual(Buffer.from(first));
  });
});

describe('screenplayToDocx: element mapping', () => {
  const elementCases: Array<{
    block: ScreenplayBlock;
    styleId: string;
    expectedText: string;
  }> = [
    {
      block: sceneHeadingBlock('a', 'INT. HOUSE - DAY'),
      styleId: 'SceneHeading',
      expectedText: 'INT. HOUSE - DAY',
    },
    { block: actionBlock('b', 'She walks in.'), styleId: 'Action', expectedText: 'She walks in.' },
    { block: characterBlock('c', 'JANE'), styleId: 'Character', expectedText: 'JANE' },
    { block: dialogueBlock('d', 'Hello.'), styleId: 'Dialogue', expectedText: 'Hello.' },
    { block: parentheticalBlock('e', '(beat)'), styleId: 'Parenthetical', expectedText: '(beat)' },
    { block: transitionBlock('f', 'CUT TO:'), styleId: 'Transition', expectedText: 'CUT TO:' },
    { block: shotBlock('g', 'CLOSE ON JANE'), styleId: 'Shot', expectedText: 'CLOSE ON JANE' },
  ];

  it.each(elementCases)(
    '$styleId maps to its own named style with the block text',
    ({ block, styleId, expectedText }) => {
      const documentXml = docxDocumentXml(screenplayToDocx(screenplayWith([block])));
      const paragraphs = paragraphsWithStyle(documentXml, styleId);
      expect(paragraphs).toHaveLength(1);
      expect(paragraphs[0]).toContain(`<w:t xml:space="preserve">${expectedText}</w:t>`);
    },
  );

  it('renders an empty-text block as a paragraph with no run', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(screenplayWith([actionBlock('empty', '')])),
    );
    const [paragraph] = paragraphsWithStyle(documentXml, 'Action');
    expect(paragraph).toBeDefined();
    expect(paragraph).not.toContain('<w:r>');
  });

  it('appends the scene number as trailing run text when present, omits it when absent', () => {
    const withNumber = docxDocumentXml(
      screenplayToDocx(screenplayWith([sceneHeadingBlock('a', 'INT. HOUSE - DAY', '12A')])),
    );
    const [paragraphWithNumber] = paragraphsWithStyle(withNumber, 'SceneHeading');
    expect(paragraphWithNumber).toContain('<w:t xml:space="preserve">  (scene 12A)</w:t>');

    const withoutNumber = docxDocumentXml(
      screenplayToDocx(screenplayWith([sceneHeadingBlock('a', 'INT. HOUSE - DAY')])),
    );
    const [paragraphWithoutNumber] = paragraphsWithStyle(withoutNumber, 'SceneHeading');
    expect(paragraphWithoutNumber).not.toContain('(scene');
  });

  it('throws on an unrecognized block type rather than skipping it silently', () => {
    const bogusBlock = { id: 'x', type: 'not_a_real_type' } as unknown as ScreenplayBlock;
    expect(() => screenplayToDocx(screenplayWith([bogusBlock]))).toThrow(
      /cannot represent unknown block type/,
    );
  });
});

describe('screenplayToDocx: escaping and whitespace preservation', () => {
  it('escapes the five XML metacharacters in authored text', () => {
    const hostile = `She said "run" & didn't <stop>.`;
    const documentXml = docxDocumentXml(
      screenplayToDocx(screenplayWith([actionBlock('a', hostile)])),
    );
    const [paragraph] = paragraphsWithStyle(documentXml, 'Action');
    expect(paragraph).toContain('She said &quot;run&quot; &amp; didn&apos;t &lt;stop&gt;.');
    // Scoped to the run's own <w:t> content, not the whole paragraph -- the paragraph's
    // surrounding markup (<w:p>, <w:pPr>, <w:pStyle .../>) legitimately contains `<`, `>`, and
    // `"` as real XML syntax, so asserting against the whole paragraph string would be exactly
    // the document-wide-assertion-standing-in-for-a-local-property mistake progress/fdx-
    // export.md's log records.
    const runText = paragraph?.match(/<w:t xml:space="preserve">([\s\S]*?)<\/w:t>/)?.[1];
    expect(runText).toBeDefined();
    expect(runText).not.toMatch(/[<>"']|&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('preserves leading and trailing spaces via xml:space="preserve", round-tripped through unzip', () => {
    // plan.md: authored text is preserved exactly, never normalised. Word trims leading/trailing
    // run-text whitespace unless xml:space="preserve" is present -- silent corruption no
    // structural assertion elsewhere in this suite would catch.
    const spaced = '   leading and trailing   ';
    const documentXml = docxDocumentXml(
      screenplayToDocx(screenplayWith([actionBlock('a', spaced)])),
    );
    const [paragraph] = paragraphsWithStyle(documentXml, 'Action');
    expect(paragraph).toContain(`<w:t xml:space="preserve">${spaced}</w:t>`);
  });
});

describe('screenplayToDocx: page breaks', () => {
  it('attaches pageBreakBefore to the paragraph immediately following a page_break block', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(
        screenplayWith([
          actionBlock('a', 'before'),
          pageBreakBlock('pb'),
          actionBlock('b', 'after'),
        ]),
      ),
    );
    const paragraphs = paragraphsWithStyle(documentXml, 'Action');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).not.toContain('<w:pageBreakBefore/>');
    expect(paragraphs[1]).toContain('<w:pageBreakBefore/>');
  });

  it('collapses consecutive page_break blocks to a single pageBreakBefore', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(
        screenplayWith([
          actionBlock('a', 'before'),
          pageBreakBlock('pb1'),
          pageBreakBlock('pb2'),
          actionBlock('b', 'after'),
        ]),
      ),
    );
    const [, afterParagraph] = paragraphsWithStyle(documentXml, 'Action');
    const occurrences = afterParagraph?.match(/<w:pageBreakBefore\/>/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('renders nothing extra for a trailing page_break with no following block', () => {
    const withTrailing = docxDocumentXml(
      screenplayToDocx(screenplayWith([actionBlock('a', 'only'), pageBreakBlock('pb')])),
    );
    const withoutTrailing = docxDocumentXml(
      screenplayToDocx(screenplayWith([actionBlock('a', 'only')])),
    );
    expect(paragraphsWithStyle(withTrailing, 'Action')).toEqual(
      paragraphsWithStyle(withoutTrailing, 'Action'),
    );
  });

  it('gives a dual_dialogue table pageBreakBefore on its own first cell paragraph', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(screenplayWith([pageBreakBlock('pb'), dualDialogueBlock('dd')])),
    );
    const allCharacterParagraphs = paragraphsWithStyle(documentXml, 'Character');
    expect(allCharacterParagraphs).toHaveLength(2); // left column's Character, right column's Character
    expect(allCharacterParagraphs[0]).toContain('<w:pageBreakBefore/>');
    // Only the first paragraph of the left column carries it, not every paragraph in the table.
    const breakCount = allCharacterParagraphs.filter((p) =>
      p.includes('<w:pageBreakBefore/>'),
    ).length;
    expect(breakCount).toBe(1);
  });
});

describe('screenplayToDocx: title page', () => {
  it('forces the first script paragraph onto a new page after a title page, with no explicit page_break', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(
        screenplayWith([actionBlock('a', 'first')], {
          titlePages: [titlePageWith({ title: 'T' })],
        }),
      ),
    );
    const [firstAction] = paragraphsWithStyle(documentXml, 'Action');
    expect(firstAction).toContain('<w:pageBreakBefore/>');
  });

  it('does not force a page break on the first paragraph when there is no title page', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(screenplayWith([actionBlock('a', 'first')])),
    );
    const [firstAction] = paragraphsWithStyle(documentXml, 'Action');
    expect(firstAction).not.toContain('<w:pageBreakBefore/>');
  });

  it('renders the title with caps and underline emphasis, credit and authors plainly', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(
        screenplayWith([], {
          titlePages: [
            titlePageWith({
              title: 'The Long Way Home',
              credit: 'written by',
              authors: ['A. Writer'],
            }),
          ],
        }),
      ),
    );
    const titleParagraphs = paragraphsWithStyle(documentXml, 'TitlePage').filter((p) =>
      p.includes('The Long Way Home'),
    );
    expect(titleParagraphs).toHaveLength(1);
    expect(titleParagraphs[0]).toContain('<w:caps/>');
    expect(titleParagraphs[0]).toContain('<w:u w:val="single"/>');
    expect(documentXml).toContain('<w:t xml:space="preserve">written by</w:t>');
    expect(documentXml).toContain('<w:t xml:space="preserve">A. Writer</w:t>');
  });

  it('renders source and draftDate when present', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(
        screenplayWith([], {
          titlePages: [titlePageWith({ source: 'based on true events', draftDate: 'Third Draft' })],
        }),
      ),
    );
    expect(documentXml).toContain('<w:t xml:space="preserve">based on true events</w:t>');
    expect(documentXml).toContain('<w:t xml:space="preserve">Third Draft</w:t>');
  });

  it('joins a multi-line contact block into one right-aligned paragraph with w:br between lines', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(
        screenplayWith([], {
          titlePages: [titlePageWith({ contact: ['123 Main St', 'jane@example.com'] })],
        }),
      ),
    );
    const contactParagraphs = paragraphsWithStyle(documentXml, 'TitlePage').filter((p) =>
      p.includes('123 Main St'),
    );
    expect(contactParagraphs).toHaveLength(1);
    const [contactParagraph] = contactParagraphs;
    expect(contactParagraph).toContain('w:jc w:val="right"');
    expect(contactParagraph).toContain(
      '<w:t xml:space="preserve">123 Main St</w:t>\n        <w:br/>\n        <w:t xml:space="preserve">jane@example.com</w:t>',
    );
    // Not FDX's convention: a literal embedded newline inside one <w:t> would not render as a
    // line break in WordprocessingML at all.
    expect(contactParagraph).not.toContain('123 Main St\njane@example.com');
  });

  it('omits any TitlePage-styled paragraph entirely when there are no title pages', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(screenplayWith([actionBlock('a', 'only')])),
    );
    expect(paragraphsWithStyle(documentXml, 'TitlePage')).toHaveLength(0);
  });

  it('throws when given more than one title page', () => {
    const screenplay = screenplayWith([], {
      titlePages: [
        titlePageWith({ title: 'One' }),
        titlePageWith({ id: 'a-different-id', title: 'Two' }),
      ],
    });
    expect(() => screenplayToDocx(screenplay)).toThrow(/at most one title page/);
  });
});

describe('screenplayToDocx: dual_dialogue', () => {
  it("renders a two-column borderless table, left column's blocks before right's", () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(screenplayWith([dualDialogueBlock('dd')])),
    );
    expect(documentXml).toContain('<w:tbl>');
    expect(documentXml).toContain('w:val="nil"'); // borderless table
    const adaIndex = documentXml.indexOf('ADA');
    const milesIndex = documentXml.indexOf('MILES');
    expect(adaIndex).toBeGreaterThan(-1);
    expect(milesIndex).toBeGreaterThan(-1);
    expect(adaIndex).toBeLessThan(milesIndex);
  });

  it('gives each column cell paragraph a zeroed indent, overriding the named style default', () => {
    const documentXml = docxDocumentXml(
      screenplayToDocx(screenplayWith([dualDialogueBlock('dd')])),
    );
    const characterParagraphs = paragraphsWithStyle(documentXml, 'Character');
    for (const paragraph of characterParagraphs) {
      expect(paragraph).toContain('<w:ind w:left="0" w:right="0"/>');
    }
  });
});

describe('screenplayToDocx: annotations never enter the flow', () => {
  it('produces byte-identical output whether or not the screenplay carries an annotation', () => {
    const withAnnotation = screenplayFixture;
    const withoutAnnotation = { ...screenplayFixture, annotations: [] };
    expect(withAnnotation.annotations.length).toBeGreaterThan(0); // guard: the fixture must
    // actually carry one, or this test would pass vacuously.
    expect(Buffer.from(screenplayToDocx(withAnnotation))).toEqual(
      Buffer.from(screenplayToDocx(withoutAnnotation)),
    );
  });
});
