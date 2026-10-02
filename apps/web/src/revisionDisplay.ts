import type { RevisionListItem } from './api.js';

/**
 * Shared by the revision-history list route and the historical-preview route so the same
 * revision reads identically in both places -- a writer navigating from the list to a preview and
 * back must see the same label, not two independently worded descriptions of the same row.
 */
export function humanizeRevisionKind(revision: Pick<RevisionListItem, 'kind' | 'label'>): string {
  switch (revision.kind) {
    case 'named':
      return revision.label ?? 'Named revision';
    case 'idle_session':
      return 'Automatic — idle session';
    case 'structural_change':
      return 'Automatic — structural change';
    case 'export':
      return 'Automatic — export';
  }
}

export function formatRevisionCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** `previewMetadata` is `unknown` on the wire (`RevisionListItem`'s own schema comment) -- a
 * display convenience nothing here is ever allowed to trust the shape of without checking. */
export function revisionPreviewSummary(
  previewMetadata: RevisionListItem['previewMetadata'],
): string | undefined {
  if (
    !previewMetadata ||
    typeof previewMetadata !== 'object' ||
    !('sceneCount' in previewMetadata) ||
    !('blockCount' in previewMetadata)
  ) {
    return undefined;
  }
  const { sceneCount, blockCount } = previewMetadata as {
    sceneCount: unknown;
    blockCount: unknown;
  };
  if (typeof sceneCount !== 'number' || typeof blockCount !== 'number') return undefined;
  return `${sceneCount} scene${sceneCount === 1 ? '' : 's'}, ${blockCount} block${blockCount === 1 ? '' : 's'}`;
}
