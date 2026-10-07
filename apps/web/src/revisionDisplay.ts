import type { RevisionDiffSide, RevisionListItem } from './api.js';

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
      return 'Autosave — idle session';
    case 'structural_change':
      return 'Autosave — structural change';
    case 'export':
      return 'Autosave — export';
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

/**
 * Collaboration slice 4b's screenplay-aware diff. A `RevisionDiffSide` is either a real, stored
 * revision (same shape `humanizeRevisionKind` already knows how to read) or the one sentinel
 * value `id: 'current'` -- the screenplay's live, mutable projection, which has no `kind`, `label`,
 * or fixed `createdAt` of its own. Handling that sentinel here, once, is what lets every page that
 * renders a diff side (the diff view itself, and anywhere a future restore-preview reuses it) read
 * identically rather than re-deriving "what does this mean when it's 'current'" independently.
 */
export function humanizeRevisionDiffSide(side: RevisionDiffSide): string {
  if (side.id === 'current') return 'Current document';
  return `${humanizeRevisionKind({ kind: side.kind!, label: side.label })} — ${formatRevisionCreatedAt(side.createdAt!)}`;
}
