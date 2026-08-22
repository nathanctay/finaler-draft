import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { fdxFilename, triggerFdxDownload } from './fdxDownload.js';

describe('fdxFilename', () => {
  it('appends .fdx to an ordinary title', () => {
    expect(fdxFilename('The Last Stop')).toBe('The Last Stop.fdx');
  });

  it('replaces characters that are invalid in a filename on Windows, collapsing the resulting whitespace', () => {
    expect(fdxFilename('Who/What: A "Title"?')).toBe('Who What A Title.fdx');
  });

  it('strips control characters and trims surrounding whitespace', () => {
    expect(fdxFilename('  Spaced Title \t\n')).toBe('Spaced Title.fdx');
  });

  it('falls back to a fixed name when the title is empty once sanitized', () => {
    expect(fdxFilename('///')).toBe('Untitled Screenplay.fdx');
  });
});

describe('triggerFdxDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an object URL for the serialized FDX, clicks a download anchor, and revokes the URL', () => {
    const objectUrl = 'blob:mock-url';
    const createObjectURL = vi.fn().mockReturnValue(objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');

    triggerFdxDownload(screenplayFixture);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Passed a Blob of the same XML `screenplayToFdx` would produce -- checked via its type
    // (jsdom's Blob doesn't expose synchronous text access) rather than re-deriving the exact
    // string, since the FDX content itself is `@finaler-draft/fdx`'s responsibility, not this
    // thin layer's.
    const blobArgument = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blobArgument.type).toBe('application/xml');

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const anchor = appendSpy.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(anchor.tagName).toBe('A');
    expect(anchor.href).toBe(objectUrl);
    expect(anchor.download).toBe('The Last Stop.fdx');

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

    expect(() => triggerFdxDownload(screenplayFixture)).toThrow('boom');
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });
});
