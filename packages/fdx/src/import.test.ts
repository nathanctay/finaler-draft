import { describe, expect, it, vi } from 'vitest';
import type { Screenplay } from '@finaler-draft/screenplay';
import { DEFAULT_DOCUMENT_SETTINGS, safeParseScreenplay } from '@finaler-draft/screenplay';
import { screenplayFixture, minimalScreenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { screenplayToFdx } from './index.js';
import {
  FdxImportError,
  fdxToScreenplay,
  FdxUnknownTypesError,
  type FdxUnknownTypeResolutions,
} from './import.js';
import {
  readReferenceFixture,
  readMultiPageScriptFixture,
  screenplayWith,
  actionBlock,
  titlePageWith,
} from './testFixtures.js';
import type * as XmlParserModule from './xmlParser.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `screenplayFixture` (every block type, scene numbers, a title page with every field but
 * `source`, `dual_dialogue`) is the package's richest existing canonical fixture, but two of its
 * shapes are already-documented, pre-existing *export* limitations unrelated to import (see
 * `progress/fdx-export.md` and this slice's own `progress/fdx-import.md`): `annotations` is never
 * written to FDX at all, and a *trailing* `page_break` with nothing after it renders nothing
 * (FDX has no way to express "one blank page at the very end"). This derived fixture removes both
 * so the round-trip test below proves the property it is actually able to prove -- that
 * `fdxToScreenplay(screenplayToFdx(s))` reproduces `s` modulo ids -- rather than failing on a gap
 * that belongs to the exporter, not the importer.
 */
const roundTripFixture: Screenplay = {
  ...screenplayFixture,
  annotations: [],
  blocks: [
    ...screenplayFixture.blocks,
    { id: 'f1a2b3c4-d5e6-4789-9abc-def012345678', type: 'action', text: 'The train pulls away.' },
  ],
};

function expectValidUuid(value: string | undefined): void {
  expect(value).toBeDefined();
  expect(value!).toMatch(UUID_PATTERN);
}

describe('fdxToScreenplay: round trip through screenplayToFdx', () => {
  it('reproduces the fixture exactly, modulo the ids and the top-level title FDX has no attribute for', () => {
    const { screenplay: imported, skipped } = fdxToScreenplay(screenplayToFdx(roundTripFixture));

    // The fixture contains no `General` paragraph and nothing from `SKIPPABLE_FDX_TYPES`, so the
    // owner's relaxation (map General, skip-and-report the structure/outline types) has nothing
    // to do here -- this is the control proving the relaxation does not change behavior for a
    // screenplay that never touches it.
    expect(skipped.size).toBe(0);

    // Five fields this format genuinely cannot carry, each asserted to have been *regenerated*
    // (a real, freshly minted UUID distinct from the original), not merely "whatever it is":
    // the screenplay's own id, the title page's id, the dual-dialogue block's two column ids
    // (`left.id`/`right.id`), and the synthesized `page_break` block's id (page_break has no FDX
    // element or attribute of its own at all -- it is inferred purely from `StartsNewPage="Yes"`
    // on the *next* paragraph, so there is nowhere for its id to have been stored in the first
    // place; see decodeContent's doc comment).
    expectValidUuid(imported.id);
    expect(imported.id).not.toBe(roundTripFixture.id);
    expectValidUuid(imported.titlePages[0]?.id);
    expect(imported.titlePages[0]?.id).not.toBe(roundTripFixture.titlePages[0]?.id);
    const importedDualDialogue = imported.blocks.find((b) => b.type === 'dual_dialogue');
    const originalDualDialogue = roundTripFixture.blocks.find((b) => b.type === 'dual_dialogue');
    expect(importedDualDialogue?.type).toBe('dual_dialogue');
    expect(originalDualDialogue?.type).toBe('dual_dialogue');
    if (
      importedDualDialogue?.type === 'dual_dialogue' &&
      originalDualDialogue?.type === 'dual_dialogue'
    ) {
      expectValidUuid(importedDualDialogue.left.id);
      expectValidUuid(importedDualDialogue.right.id);
      expect(importedDualDialogue.left.id).not.toBe(originalDualDialogue.left.id);
      expect(importedDualDialogue.right.id).not.toBe(originalDualDialogue.right.id);
    }
    const importedPageBreak = imported.blocks.find((b) => b.type === 'page_break');
    const originalPageBreak = roundTripFixture.blocks.find((b) => b.type === 'page_break');
    expectValidUuid(importedPageBreak?.id);
    expect(importedPageBreak?.id).not.toBe(originalPageBreak?.id);

    // `screenplay.title` (the organizational/listing title) is a sixth, distinct gap, confirmed
    // directly by this very fixture: `screenplayFixture.title` is "The Last Stop" but its title
    // page's own `title` is "THE LAST STOP" -- a deliberate case difference in the ground-truth
    // fixture proving these are two independent pieces of content. FDX has only one of them (the
    // printed title page's title); there is nowhere in the format for a separate organizational
    // title to live, so import always derives the top-level `title` from `titlePages[0].title`
    // (`fdxToScreenplay`'s own doc comment) and the original top-level title, when it differed,
    // is not recoverable. Asserted explicitly here, and again in its own dedicated test below.
    expect(imported.title).toBe('THE LAST STOP');
    expect(imported.title).not.toBe(roundTripFixture.title);

    // Everything else -- every body block's own id and text, sceneNumber, every dual-dialogue
    // column block's id and text, every title-page field's value, and documentSettings -- must
    // match exactly. Building the expected value by substituting only the six proven-unstable
    // fields (rather than comparing field-by-field) is what makes this assertion strong: a future
    // change that drops or alters any *other* field fails this `toEqual`, not a hand-picked
    // subset of fields someone remembered to check.
    const expected: Screenplay = {
      ...roundTripFixture,
      id: imported.id,
      title: imported.title,
      titlePages: [{ ...roundTripFixture.titlePages[0]!, id: imported.titlePages[0]!.id }],
      blocks: roundTripFixture.blocks.map((block) => {
        if (block.type === 'page_break') return { ...block, id: importedPageBreak!.id };
        if (block.type !== 'dual_dialogue' || importedDualDialogue?.type !== 'dual_dialogue') {
          return block;
        }
        return {
          ...block,
          left: { ...block.left, id: importedDualDialogue.left.id },
          right: { ...block.right, id: importedDualDialogue.right.id },
        };
      }),
    };
    expect(imported).toEqual(expected);
  });

  it("reproduces every body block id exactly, except page_break (which FDX stores nowhere) -- correcting this scope's own premise", () => {
    // This scope was briefed that "FDX has no id attribute," so block ids could not survive a
    // round trip. That is incorrect for ordinary body blocks: the genuine FD13 reference fixture
    // gives every Content paragraph a UUID `id` attribute (verified directly in
    // `packages/fdx/fixtures/final-draft-13-reference.fdx`), and `screenplayToFdx`'s own
    // `bodyParagraph` deliberately writes the canonical block's own id into that exact attribute
    // (see that function's doc comment: "this takes that identity rather than inventing a
    // parallel one"). Those ids round-trip exactly, not "modulo ids" -- see
    // `progress/fdx-import.md` for the full correction. `page_break` is the one real exception,
    // excluded below: it has no FDX representation of its own at all (see the test above).
    const { screenplay: imported } = fdxToScreenplay(screenplayToFdx(roundTripFixture));
    const idsExcludingPageBreaks = (blocks: readonly Screenplay['blocks'][number][]) =>
      blocks.flatMap((block) => {
        if (block.type === 'page_break') return [];
        if (block.type === 'dual_dialogue') {
          return [...block.left.blocks.map((b) => b.id), ...block.right.blocks.map((b) => b.id)];
        }
        return [block.id];
      });
    expect(idsExcludingPageBreaks(imported.blocks)).toEqual(
      idsExcludingPageBreaks(roundTripFixture.blocks),
    );
  });

  it("does not and cannot recover a top-level screenplay.title that differs from the title page's own title", () => {
    expect(roundTripFixture.title).toBe('The Last Stop');
    expect(roundTripFixture.titlePages[0]?.title).toBe('THE LAST STOP');
    const { screenplay: imported } = fdxToScreenplay(screenplayToFdx(roundTripFixture));
    expect(imported.title).toBe('THE LAST STOP');
  });

  it('round-trips the minimal fixture (no blocks, no title pages) to an empty-result refusal', () => {
    // `minimalScreenplayFixture` has no blocks and no title pages, so `screenplayToFdx` emits an
    // empty <Content> and no <TitlePage> at all -- correctly refused by import as carrying no
    // screenplay content, exactly as plan.md's "fail closed" principle requires, not silently
    // accepted as a valid but vacuous screenplay.
    const xml = screenplayToFdx(minimalScreenplayFixture);
    expect(() => fdxToScreenplay(xml)).toThrow(FdxImportError);
    try {
      fdxToScreenplay(xml);
      expect.unreachable();
    } catch (error) {
      expect((error as FdxImportError).code).toBe('empty_result');
    }
  });

  it('round-trips a page_break that is not trailing', () => {
    // roundTripFixture's blocks end [..., dual_dialogue, page_break, action("The train pulls
    // away.")] -- the extra trailing action block is exactly what turns the fixture's originally
    // *trailing* page_break (which `screenplayToFdx` would otherwise drop entirely, see this
    // file's own fixture comment) into one `screenplayToFdx` can actually express.
    const { screenplay: imported } = fdxToScreenplay(screenplayToFdx(roundTripFixture));
    const types = imported.blocks.map((b) => b.type);
    expect(types).toContain('page_break');
    const pageBreakIndex = types.indexOf('page_break');
    expect(types[pageBreakIndex - 1]).toBe('dual_dialogue');
    expect(types[pageBreakIndex + 1]).toBe('action');
    expect(imported.blocks[pageBreakIndex + 1]).toMatchObject({ text: 'The train pulls away.' });
  });

  describe('documentSettings: a documented, tested limitation of this round trip', () => {
    it('recovers characterIndentIn and parentheticalIndentIn, but falls back to defaults for parentheticalWidthIn and pageNumberStyle', () => {
      // screenplayToFdx writes no <ElementSettings> at all (progress/fdx-export.md:
      // "documentSettings is not mapped into FDX page-layout settings") -- the only place
      // characterIndentIn/parentheticalIndentIn show up in the file is as each Character/
      // Parenthetical paragraph instance's own LeftIndent, which import reads back. Nothing in
      // the file encodes a parenthetical's *width* or the page-number style at all, so those two
      // fields can never be recovered and always fall back to DEFAULT_DOCUMENT_SETTINGS -- this
      // test proves both halves of that claim with non-default values, not just the half that
      // happens to work.
      const screenplay = screenplayWith(
        [
          { id: '11111111-1111-4111-8111-111111111111', type: 'character', text: 'ADA' },
          { id: '22222222-2222-4222-8222-222222222222', type: 'parenthetical', text: '(beat)' },
        ],
        {
          documentSettings: {
            ...DEFAULT_DOCUMENT_SETTINGS,
            characterIndentIn: 4.0,
            parentheticalIndentIn: 3.3,
            parentheticalWidthIn: 2.5,
            pageNumberStyle: 'roman',
          },
        },
      );
      const { screenplay: imported } = fdxToScreenplay(screenplayToFdx(screenplay));
      expect(imported.documentSettings.characterIndentIn).toBe(4.0);
      expect(imported.documentSettings.parentheticalIndentIn).toBe(3.3);
      expect(imported.documentSettings.parentheticalWidthIn).toBe(
        DEFAULT_DOCUMENT_SETTINGS.parentheticalWidthIn,
      );
      expect(imported.documentSettings.pageNumberStyle).toBe(
        DEFAULT_DOCUMENT_SETTINGS.pageNumberStyle,
      );
    });

    it('recovers sceneNumbersEnabled and autoMoreContinued exactly', () => {
      const screenplay = screenplayWith([actionBlock('a0', 'Body.')], {
        documentSettings: {
          ...DEFAULT_DOCUMENT_SETTINGS,
          sceneNumbersEnabled: true,
          autoMoreContinued: false,
        },
      });
      const { screenplay: imported } = fdxToScreenplay(screenplayToFdx(screenplay));
      expect(imported.documentSettings.sceneNumbersEnabled).toBe(true);
      expect(imported.documentSettings.autoMoreContinued).toBe(false);
    });
  });
});

describe('fdxToScreenplay: mapping against the genuine FD13 reference', () => {
  it("imports the genuine reference file successfully -- the headline test of the owner's relaxation, with the block count and the skipped tally both pinned", () => {
    // Before the owner's relaxation (see progress/fdx-import.md), this test asserted that the
    // real reference file was *refused*, on `Type="General"` at content position 7 -- this
    // project's own genuine Final Draft 13 file could not be imported, because `General` is
    // Final Draft's ordinary plain paragraph and real scripts contain it routinely. The owner's
    // decision was: map `General` (faithfully -- same indent as `Action`), and skip-and-report
    // the nine structure/outline paragraphs (`Cast List`, `New Act`, `Sequence`, `End of Act`,
    // `Summary`, `Outline 1`, `Outline 2`, `Outline 3`, `Note`) rather than refuse the whole file
    // over content that is genuinely not screenplay body text. Every one of the reference's 20
    // `Content` paragraphs is now accounted for by this mapping -- 11 kept, 9 skipped -- which is
    // what this test pins exactly, read directly off the fixture rather than guessed at.
    const { screenplay, skipped, titlePageUnreadable } = fdxToScreenplay(readReferenceFixture());

    expect(titlePageUnreadable).toBe(false);
    expect(screenplay.blocks).toHaveLength(11);
    expect(screenplay.blocks.map((block) => block.type)).toEqual([
      'transition',
      'scene_heading',
      'character',
      'parenthetical',
      'dialogue',
      'action',
      'action', // the `General` paragraph, mapped exactly like `Action`
      'transition',
      'shot',
      'action',
      'character',
    ]);
    // The `General` paragraph's own text survives, confirming it was mapped, not dropped and
    // replaced with something else that happened to also be type `action`.
    expect(screenplay.blocks[6]).toMatchObject({ type: 'action', text: 'sdfsdfs' });
    // The final `Character` paragraph in the reference is empty and self-closing
    // (`<Paragraph ... Type="Character" .../>`) -- confirms the empty-text path still decodes.
    expect(screenplay.blocks[10]).toMatchObject({ type: 'character', text: '' });

    expect(Object.fromEntries(skipped)).toEqual({
      'Cast List': 1,
      'New Act': 1,
      Sequence: 1,
      'End of Act': 1,
      Summary: 1,
      'Outline 1': 1,
      'Outline 2': 1,
      'Outline 3': 1,
      Note: 1,
    });

    // The title page and document settings this reference carries, read directly off the file
    // (this is Final Draft's own saved title page, not this package's own output) -- confirming
    // the relaxation did not touch anything else this mapping already covered.
    expect(screenplay.titlePages).toHaveLength(1);
    expect(screenplay.titlePages[0]).toMatchObject({
      title: 'Script Title',
      credit: 'Written by',
      authors: ['Name of First Writer'],
      source: 'Based on, ',
    });
    expect(screenplay.titlePages[0]?.draftDate).toBeUndefined();
    expect(screenplay.titlePages[0]?.contact).toBeUndefined();
    expect(screenplay.documentSettings).toMatchObject({
      characterIndentIn: 3.5,
      parentheticalIndentIn: 3.0,
      sceneNumbersEnabled: true,
      autoMoreContinued: true,
    });

    // And the full result still passes `screenplaySchema` -- this is a real, usable screenplay,
    // not merely "did not throw".
    expect(safeParseScreenplay(screenplay).success).toBe(true);
  });

  it('decodes the genuine reference title page exactly, byte-for-byte', () => {
    // The exact <TitlePage> block from final-draft-13-reference.fdx, copied verbatim, wrapped in
    // a minimal otherwise-mappable document. This is Final Draft's own default title-page
    // template (not this package's own output), so a correct decode here is independent
    // cross-validation of decodeTitlePageContent's grammar, not a test of the exporter at all.
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
      '<FinalDraft DocumentType="Script" Template="No" Version="6">\n' +
      '  <Content>\n' +
      '    <Paragraph Alignment="Left" LeftIndent="1.50" Type="Action" id="7a396a1c-6463-46ff-b6ae-c6c6e9a74eb0"><Text>Body.</Text></Paragraph>\n' +
      '  </Content>\n' +
      '  <TitlePage>\n' +
      '    <Content>\n' +
      '      <Paragraph Alignment="Left" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="9bc4b82f-147d-451c-92fb-7d9e43a00d4c"/>\n'.repeat(
        1,
      ) +
      Array.from(
        { length: 16 },
        (_, i) =>
          `      <Paragraph Alignment="Left" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="pad-${i}"/>\n`,
      ).join('') +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="de678e4b-17ed-4490-bbdd-22ffffc267f1"><Text Font="Courier Final Draft" Size="12" Style="Underline+AllCaps">Script Title</Text></Paragraph>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="ae3157c0-4a39-4f24-a72e-5020be058963"/>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="550da81b-2e63-4a9a-9a04-b9157df853b9"/>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="2bcf9e20-b18f-4a71-bd06-22e1140683ed"/>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="b2d301b3-074d-42d9-8278-be1633241698"><Text Font="Courier Final Draft" Size="12">Written by</Text></Paragraph>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="0d4c1ec1-2c08-4817-835c-dd3ebb4219fd"/>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="ec769917-ae0e-4add-8fbe-318236b71d6f"/>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="6f8249a4-0f98-4944-bcd0-2e0552732b7d"><Text Font="Courier Final Draft" Size="12">Name of First Writer</Text></Paragraph>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="c319a10e-ba9c-4ffc-a16c-194d2baaa7be"/>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="b6c609b5-ca29-49b0-9ce1-45459b5ee3cf"/>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="6386a067-32fc-43c4-98a9-3cbb0eeb3ddc"/>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="c27b3055-6b67-4321-967c-80b9a4e182b7"/>\n' +
      '      <Paragraph Alignment="Center" FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph" id="bb215028-518a-490d-9c66-bdac0a78c38e"><Text Font="Courier Final Draft" Size="12">Based on, </Text></Paragraph>\n' +
      '    </Content>\n' +
      '  </TitlePage>\n' +
      '</FinalDraft>\n';
    const { screenplay: imported } = fdxToScreenplay(xml);
    expect(imported.titlePages).toHaveLength(1);
    const titlePage = imported.titlePages[0]!;
    expect(titlePage.title).toBe('Script Title');
    expect(titlePage.credit).toBe('Written by');
    expect(titlePage.authors).toEqual(['Name of First Writer']);
    expect(titlePage.source).toBe('Based on, ');
    expect(titlePage.draftDate).toBeUndefined();
    expect(titlePage.contact).toBeUndefined();
  });
});

describe("fdxToScreenplay: the owner's real reproduction file (multi-page-script.fdx) -- trailing blank authors", () => {
  it("imports the owner's real file successfully, decoding its title page field-by-field including a trailing-blank authors array", () => {
    // Before Task 1 (this pass), this file threw `unmapped_content` -- "a title page whose
    // paragraph sequence does not match the structure this product recognizes (unrecognized
    // content starting at title-page paragraph 32 of 40)" -- because its `authors` field is
    // `['Nathan', '', '']`: two trailing blank author lines that `tryAuthors` does not itself
    // consume, which then merged into `source`'s own 4-blank gap as one wrong-sized 6-blank run.
    // See `decodeTitlePageContent`'s doc comment and `packages/fdx/fixtures/README.md` for the
    // full diagnosis. This is the headline test of this task: the real file, read from disk
    // exactly as a writer's browser would read it, imports completely.
    const { screenplay, skipped, titlePageUnreadable } = fdxToScreenplay(
      readMultiPageScriptFixture(),
    );

    expect(titlePageUnreadable).toBe(false);
    // Every one of the file's 118 body paragraphs is mappable (96 Action, 10 Dialogue,
    // 5 Character, 4 Scene Heading, 2 Parenthetical, 1 Shot) -- confirmed directly against the
    // fixture, not assumed -- so nothing is skipped and the whole body survives.
    expect(screenplay.blocks).toHaveLength(118);
    expect(Object.fromEntries(skipped)).toEqual({});
    expect(screenplay.blocks.filter((block) => block.type === 'scene_heading')).toHaveLength(4);
    expect(screenplay.blocks.filter((block) => block.type === 'character')).toHaveLength(5);
    expect(screenplay.blocks.filter((block) => block.type === 'dialogue')).toHaveLength(10);
    expect(screenplay.blocks.filter((block) => block.type === 'parenthetical')).toHaveLength(2);
    expect(screenplay.blocks.filter((block) => block.type === 'shot')).toHaveLength(1);
    expect(screenplay.blocks.filter((block) => block.type === 'action')).toHaveLength(96);

    expect(screenplay.titlePages).toHaveLength(1);
    const titlePage = screenplay.titlePages[0]!;
    expect(titlePage.title).toBe('Multi page script');
    expect(titlePage.credit).toBe('written by');
    // The field this task exists for: two real, trailing blank author entries, preserved rather
    // than discarded -- not normalized down to `['Nathan']`.
    expect(titlePage.authors).toEqual(['Nathan', '', '']);
    expect(titlePage.source).toBe('Based on War and Peace');
    expect(titlePage.draftDate).toBe('08/22/26');
    expect(titlePage.contact).toHaveLength(15);
    expect(titlePage.contact?.[0]).toBe('line 1');

    // And the full result still passes `screenplaySchema`, exactly as the FD13 reference does.
    expect(safeParseScreenplay(screenplay).success).toBe(true);
  });
});

describe("fdxToScreenplay: the owner's relaxation -- General mapped, a closed skip allowlist, unknown types still fatal", () => {
  it('maps a "General" paragraph to action, faithfully rather than as a guess', () => {
    // The reference fixture's own General paragraph carries LeftIndent="1.50", identical to
    // Action's -- confirmed in the headline reference-file test above -- so this is a faithful,
    // structural mapping, not a lossy approximation. This is a focused, hand-written unit test of
    // the same claim, independent of the large reference fixture.
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Alignment="Left" LeftIndent="1.50" Type="General" id="11111111-1111-4111-8111-111111111111"><Text>Plain paragraph text.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay } = fdxToScreenplay(xml);
    expect(screenplay.blocks).toEqual([
      { id: '11111111-1111-4111-8111-111111111111', type: 'action', text: 'Plain paragraph text.' },
    ]);
  });

  it('skips every type in the closed allowlist, tallies each by its exact FDX Type string, and never adds a skipped paragraph to blocks', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>Kept one.</Text></Paragraph>' +
      '<Paragraph Type="Outline 1"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Outline 1"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Outline 2"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Outline 3"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Summary"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Beat"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Sequence"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="New Act"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="End of Act"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Cast List"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Note"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Action"><Text>Kept two.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay, skipped } = fdxToScreenplay(xml);
    expect(screenplay.blocks.map((block) => ('text' in block ? block.text : block.type))).toEqual([
      'Kept one.',
      'Kept two.',
    ]);
    expect(Object.fromEntries(skipped)).toEqual({
      'Outline 1': 2,
      'Outline 2': 1,
      'Outline 3': 1,
      Summary: 1,
      Beat: 1,
      Sequence: 1,
      'New Act': 1,
      'End of Act': 1,
      'Cast List': 1,
      Note: 1,
    });
  });

  it('a page_break forced by a skipped paragraph\'s own StartsNewPage="Yes" still survives, independent of the skip', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>Before.</Text></Paragraph>' +
      '<Paragraph Type="Note" StartsNewPage="Yes"><Text>skip</Text></Paragraph>' +
      '<Paragraph Type="Action"><Text>After.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay, skipped } = fdxToScreenplay(xml);
    expect(screenplay.blocks.map((block) => block.type)).toEqual([
      'action',
      'page_break',
      'action',
    ]);
    expect(Object.fromEntries(skipped)).toEqual({ Note: 1 });
  });

  it('is a closed allowlist, not a catch-all: a Type absent from both tables is still fatal `unknown_types`, never silently skipped or guessed', () => {
    // This is the property that keeps the relaxation safe (plan.md's fail-closed principle,
    // still in force for everything outside the two named tables): an unrecognized Final Draft
    // construct -- today's or a future version's -- is refused until the writer decides what to
    // do with it, never guessed into "probably skippable" the way a looser, type-name-pattern-
    // based rule might, and never silently mapped either. See `progress/fdx-import.md`'s Task 2:
    // this used to be the generic `'unmapped_content'` code; it is now the more specific
    // `'unknown_types'`, which is still an `FdxImportError` (so a caller that only checks
    // `instanceof FdxImportError` is unaffected) but carries the structured `unknownTypes` list a
    // caller needs to let the writer resolve it, tested in its own describe block below.
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Some Future Final Draft Type"><Text>?</Text></Paragraph>' +
      '</Content></FinalDraft>';
    try {
      fdxToScreenplay(xml);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxImportError);
      expect((error as FdxImportError).code).toBe('unknown_types');
      expect((error as Error).message).toContain('Some Future Final Draft Type');
    }
  });
});

describe('fdxToScreenplay: FdxUnknownTypesError and the resolutions API (Task 2)', () => {
  it('gathers every distinct unknown Type in one pass, with its count and an excerpt of its first instance, rather than stopping at the first one', () => {
    // Three paragraphs of one unknown type and one of another, interleaved with ordinary mapped
    // content -- a single call must report both, not just whichever is encountered first. This is
    // the entire point of `FdxUnknownTypesError` existing separately from the original, single-shot
    // `unmapped()` throw: a file with three unknown types used to take three failed attempts to
    // discover all of them.
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>Kept.</Text></Paragraph>' +
      '<Paragraph Type="Weird Type One"><Text>First weird paragraph, quite long so the excerpt truncation can be checked against the eighty-character limit precisely.</Text></Paragraph>' +
      '<Paragraph Type="Weird Type Two"><Text>Second kind.</Text></Paragraph>' +
      '<Paragraph Type="Weird Type One"><Text>A second instance of the first weird type.</Text></Paragraph>' +
      '<Paragraph Type="Weird Type One"><Text>A third.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    try {
      fdxToScreenplay(xml);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxUnknownTypesError);
      const unknownTypes = (error as FdxUnknownTypesError).unknownTypes;
      expect(unknownTypes).toHaveLength(2);
      const byType = Object.fromEntries(unknownTypes.map((entry) => [entry.type, entry]));
      expect(byType['Weird Type One']?.count).toBe(3);
      expect(byType['Weird Type One']?.excerpt).toBe(
        'First weird paragraph, quite long so the excerpt truncation can be checked again…',
      );
      expect(byType['Weird Type One']!.excerpt.length).toBeLessThanOrEqual(81); // 80 chars + the ellipsis
      expect(byType['Weird Type Two']).toMatchObject({ count: 1, excerpt: 'Second kind.' });
      expect((error as Error).message).toContain('Weird Type One');
      expect((error as Error).message).toContain('Weird Type Two');
    }
  });

  it('reports an empty excerpt for an unknown type whose first instance has no text, without throwing', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Weird Empty"/>' +
      '</Content></FinalDraft>';
    try {
      fdxToScreenplay(xml);
      expect.unreachable();
    } catch (error) {
      const unknownTypes = (error as FdxUnknownTypesError).unknownTypes;
      expect(unknownTypes).toEqual([{ type: 'Weird Empty', count: 1, excerpt: '' }]);
    }
  });

  it('proceeds once every reported unknown type has a resolution, skipping a "skip" decision into the ordinary skipped tally', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>Kept.</Text></Paragraph>' +
      '<Paragraph Type="Weird Type"><Text>Ignore me.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const resolutions: FdxUnknownTypeResolutions = { 'Weird Type': { action: 'skip' } };
    const { screenplay, skipped } = fdxToScreenplay(xml, resolutions);
    expect(screenplay.blocks.map((block) => ('text' in block ? block.text : block.type))).toEqual([
      'Kept.',
    ]);
    // Tallied exactly like a `SKIPPABLE_FDX_TYPES` entry -- the writer-facing confirmation step
    // (`FdxImportConfirmDialog`) does not need to distinguish "always skippable" from "the writer
    // chose to skip it this time"; both mean the same thing by the time the import commits.
    expect(Object.fromEntries(skipped)).toEqual({ 'Weird Type': 1 });
  });

  it('proceeds once every reported unknown type has a resolution, mapping a "map" decision to the chosen canonical block type', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Weird Type" id="11111111-1111-4111-8111-111111111111"><Text>Treat me as dialogue.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const resolutions: FdxUnknownTypeResolutions = {
      'Weird Type': { action: 'map', blockType: 'dialogue' },
    };
    const { screenplay, skipped } = fdxToScreenplay(xml, resolutions);
    expect(screenplay.blocks).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'dialogue',
        text: 'Treat me as dialogue.',
      },
    ]);
    expect(skipped.size).toBe(0);
  });

  it('a resolution naming a scene_heading target still recovers the Number attribute, exactly like a genuinely mapped Scene Heading', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Weird Heading" Number="12A"><Text>INT. SOMEWHERE</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay } = fdxToScreenplay(xml, {
      'Weird Heading': { action: 'map', blockType: 'scene_heading' },
    });
    expect(screenplay.blocks[0]).toMatchObject({
      type: 'scene_heading',
      text: 'INT. SOMEWHERE',
      sceneNumber: '12A',
    });
  });

  it('a resolution covering only some of the reported unknown types still throws, naming just what remains unresolved', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Weird One"><Text>?</Text></Paragraph>' +
      '<Paragraph Type="Weird Two"><Text>?</Text></Paragraph>' +
      '</Content></FinalDraft>';
    try {
      fdxToScreenplay(xml, { 'Weird One': { action: 'skip' } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxUnknownTypesError);
      const unknownTypes = (error as FdxUnknownTypesError).unknownTypes;
      expect(unknownTypes.map((entry) => entry.type)).toEqual(['Weird Two']);
    }
  });

  it('a StartsNewPage="Yes" paragraph of a still-unresolved unknown type does not prevent the page_break from being reported alongside the unknown type', () => {
    // The forced-page-break tally runs unconditionally, before the skip/map/unknown decision --
    // this is the unknown-type analogue of the existing SKIPPABLE_FDX_TYPES test with the same
    // name. Confirmed here by resolving the type on a second call and checking the break survived
    // being reported as unknown on the first.
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>Before.</Text></Paragraph>' +
      '<Paragraph Type="Weird Type" StartsNewPage="Yes"><Text>?</Text></Paragraph>' +
      '<Paragraph Type="Action"><Text>After.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay } = fdxToScreenplay(xml, { 'Weird Type': { action: 'skip' } });
    expect(screenplay.blocks.map((block) => block.type)).toEqual([
      'action',
      'page_break',
      'action',
    ]);
  });

  it('FdxUnknownTypesError is an FdxImportError with code "unknown_types", so a caller checking `instanceof FdxImportError` still catches it', () => {
    const error = new FdxUnknownTypesError([{ type: 'Weird', count: 1, excerpt: 'x' }]);
    expect(error).toBeInstanceOf(FdxImportError);
    expect(error.code).toBe('unknown_types');
    expect(error.name).toBe('FdxUnknownTypesError');
    expect(error.unknownTypes).toEqual([{ type: 'Weird', count: 1, excerpt: 'x' }]);
  });
});

function titleParagraph(options: {
  alignment: 'Left' | 'Center' | 'Right';
  text?: string;
  style?: string;
}): string {
  const styleAttr = options.style !== undefined ? ` Style="${options.style}"` : '';
  const textChild =
    options.text !== undefined
      ? `<Text Font="Courier Final Draft" Size="12"${styleAttr}>${options.text}</Text>`
      : '';
  return (
    `      <Paragraph Alignment="${options.alignment}" FirstIndent="0.00" Leading="Regular" ` +
    'LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1" ' +
    `StartsNewPage="No" Type="Title Paragraph">${textChild}</Paragraph>\n`
  );
}

function blankTitleParagraphs(
  count: number,
  alignment: 'Left' | 'Center' | 'Right' = 'Left',
): string {
  return Array.from({ length: count }, () => titleParagraph({ alignment })).join('');
}

function wrapTitlePage(titlePageLines: string): string {
  return (
    '<FinalDraft Version="6"><Content>' +
    '<Paragraph Type="Action"><Text>Body.</Text></Paragraph>' +
    `</Content><TitlePage><Content>\n${titlePageLines}    </Content></TitlePage></FinalDraft>`
  );
}

describe('fdxToScreenplay: title-page grammar edge cases', () => {
  // Before Task 2 (this pass), every `it` below asserted that a title-page decode failure threw
  // `FdxImportError('unmapped_content')` and refused the *entire* import, body included. That
  // was the fatal behaviour this pass replaced: `fdxToScreenplay` now catches exactly this
  // failure, reports it as `titlePageUnreadable: true` with `titlePages: []`, and still returns
  // the fully-decoded body (`wrapTitlePage`'s own `Action` paragraph survives every case below) --
  // see `decodeTitlePageContent` and `fdxToScreenplay`'s own doc comments. The title page itself
  // is still refused exactly as strictly as before (nothing here is guessed at or approximated);
  // only the *consequence* of that refusal changed, from "nothing imports" to "the title page is
  // reported, the body imports."
  it('stops an authors run as soon as a line no longer matches the plain-Center shape, and reports the title page as unreadable rather than guessing at the leftover', () => {
    // Two genuine authors, then a third line that is styled (never produced by this format for
    // an author line) sitting directly adjacent with no blank line to separate it -- the authors
    // run correctly stops after the second line, and the leftover styled line (which matches none
    // of the remaining expected fields either) still cannot be decoded.
    const xml = wrapTitlePage(
      blankTitleParagraphs(17) +
        titleParagraph({ alignment: 'Center', text: 'A Script', style: 'Underline+AllCaps' }) +
        blankTitleParagraphs(2, 'Center') +
        titleParagraph({ alignment: 'Center', text: 'First Writer' }) +
        titleParagraph({ alignment: 'Center', text: 'Second Writer' }) +
        titleParagraph({ alignment: 'Center', text: 'ODDLY STYLED', style: 'Bold' }),
    );
    const { screenplay, titlePageUnreadable } = fdxToScreenplay(xml);
    expect(titlePageUnreadable).toBe(true);
    expect(screenplay.titlePages).toEqual([]);
    expect(screenplay.blocks).toEqual([expect.objectContaining({ type: 'action', text: 'Body.' })]);
  });

  it('decodes a two-author run correctly when nothing follows it', () => {
    const xml = wrapTitlePage(
      blankTitleParagraphs(17) +
        titleParagraph({ alignment: 'Center', text: 'A Script', style: 'Underline+AllCaps' }) +
        blankTitleParagraphs(2, 'Center') +
        titleParagraph({ alignment: 'Center', text: 'First Writer' }) +
        titleParagraph({ alignment: 'Center', text: 'Second Writer' }),
    );
    const { screenplay: imported, titlePageUnreadable } = fdxToScreenplay(xml);
    expect(titlePageUnreadable).toBe(false);
    expect(imported.titlePages[0]?.authors).toEqual(['First Writer', 'Second Writer']);
  });

  it("reports the title page as unreadable, but still imports the body, when a field's blank-line gap does not match this grammar's fixed constants", () => {
    // Credit's gap is 5 blank lines here, not the 3 `screenplayToFdx` always writes -- this
    // cannot be any recognized field at that position, so the title page itself still cannot be
    // decoded (nothing here guesses which field the writer meant); only the import's overall
    // fate changed, from a thrown error to a reported, non-fatal flag.
    const xml = wrapTitlePage(
      blankTitleParagraphs(17) +
        titleParagraph({ alignment: 'Center', text: 'A Script', style: 'Underline+AllCaps' }) +
        blankTitleParagraphs(5, 'Center') +
        titleParagraph({ alignment: 'Center', text: 'Written by' }),
    );
    const { screenplay, titlePageUnreadable } = fdxToScreenplay(xml);
    expect(titlePageUnreadable).toBe(true);
    expect(screenplay.titlePages).toEqual([]);
    expect(screenplay.blocks).toEqual([expect.objectContaining({ type: 'action', text: 'Body.' })]);
  });

  it('reports the title page as unreadable, but still imports the body, when a title-page element is not a "Title Paragraph"', () => {
    const xml =
      '<FinalDraft Version="6"><Content><Paragraph Type="Action"><Text>Body.</Text></Paragraph></Content>' +
      '<TitlePage><Content><SomethingElse/></Content></TitlePage></FinalDraft>';
    const { screenplay, titlePageUnreadable } = fdxToScreenplay(xml);
    expect(titlePageUnreadable).toBe(true);
    expect(screenplay.titlePages).toEqual([]);
    expect(screenplay.blocks).toEqual([expect.objectContaining({ type: 'action', text: 'Body.' })]);
  });

  it('still throws `unmapped_content` (fatal) when the body itself -- not the title page -- contains unrepresentable content', () => {
    // The flip side of the three tests above, stated explicitly so Task 2's relaxation is never
    // mistaken for a blanket one: only a title-page decode failure is non-fatal. A body paragraph
    // this mapping cannot represent (a dual-dialogue block whose column split is ambiguous, here)
    // is still a thrown, fatal `'unmapped_content'` error, exactly as before this pass.
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph id="dd1"><DualDialogue>' +
      '<Paragraph Type="Character"><Text>ONE</Text></Paragraph>' +
      '<Paragraph Type="Dialogue"><Text>Hi.</Text></Paragraph>' +
      '<Paragraph Type="Character"><Text>TWO</Text></Paragraph>' +
      '<Paragraph Type="Character"><Text>THREE</Text></Paragraph>' +
      '<Paragraph Type="Dialogue"><Text>Hey.</Text></Paragraph>' +
      '</DualDialogue></Paragraph>' +
      '</Content></FinalDraft>';
    try {
      fdxToScreenplay(xml);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxImportError);
      expect((error as FdxImportError).code).toBe('unmapped_content');
    }
  });

  it('imports a <TitlePage> with no <Content> at all as an empty, present title page', () => {
    const xml =
      '<FinalDraft Version="6"><Content><Paragraph Type="Action"><Text>Body.</Text></Paragraph></Content>' +
      '<TitlePage></TitlePage></FinalDraft>';
    const { screenplay: imported } = fdxToScreenplay(xml);
    expect(imported.titlePages).toHaveLength(1);
    expect(imported.titlePages[0]?.title).toBeUndefined();
  });
});

/**
 * A fixed sample value for each of the six optional `TitlePage` fields, distinguishable from one
 * another so a mix-up (e.g. `source`'s text landing in `credit`) would show up as a mismatch
 * rather than passing by coincidence.
 */
const TITLE_PAGE_FIELD_NAMES = [
  'title',
  'credit',
  'authors',
  'source',
  'draftDate',
  'contact',
] as const;
type TitlePageFieldName = (typeof TITLE_PAGE_FIELD_NAMES)[number];

function sampleTitlePageFieldValue(field: TitlePageFieldName): string | string[] {
  switch (field) {
    case 'title':
      return 'A Sweep Title';
    case 'credit':
      return 'Written by';
    case 'authors':
      return ['Writer One', 'Writer Two'];
    case 'source':
      return 'Based on the sweep';
    case 'draftDate':
      return 'Draft date here';
    case 'contact':
      return ['123 Main St', 'Anytown, ST'];
  }
}

// How many trailing blank entries to append to the `authors` sample value, per sweep variant --
// `0` reproduces the original 64-combination sweep exactly; `1`-`3` are this task's extension,
// covering the owner's own reported shape (`['Nathan', '', '']`, two trailing blanks) and the
// neighboring counts named in the task brief (one and three).
const TRAILING_AUTHOR_BLANK_COUNTS = [0, 1, 2, 3] as const;

describe('fdxToScreenplay: the title-page decoder must accept every field combination, not only the ones that include `title`', () => {
  // This is the defect the owner diagnosed: `titlePageLines` (index.ts) pushes
  // `TITLE_PAGE_LINES_BEFORE_TITLE` blank paragraphs *unconditionally*, outside the
  // `if (titlePage.title !== undefined)` guard, but `decodeTitlePageContent`'s `tryTitle` used to
  // consume that leading run *inside* its own backtracking attempt and reset over it whenever no
  // title paragraph followed -- feeding the leading run into the next-present field's own gap
  // check as one merged, wrong-sized gap, which then cascaded a backtrack through every remaining
  // field. The rule was exact: every one of the 64 combinations of the six optional title-page
  // fields that omits `title` while containing at least one other field failed; every combination
  // containing `title` passed. See progress/fdx-import.md's Task 1 (prior pass) for that original
  // diagnosis.
  //
  // This pass extends the same sweep to also vary the number of trailing blank entries in
  // `authors` (0-3), reproducing the owner's *second* reported defect: `['Nathan', '', '']` (two
  // trailing blanks) fails to decode whenever a field with its own fixed gap follows `authors`,
  // because `tryAuthors` stops reading at the first blank it meets and the trailing blanks get
  // folded into the next field's gap check as one wrong-sized sum. See
  // `decodeTitlePageContent`'s doc comment and `progress/fdx-import.md`'s Task 1 (this pass) for
  // the full diagnosis and the before/after sweep numbers this test produced.
  //
  // Deliberately a single test over all ~256 (64 field combinations x 4 trailing-blank counts)
  // cases, not one `it` per case, so a regression reports exactly how many and which combinations
  // broke in one place, matching the owner's own request for the original 64-combination sweep.
  // Comparison is field-by-field against the known sample values above, not `JSON.stringify`
  // (whose key order differs between `titlePageWith`'s construction order and `screenplaySchema`'s
  // own declared shape order) -- the owner's own note on being briefly misled by exactly that.
  it('round-trips all 64 combinations of title/credit/authors/source/draftDate/contact, x 4 trailing-blank-author counts', () => {
    const failures: string[] = [];
    let totalCases = 0;

    for (let mask = 0; mask < 64; mask += 1) {
      const presentFields = TITLE_PAGE_FIELD_NAMES.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );

      for (const trailingBlanks of TRAILING_AUTHOR_BLANK_COUNTS) {
        totalCases += 1;
        const fieldOverrides = Object.fromEntries(
          presentFields.map((field) => {
            const value = sampleTitlePageFieldValue(field);
            if (field === 'authors' && trailingBlanks > 0) {
              return [field, [...(value as string[]), ...new Array(trailingBlanks).fill('')]];
            }
            return [field, value];
          }),
        );
        const screenplay = screenplayWith(
          [actionBlock('a0000000-0000-4000-8000-000000000000', 'Body.')],
          {
            titlePages: [titlePageWith(fieldOverrides)],
          },
        );

        const describeCase = `${presentFields.length > 0 ? presentFields.join('+') : '(none)'}, trailingAuthorBlanks=${trailingBlanks}`;
        try {
          const { screenplay: imported } = fdxToScreenplay(screenplayToFdx(screenplay));
          const titlePage = imported.titlePages[0];
          if (titlePage === undefined) {
            failures.push(`mask ${mask} [${describeCase}]: no title page decoded at all`);
            continue;
          }
          for (const field of TITLE_PAGE_FIELD_NAMES) {
            const baseExpected = presentFields.includes(field)
              ? sampleTitlePageFieldValue(field)
              : undefined;
            const expected =
              field === 'authors' && baseExpected !== undefined && trailingBlanks > 0
                ? [...(baseExpected as string[]), ...new Array(trailingBlanks).fill('')]
                : baseExpected;
            const actual = titlePage[field];
            const matches = Array.isArray(expected)
              ? Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected)
              : actual === expected;
            if (!matches) {
              failures.push(
                `mask ${mask} [${describeCase}]: field "${field}" expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
              );
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`mask ${mask} [${describeCase}]: threw -- ${message}`);
        }
      }
    }

    expect(
      failures,
      `${failures.length} of ${totalCases} combinations failed:\n${failures.join('\n')}`,
    ).toEqual([]);
  });
});

describe('fdxToScreenplay: block-id fallback when an incoming id is missing or malformed', () => {
  it('mints a fresh UUID when a paragraph has no id attribute', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>No id here.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay: imported } = fdxToScreenplay(xml);
    expectValidUuid(imported.blocks[0]?.id);
  });

  it('mints a fresh UUID when a paragraph id attribute is not a valid UUID', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action" id="not-a-real-uuid"><Text>Malformed id.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay: imported } = fdxToScreenplay(xml);
    expectValidUuid(imported.blocks[0]?.id);
    expect(imported.blocks[0]?.id).not.toBe('not-a-real-uuid');
  });
});

describe('fdxToScreenplay: dual-dialogue column-split safety', () => {
  it('refuses a dual-dialogue block whose column split is ambiguous (not exactly two character cues)', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph id="dd1"><DualDialogue>' +
      '<Paragraph Type="Character"><Text>ADA</Text></Paragraph>' +
      '<Paragraph Type="Dialogue"><Text>Hi.</Text></Paragraph>' +
      '<Paragraph Type="Character"><Text>MILES</Text></Paragraph>' +
      '<Paragraph Type="Character"><Text>MILES AGAIN</Text></Paragraph>' +
      '<Paragraph Type="Dialogue"><Text>Hey.</Text></Paragraph>' +
      '</DualDialogue></Paragraph>' +
      '</Content></FinalDraft>';
    try {
      fdxToScreenplay(xml);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxImportError);
      expect((error as FdxImportError).code).toBe('unmapped_content');
      expect((error as Error).message).toContain('3 character cues instead of exactly two');
    }
  });

  it('decodes an unambiguous dual-dialogue block (exactly two character cues) into left/right columns', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph id="11111111-1111-4111-8111-111111111111"><DualDialogue>' +
      '<Paragraph Type="Character" id="22222222-2222-4222-8222-222222222222"><Text>ADA</Text></Paragraph>' +
      '<Paragraph Type="Dialogue" id="33333333-3333-4333-8333-333333333333"><Text>Hi.</Text></Paragraph>' +
      '<Paragraph Type="Character" id="44444444-4444-4444-8444-444444444444"><Text>MILES</Text></Paragraph>' +
      '<Paragraph Type="Parenthetical" id="55555555-5555-4555-8555-555555555555"><Text>(beat)</Text></Paragraph>' +
      '<Paragraph Type="Dialogue" id="66666666-6666-4666-8666-666666666666"><Text>Hey.</Text></Paragraph>' +
      '</DualDialogue></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay: imported } = fdxToScreenplay(xml);
    const block = imported.blocks[0];
    expect(block?.type).toBe('dual_dialogue');
    if (block?.type === 'dual_dialogue') {
      expect(block.id).toBe('11111111-1111-4111-8111-111111111111');
      expect(block.left.blocks.map((b) => b.text)).toEqual(['ADA', 'Hi.']);
      expect(block.right.blocks.map((b) => b.text)).toEqual(['MILES', '(beat)', 'Hey.']);
    }
  });
});

describe('fdxToScreenplay: error taxonomy', () => {
  it('"not_xml" for input that is not XML at all', () => {
    try {
      fdxToScreenplay('this is just some text, not a file format at all');
      expect.unreachable();
    } catch (error) {
      expect((error as FdxImportError).code).toBe('not_xml');
    }
  });

  it('"not_fdx" for well-formed XML whose root is not <FinalDraft>', () => {
    try {
      fdxToScreenplay('<?xml version="1.0"?><SomethingElse/>');
      expect.unreachable();
    } catch (error) {
      expect((error as FdxImportError).code).toBe('not_fdx');
    }
  });

  it('"not_fdx" for a <FinalDraft> document with no <Content> element', () => {
    try {
      fdxToScreenplay('<FinalDraft Version="6"></FinalDraft>');
      expect.unreachable();
    } catch (error) {
      expect((error as FdxImportError).code).toBe('not_fdx');
    }
  });

  it('"doctype_rejected" for a document containing a DOCTYPE', () => {
    try {
      fdxToScreenplay('<!DOCTYPE foo><FinalDraft Version="6"><Content/></FinalDraft>');
      expect.unreachable();
    } catch (error) {
      expect((error as FdxImportError).code).toBe('doctype_rejected');
    }
  });

  it('"too_large" for a document exceeding the size limit', () => {
    const huge = `<FinalDraft><Content>${'a'.repeat(10_000_001)}</Content></FinalDraft>`;
    try {
      fdxToScreenplay(huge);
      expect.unreachable();
    } catch (error) {
      expect((error as FdxImportError).code).toBe('too_large');
    }
  });

  it('"empty_result" for a valid FDX document with no usable screenplay content', () => {
    try {
      fdxToScreenplay('<FinalDraft Version="6"><Content/></FinalDraft>');
      expect.unreachable();
    } catch (error) {
      expect((error as FdxImportError).code).toBe('empty_result');
    }
  });

  it('"empty_result", not a silent success, when the body is empty and the title page is also unreadable', () => {
    // Task 2's relaxation only ever defers the title-page failure to a non-fatal report -- it
    // never invents a reason to succeed. A document with no body at all and an undecodable title
    // page genuinely has nothing to import, so this still throws, with a message that names both
    // reasons rather than reusing the generic "no body paragraphs and no title page content"
    // wording (which would be misleading here: this title page *had* content, it just could not
    // be decoded).
    const xml =
      '<FinalDraft Version="6"><Content/>' +
      '<TitlePage><Content><SomethingElse/></Content></TitlePage></FinalDraft>';
    try {
      fdxToScreenplay(xml);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxImportError);
      expect((error as FdxImportError).code).toBe('empty_result');
      expect((error as Error).message).toContain('its title page could not be read either');
    }
  });

  it('"unknown_types" for a paragraph type in neither the mapped nor the skippable table', () => {
    // `Cast List` moved to the skippable allowlist under the owner's relaxation
    // (`progress/fdx-import.md`), so it can no longer stand in for "genuinely unmapped" here --
    // this uses an invented type name that is not, and should never become, a stand-in for a
    // real Final Draft construct this product has classified either way. Task 2 gave this case
    // its own, more specific code (`'unknown_types'`, carrying the resolvable `unknownTypes`
    // list) in place of the generic `'unmapped_content'` this test used to assert.
    try {
      fdxToScreenplay(
        '<FinalDraft Version="6"><Content><Paragraph Type="Not A Real Final Draft Type"><Text>?</Text></Paragraph></Content></FinalDraft>',
      );
      expect.unreachable();
    } catch (error) {
      expect((error as FdxImportError).code).toBe('unknown_types');
      expect((error as Error).message).toContain('Not A Real Final Draft Type');
    }
  });

  it('each FdxImportError exposes a stable, documented `code` alongside its message', () => {
    const error = new FdxImportError('not_fdx', 'test message');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FdxImportError');
    expect(error.code).toBe('not_fdx');
    expect(error.message).toBe('test message');
  });
});

describe('fdxToScreenplay: scene numbers', () => {
  it('round-trips a scene heading with a scene number', () => {
    const screenplay = screenplayWith([
      {
        id: '77777777-7777-4777-8777-777777777777',
        type: 'scene_heading',
        text: 'INT. HOUSE - DAY',
        sceneNumber: '1A',
      },
    ]);
    const { screenplay: imported } = fdxToScreenplay(screenplayToFdx(screenplay));
    const heading = imported.blocks[0];
    expect(heading?.type).toBe('scene_heading');
    if (heading?.type === 'scene_heading') {
      expect(heading.sceneNumber).toBe('1A');
    }
  });

  it('omits sceneNumber entirely when the FDX paragraph has no Number attribute', () => {
    const screenplay = screenplayWith([
      {
        id: '88888888-8888-4888-8888-888888888888',
        type: 'scene_heading',
        text: 'INT. HOUSE - DAY',
      },
    ]);
    const { screenplay: imported } = fdxToScreenplay(screenplayToFdx(screenplay));
    const heading = imported.blocks[0];
    expect(heading?.type).toBe('scene_heading');
    if (heading?.type === 'scene_heading') {
      expect(heading.sceneNumber).toBeUndefined();
    }
  });
});

describe('fdxToScreenplay: page_break synthesis', () => {
  it('inserts a page_break before a paragraph with StartsNewPage="Yes"', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>Before.</Text></Paragraph>' +
      '<Paragraph Type="Action" StartsNewPage="Yes"><Text>After the break.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay: imported } = fdxToScreenplay(xml);
    expect(imported.blocks.map((b) => b.type)).toEqual(['action', 'page_break', 'action']);
  });

  it('never synthesizes a page_break for a paragraph with no StartsNewPage attribute', () => {
    const xml =
      '<FinalDraft Version="6"><Content>' +
      '<Paragraph Type="Action"><Text>Only one.</Text></Paragraph>' +
      '</Content></FinalDraft>';
    const { screenplay: imported } = fdxToScreenplay(xml);
    expect(imported.blocks.map((b) => b.type)).toEqual(['action']);
  });
});

describe('fdxToScreenplay: never produces output that fails canonical validation', () => {
  it('the output of every successful import here is independently re-validated by safeParseScreenplay', () => {
    const { screenplay: imported } = fdxToScreenplay(screenplayToFdx(roundTripFixture));
    const revalidated = safeParseScreenplay(imported);
    expect(revalidated.success).toBe(true);
  });

  it('"empty_result" (not a thrown schema error) when the assembled screenplay still fails validation', () => {
    // Two paragraphs sharing the identical, otherwise-valid `id` attribute: each decodes and
    // maps cleanly on its own, but `screenplaySchema`'s own uniqueness check
    // (`registerStableId`) catches the collision that nothing earlier in this mapping checks
    // for. This is the one validation failure this slice's own test suite can construct --
    // proof that the final `safeParseScreenplay` call is a real, reachable backstop, not dead
    // code sitting after every path that could fail already failed.
    const duplicateId = '99999999-9999-4999-8999-999999999999';
    const xml =
      '<FinalDraft Version="6"><Content>' +
      `<Paragraph Type="Action" id="${duplicateId}"><Text>First.</Text></Paragraph>` +
      `<Paragraph Type="Action" id="${duplicateId}"><Text>Second.</Text></Paragraph>` +
      '</Content></FinalDraft>';
    try {
      fdxToScreenplay(xml);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxImportError);
      expect((error as FdxImportError).code).toBe('empty_result');
      expect((error as Error).message).toContain('did not pass validation');
    }
  });
});

describe('fdxToScreenplay: propagates an unexpected parser failure unchanged', () => {
  it('rethrows an error from the XML layer that is not an FdxXmlError, rather than masking it', async () => {
    vi.resetModules();
    vi.doMock('./xmlParser.js', async () => {
      const actual = await vi.importActual<typeof XmlParserModule>('./xmlParser.js');
      return {
        ...actual,
        parseFdxXml: () => {
          throw new Error('an unrelated, unexpected failure');
        },
      };
    });
    const { fdxToScreenplay: fdxToScreenplayWithMockedParser } = await import('./import.js');
    expect(() => fdxToScreenplayWithMockedParser('<Root/>')).toThrow(
      'an unrelated, unexpected failure',
    );
    vi.doUnmock('./xmlParser.js');
    vi.resetModules();
  });
});
