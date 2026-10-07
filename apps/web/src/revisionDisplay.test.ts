import { describe, expect, it } from 'vitest';
import {
  formatRevisionCreatedAt,
  humanizeRevisionDiffSide,
  humanizeRevisionKind,
  revisionPreviewSummary,
} from './revisionDisplay.js';

describe('humanizeRevisionKind', () => {
  it('shows a named revision’s own label, falling back to a generic name only if absent', () => {
    expect(humanizeRevisionKind({ kind: 'named', label: 'Draft 2' })).toBe('Draft 2');
    expect(humanizeRevisionKind({ kind: 'named', label: null })).toBe('Named revision');
  });

  it('describes each automatic kind distinctly', () => {
    expect(humanizeRevisionKind({ kind: 'idle_session', label: null })).toBe(
      'Autosave — idle session',
    );
    expect(humanizeRevisionKind({ kind: 'structural_change', label: null })).toBe(
      'Autosave — structural change',
    );
    expect(humanizeRevisionKind({ kind: 'export', label: null })).toBe('Autosave — export');
  });
});

describe('formatRevisionCreatedAt', () => {
  it('formats an ISO timestamp using the viewer’s own locale conventions', () => {
    const iso = '2026-08-06T15:04:00.000Z';
    expect(formatRevisionCreatedAt(iso)).toBe(new Date(iso).toLocaleString());
  });
});

describe('revisionPreviewSummary', () => {
  it('summarizes scene and block counts when both are present and numeric', () => {
    expect(revisionPreviewSummary({ sceneCount: 3, blockCount: 40 })).toBe('3 scenes, 40 blocks');
    expect(revisionPreviewSummary({ sceneCount: 1, blockCount: 1 })).toBe('1 scene, 1 block');
  });

  it('returns undefined for anything that is not the expected shape, never guessing at a summary', () => {
    expect(revisionPreviewSummary(null)).toBeUndefined();
    expect(revisionPreviewSummary(undefined)).toBeUndefined();
    expect(revisionPreviewSummary('not an object')).toBeUndefined();
    expect(revisionPreviewSummary({})).toBeUndefined();
    expect(revisionPreviewSummary({ sceneCount: 3 })).toBeUndefined();
    expect(revisionPreviewSummary({ blockCount: 40 })).toBeUndefined();
    expect(revisionPreviewSummary({ sceneCount: '3', blockCount: 40 })).toBeUndefined();
    expect(revisionPreviewSummary({ sceneCount: 3, blockCount: '40' })).toBeUndefined();
  });
});

describe('humanizeRevisionDiffSide', () => {
  it('labels the live document distinctly, with no kind/label/timestamp to read', () => {
    expect(
      humanizeRevisionDiffSide({ id: 'current', kind: null, label: null, createdAt: null }),
    ).toBe('Current document');
  });

  it('reads a real revision side exactly like humanizeRevisionKind plus its timestamp', () => {
    const iso = '2026-08-06T15:04:00.000Z';
    expect(
      humanizeRevisionDiffSide({ id: 'rev-1', kind: 'named', label: 'Draft 2', createdAt: iso }),
    ).toBe(`Draft 2 — ${formatRevisionCreatedAt(iso)}`);
    expect(
      humanizeRevisionDiffSide({ id: 'rev-2', kind: 'idle_session', label: null, createdAt: iso }),
    ).toBe(`Autosave — idle session — ${formatRevisionCreatedAt(iso)}`);
  });
});
