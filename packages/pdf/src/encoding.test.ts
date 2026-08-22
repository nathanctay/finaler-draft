import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { assertEncodable } from './encoding.js';

describe('assertEncodable', () => {
  it('does not throw for ordinary WinAnsi-covered text, including curly quotes and an em dash', async () => {
    const pdfDoc = await PDFDocument.create({ updateMetadata: false });
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    expect(() =>
      assertEncodable(font, 'She said, “wait—stop.”', { context: 'a screenplay line' }),
    ).not.toThrow();
  });

  it('names the offending character, its code point, and locates it by block and element', async () => {
    const pdfDoc = await PDFDocument.create({ updateMetadata: false });
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    expect(() =>
      assertEncodable(font, 'Ada speaks: 書', {
        context: 'a screenplay line',
        blockId: 'a0',
        element: 'action',
      }),
    ).toThrow(/書.*0x66f8/);
    expect(() =>
      assertEncodable(font, 'Ada speaks: 書', {
        context: 'a screenplay line',
        blockId: 'a0',
        element: 'action',
      }),
    ).toThrow(/block "a0", action/);
  });

  it('says plainly that this is a limitation of the un-embedded standard font, not a script defect', async () => {
    const pdfDoc = await PDFDocument.create({ updateMetadata: false });
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    expect(() => assertEncodable(font, '書', { context: 'a screenplay line' })).toThrow(
      /un-embedded Courier/,
    );
    expect(() => assertEncodable(font, '書', { context: 'a screenplay line' })).toThrow(
      /not a defect in the screenplay/,
    );
    expect(() => assertEncodable(font, '書', { context: 'a screenplay line' })).toThrow(
      /Embedding Courier Prime/,
    );
  });

  it('omits the block/element parenthetical when no blockId is given (e.g. the title page, the page number)', async () => {
    const pdfDoc = await PDFDocument.create({ updateMetadata: false });
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    try {
      assertEncodable(font, '書', { context: 'the title page' });
      throw new Error('expected assertEncodable to throw');
    } catch (error) {
      expect(String((error as Error).message)).toContain('the title page:');
      expect(String((error as Error).message)).not.toContain('(block');
    }
  });

  it('shows the block id with no trailing element when only element is omitted', async () => {
    const pdfDoc = await PDFDocument.create({ updateMetadata: false });
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    try {
      assertEncodable(font, '書', { context: 'a generated line', blockId: 'x0' });
      throw new Error('expected assertEncodable to throw');
    } catch (error) {
      expect(String((error as Error).message)).toContain('a generated line (block "x0")');
    }
  });
});
