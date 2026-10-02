import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createLocalScreenplayYDoc,
  createScreenplayEditorInit,
  SCREENPLAY_YJS_FRAGMENT,
  seedScreenplayYDoc,
} from '@finaler-draft/screenplay-editor';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { Screenplay } from '@finaler-draft/screenplay';

vi.mock('@finaler-draft/database', () => ({
  insertRevisionIfChanged: vi.fn(),
  latestRevision: vi.fn(),
}));
vi.mock('./updateLog.js', () => ({
  reconstructDocumentState: vi.fn(),
}));

import { insertRevisionIfChanged, latestRevision } from '@finaler-draft/database';
import { reconstructDocumentState } from './updateLog.js';
import {
  createIdleSessionRevisionScheduler,
  maybeCreateIdleSessionRevision,
  maybeCreateStructuralChangeRevision,
} from './revisions.js';

const mockInsertRevisionIfChanged = insertRevisionIfChanged as ReturnType<typeof vi.fn>;
const mockLatestRevision = latestRevision as ReturnType<typeof vi.fn>;
const mockReconstructDocumentState = reconstructDocumentState as ReturnType<typeof vi.fn>;

const SCREENPLAY_ID = '00000000-0000-4000-8000-000000000010';
const EPOCH = 0;

function bareDoc(content: Parameters<typeof createLocalScreenplayYDoc>[0]) {
  return createLocalScreenplayYDoc(content);
}

function emptyScreenplay(): Screenplay {
  // `annotations` cleared along with `blocks`: `screenplayFixture`'s own annotations anchor to
  // specific block ids that would no longer exist, which `screenplaySchema` rejects.
  return { ...screenplayFixture, id: SCREENPLAY_ID, blocks: [], annotations: [] };
}

beforeEach(() => {
  mockInsertRevisionIfChanged.mockReset();
  mockLatestRevision.mockReset();
  mockReconstructDocumentState.mockReset();
});

describe('createIdleSessionRevisionScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onIdle only after idleMs has passed with no further activity', async () => {
    const onIdle = vi.fn().mockResolvedValue(undefined);
    const scheduler = createIdleSessionRevisionScheduler(onIdle, { idleMs: 1000 });

    scheduler.noteActivity(SCREENPLAY_ID, EPOCH);
    await vi.advanceTimersByTimeAsync(999);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledWith(SCREENPLAY_ID, EPOCH);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('resets the timer on every fresh activity, so continued editing never fires it', async () => {
    const onIdle = vi.fn().mockResolvedValue(undefined);
    const scheduler = createIdleSessionRevisionScheduler(onIdle, { idleMs: 1000 });

    scheduler.noteActivity(SCREENPLAY_ID, EPOCH);
    await vi.advanceTimersByTimeAsync(700);
    scheduler.noteActivity(SCREENPLAY_ID, EPOCH); // resets the clock before it would have fired
    await vi.advanceTimersByTimeAsync(700);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('tracks each screenplay independently', async () => {
    const onIdle = vi.fn().mockResolvedValue(undefined);
    const scheduler = createIdleSessionRevisionScheduler(onIdle, { idleMs: 1000 });
    const OTHER = '00000000-0000-4000-8000-000000000099';

    scheduler.noteActivity(SCREENPLAY_ID, EPOCH);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.noteActivity(OTHER, EPOCH);
    await vi.advanceTimersByTimeAsync(500);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledWith(SCREENPLAY_ID, EPOCH);
    await vi.advanceTimersByTimeAsync(500);
    expect(onIdle).toHaveBeenCalledTimes(2);
    expect(onIdle).toHaveBeenCalledWith(OTHER, EPOCH);
  });

  it('dispose cancels every pending timer -- onIdle never fires for work scheduled before it', async () => {
    const onIdle = vi.fn().mockResolvedValue(undefined);
    const scheduler = createIdleSessionRevisionScheduler(onIdle, { idleMs: 1000 });

    scheduler.noteActivity(SCREENPLAY_ID, EPOCH);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('reports a rejected onIdle through onError, keyed to the screenplay id', async () => {
    const failure = new Error('write failed');
    const onIdle = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();
    const scheduler = createIdleSessionRevisionScheduler(onIdle, { idleMs: 1000, onError });

    scheduler.noteActivity(SCREENPLAY_ID, EPOCH);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure, SCREENPLAY_ID));
  });
});

describe('maybeCreateStructuralChangeRevision', () => {
  it('attempts no write when there is no prior revision and the screenplay is empty', async () => {
    mockLatestRevision.mockResolvedValue(undefined);
    const result = await maybeCreateStructuralChangeRevision(undefined as unknown as Pool, {
      screenplayId: SCREENPLAY_ID,
      epoch: EPOCH,
      screenplay: emptyScreenplay(),
    });
    expect(result).toBeUndefined();
    expect(mockInsertRevisionIfChanged).not.toHaveBeenCalled();
  });

  it('creates the very first revision once real content exists and none has been recorded yet', async () => {
    mockLatestRevision.mockResolvedValue(undefined);
    mockInsertRevisionIfChanged.mockResolvedValue({ id: 'r1', created: true });

    const result = await maybeCreateStructuralChangeRevision(undefined as unknown as Pool, {
      screenplayId: SCREENPLAY_ID,
      epoch: EPOCH,
      screenplay: screenplayFixture,
    });

    expect(result).toEqual({ id: 'r1', created: true });
    expect(mockInsertRevisionIfChanged).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        screenplayId: SCREENPLAY_ID,
        sourceEpoch: EPOCH,
        kind: 'structural_change',
        label: null,
        authoredBy: null,
      }),
    );
  });

  it('does not attempt a write for an ordinary minor edit against the latest revision', async () => {
    mockLatestRevision.mockResolvedValue({
      id: 'r1',
      canonicalScreenplay: screenplayFixture,
    });
    const edited: Screenplay = {
      ...screenplayFixture,
      blocks: screenplayFixture.blocks.map((block, i) =>
        i === 0 && block.type === 'action' ? { ...block, text: `${block.text} Edited.` } : block,
      ),
    };

    await maybeCreateStructuralChangeRevision(undefined as unknown as Pool, {
      screenplayId: SCREENPLAY_ID,
      epoch: EPOCH,
      screenplay: edited,
    });

    expect(mockInsertRevisionIfChanged).not.toHaveBeenCalled();
  });

  it('attempts a write when a scene is added relative to the latest revision', async () => {
    mockLatestRevision.mockResolvedValue({
      id: 'r1',
      canonicalScreenplay: emptyScreenplay(),
    });
    mockInsertRevisionIfChanged.mockResolvedValue({ id: 'r2', created: true });

    await maybeCreateStructuralChangeRevision(undefined as unknown as Pool, {
      screenplayId: SCREENPLAY_ID,
      epoch: EPOCH,
      screenplay: screenplayFixture,
    });

    expect(mockInsertRevisionIfChanged).toHaveBeenCalled();
  });

  it('does nothing and logs, rather than guessing, when the latest revision is unreadable', async () => {
    mockLatestRevision.mockResolvedValue({
      id: 'r1',
      canonicalScreenplay: { not: 'a valid screenplay' },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await maybeCreateStructuralChangeRevision(undefined as unknown as Pool, {
      screenplayId: SCREENPLAY_ID,
      epoch: EPOCH,
      screenplay: screenplayFixture,
    });

    expect(result).toBeUndefined();
    expect(mockInsertRevisionIfChanged).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('structural_change_baseline_unreadable'),
    );
    errorSpy.mockRestore();
  });
});

describe('maybeCreateIdleSessionRevision', () => {
  function fakePool(row: { title: string; canonicalScreenplay: unknown } | undefined) {
    return {
      async query() {
        return { rows: row ? [row] : [] };
      },
    } as unknown as Pool;
  }

  it('does nothing when the screenplay has never been opened collaboratively', async () => {
    mockReconstructDocumentState.mockResolvedValue(undefined);
    const result = await maybeCreateIdleSessionRevision(fakePool(undefined), {
      screenplayId: SCREENPLAY_ID,
      epoch: EPOCH,
    });
    expect(result).toBeUndefined();
    expect(mockInsertRevisionIfChanged).not.toHaveBeenCalled();
  });

  it('does nothing when the screenplay row is gone', async () => {
    const doc = bareDoc(
      createScreenplayEditorInit(new Y.Doc().getXmlFragment(SCREENPLAY_YJS_FRAGMENT)).content,
    );
    mockReconstructDocumentState.mockResolvedValue({ doc, throughSequence: 3 });
    const result = await maybeCreateIdleSessionRevision(fakePool(undefined), {
      screenplayId: SCREENPLAY_ID,
      epoch: EPOCH,
    });
    expect(result).toBeUndefined();
    expect(mockInsertRevisionIfChanged).not.toHaveBeenCalled();
  });

  it('creates an idle-session revision from the reconstructed, projected document', async () => {
    const content = createScreenplayEditorInit(
      new Y.Doc().getXmlFragment(SCREENPLAY_YJS_FRAGMENT),
    ).content;
    const doc = seedScreenplayYDoc(content, undefined, undefined);
    mockReconstructDocumentState.mockResolvedValue({ doc, throughSequence: 7 });
    mockInsertRevisionIfChanged.mockResolvedValue({ id: 'r3', created: true });

    const result = await maybeCreateIdleSessionRevision(
      fakePool({ title: 'Row Title', canonicalScreenplay: {} }),
      { screenplayId: SCREENPLAY_ID, epoch: EPOCH },
    );

    expect(result).toEqual({ id: 'r3', created: true });
    expect(mockInsertRevisionIfChanged).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        screenplayId: SCREENPLAY_ID,
        sourceEpoch: EPOCH,
        kind: 'idle_session',
        label: null,
        authoredBy: null,
      }),
    );
  });
});
