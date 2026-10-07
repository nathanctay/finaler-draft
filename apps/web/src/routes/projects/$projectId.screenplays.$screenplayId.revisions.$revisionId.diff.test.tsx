import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { diffScreenplays, type Screenplay, type ScreenplayBlock } from '@finaler-draft/screenplay';
import { DEFAULT_DOCUMENT_SETTINGS } from '@finaler-draft/screenplay/pageFormat';
import type { RevisionDiffResult, ScreenplayDiff, SessionUser } from '../../api.js';
import { humanizeRevisionDiffSide } from '../../revisionDisplay.js';
import {
  projectId,
  resetRouteHarness,
  revisionId,
  routeState,
  screenplayId,
} from '../../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import(
  './$projectId.screenplays.$screenplayId.revisions.$revisionId.diff.js'
);
const RevisionDiffPage = Route.options.component!;

const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function action(index: number, text: string): ScreenplayBlock {
  return { id: uuidFor(index), type: 'action', text };
}

function dialogue(index: number, text: string): ScreenplayBlock {
  return { id: uuidFor(index), type: 'dialogue', text };
}

function character(index: number, text: string): ScreenplayBlock {
  return { id: uuidFor(index), type: 'character', text };
}

function sceneHeading(index: number, text: string): ScreenplayBlock {
  return { id: uuidFor(index), type: 'scene_heading', text };
}

function screenplay(blocks: ScreenplayBlock[], overrides: Partial<Screenplay> = {}): Screenplay {
  return {
    id: 'fixture',
    title: 'Fixture',
    schemaVersion: 1,
    titlePages: [],
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    annotations: [],
    blocks,
    ...overrides,
  };
}

/**
 * Every fixture here is two real screenplays plus the **real** `diffScreenplays` output, not a
 * hand-written diff. The view's job is to render what that function actually reports, and a
 * hand-written diff would let a view that misreads a real field pass.
 */
function diffResult(older: Screenplay, newer: Screenplay): RevisionDiffResult {
  return {
    screenplayId,
    older: {
      id: revisionId,
      kind: 'named' as const,
      label: 'Draft 2',
      createdAt: '2026-08-06T15:04:00.000Z',
    },
    newer: { id: 'current', kind: null, label: null, createdAt: null },
    diff: diffScreenplays(older, newer) as ScreenplayDiff,
    olderScreenplay: older,
    newerScreenplay: newer,
  };
}

const identicalBlocks = [
  sceneHeading(1, 'INT. KITCHEN - DAY'),
  action(2, 'Ada stirs a pot.'),
  character(3, 'ADA'),
  dialogue(4, 'It needs salt.'),
];
const emptyDiffResult = diffResult(
  screenplay(identicalBlocks),
  screenplay(JSON.parse(JSON.stringify(identicalBlocks)) as ScreenplayBlock[]),
);

function renderWith(data: RevisionDiffResult) {
  routeState.query = { data, isError: false, isLoading: false };
  return render(<RevisionDiffPage />);
}

/** Every rendered manuscript row, in document order, with its mark -- the shape of the one continuous
 * read this view replaced a nested list of sections with. */
function renderedRows(): { mark: string | null; kind: string | null; text: string }[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-diff-row]')).map((element) => ({
    kind: element.getAttribute('data-diff-row'),
    mark: element.getAttribute('data-diff-mark'),
    text: element.textContent ?? '',
  }));
}

/** One Inspector section, found by its own `<h2>` -- the Inspector is where the comparison's metadata
 * lives now (the two sides, the counts, the document-level changes, the legend). */
function inspectorSection(heading: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>('.inspector-section')).find(
    (section) => section.querySelector('h2')?.textContent === heading,
  );
  if (!match) throw new Error(`No Inspector section headed ${JSON.stringify(heading)}.`);
  return match;
}

/** Every row of whichever Navigator tab is open, in order, with its change marking. */
function navigatorRows(): { marking: string | null; text: string }[] {
  return Array.from(screen.getByRole('tabpanel').querySelectorAll<HTMLElement>('li > button')).map(
    (button) => ({
      marking: button.getAttribute('data-navigator-status'),
      text: button.textContent ?? '',
    }),
  );
}

function rowFor(text: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>('[data-diff-row="block"]')).find(
    (element) => (element.textContent ?? '').includes(text),
  );
  if (!row) throw new Error(`No manuscript row contains ${JSON.stringify(text)}.`);
  return row;
}

describe('revision diff page: guards and states', () => {
  beforeEach(resetRouteHarness);

  it('redirects a signed-out visitor to /sign-in instead of rendering, the same guard every other protected route uses', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  it('rejects malformed identifiers before the page consumes them', () => {
    const parse = Route.options.params?.parse as
      | ((params: { projectId: string; revisionId: string; screenplayId: string }) => unknown)
      | undefined;
    expect(parse).toBeDefined();
    expect(parse?.({ projectId, revisionId, screenplayId })).toEqual({
      projectId,
      revisionId,
      screenplayId,
    });
    expect(() => parse?.({ projectId, revisionId: 'bad-id', screenplayId })).toThrow();
  });

  it('shows a loading state, then an unavailable state', () => {
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<RevisionDiffPage />);
    expect(screen.getByText('Loading diff…')).toBeVisible();

    routeState.query = { data: undefined, isError: true, isLoading: false };
    rerender(<RevisionDiffPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('This diff could not be loaded.');
  });

  it('links back to the revision history, not to this revision’s own preview', () => {
    renderWith(emptyDiffResult);
    expect(screen.getByRole('link', { name: 'Back to revisions' })).toHaveAttribute(
      'href',
      '/projects/$projectId/screenplays/$screenplayId/revisions',
    );
  });

  it('renders "No differences." for two identical screenplays, and draws no manuscript at all', () => {
    renderWith(emptyDiffResult);
    expect(screen.getByText('No differences.')).toBeVisible();
    expect(document.querySelector('.diff-manuscript')).toBeNull();
    expect(renderedRows()).toEqual([]);
  });

  /** Named in the banner's sentence, and again in the Inspector's "Comparing" section -- deliberately
   * both, since the banner cannot be closed and the Inspector can (see the route's banner comment). */
  it('labels each side distinctly, including the "Current document" sentinel for the live side', () => {
    renderWith(emptyDiffResult);

    // `.readonly-banner`, not `getByRole('status')`: the toolbar's zoom `<output>` also has the
    // implicit `status` role, exactly as it does in the editor.
    const banner = document.querySelector<HTMLElement>('.readonly-banner');
    expect(banner).not.toBeNull();
    expect(within(banner as HTMLElement).getByText(/Draft 2/u)).toBeVisible();
    expect(within(banner as HTMLElement).getByText(/Current document/u)).toBeVisible();

    const comparing = inspectorSection('Comparing');
    expect(comparing.textContent).toMatch(/Draft 2/u);
    expect(comparing.textContent).toMatch(/Current document/u);
  });
});

describe('revision diff page: the screenplay, with changes marked in place', () => {
  beforeEach(resetRouteHarness);

  const older = screenplay([
    sceneHeading(1, 'INT. KITCHEN - DAY'),
    action(2, 'Ada stirs a pot.'),
    action(3, 'A beat that gets cut.'),
    sceneHeading(4, 'EXT. GARDEN - DAY'),
    action(5, 'Rain starts.'),
    sceneHeading(6, 'INT. HALL - NIGHT'),
    character(7, 'ADA'),
    dialogue(8, 'I waited by the window.'),
  ]);
  const newer = screenplay([
    sceneHeading(1, 'INT. KITCHEN - DAY'),
    action(2, 'Ada stirs a pot.'),
    action(9, 'She adds salt.'),
    sceneHeading(6, 'INT. HALL - NIGHT'),
    character(7, 'ADA'),
    dialogue(8, 'I waited by the doorway.'),
    sceneHeading(4, 'EXT. GARDEN - DAY'),
    action(5, 'Rain starts.'),
  ]);

  /**
   * The redesign, asserted as a whole: the document reads top to bottom as a screenplay, unchanged
   * lines included, with each change marked where it happened. The view it replaced rendered
   * `<section><h2>Scenes</h2><ul>…` and showed none of the unchanged content, which is what made it
   * unreadable as a document.
   */
  it('renders every line of the document in order, unchanged lines included, with no change-report sections', () => {
    renderWith(diffResult(older, newer));

    expect(renderedRows()).toEqual([
      { kind: 'block', mark: 'unchanged', text: 'INT. KITCHEN - DAY' },
      { kind: 'block', mark: 'unchanged', text: 'Ada stirs a pot.' },
      { kind: 'block', mark: 'removed', text: 'Removed. -A beat that gets cut.' },
      {
        kind: 'scene-move',
        mark: null,
        text: 'MOVEDScene moved from here: EXT. GARDEN - DAY was scene 2, now scene 3',
      },
      { kind: 'block', mark: 'added', text: 'Added. +She adds salt.' },
      { kind: 'block', mark: 'unchanged', text: 'INT. HALL - NIGHT' },
      { kind: 'block', mark: 'unchanged', text: 'ADA' },
      { kind: 'block', mark: 'changed', text: 'Changed. ~I waited by the window.doorway.' },
      {
        kind: 'scene-move',
        mark: null,
        text: 'MOVEDScene moved to here: EXT. GARDEN - DAY was scene 2, now scene 3',
      },
      { kind: 'block', mark: 'unchanged', text: 'EXT. GARDEN - DAY' },
      { kind: 'block', mark: 'unchanged', text: 'Rain starts.' },
    ]);
    // None of the old report scaffolding survives.
    expect(screen.queryByRole('heading', { name: 'Scenes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Title page' })).not.toBeInTheDocument();
    expect(document.querySelector('.diff-scene-list')).toBeNull();
    expect(document.querySelector('.diff-status-badge')).toBeNull();
  });

  it('renders each row at the real screenplay element geometry, reusing the editor’s own manuscript classes', () => {
    renderWith(diffResult(older, newer));

    // The same containers and the same per-element attribute the editor's own blocks are laid out by,
    // so indents, measures and spacing come from one authority rather than a parallel stylesheet.
    const body = document.querySelector('.page.diff-manuscript .script-body');
    expect(body).not.toBeNull();
    expect(rowFor('INT. KITCHEN - DAY')).toHaveAttribute(
      'data-screenplay-element',
      'scene_heading',
    );
    expect(rowFor('Ada stirs a pot.')).toHaveAttribute('data-screenplay-element', 'action');
    expect(rowFor('ADA')).toHaveAttribute('data-screenplay-element', 'character');
    expect(rowFor('I waited by the')).toHaveAttribute('data-screenplay-element', 'dialogue');
    for (const row of document.querySelectorAll('[data-diff-row="block"]')) {
      expect(row).toHaveAttribute('data-screenplay-block');
    }
  });

  it('structurally cannot edit the document: no editing canvas, and no accept or reject control', () => {
    renderWith(diffResult(older, newer));
    expect(screen.queryByRole('textbox', { name: 'Screenplay editing canvas' })).toBeNull();
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  /** A changed line marks only the words that changed. This is the assertion the word-level mutation
   * has to break: see `progress/screenplay-diff.md`'s mutation-testing section. */
  it('marks only the changed words inside a changed line, leaving the rest of the speech unmarked', () => {
    renderWith(diffResult(older, newer));
    const row = rowFor('I waited by the');

    expect(within(row).getByText('window.').tagName).toBe('DEL');
    expect(within(row).getByText('doorway.').tagName).toBe('INS');
    // The unchanged words are plain text in the row, inside no mark element at all.
    const markedText = Array.from(row.querySelectorAll('del, ins'))
      .map((element) => element.textContent ?? '')
      .join('');
    expect(markedText).toBe('window.doorway.');
    expect(row.textContent).toContain('I waited by the ');
    expect(markedText.length).toBeLessThan((row.textContent ?? '').length / 2);
  });

  it('marks an added line with <ins> and a removed line with <del>, each in full', () => {
    renderWith(diffResult(older, newer));
    expect(within(rowFor('She adds salt.')).getByText('She adds salt.').tagName).toBe('INS');
    expect(within(rowFor('A beat that gets cut.')).getByText('A beat that gets cut.').tagName).toBe(
      'DEL',
    );
  });

  /**
   * The non-colour cues, asserted as the brief requires rather than left to the stylesheet: a glyph in
   * the gutter, a strikethrough or underline on the words themselves, and a label in words for a
   * reader using a screen reader. A reader who cannot distinguish the colours still has three signals.
   */
  it('gives added and removed content a reader-visible cue that is not colour', () => {
    renderWith(diffResult(older, newer));

    const added = rowFor('She adds salt.');
    const removed = rowFor('A beat that gets cut.');
    const changed = rowFor('I waited by the');

    // 1. A gutter glyph, out in the page margin, distinct per mark.
    expect(added.querySelector('.diff-gutter-glyph')?.textContent).toBe('+');
    expect(removed.querySelector('.diff-gutter-glyph')?.textContent).toBe('-');
    expect(changed.querySelector('.diff-gutter-glyph')?.textContent).toBe('~');

    // 2. The semantic element that carries the decoration: <ins> underlines, <del> strikes through.
    expect(added.querySelector('ins')).not.toBeNull();
    expect(removed.querySelector('del')).not.toBeNull();

    // 3. A label in words, announced before the line's own text.
    expect(added.textContent).toMatch(/^Added\./);
    expect(removed.textContent).toMatch(/^Removed\./);
    expect(changed.textContent).toMatch(/^Changed\./);

    // And the legend states the same vocabulary on the page itself.
    for (const mark of ['added', 'removed', 'changed', 'moved']) {
      expect(document.querySelector(`[data-diff-legend="${mark}"]`)).not.toBeNull();
    }
  });

  /** A relocated scene reads as a move at both ends, and nowhere as a deletion plus an insertion.
   * This is the assertion the delete-plus-add mutation has to break. */
  it('renders a relocated scene as a move at each end, never as a deletion plus an insertion', () => {
    renderWith(diffResult(older, newer));

    const markers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-diff-row="scene-move"]'),
    );
    expect(markers).toHaveLength(2);
    expect(markers.map((marker) => marker.getAttribute('data-diff-move-place'))).toEqual([
      'origin',
      'destination',
    ]);
    expect(markers[0]!.textContent).toContain('Scene moved from here: EXT. GARDEN - DAY');
    expect(markers[1]!.textContent).toContain('Scene moved to here: EXT. GARDEN - DAY');
    expect(new Set(markers.map((marker) => marker.getAttribute('data-diff-scene-id')))).toEqual(
      new Set([uuidFor(4)]),
    );

    // The relocated scene's own lines carry no mark of any kind -- nothing in them changed.
    for (const text of ['EXT. GARDEN - DAY', 'Rain starts.']) {
      const row = rowFor(text);
      expect(row).toHaveAttribute('data-diff-mark', 'unchanged');
      expect(row.querySelector('del, ins')).toBeNull();
    }
    // And no row anywhere in the document claims that scene was deleted or inserted.
    const markedTexts = Array.from(document.querySelectorAll('del, ins')).map(
      (element) => element.textContent ?? '',
    );
    expect(markedTexts.some((text) => text.includes('Rain starts.'))).toBe(false);
    expect(markedTexts.some((text) => text.includes('EXT. GARDEN - DAY'))).toBe(false);
  });

  it('summarises the comparison in counts a reader can scan before reading it', () => {
    renderWith(diffResult(older, newer));
    expect(document.querySelector('.diff-summary')?.textContent).toBe(
      '1 line added, 1 line removed, 1 line changed, 1 scene moved',
    );
  });

  /**
   * The pagination caveat, which the brief requires be obvious in the interface rather than left for a
   * reader to discover: removed lines shown in place make this longer than the script, so its page
   * breaks are not the document's -- and no page boundary is drawn, because none could be truthful.
   */
  it('states in the interface that this is a comparison and not a paginated script', () => {
    renderWith(diffResult(older, newer));
    const caveat = screen.getByRole('note');
    expect(caveat).toBeVisible();
    expect(caveat.textContent).toMatch(/not a paginated script/i);
    expect(caveat.textContent).toMatch(/page breaks are not the document's/i);
    expect(caveat.textContent).toMatch(/can be edited, accepted, or rejected/i);
    expect(document.querySelector('.page.diff-manuscript')).not.toBeNull();
    expect(document.querySelector('.page-number')).toBeNull();
  });

  /** Screen-only, and never mistakable for production revision marks (plan.md's "Locked scripts"
   * asterisks against a lock), which this view must never become or reuse. */
  it('carries a print refusal rather than a printable manuscript', () => {
    renderWith(diffResult(older, newer));
    const refusal = document.querySelector('.diff-print-refusal');
    expect(refusal).not.toBeNull();
    expect(refusal?.textContent).toMatch(/must not be printed/i);
  });

  /** Zoom is the toolbar's control now -- the editor's own, by the same accessible names -- not a
   * one-off `<select>` in the banner. It is live here: there is one sheet, and a reader may want it
   * larger. */
  it('reads at more than one scale, through the toolbar’s own zoom control', async () => {
    const user = userEvent.setup();
    renderWith(diffResult(older, newer));

    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('100%');
    expect(document.querySelector<HTMLElement>('[data-diff-manuscript]')?.style.zoom).toBe('1');

    await user.selectOptions(within(toolbar).getByRole('combobox', { name: 'Zoom preset' }), '50');
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('50%');
    expect(document.querySelector<HTMLElement>('[data-diff-manuscript]')?.style.zoom).toBe('0.5');

    await user.click(within(toolbar).getByRole('button', { name: 'Zoom in' }));
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('60%');
    await user.click(within(toolbar).getByRole('button', { name: 'Zoom out' }));
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('50%');
    // The floor is the application's own, from `zoomPresets.ts`, not a second one written down here.
    await user.click(within(toolbar).getByRole('button', { name: 'Zoom out' }));
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('50%');
  });
});

describe('revision diff page: element type, scene number and structural rows', () => {
  beforeEach(resetRouteHarness);

  it('names an element-type change in the gutter and in the announced label', () => {
    renderWith(
      diffResult(
        screenplay([{ id: uuidFor(1), type: 'action', text: 'Same words.' }]),
        screenplay([{ id: uuidFor(1), type: 'dialogue', text: 'Same words.' }]),
      ),
    );
    const row = rowFor('Same words.');
    expect(row).toHaveAttribute('data-screenplay-element', 'dialogue');
    expect(row.querySelector('.diff-gutter')?.textContent).toContain('ACTION>DIAL');
    expect(row.textContent).toContain('Element changed from action to dialogue');
    // The words themselves did not change, so none of them is marked.
    expect(row.querySelector('del, ins')).toBeNull();
  });

  it('announces a scene-number change without marking the heading’s words', () => {
    renderWith(
      diffResult(
        screenplay([
          { id: uuidFor(1), type: 'scene_heading', text: 'INT. HALL - DAY', sceneNumber: '4' },
        ]),
        screenplay([
          { id: uuidFor(1), type: 'scene_heading', text: 'INT. HALL - DAY', sceneNumber: '5' },
        ]),
      ),
    );
    const row = rowFor('INT. HALL - DAY');
    expect(row.textContent).toContain('Scene number 4 to 5');
    expect(row.querySelector('del, ins')).toBeNull();
  });

  it('marks a line that moved on its own with MOVED in the gutter, still unchanged and unmarked', () => {
    renderWith(
      diffResult(
        screenplay([action(1, 'First beat.'), action(2, 'Second beat.'), action(3, 'Third beat.')]),
        screenplay([action(2, 'Second beat.'), action(3, 'Third beat.'), action(1, 'First beat.')]),
      ),
    );
    const row = rowFor('First beat.');
    expect(row).toHaveAttribute('data-diff-moved', 'true');
    expect(row).toHaveAttribute('data-diff-mark', 'unchanged');
    expect(row.querySelector('.diff-gutter')?.textContent).toContain('MOVED');
    expect(row.textContent).toMatch(/^Moved\./);
    expect(row.querySelector('del, ins')).toBeNull();
  });

  it('renders an added forced page break as a labelled structural row, not as a manuscript line', () => {
    renderWith(
      diffResult(
        screenplay([action(1, 'One.'), action(2, 'Two.')]),
        screenplay([action(1, 'One.'), { id: uuidFor(9), type: 'page_break' }, action(2, 'Two.')]),
      ),
    );
    const row = document.querySelector<HTMLElement>('[data-diff-row="page-break"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Forced page break added');
    expect(row).not.toHaveAttribute('data-screenplay-element');
  });
});

describe('revision diff page: document-level changes', () => {
  beforeEach(resetRouteHarness);

  it('names title, document-settings and title-page changes in the Inspector, where per-document detail belongs', () => {
    const blocks = [action(1, 'One.')];
    const titlePage = { id: uuidFor(50), title: 'Old Title Page' };
    const result = diffResult(
      screenplay(blocks, { title: 'Draft One', titlePages: [titlePage] }),
      screenplay(blocks, {
        title: 'Draft Two',
        titlePages: [{ ...titlePage, title: 'New Title Page' }],
        documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, sceneNumbersEnabled: true },
      }),
    );
    renderWith(result);

    const section = inspectorSection('Document');
    expect(section.textContent).toContain('Draft One');
    expect(section.textContent).toContain('Draft Two');
    expect(section.textContent).toContain('sceneNumbersEnabled');
    expect(section.textContent).toContain('Title page changed');
    expect(section.textContent).toContain('New Title Page');
    // Panel content, never a row inside the manuscript.
    expect(section.closest('.diff-manuscript')).toBeNull();
    expect(section.closest('.inspector')).not.toBeNull();
  });

  /** No heading without a list under it: a comparison with no document-level difference gets no
   * "Document" section at all, rather than an empty one. */
  it('offers no Document section when nothing about the document itself changed', () => {
    renderWith(diffResult(screenplay([action(1, 'One.')]), screenplay([action(1, 'Two.')])));

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Comparing', 'Changes', 'Legend']);
  });
});

/**
 * The comparison wears the editor's own chrome (`applicationShell.tsx`). The owner's objection to
 * what this replaced, verbatim: "My bigger concern is just UI consistency. I like the UI we've built
 * out for the editor, and don't want users thrust into some plain UI when looking at the
 * difference." The manuscript inside this view was already the editor's; everything around it was a
 * `.project-screen` with a `.project-header` holding one link -- the vocabulary of the sign-in and
 * project-list screens, not of the application.
 *
 * These assertions are about which chrome rows this view fills and which it leaves out, and about
 * them being the *same* rows the editor's are rather than lookalikes. What they cannot check is what
 * those rows measure: jsdom runs no layout. `screenplay-diff-persistence.spec.ts` proves the chrome
 * parity against real Chrome, and `page-rendering-persistence.spec.ts` proves the editor's own
 * geometry did not move when the shell was extracted.
 */
describe('revision diff page: the editor’s chrome, not a plainer page', () => {
  beforeEach(resetRouteHarness);

  const older = screenplay([action(1, 'One.'), action(2, 'Two.')], { title: 'Hollow Heart' });
  const newer = screenplay([action(1, 'One.'), action(3, 'Three.')], { title: 'Hollow Heart' });

  function main(): HTMLElement {
    return screen.getByRole('main');
  }

  it('renders inside the application shell, not a project screen', () => {
    renderWith(diffResult(older, newer));

    expect(main()).toHaveClass('application');
    expect(main()).toHaveClass('diff-screen');
    expect(main()).not.toHaveClass('project-screen');
    // The plain-page vocabulary this replaced, gone rather than merely restyled.
    expect(document.querySelector('.project-header')).toBeNull();
    expect(document.querySelector('.eyebrow')).toBeNull();
  });

  /**
   * Which rows this view fills, stated exactly and in grid-track order -- a census that fails if the
   * shell ever renders a child nobody asked for, and the assertion that records this pass's decision:
   * **every** row, menubar and toolbar included.
   *
   * The pass before this one filled neither, on the argument that a bar of disabled controls advertises
   * a crippled editor. The owner overruled it -- "There is no toolbar... It still just feels like a
   * free floating thing, not like part of the greater product" -- and this is where that decision is
   * now checkable. The print refusal is `display: none` on screen and occupies no row.
   */
  it('fills every chrome row the editor does, in grid-track order', () => {
    renderWith(diffResult(older, newer));

    expect(Array.from(main().children).map((child) => child.className)).toEqual([
      'titlebar',
      'menubar',
      'readonly-banner readonly-banner-comparison',
      'toolbar',
      'workspace',
      'statusbar',
      'diff-print-refusal',
    ]);
    // And so names no missing row: the three `shell-without-*` modifiers are all absent.
    expect(main().className).toBe('application has-readonly-banner diff-screen');
  });

  it('wears the application’s own title bar: same identity, same way out, and the document named', () => {
    renderWith(diffResult(older, newer));

    const titlebar = main().querySelector('.titlebar');
    expect(titlebar).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'Finaler Draft — back to your projects' }),
    ).toHaveAttribute('href', '/projects');
    expect(titlebar?.querySelector('.document-title')?.textContent).toBe('Hollow Heart Comparison');
    // No save dot: nothing on this screen is saving, so there is no document state for one to report.
    expect(titlebar?.querySelector('.save-dot')).toBeNull();
  });

  /** The same banner mechanics as the historical-revision preview's "Historical revision." banner
   * (App.tsx): `.readonly-banner`'s own markup, its `role="status"`, and the `auto` grid row the
   * shell opens for it. */
  it('announces itself in the shell’s banner row, the way the historical preview does', () => {
    renderWith(diffResult(older, newer));

    expect(main()).toHaveClass('has-readonly-banner');
    const banner = main().querySelector('.readonly-banner');
    expect(banner).not.toBeNull();
    expect(banner).toHaveClass('readonly-banner-comparison');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner?.textContent).toContain('Comparison.');
    // The same `humanizeRevisionDiffSide` labels the view already used, now inside the banner's own
    // sentence rather than in a paragraph of a plainer page's body.
    const sides = banner?.querySelector('.diff-sides')?.textContent ?? '';
    expect(sides).toBe(
      `${humanizeRevisionDiffSide(diffResult(older, newer).older)} → ${humanizeRevisionDiffSide(
        diffResult(older, newer).newer,
      )}`,
    );
    expect(sides).toMatch(/^Draft 2 /u);
    expect(sides).toMatch(/ → Current document$/u);
    // The way out lives in the banner, because it is about the comparison rather than about editing
    // anything. The zoom control left it this pass: zoom is a toolbar control on both screens now.
    expect(banner?.contains(screen.getByRole('link', { name: 'Back to revisions' }))).toBe(true);
    expect(banner?.querySelector('.diff-zoom')).toBeNull();
  });

  it('fills the menubar and toolbar rows, with the same components the editor renders', () => {
    renderWith(diffResult(older, newer));

    expect(main()).not.toHaveClass('shell-without-menubar');
    expect(main()).not.toHaveClass('shell-without-toolbar');
    expect(screen.getByRole('navigation', { name: 'Application menu' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Screenplay tools' })).toBeInTheDocument();
  });

  /**
   * The toolbar's whole control inventory, present and named exactly as the editor's is, with the real
   * `disabled` attribute on every one that cannot act on a read-only comparison of two stored
   * snapshots. The route's own `toolbar` comment carries the reason for each.
   *
   * This is the unit-level half of the owner's "feels like part of the greater product"; the
   * browser-level half -- the two screens' chrome enumerated side by side against real Chrome -- is in
   * `screenplay-diff-persistence.spec.ts`.
   */
  it('renders every toolbar control, disabling exactly those a snapshot comparison cannot use', () => {
    renderWith(diffResult(older, newer));

    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });
    for (const name of [
      'Undo local change',
      'Redo local change',
      'Toggle element labels',
      'Toggle continuous scroll',
    ]) {
      expect(within(toolbar).getByRole('button', { name })).toBeDisabled();
    }
    expect(
      within(toolbar).getByRole('combobox', { name: 'Active screenplay element' }),
    ).toBeDisabled();

    // Live, because they genuinely apply: one sheet to scale, two panels with real content in them.
    for (const name of ['Zoom out', 'Zoom in', 'Toggle navigator', 'Toggle inspector']) {
      expect(within(toolbar).getByRole('button', { name })).toBeEnabled();
    }
    expect(within(toolbar).getByRole('combobox', { name: 'Zoom preset' })).toBeEnabled();

    // The two fit modes are present, named, and really disabled -- they need `.editor-region`'s
    // measured available area and a recompute lifecycle this view has none of.
    const options = Array.from(
      within(toolbar).getByRole('combobox', { name: 'Zoom preset' }).querySelectorAll('option'),
    );
    expect(options.find((option) => option.value === 'fit-width')).toBeDisabled();
    expect(options.find((option) => option.value === 'fit-page')).toBeDisabled();
  });

  /** The File menu is the editor's own item set. Only "Revision history…" applies to a comparison; the
   * other five are really-disabled menu items that say why. */
  it('renders the File menu with every item, disabling all but the one that applies', async () => {
    const user = userEvent.setup();
    renderWith(diffResult(older, newer));

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Document settings…',
      'Save named revision…',
      'Revision history…',
      'Download FDX…',
      'Download DOCX…',
      'Download PDF…',
    ]);
    for (const item of items) {
      if (item.textContent === 'Revision history…') {
        expect(item).toBeEnabled();
      } else {
        expect(item).toBeDisabled();
        expect(item).toHaveAttribute('title', expect.stringMatching(/comparison/iu));
      }
    }

    await user.click(screen.getByRole('menuitem', { name: 'Revision history…' }));
    expect(routeState.navigate).toHaveBeenCalledWith({
      params: { projectId, screenplayId },
      to: '/projects/$projectId/screenplays/$screenplayId/revisions',
    });
  });

  /** The dark canvas is a view preference and the comparison has a canvas, so it is live -- the one
   * menubar control besides File that does something here. */
  it('offers a working dark-canvas toggle, because there is a canvas to darken', async () => {
    const user = userEvent.setup();
    renderWith(diffResult(older, newer));

    expect(main()).not.toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: 'Dark canvas' }));
    expect(main()).toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: 'Light canvas' }));
    expect(main()).not.toHaveClass('dark');
  });

  /**
   * The status bar is filled, and with the one report that is true of an unpaginated comparison. A
   * page count and a scene count -- the two figures the editor's own bar neighbours -- are exactly
   * what this view may not state: removed lines shown in place put more content on the sheet than
   * either document holds, so its pages are not the document's.
   */
  it('fills the status-bar row with the change counts, and with no page or scene count', () => {
    renderWith(diffResult(older, newer));

    expect(main()).not.toHaveClass('shell-without-statusbar');
    const statusbar = main().querySelector('.statusbar');
    expect(statusbar).not.toBeNull();
    // The editor's own three-part bar: the active scene on the left, the one report an unpaginated
    // comparison is entitled to in the centre. A page count and a scene count -- the two figures the
    // editor's bar neighbours -- are exactly what this view may not state: removed lines shown in
    // place put more content on the sheet than either document holds.
    expect(statusbar?.querySelector('.diff-summary')?.textContent).toBe(
      '1 line added, 1 line removed',
    );
    expect(statusbar?.textContent).not.toMatch(/page/iu);
    // These two screenplays have no scene heading at all, so there is no active scene to name.
    expect(within(statusbar as HTMLElement).getByLabelText('Active scene')).toHaveTextContent(
      'No active scene',
    );
  });

  it('puts the sheet in the shell’s workspace row, the one region that scrolls', () => {
    renderWith(diffResult(older, newer));

    const workspace = main().querySelector('.workspace');
    expect(workspace).not.toBeNull();
    const region = workspace?.querySelector('.diff-manuscript-region');
    expect(region).not.toBeNull();
    expect(region?.querySelector('.page.diff-manuscript')).not.toBeNull();
    // The reading apparatus scrolls with the sheet rather than sitting in a band above it.
    expect(region?.querySelector('.diff-page-body')).not.toBeNull();
  });

  it('keeps the print refusal out of every grid row, where it occupies none', () => {
    renderWith(diffResult(older, newer));

    const refusal = main().querySelector('.diff-print-refusal');
    expect(refusal).not.toBeNull();
    // Last child: after the status bar, with the rest of the out-of-flow children.
    expect(main().lastElementChild).toBe(refusal);
  });

  /** The chrome is the application's, which means it is there before the comparison is -- a writer
   * who opens this and waits is already inside the application, not on a bare loading page. */
  it('wears the whole chrome while the comparison is still loading, and when it fails', () => {
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<RevisionDiffPage />);

    expect(main()).toHaveClass('application');
    expect(main().querySelector('.titlebar')).not.toBeNull();
    expect(main().querySelector('.menubar')).not.toBeNull();
    expect(main().querySelector('.readonly-banner')).not.toBeNull();
    expect(main().querySelector('.toolbar')).not.toBeNull();
    expect(main().querySelector('.diff-summary')?.textContent).toBe('Comparing…');
    expect(screen.getByRole('link', { name: 'Back to revisions' })).toBeVisible();
    // Both panels are there, each saying it has nothing yet rather than looking broken.
    expect(screen.getByRole('complementary', { name: 'Navigator' })).toBeInTheDocument();
    expect(document.querySelector('.navigator-footer')?.textContent).toBe('Comparing…');
    expect(inspectorSection('Comparing').textContent).toContain('Comparing…');

    routeState.query = { data: undefined, isError: true, isLoading: false };
    rerender(<RevisionDiffPage />);

    expect(main()).toHaveClass('application');
    expect(main().querySelector('.titlebar')).not.toBeNull();
    expect(main().querySelector('.diff-summary')?.textContent).toBe(
      'This comparison could not be loaded',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This diff could not be loaded.');
  });

  /**
   * Chrome, not an editor. Wearing the editor's whole frame is what this pass added; being unable to
   * write to either document is what has not changed. There is no editing surface of any kind, and
   * every control that could change a document is really disabled rather than absent -- which is a
   * stronger claim than the previous pass's "no such control exists", because it is now checkable
   * against a control that is on screen.
   */
  it('gains no editing surface from wearing the editor’s whole chrome', () => {
    renderWith(diffResult(older, newer));

    expect(screen.queryByRole('textbox', { name: 'Screenplay editing canvas' })).toBeNull();
    expect(document.querySelector('[contenteditable]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo local change' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toBeDisabled();
    // Not Track Changes: there is no accept or reject control anywhere in the frame.
    expect(screen.queryByRole('button', { name: /accept/iu })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/iu })).toBeNull();
  });

  /**
   * The Navigator, with real content: the document's scene skeleton, the changed scenes marked, and a
   * jump that scrolls the marked row into view.
   *
   * The scroll itself is stubbed because jsdom implements no scrolling at all -- asserting the call on
   * the right element is the honest limit of what a non-layout environment can check here. That the
   * element it lands on is a real manuscript row is checked directly.
   */
  it('lists the scene skeleton in the Navigator and marks which scenes changed', () => {
    const olderScenes = screenplay([
      sceneHeading(10, 'INT. KITCHEN - DAY'),
      action(11, 'Ada stirs.'),
      sceneHeading(12, 'EXT. ROOF - DAWN'),
      action(13, 'Wind lifts the tarp.'),
    ]);
    const newerScenes = screenplay([
      sceneHeading(10, 'INT. KITCHEN - DAY'),
      action(11, 'Ada stirs twice.'),
      sceneHeading(12, 'EXT. ROOF - DAWN'),
      action(13, 'Wind lifts the tarp.'),
    ]);
    renderWith(diffResult(olderScenes, newerScenes));

    expect(navigatorRows()).toEqual([
      { marking: 'changed', text: 'Changed. ~1. INT. KITCHEN - DAY1 changed' },
      { marking: null, text: '2. EXT. ROOF - DAWNunchanged' },
    ]);
    expect(document.querySelector('.navigator-footer')?.textContent).toBe('1 of 2 scenes changed');
  });

  it('jumps to a scene’s own manuscript row when its Navigator entry is chosen', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
      writable: true,
    });
    try {
      const olderScenes = screenplay([
        sceneHeading(10, 'INT. KITCHEN - DAY'),
        action(11, 'Ada stirs.'),
        sceneHeading(12, 'EXT. ROOF - DAWN'),
        action(13, 'Wind lifts the tarp.'),
      ]);
      const newerScenes = screenplay([
        sceneHeading(10, 'INT. KITCHEN - DAY'),
        action(11, 'Ada stirs.'),
        sceneHeading(12, 'EXT. ROOF - DAWN'),
        action(13, 'Wind tears the tarp.'),
      ]);
      renderWith(diffResult(olderScenes, newerScenes));

      await user.click(screen.getByRole('button', { name: /EXT\. ROOF - DAWN/u }));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      const target = scrollIntoView.mock.instances[0] as HTMLElement;
      expect(target.getAttribute('data-diff-block-id')).toBe(uuidFor(12));
      expect(target.getAttribute('data-screenplay-element')).toBe('scene_heading');
      // Choosing it also makes it the status bar's active scene, as in the editor.
      expect(
        within(main().querySelector('.statusbar') as HTMLElement).getByLabelText('Active scene'),
      ).toHaveTextContent('EXT. ROOF - DAWN');
    } finally {
      if (original === undefined) {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      } else {
        Object.defineProperty(Element.prototype, 'scrollIntoView', {
          configurable: true,
          value: original,
          writable: true,
        });
      }
    }
  });

  /** The Characters tab earns its place by listing only speakers whose lines changed -- a question only
   * a diff can answer, and the thing a writer actually asks of a revision. */
  it('lists only characters whose lines changed, and explains an empty tab', async () => {
    const user = userEvent.setup();
    const olderSpeech = screenplay([
      sceneHeading(20, 'INT. KITCHEN - DAY'),
      character(21, 'ADA'),
      dialogue(22, 'It needs salt.'),
      character(23, 'BEN'),
      dialogue(24, 'It needs nothing.'),
    ]);
    const newerSpeech = screenplay([
      sceneHeading(20, 'INT. KITCHEN - DAY'),
      character(21, 'ADA'),
      dialogue(22, 'It needs pepper.'),
      character(23, 'BEN'),
      dialogue(24, 'It needs nothing.'),
    ]);
    renderWith(diffResult(olderSpeech, newerSpeech));

    await user.click(screen.getByRole('tab', { name: 'Characters' }));
    expect(navigatorRows()).toEqual([{ marking: 'changed', text: 'Changed. ~ADA1 changed' }]);
    expect(document.querySelector('.navigator-footer')?.textContent).toBe('1 with changed lines');
  });

  /** An empty tab says why it is empty, rather than rendering as a blank panel a reader cannot tell
   * from a failure. */
  it('explains the Characters tab when nobody’s lines changed', async () => {
    const user = userEvent.setup();
    const blocks = [
      sceneHeading(20, 'INT. KITCHEN - DAY'),
      character(21, 'ADA'),
      dialogue(22, 'It needs salt.'),
    ];
    renderWith(
      diffResult(
        screenplay(blocks),
        screenplay(JSON.parse(JSON.stringify(blocks)) as ScreenplayBlock[]),
      ),
    );

    await user.click(screen.getByRole('tab', { name: 'Characters' }));
    expect(document.querySelector('.navigator-empty')?.textContent).toBe(
      'No character’s lines changed.',
    );
    expect(document.querySelector('.navigator-footer')?.textContent).toBe('0 with changed lines');
  });

  /**
   * The Inspector, carrying the comparison's own metadata. The legend moved here this pass: it is
   * reading apparatus, and the previous pass had flagged a band of it above the manuscript as awkward.
   * The pagination caveat stayed above the sheet, because it is a correctness warning about the sheet
   * and must not be hideable by closing a panel.
   */
  it('carries the sides, the counts and the legend in the Inspector, and leaves only the caveat above the sheet', () => {
    renderWith(diffResult(older, newer));

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Comparing', 'Changes', 'Legend']);

    expect(
      Array.from(inspectorSection('Changes').querySelectorAll('li')).map(
        (item) => item.textContent,
      ),
    ).toEqual(['1 line added', '1 line removed']);

    const legend = inspectorSection('Legend');
    expect(
      Array.from(legend.querySelectorAll('[data-diff-legend]')).map((item) =>
        item.getAttribute('data-diff-legend'),
      ),
    ).toEqual(['added', 'removed', 'changed', 'moved']);
    expect(legend.closest('.inspector')).not.toBeNull();

    // Above the sheet: the caveat, and nothing else.
    const above = document.querySelector('.diff-page-body');
    expect(above?.children).toHaveLength(1);
    expect(above?.firstElementChild).toBe(screen.getByRole('note'));
    expect(document.querySelector('.diff-page-body .diff-legend')).toBeNull();
  });

  /** Both panels are the toolbar's to open and close, exactly as in the editor, and the close button in
   * each panel heading does the same. */
  it('opens and closes both panels from the toolbar and from their own headings', async () => {
    const user = userEvent.setup();
    renderWith(diffResult(older, newer));

    expect(screen.getByRole('complementary', { name: 'Navigator' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Toggle navigator' }));
    expect(screen.queryByRole('complementary', { name: 'Navigator' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Toggle navigator' }));
    expect(screen.getByRole('complementary', { name: 'Navigator' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Toggle inspector' }));
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();
  });
});
