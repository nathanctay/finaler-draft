import { screenplayToPdf } from '@finaler-draft/pdf';
import type { Screenplay } from '@finaler-draft/screenplay';

/**
 * A filesystem-safe basename for a downloaded `.pdf` file, derived from the screenplay's title.
 * Identical sanitization to `fdxDownload.ts`'s `fdxFilename`/`docxDownload.ts`'s `docxFilename` --
 * the same Windows-reserved and control characters are invalid regardless of which export format
 * the file carries.
 */
export function pdfFilename(title: string): string {
  const sanitized = title
    // eslint-disable-next-line no-control-regex -- deliberately stripping C0 control characters.
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${sanitized.length > 0 ? sanitized : 'Untitled Screenplay'}.pdf`;
}

/**
 * This scope's client-side download (`progress/pdf-export.md`, item 7): serializes the current
 * canonical projection with the pure `screenplayToPdf` and saves it via a throwaway object URL
 * and a synthetic anchor click -- a mirror of `fdxDownload.ts`'s `triggerFdxDownload` and
 * `docxDownload.ts`'s `triggerDocxDownload`. Deliberately thin: every real PDF decision lives in
 * `@finaler-draft/pdf`, which knows nothing about the DOM, `Blob`, or `URL`; this function is the
 * only place those meet, so the pure serializer stays reusable by a future server-side export
 * unchanged.
 *
 * **`async`, unlike its FDX/DOCX siblings** -- `screenplayToPdf` itself is `async` (see that
 * package's `index.ts` for why: `pdf-lib`'s entire document API returns a `Promise` even for
 * this package's zero-I/O usage), so this wrapper is too. Callers already await it (`App.tsx`'s
 * File-menu handler).
 */
export async function triggerPdfDownload(screenplay: Screenplay): Promise<void> {
  const bytes = await screenplayToPdf(screenplay);
  // `.slice()`, not the raw `Uint8Array`, for the identical reason `docxDownload.ts` documents:
  // `BlobPart` requires a view concretely backed by `ArrayBuffer`, while `screenplayToPdf`'s
  // return type is backed by the wider `ArrayBufferLike`.
  const blob = new Blob([bytes.slice()], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = pdfFilename(screenplay.title);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}
