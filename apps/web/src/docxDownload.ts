import { screenplayToDocx } from '@finaler-draft/docx';
import type { Screenplay } from '@finaler-draft/screenplay';

/**
 * A filesystem-safe basename for a downloaded `.docx` file, derived from the screenplay's title.
 * Identical sanitization to `fdxDownload.ts`'s `fdxFilename` -- the same Windows-reserved and
 * control characters are invalid regardless of which export format the file carries.
 */
export function docxFilename(title: string): string {
  const sanitized = title
    // eslint-disable-next-line no-control-regex -- deliberately stripping C0 control characters.
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${sanitized.length > 0 ? sanitized : 'Untitled Screenplay'}.docx`;
}

/**
 * This scope's client-side download (`progress/docx-export.md` item 10): serializes the current
 * canonical projection with the pure `screenplayToDocx` and saves it via a throwaway object URL
 * and a synthetic anchor click -- a line-for-line mirror of `fdxDownload.ts`'s
 * `triggerFdxDownload`. Deliberately thin: every real DOCX decision lives in `@finaler-draft/docx`,
 * which knows nothing about the DOM, `Blob`, or `URL`; this function is the only place those meet,
 * so the pure serializer stays reusable by a future server-side export unchanged.
 */
export function triggerDocxDownload(screenplay: Screenplay): void {
  const bytes = screenplayToDocx(screenplay);
  // `.slice()`, not the raw `Uint8Array`: `BlobPart` requires a view backed concretely by
  // `ArrayBuffer`, while `screenplayToDocx`'s return type is backed by the wider
  // `ArrayBufferLike` (which also admits `SharedArrayBuffer`) -- a real type mismatch under this
  // TypeScript/DOM-lib version, not a runtime concern (`zipSync` never produces a
  // `SharedArrayBuffer`-backed view). `.slice()` is the idiomatic way to get a concretely-typed
  // copy rather than an unsound cast.
  const blob = new Blob([bytes.slice()], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = docxFilename(screenplay.title);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}
