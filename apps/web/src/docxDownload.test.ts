import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { docxFilename, triggerDocxDownload } from './docxDownload.js';

describe('docxFilename', () => {
  it('appends .docx to an ordinary title', () => {
    expect(docxFilename('The Last Stop')).toBe('The Last Stop.docx');
  });

  it('replaces characters that are invalid in a filename on Windows, collapsing the resulting whitespace', () => {
    expect(docxFilename('Who/What: A "Title"?')).toBe('Who What A Title.docx');
  });

  it('strips control characters and trims surrounding whitespace', () => {
    expect(docxFilename('  Spaced Title \t\n')).toBe('Spaced Title.docx');
  });

  it('falls back to a fixed name when the title is empty once sanitized', () => {
    expect(docxFilename('///')).toBe('Untitled Screenplay.docx');
  });
});

describe('triggerDocxDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an object URL for the serialized DOCX, clicks a download anchor, and revokes the URL', () => {
    const objectUrl = 'blob:mock-url';
    const createObjectURL = vi.fn().mockReturnValue(objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');

    triggerDocxDownload(screenplayFixture);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Passed a Blob of the same bytes `screenplayToDocx` would produce -- checked via its MIME
    // type (jsdom's Blob doesn't expose synchronous byte access) rather than re-deriving the
    // exact bytes, since the DOCX content itself is `@finaler-draft/docx`'s responsibility, not
    // this thin layer's.
    const blobArgument = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blobArgument.type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const anchor = appendSpy.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(anchor.tagName).toBe('A');
    expect(anchor.href).toBe(objectUrl);
    expect(anchor.download).toBe('The Last Stop.docx');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(anchor);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it('still revokes the object URL if the anchor click throws', () => {
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

    expect(() => triggerDocxDownload(screenplayFixture)).toThrow('boom');
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });
});
