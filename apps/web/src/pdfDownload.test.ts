import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DOCUMENT_SETTINGS, type Screenplay } from '@finaler-draft/screenplay';
import { pdfFilename, triggerPdfDownload } from './pdfDownload.js';

// Not `@finaler-draft/screenplay/fixtures`' `screenplayFixture`: it carries a `dual_dialogue`
// block, which `@finaler-draft/pdf` (unlike FDX/DOCX) refuses to paginate -- `packages/layout`'s
// `UnsupportedBlockError`, its column geometry being unsettled in plan.md. Using it here would
// make every test in this file reject before ever reaching the anchor-click/object-URL logic
// this file actually tests, so a small screenplay `@finaler-draft/pdf` can genuinely render is
// used instead.
const pdfSafeScreenplayFixture: Screenplay = {
  schemaVersion: 1,
  id: 'e1f8e6a8-e7bb-42bd-b2fa-0805d4064201',
  title: 'The Last Stop',
  documentSettings: DEFAULT_DOCUMENT_SETTINGS,
  titlePages: [],
  blocks: [{ id: 'a0', type: 'action', text: 'Ada waits.' }],
  annotations: [],
};

describe('pdfFilename', () => {
  it('appends .pdf to an ordinary title', () => {
    expect(pdfFilename('The Last Stop')).toBe('The Last Stop.pdf');
  });

  it('replaces characters that are invalid in a filename on Windows, collapsing the resulting whitespace', () => {
    expect(pdfFilename('Who/What: A "Title"?')).toBe('Who What A Title.pdf');
  });

  it('strips control characters and trims surrounding whitespace', () => {
    expect(pdfFilename('  Spaced Title \t\n')).toBe('Spaced Title.pdf');
  });

  it('falls back to a fixed name when the title is empty once sanitized', () => {
    expect(pdfFilename('///')).toBe('Untitled Screenplay.pdf');
  });
});

describe('triggerPdfDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an object URL for the serialized PDF, clicks a download anchor, and revokes the URL', async () => {
    const objectUrl = 'blob:mock-url';
    const createObjectURL = vi.fn().mockReturnValue(objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');

    await triggerPdfDownload(pdfSafeScreenplayFixture);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Passed a Blob of the same bytes `screenplayToPdf` would produce -- checked via its MIME
    // type (jsdom's Blob doesn't expose synchronous byte access) rather than re-deriving the
    // exact bytes, since the PDF content itself is `@finaler-draft/pdf`'s responsibility, not
    // this thin layer's.
    const blobArgument = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blobArgument.type).toBe('application/pdf');

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const anchor = appendSpy.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(anchor.tagName).toBe('A');
    expect(anchor.href).toBe(objectUrl);
    expect(anchor.download).toBe('The Last Stop.pdf');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(anchor);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it('still revokes the object URL if the anchor click throws', async () => {
    const objectUrl = 'blob:mock-url';
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue(objectUrl),
      revokeObjectURL,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(triggerPdfDownload(pdfSafeScreenplayFixture)).rejects.toThrow('boom');
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });
});
