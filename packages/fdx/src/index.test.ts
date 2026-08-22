import { describe, expect, it } from 'vitest';
import type { ScreenplayBlock } from '@finaler-draft/screenplay';
import { minimalScreenplayFixture, screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { screenplayToFdx } from './index.js';
import {
  actionBlock,
  characterBlock,
  dialogueBlock,
  dualDialogueBlock,
  pageBreakBlock,
  parentheticalBlock,
  readReferenceFixture,
  sceneHeadingBlock,
  screenplayWith,
  shotBlock,
  titlePageWith,
  transitionBlock,
} from './testFixtures.js';

// Every test in this file that makes a claim about what real FDX looks like checks that claim
// against `readReferenceFixture()` (a genuine Final Draft 13 file, see testFixtures.ts and
// packages/fdx/fixtures/README.md) rather than asserting a remembered transcription of it. The
// package's first version was built from third-party sources only and produced a document Final
// Draft rejected outright -- these tests exist so that regression cannot happen silently again.

describe('screenplayToFdx: document shell matches the FD13 reference', () => {
  it('emits the reference file XML declaration exactly', () => {
    const reference = readReferenceFixture();
    const declarationLine = reference.split('\n')[0];
    const xml = screenplayToFdx(minimalScreenplayFixture);
    expect(xml.split('\n')[0]).toBe(declarationLine);
  });

  it('emits the reference file root element exactly, including Version="6"', () => {
    const reference = readReferenceFixture();
    expect(reference).toContain('<FinalDraft DocumentType="Script" Template="No" Version="6">');
    const xml = screenplayToFdx(minimalScreenplayFixture);
    expect(xml).toContain('<FinalDraft DocumentType="Script" Template="No" Version="6">');
  });

  it('renders an empty <Content> for a screenplay with no blocks, and omits <TitlePage> entirely', () => {
    const xml = screenplayToFdx(minimalScreenplayFixture);
    expect(xml).toContain('<Content>\n  </Content>');
    expect(xml).not.toContain('<TitlePage>');
  });

  it('ends with a single trailing newline after </FinalDraft>, matching the reference', () => {
    const reference = readReferenceFixture();
    expect(reference.endsWith('</FinalDraft>\n')).toBe(true);
    expect(reference.endsWith('</FinalDraft>\n\n')).toBe(false);
    const xml = screenplayToFdx(minimalScreenplayFixture);
    expect(xml.endsWith('</FinalDraft>\n')).toBe(true);
    expect(xml.endsWith('</FinalDraft>\n\n')).toBe(false);
  });
});

describe('screenplayToFdx: body paragraph shape matches the FD13 reference', () => {
  // Attribute *names and order* -- Alignment, LeftIndent, [Number], [StartsNewPage], Type, id --
  // are read directly from the reference for every one of these types. The reference's own
  // LeftIndent *values* are Final Draft's out-of-the-box defaults for an unmodified script and are
  // deliberately not asserted here where they'd conflict with our own specification (character and
  // parenthetical indents come from `documentSettings`, not from Final Draft's defaults) --
  // see index.ts's own comment on `bodyParagraphStyleFor`.
  const referenceAttributeOrder =
    /Alignment="[^"]*" LeftIndent="[^"]*"(?: Number="[^"]*")?(?: StartsNewPage="[^"]*")? Type="[^"]*" id="[^"]*"/;

  it.each([
    ['Scene Heading', 'INT. HOUSE - DAY', true],
    ['Action', 'She walks in.', false],
    ['Character', 'ADA', true],
    ['Parenthetical', '(quietly)', false],
    ['Dialogue', 'Hello.', false],
    ['Transition', 'CUT TO:', true],
    ['Shot', 'CLOSE ON the door.', true],
  ] as const)(
    '%s: attribute order and AllCaps style match the reference',
    (type, text, allCaps) => {
      const reference = readReferenceFixture();
      const referenceParagraph = new RegExp(`<Paragraph [^>]*Type="${type}"[^>]*>`).exec(reference);
      expect(referenceParagraph, `reference file has no ${type} paragraph`).not.toBeNull();
      expect(referenceParagraph![0]).toMatch(referenceAttributeOrder);
      if (allCaps) {
        const referenceText = new RegExp(`Type="${type}"[^>]*>\\s*<Text Style="([^"]*)"`).exec(
          reference,
        );
        expect(referenceText, `reference ${type} has no styled Text`).not.toBeNull();
        expect(referenceText![1]).toContain('AllCaps');
      }

      const block = ((): ScreenplayBlock => {
        switch (type) {
          case 'Scene Heading':
            return sceneHeadingBlock('b0', text);
          case 'Action':
            return actionBlock('b0', text);
          case 'Character':
            return characterBlock('b0', text);
          case 'Parenthetical':
            return parentheticalBlock('b0', text);
          case 'Dialogue':
            return dialogueBlock('b0', text);
          case 'Transition':
            return transitionBlock('b0', text);
          case 'Shot':
            return shotBlock('b0', text);
        }
      })();
      const xml = screenplayToFdx(screenplayWith([block]));
      const ownParagraph = new RegExp(`<Paragraph [^>]*Type="${type}"[^>]*>`).exec(xml);
      expect(ownParagraph, `our own output has no ${type} paragraph`).not.toBeNull();
      expect(ownParagraph![0]).toMatch(referenceAttributeOrder);
      expect(ownParagraph![0]).toContain(`id="b0"`);
      if (allCaps) {
        expect(xml).toContain(`Style="AllCaps">${text}</Text>`);
      } else {
        expect(xml).not.toMatch(new RegExp(`Type="${type}"[^>]*>\\s*<Text Style=`));
      }
    },
  );

  it('uses the canonical block id as the FDX paragraph id', () => {
    const xml = screenplayToFdx(
      screenplayWith([actionBlock('11111111-1111-4111-8111-111111111111', 'Hello.')]),
    );
    expect(xml).toContain('id="11111111-1111-4111-8111-111111111111"');
  });

  it('self-closes an empty block with no <Text> child at all, matching the reference exactly', () => {
    // The reference's own empty paragraph: a Character block with nothing typed into it.
    const reference = readReferenceFixture();
    expect(reference).toContain(
      '<Paragraph Alignment="Left" LeftIndent="3.50" Type="Character" id="a21af62a-4f6f-4674-83e2-e93a33f8f7be"/>',
    );
    // Confirm it is genuinely self-closed, not an empty-Text paragraph in disguise.
    expect(reference).not.toContain(
      '<Paragraph Alignment="Left" LeftIndent="3.50" Type="Character" id="a21af62a-4f6f-4674-83e2-e93a33f8f7be">\n',
    );

    const xml = screenplayToFdx(screenplayWith([actionBlock('a0', '')]));
    expect(xml).toContain(
      '<Paragraph Alignment="Left" LeftIndent="1.50" Type="Action" id="a0"/>\n',
    );
    expect(xml).not.toContain('<Text></Text>');
  });

  it('omits the Number attribute entirely when a scene heading has no scene number', () => {
    const xml = screenplayToFdx(screenplayWith([sceneHeadingBlock('s0', 'INT. HOUSE - DAY')]));
    expect(xml).toContain(
      '<Paragraph Alignment="Left" LeftIndent="1.50" Type="Scene Heading" id="s0">',
    );
    // Scoped to the paragraph, not the whole document: `MoresAndContinueds` legitimately contains
    // `ContinuedNumber="No"`, so a document-wide `not.toContain('Number=')` fails on an unrelated
    // element. The property under test is that *this paragraph* carries no scene number.
    const paragraph = xml.slice(xml.indexOf('<Paragraph'), xml.indexOf('</Paragraph>'));
    expect(paragraph).not.toContain('Number=');
  });

  it('places Number between LeftIndent and StartsNewPage/Type, matching alphabetical attribute order', () => {
    const xml = screenplayToFdx(
      screenplayWith([pageBreakBlock('pb0'), sceneHeadingBlock('s0', 'INT. HOUSE - DAY', '4')]),
    );
    expect(xml).toContain(
      '<Paragraph Alignment="Left" LeftIndent="1.50" Number="4" StartsNewPage="Yes" ' +
        'Type="Scene Heading" id="s0">',
    );
  });

  it('throws on an unrecognized block type instead of silently skipping it', () => {
    const bogusBlock = { id: 'x0', type: 'bogus' } as unknown as ScreenplayBlock;
    expect(() =>
      screenplayToFdx(screenplayWith([actionBlock('a0', 'Before.'), bogusBlock])),
    ).toThrow(/cannot represent unknown block type/);
  });
});

describe('screenplayToFdx: character/parenthetical indents come from documentSettings, not FD13 defaults', () => {
  it("uses this specification's own character and parenthetical indents, not the reference file's", () => {
    const reference = readReferenceFixture();
    // The reference (an out-of-the-box FD13 script) uses Final Draft's own defaults, 3.50/3.00 --
    // deliberately different from ours (3.70/3.10, packages/screenplay/src/pageFormat.ts). Taking
    // the reference's *structure* does not mean taking its *values* for document-specific fields.
    expect(reference).toContain('LeftIndent="3.50" Type="Character"');
    expect(reference).toContain('LeftIndent="3.00" Type="Parenthetical"');

    const xml = screenplayToFdx(
      screenplayWith([characterBlock('c0', 'ADA'), parentheticalBlock('p0', '(quietly)')]),
    );
    expect(xml).toContain('LeftIndent="3.70" Type="Character"');
    expect(xml).toContain('LeftIndent="3.10" Type="Parenthetical"');
  });

  it('reflects a custom characterIndentIn/parentheticalIndentIn from documentSettings', () => {
    const xml = screenplayToFdx(
      screenplayWith([characterBlock('c0', 'ADA'), parentheticalBlock('p0', '(quietly)')], {
        documentSettings: {
          characterIndentIn: 4.1,
          parentheticalIndentIn: 3.6,
          parentheticalWidthIn: 1.8,
          pageNumberStyle: 'arabic',
          sceneNumbersEnabled: false,
          autoMoreContinued: true,
        },
      }),
    );
    expect(xml).toContain('LeftIndent="4.10" Type="Character"');
    expect(xml).toContain('LeftIndent="3.60" Type="Parenthetical"');
  });
});

describe('screenplayToFdx: dual_dialogue mapping (unverified against FD13 -- see index.ts)', () => {
  it('has no DualDialogue example in the reference file, confirming this remains unverified', () => {
    expect(readReferenceFixture()).not.toContain('DualDialogue');
  });

  it('wraps the left column then the right column, in order, inside an untyped Paragraph', () => {
    const xml = screenplayToFdx(screenplayWith([dualDialogueBlock('dd0')]));
    const dualDialogueIndex = xml.indexOf('<DualDialogue>');
    expect(dualDialogueIndex).toBeGreaterThan(-1);
    const dualDialogueSection = xml.slice(dualDialogueIndex, xml.indexOf('</DualDialogue>'));
    expect(dualDialogueSection.indexOf('ADA')).toBeLessThan(dualDialogueSection.indexOf('MILES'));
    expect(dualDialogueSection).toContain('<Text>You made it.</Text>');
    expect(dualDialogueSection).toContain('<Text>The train was late.</Text>');
    expect(xml).toContain('<Paragraph id="dd0">\n      <DualDialogue>');
  });

  it("uses the dual_dialogue block's own id on the wrapping Paragraph", () => {
    const xml = screenplayToFdx(
      screenplayWith([dualDialogueBlock('22222222-2222-4222-8222-222222222222')]),
    );
    expect(xml).toContain('<Paragraph id="22222222-2222-4222-8222-222222222222">');
  });
});

describe('screenplayToFdx: page_break mapping', () => {
  it('attaches StartsNewPage="Yes" to the paragraph immediately following a page_break', () => {
    const xml = screenplayToFdx(
      screenplayWith([
        actionBlock('a0', 'Before.'),
        pageBreakBlock('pb0'),
        actionBlock('a1', 'After.'),
      ]),
    );
    expect(xml).toContain(
      '<Paragraph Alignment="Left" LeftIndent="1.50" Type="Action" id="a0">\n      <Text>Before.</Text>',
    );
    expect(xml).toContain(
      '<Paragraph Alignment="Left" LeftIndent="1.50" StartsNewPage="Yes" Type="Action" id="a1">\n      <Text>After.</Text>',
    );
    expect(xml.match(/StartsNewPage/g)).toHaveLength(1);
  });

  it('collapses consecutive page_break blocks to a single StartsNewPage="Yes"', () => {
    const xml = screenplayToFdx(
      screenplayWith([
        actionBlock('a0', 'Before.'),
        pageBreakBlock('pb0'),
        pageBreakBlock('pb1'),
        pageBreakBlock('pb2'),
        actionBlock('a1', 'After.'),
      ]),
    );
    expect(xml.match(/StartsNewPage/g)).toHaveLength(1);
    expect(xml).toContain(
      '<Paragraph Alignment="Left" LeftIndent="1.50" StartsNewPage="Yes" Type="Action" id="a1">\n      <Text>After.</Text>',
    );
  });

  it('attaches StartsNewPage="Yes" to a dual_dialogue block that follows a page_break', () => {
    const xml = screenplayToFdx(screenplayWith([pageBreakBlock('pb0'), dualDialogueBlock('dd0')]));
    expect(xml).toContain('<Paragraph StartsNewPage="Yes" id="dd0">\n      <DualDialogue>');
  });

  it('renders nothing for a trailing page_break with no following block', () => {
    const xml = screenplayToFdx(screenplayWith([actionBlock('a0', 'Only content.')]));
    const withTrailingBreak = screenplayToFdx(
      screenplayWith([actionBlock('a0', 'Only content.'), pageBreakBlock('pb0')]),
    );
    expect(withTrailingBreak).toBe(xml);
  });

  it('renders an empty Content for a screenplay containing only a page_break', () => {
    const xml = screenplayToFdx(screenplayWith([pageBreakBlock('pb0')]));
    expect(xml).toContain('<Content>\n  </Content>');
  });
});

describe('screenplayToFdx: title page matches the FD13 reference structure', () => {
  it('uses Type="Title Paragraph" and the reference\'s fixed paragraph attributes, verbatim', () => {
    const reference = readReferenceFixture();
    const fixedAttrs =
      'FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" ' +
      'SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph"';
    expect(reference).toContain(fixedAttrs);

    const xml = screenplayToFdx(
      screenplayWith([actionBlock('a0', 'Body.')], {
        titlePages: [titlePageWith({ title: 'SCRIPT TITLE' })],
      }),
    );
    expect(xml).toContain(fixedAttrs);
  });

  it('gives the title line Style="Underline+AllCaps", matching the reference exactly', () => {
    const reference = readReferenceFixture();
    expect(reference).toContain(
      '<Text Font="Courier Final Draft" Size="12" Style="Underline+AllCaps">Script Title</Text>',
    );

    const xml = screenplayToFdx(
      screenplayWith([actionBlock('a0', 'Body.')], {
        titlePages: [titlePageWith({ title: 'Script Title' })],
      }),
    );
    expect(xml).toContain(
      '<Text Font="Courier Final Draft" Size="12" Style="Underline+AllCaps">Script Title</Text>',
    );
  });

  it('gives credit/author/source no Style attribute, matching the reference exactly', () => {
    const reference = readReferenceFixture();
    expect(reference).toContain('<Text Font="Courier Final Draft" Size="12">Written by</Text>');
    expect(reference).toContain(
      '<Text Font="Courier Final Draft" Size="12">Name of First Writer</Text>',
    );

    const xml = screenplayToFdx(
      screenplayWith([actionBlock('a0', 'Body.')], {
        titlePages: [titlePageWith({ credit: 'Written by', authors: ['Name of First Writer'] })],
      }),
    );
    expect(xml).toContain('<Text Font="Courier Final Draft" Size="12">Written by</Text>');
    expect(xml).toContain('<Text Font="Courier Final Draft" Size="12">Name of First Writer</Text>');
  });

  it("reproduces the reference's exact gap counts: 17 blank/title, 3 blank/credit, 2 blank/author, 4 blank/source", () => {
    // Read directly from the reference: 17 leading blank Left paragraphs, then Title; 3 blank
    // Center paragraphs, then credit; 2 blank Center paragraphs, then the one author line it has;
    // 4 blank Center paragraphs, then source. Counted structurally (self-closed vs not), not
    // retyped from memory.
    const reference = readReferenceFixture();
    const titlePageContent = reference.slice(
      reference.indexOf('<TitlePage>'),
      reference.indexOf('</TitlePage>'),
    );
    const paragraphs =
      titlePageContent.match(/<Paragraph\b[^>]*?(?:\/>|>[^]*?<\/Paragraph>)/g) ?? [];
    const isBlank = (paragraph: string) => paragraph.endsWith('/>');
    const titleIndex = paragraphs.findIndex((p) => p.includes('Script Title'));
    const creditIndex = paragraphs.findIndex((p) => p.includes('Written by'));
    const authorIndex = paragraphs.findIndex((p) => p.includes('Name of First Writer'));
    const sourceIndex = paragraphs.findIndex((p) => p.includes('Based on'));
    expect(paragraphs.slice(0, titleIndex).every(isBlank)).toBe(true);
    expect(titleIndex).toBe(17);
    expect(paragraphs.slice(titleIndex + 1, creditIndex).every(isBlank)).toBe(true);
    expect(creditIndex - titleIndex - 1).toBe(3);
    expect(paragraphs.slice(creditIndex + 1, authorIndex).every(isBlank)).toBe(true);
    expect(authorIndex - creditIndex - 1).toBe(2);
    expect(paragraphs.slice(authorIndex + 1, sourceIndex).every(isBlank)).toBe(true);
    expect(sourceIndex - authorIndex - 1).toBe(4);

    // Our own output, for a title page carrying the same four fields, reproduces the identical
    // gap structure.
    const xml = screenplayToFdx(
      screenplayWith([actionBlock('a0', 'Body.')], {
        titlePages: [
          titlePageWith({
            title: 'Script Title',
            credit: 'Written by',
            authors: ['Name of First Writer'],
            source: 'Based on, ',
          }),
        ],
      }),
    );
    const ownParagraphs =
      xml
        .slice(xml.indexOf('<TitlePage>'), xml.indexOf('</TitlePage>'))
        .match(/<Paragraph\b[^>]*?(?:\/>|>[^]*?<\/Paragraph>)/g) ?? [];
    const ownIsBlank = (paragraph: string) => paragraph.endsWith('/>');
    const ownTitleIndex = ownParagraphs.findIndex((p) => p.includes('Script Title'));
    const ownCreditIndex = ownParagraphs.findIndex((p) => p.includes('Written by'));
    const ownAuthorIndex = ownParagraphs.findIndex((p) => p.includes('Name of First Writer'));
    const ownSourceIndex = ownParagraphs.findIndex((p) => p.includes('Based on'));
    expect(ownParagraphs.slice(0, ownTitleIndex).every(ownIsBlank)).toBe(true);
    expect(ownTitleIndex).toBe(17);
    expect(ownCreditIndex - ownTitleIndex - 1).toBe(3);
    expect(ownAuthorIndex - ownCreditIndex - 1).toBe(2);
    expect(ownSourceIndex - ownAuthorIndex - 1).toBe(4);
  });

  it('gives every title-page paragraph a unique, UUID-shaped id, matching the reference structurally', () => {
    const xml = screenplayToFdx(
      screenplayWith([actionBlock('a0', 'Body.')], {
        titlePages: [titlePageWith({ title: 'Script Title', credit: 'Written by' })],
      }),
    );
    const ids = [...xml.matchAll(/Type="Title Paragraph" id="([0-9a-f-]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('is deterministic: the same title page produces byte-identical ids across calls', () => {
    const screenplay = screenplayWith([actionBlock('a0', 'Body.')], {
      titlePages: [titlePageWith({ title: 'Script Title' })],
    });
    expect(screenplayToFdx(screenplay)).toBe(screenplayToFdx(screenplay));
  });

  it('places contact in the lower right (Alignment="Right"), per plan.md, since the reference leaves it blank', () => {
    const xml = screenplayToFdx(
      screenplayWith([actionBlock('a0', 'Body.')], {
        titlePages: [titlePageWith({ contact: ['writer@example.test', '555-0100'] })],
      }),
    );
    expect(xml).toContain(
      '<Paragraph Alignment="Right" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" ' +
        'OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" ' +
        'Type="Title Paragraph"',
    );
    expect(xml).toContain(
      '<Text Font="Courier Final Draft" Size="12">writer@example.test\n555-0100</Text>',
    );
  });

  it('omits a field entirely when it is absent from the title page, with no stray blank paragraph text', () => {
    const xml = screenplayToFdx(
      screenplayWith([actionBlock('a0', 'Body.')], {
        titlePages: [titlePageWith({ title: 'ONLY TITLE' })],
      }),
    );
    expect(xml).toContain('ONLY TITLE');
    expect(xml).not.toContain('Written by');
  });

  it('renders the shared fixture title page (no source field) without a source paragraph', () => {
    const xml = screenplayToFdx(screenplayFixture);
    expect(xml).toContain('THE LAST STOP');
    expect(xml).toContain('Morgan Vale');
    expect(xml).toContain('morgan@example.test');
  });

  it('throws when a screenplay carries more than one title page', () => {
    const screenplay = screenplayWith([actionBlock('a0', 'Body.')], {
      titlePages: [
        titlePageWith({ id: 't0', title: 'First' }),
        titlePageWith({ id: 't1', title: 'Second' }),
      ],
    });
    expect(() => screenplayToFdx(screenplay)).toThrow(/at most one title page/);
  });
});

describe('screenplayToFdx: annotations never enter the exported script', () => {
  it('produces identical output for a screenplay with annotations and the same screenplay without any', () => {
    const withAnnotations = screenplayToFdx(screenplayFixture);
    const withoutAnnotations = screenplayToFdx({ ...screenplayFixture, annotations: [] });
    expect(withoutAnnotations).toBe(withAnnotations);
    // Confirms the annotation's own text genuinely never appears, not just that the two outputs
    // happen to match for an unrelated reason.
    expect(withAnnotations).not.toContain('Confirm station access.');
  });
});

describe('screenplayToFdx: escaping is applied at every emission site, not just Text content', () => {
  it('escapes hostile text inside an ordinary body block', () => {
    const hostile = `<Paragraph Type="Character">FAKE</Paragraph> & "quoted" 'stuff' ]]>`;
    const xml = screenplayToFdx(screenplayWith([actionBlock('a0', hostile)]));
    expect(xml).toContain(
      '<Text>&lt;Paragraph Type=&quot;Character&quot;&gt;FAKE&lt;/Paragraph&gt; &amp; ' +
        '&quot;quoted&quot; &apos;stuff&apos; ]]&gt;</Text>',
    );
    // The vacuous-test trap this guards against: asserting only that the raw text is *contained*
    // in the output would also pass on a completely unescaped exporter.
    expect(xml).not.toContain('<Paragraph Type="Character">FAKE</Paragraph>');
  });

  it('escapes a hostile scene number in the Number attribute', () => {
    const xml = screenplayToFdx(
      screenplayWith([sceneHeadingBlock('s0', 'INT. HOUSE - DAY', '1"><Evil/>')]),
    );
    expect(xml).toContain('Number="1&quot;&gt;&lt;Evil/&gt;"');
    expect(xml).not.toContain('Number="1"><Evil/>"');
  });

  it('escapes hostile text on the title page', () => {
    const xml = screenplayToFdx(
      screenplayWith([actionBlock('a0', 'Body.')], {
        titlePages: [titlePageWith({ title: '<TitlePage/> & "co"' })],
      }),
    );
    expect(xml).toContain('&lt;TitlePage/&gt; &amp; &quot;co&quot;');
  });

  it('passes non-ASCII and emoji text through unescaped', () => {
    const xml = screenplayToFdx(screenplayWith([actionBlock('a0', 'café 日本語 🎬')]));
    expect(xml).toContain('<Text>café 日本語 🎬</Text>');
  });
});

// Exercises every text-bearing block type through one screenplay, independent of the fixture
// above, so this suite doesn't rely solely on the shared fixture happening to cover each type.
describe('screenplayToFdx: direct block-builder coverage', () => {
  it('maps character, dialogue, parenthetical, transition, and shot blocks built directly', () => {
    const xml = screenplayToFdx(
      screenplayWith([
        characterBlock('c0', 'ADA'),
        dialogueBlock('d0', 'Hello.'),
        parentheticalBlock('p0', '(quietly)'),
        transitionBlock('t0', 'CUT TO:'),
        shotBlock('sh0', 'CLOSE ON the door.'),
        dualDialogueBlock('dd0'),
      ]),
    );
    expect(xml).toContain('Type="Character" id="c0">\n      <Text Style="AllCaps">ADA</Text>');
    expect(xml).toContain('Type="Dialogue" id="d0">\n      <Text>Hello.</Text>');
    expect(xml).toContain('Type="Parenthetical" id="p0">\n      <Text>(quietly)</Text>');
    expect(xml).toContain('Type="Transition" id="t0">\n      <Text Style="AllCaps">CUT TO:</Text>');
    expect(xml).toContain(
      'Type="Shot" id="sh0">\n      <Text Style="AllCaps">CLOSE ON the door.</Text>',
    );
    expect(xml).toContain('<DualDialogue>');
  });
});

/**
 * These sections were omitted from the first accepted export, and their absence is what made Final
 * Draft render the whole script as a single continuous page: with no `PageSize` and no margins
 * there is nothing to break pages against. They are asserted against the genuine reference's
 * structure, with this product's own geometry substituted -- see `renderPageLayout`'s comment for
 * why the values are ours and not Final Draft's.
 */
describe('screenplayToFdx: page layout and document-settings sections', () => {
  it('emits PageSize in inches and every margin in points, in the reference document order', () => {
    const xml = screenplayToFdx(screenplayFixture);

    // The unit change is the easy thing to get wrong: a file that paginates at the wrong length
    // looks correct and disagrees with the page count `packages/layout` computed.
    expect(xml).toContain('<PageSize Height="11.00" Width="8.50"/>');
    expect(xml).toContain('TopMargin="72"');
    expect(xml).toContain('BottomMargin="72"');
    expect(xml).toContain('HeaderMargin="36"');
    expect(xml).toContain('FooterMargin="36"');

    // Final Draft writes these in a specific order relative to Content and TitlePage; the
    // reference is the authority for it.
    const order = [
      '<Content>',
      '<PageLayout',
      '<TitlePage>',
      '<MoresAndContinueds>',
      '<SceneNumberOptions',
    ];
    const positions = order.map((token) => xml.indexOf(token));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("tells Final Draft not to re-add (MORE)/CONT'D when the writer turned them off", () => {
    // Final Draft defaults this on. Saying nothing would mean the exported file reinstates exactly
    // the markers the setting suppressed, moving every page break after the first split speech.
    const on = screenplayToFdx(screenplayFixture);
    expect(on).toContain('AutomaticCharacterContinueds="Yes" BottomOfPage="Yes"');
    expect(on).toContain('TopOfNext="Yes"');

    const off = screenplayToFdx({
      ...screenplayFixture,
      documentSettings: { ...screenplayFixture.documentSettings, autoMoreContinued: false },
    });
    expect(off).toContain('AutomaticCharacterContinueds="No" BottomOfPage="No"');
    expect(off).toContain('TopOfNext="No"');
  });

  it('drives scene-number display from the document setting, and always states the suffix scheme', () => {
    const hidden = screenplayToFdx(screenplayFixture);
    expect(hidden).toContain('ShowNumbersOnLeft="No" ShowNumbersOnRight="No"');

    const shown = screenplayToFdx({
      ...screenplayFixture,
      documentSettings: { ...screenplayFixture.documentSettings, sceneNumbersEnabled: true },
    });
    // Both margins, per plan.md's "Locked scripts" -- the reference independently agrees.
    expect(shown).toContain('ShowNumbersOnLeft="Yes" ShowNumbersOnRight="Yes"');

    // `1A` is the suffix form (25A), not a prefix, and describes how numbers are formed rather
    // than whether they are currently displayed -- so it is stated either way.
    expect(hidden).toContain('NumberScheme="1A"');
    expect(shown).toContain('NumberScheme="1A"');
  });
});
