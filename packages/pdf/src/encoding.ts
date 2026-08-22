import type { PDFFont } from 'pdf-lib';

/** Where a piece of text came from, for the error `assertEncodable` throws -- never used for a position. */
export type EncodableLocation = {
  readonly context: string;
  readonly blockId?: string;
  readonly element?: string;
};

function describeLocation(location: EncodableLocation): string {
  if (location.blockId === undefined) {
    return location.context;
  }
  const element = location.element === undefined ? '' : `, ${location.element}`;
  return `${location.context} (block "${location.blockId}"${element})`;
}

/**
 * PDF's built-in, un-embedded Courier -- this slice's approved typeface, `progress/pdf-export.md`
 * item 2 -- uses WinAnsiEncoding, a Latin-1-ish subset that covers plain Latin text and the
 * typographic characters that show up constantly (curly quotes, em and en dashes) but excludes
 * non-Latin scripts and emoji. `pdf-lib`'s `PDFFont.encodeText` throws when it meets a character
 * outside that set, and its own message already names the character and its code point (e.g.
 * `WinAnsi cannot encode "書" (0x66F8)`) -- reused verbatim here rather than re-deriving the same
 * fact from a second copy of the encoding table, the same "don't reimplement it" reasoning that
 * governs `graphemeLength`.
 *
 * What `pdf-lib`'s own message lacks is *where* in the screenplay the character came from, which
 * a writer needs to act on it, and that this is a limitation of the un-embedded standard font
 * rather than a defect in their script -- both added here. Per the standing rule (fail loudly,
 * never silently substitute or drop a character), this is a hard stop: no transliteration, no
 * silent fallback glyph. It is a real, foreseeable limitation of this slice specifically --
 * plan.md's "Known limitation: characters outside the screenplay face" already treats non-Latin
 * fidelity as an open product question, and embedding Courier Prime (the owner's stated next step
 * for this format, `progress/pdf-export.md`) removes this restriction entirely, because an
 * embedded font can carry its own, much broader subsetted encoding.
 */
export function assertEncodable(font: PDFFont, text: string, location: EncodableLocation): void {
  try {
    font.encodeText(text);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `screenplayToPdf cannot render text in ${describeLocation(location)}: ${reason}. ` +
        `Excerpt: "${text}". This is a limitation of PDF's built-in, un-embedded Courier font, ` +
        'which only supports the WinAnsi character set (accented Latin, curly quotes, em/en ' +
        'dashes -- but not non-Latin scripts or emoji), not a defect in the screenplay. ' +
        "Embedding Courier Prime -- the owner's planned next step for this format -- removes " +
        'this limitation entirely; see progress/pdf-export.md.',
      { cause: cause instanceof Error ? cause : undefined },
    );
  }
}
