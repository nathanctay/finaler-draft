import { screenplayToFdx } from '@finaler-draft/fdx';
import type { Screenplay } from '@finaler-draft/screenplay';

/**
 * A filesystem-safe basename for a downloaded `.fdx` file, derived from the screenplay's title.
 * Replaces characters that are invalid, or reserved, in filenames on the platforms Final Draft
 * ships on (Windows forbids `\ / : * ? " < > |`; both major platforms also choke on raw control
 * characters) with a space, collapses the runs of whitespace that leaves behind, and falls back to
 * a fixed name if the title is empty once sanitized -- a title made entirely of forbidden
 * characters is unusual but not something `packages/screenplay`'s schema rules out (`titleSchema`
 * only bounds length), so this must not hand the browser an empty `download` attribute.
 */
export function fdxFilename(title: string): string {
  const sanitized = title
    // eslint-disable-next-line no-control-regex -- deliberately stripping C0 control characters.
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${sanitized.length > 0 ? sanitized : 'Untitled Screenplay'}.fdx`;
}

/**
 * This scope's client-side download (item 5 of `progress/fdx-export.md`): serializes the current
 * canonical projection with the pure `screenplayToFdx` and saves it via a throwaway object URL and
 * a synthetic anchor click -- the standard dependency-free way to hand a browser an in-memory file
 * to save. Deliberately thin: every real FDX decision lives in `@finaler-draft/fdx`, which knows
 * nothing about the DOM, `Blob`, or `URL`; this function is the only place those meet, so the pure
 * serializer stays reusable by a future server-side export unchanged.
 */
export function triggerFdxDownload(screenplay: Screenplay): void {
  const xml = screenplayToFdx(screenplay);
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fdxFilename(screenplay.title);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}
