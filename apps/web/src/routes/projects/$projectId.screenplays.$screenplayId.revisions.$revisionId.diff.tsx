import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate, useParams } from '@tanstack/react-router';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { z } from 'zod';
import type { ScreenplayElementKind } from '@finaler-draft/screenplay/pageFormat';
import type { TextDiffSegment } from '@finaler-draft/screenplay';
import { api, type RevisionDiffResult } from '../../api.js';
import { ApplicationMenubar } from '../../applicationMenubar.js';
import { ApplicationShell, ApplicationTitlebar } from '../../applicationShell.js';
import { ApplicationToolbar } from '../../applicationToolbar.js';
import {
  buildDiffNavigator,
  type DiffNavigatorCharacter,
  type DiffNavigatorScene,
} from '../../diffNavigator.js';
import { InspectorPanel } from '../../inspectorPanel.js';
import { NavigatorPanel, type NavigatorEntry } from '../../navigatorPanel.js';
import { clampZoomPercent, ZOOM_DEFAULT_PERCENT, ZOOM_STEP_PERCENT } from '../../zoomPresets.js';
import {
  buildInlineScreenplayDiff,
  type InlineDiffBlockRow,
  type InlineDiffMark,
  type InlineDiffPageBreakRow,
  type InlineDiffRow,
  type InlineDiffSceneMoveRow,
  type InlineScreenplayDiff,
} from '../../inlineScreenplayDiff.js';
import { applyPageGeometryCssVariables } from '../../pageGeometryCss.js';
import { humanizeRevisionDiffSide } from '../../revisionDisplay.js';
import { guardSessionUser } from '../../session.js';

export const Route = createFileRoute(
  '/projects/$projectId/screenplays/$screenplayId/revisions/$revisionId/diff',
)({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  params: {
    parse: (params) =>
      z
        .object({
          projectId: z.string().uuid(),
          revisionId: z.string().uuid(),
          screenplayId: z.string().uuid(),
        })
        .parse(params),
  },
  component: RevisionDiffPage,
});

/** The comparison's Navigator tabs: the editor's own two, by the same ids, because this is the same
 * panel and a reader moving between the two screens should find the same sections in the same order
 * with the same keyboard behaviour. What each tab *lists* is the comparison's own (`diffNavigator.ts`);
 * that the tabs exist at all, and which they are, is the editor's. */
const NAVIGATOR_TABS = [
  { id: 'scenes', label: 'Scenes' },
  { id: 'characters', label: 'Characters' },
] as const;

type NavigatorTabId = (typeof NAVIGATOR_TABS)[number]['id'];

/**
 * The small trailing figure on a scene row. Terse on purpose, matching the editor's own
 * `3 blocks`: a 235px panel has room for a count, and the status glyph beside it already says which
 * kind of change this is. `moved` is named in words when the scene both moved and changed, because
 * `status` can only carry one marker and the move would otherwise go unreported on that row (see
 * `diffNavigator.ts`'s `sceneStatus`).
 */
function sceneSecondary(scene: DiffNavigatorScene): string {
  if (scene.status === 'added' || scene.status === 'removed') {
    return `${scene.changedLineCount} lines`;
  }
  if (scene.status === 'changed') {
    return scene.moved
      ? `${scene.changedLineCount} changed · moved`
      : `${scene.changedLineCount} changed`;
  }
  return scene.status === 'moved' ? 'moved' : 'unchanged';
}

/** A character row's trailing figure. `lines`, not `cues`: unlike the editor's own character list
 * (which counts how many times a character speaks), this counts changed lines of their speech, which
 * is the only reason they are listed at all. */
function characterSecondary(character: DiffNavigatorCharacter): string {
  return `${character.changedLineCount} changed`;
}

/**
 * Collaboration slice 4b's screenplay-aware diff view: **the screenplay itself, in document order,
 * rendered as a screenplay, with additions and removals marked in place.**
 *
 * It replaced a nested-list change report (document settings, then title page, then a `<ul>` of
 * scenes each holding a `<ul>` of changed blocks). The owner's objection: "It is not something that
 * is easily readable by a person. I like how google drive or github does it where it shows the
 * changes on the document, but highlights whats been added or removed." The report form forced a
 * reader to rebuild the screenplay mentally before any of its findings meant anything; this form is
 * one continuous read. `inlineScreenplayDiff.ts` builds the render model; this file draws it.
 *
 * **It wears the application's whole frame.** Title bar, menubar, banner, toolbar, navigator panel,
 * manuscript, inspector panel, status bar -- the same regions in the same grid rows as the editor,
 * rendered by the same components (`applicationShell.tsx`, `applicationMenubar.tsx`,
 * `applicationToolbar.tsx`, `navigatorPanel.tsx`, `inspectorPanel.tsx`). The pass before this one
 * deliberately left the menubar and toolbar out, reasoning that a bar of disabled labels advertises a
 * crippled editor. The owner considered that and decided against it: "There is no toolbar, even if
 * theres not much in the toolbar that could actually be used here. Theres no scene/character
 * navigator. Theres no inspector. It still just feels like a free floating thing, not like part of
 * the greater product." Google Docs' and Word's own version-history views keep their full chrome for
 * the same reason. Every control that cannot act on a read-only snapshot comparison carries the real
 * `disabled` attribute -- never a styled lookalike that looks live and silently does nothing.
 *
 * **Still not the editor, and still no editor in this route's bundle.** No Tiptap `Editor`, no
 * `Y.Doc`, no `HocuspocusProvider`, no pagination plugin -- nothing this route imports reaches any of
 * them, which is what keeps the lazy editor chunk out of this route and keeps this view structurally
 * incapable of writing to the document. The extracted chrome components are presentational and carry
 * no editor dependency of their own; that is a load-bearing property of this feature, not a
 * convention, and `scripts/check-bundle-budget.mjs` plus the built-output grep in
 * `progress/screenplay-diff.md` are what hold it. What this view *does* reuse is the manuscript's
 * real geometry: the same `.page` / `.script-body` / `[data-screenplay-element]` rules the editor's
 * own blocks are laid out by (`styles.css`), fed by the same `pageGeometryCssVariables` projection of
 * `@finaler-draft/screenplay/pageFormat` the editor and the PDF path both read. Element indents,
 * measures, inter-element line spacing, and the scene-heading/character-cue weight are therefore the
 * real ones by construction rather than by a parallel re-implementation that could drift.
 *
 * **Nothing drawn here occupies a character cell.** Every marker is either `position: absolute` with
 * no layout contribution (the gutter glyph and its note, in the page's own left margin -- the same
 * technique `.scene-number`, `.smarttype-ghost` and `.remote-cursor` already use and that
 * `page-rendering-persistence.spec.ts` set the measurement precedent for) or a text-decoration and
 * background on an inline `<del>`/`<ins>`, neither of which changes any glyph's advance width.
 * `screenplay-diff-persistence.spec.ts` measures every rendered character against its own grid cell,
 * at two zoom levels, rather than trusting that reasoning.
 *
 * **Not revision marks, and not Track Changes.** `plan.md`'s "Locked scripts" revision marks are
 * asterisks in the printed margin computed against the most recent *lock*, with frozen scene numbers
 * and `OMITTED` scenes; they are a production artifact of a later phase, and `plan.md` requires that
 * revision history, Track Changes and production revision sets never share one implementation or
 * interface state. Nothing here is reusable as one: the markers are `+`/`-`/`~` glyphs in a
 * screen-only gutter, computed between two arbitrary revisions, and the whole view refuses to print
 * (see `.diff-print-refusal`). There is no accept or reject control, because this is not Track
 * Changes -- it is a read-only comparison of two snapshots.
 */
function RevisionDiffPage() {
  const { projectId, revisionId, screenplayId } = useParams({
    from: '/projects/$projectId/screenplays/$screenplayId/revisions/$revisionId/diff',
  });
  const navigate = useNavigate();
  const diffQuery = useQuery({
    queryKey: ['revisionDiff', screenplayId, revisionId],
    queryFn: () => api.revisionDiff(screenplayId, revisionId),
  });
  const result = diffQuery.data as RevisionDiffResult | undefined;
  const inline = useMemo(
    () => (result === undefined ? undefined : buildInlineScreenplayDiff(result)),
    [result],
  );
  const outline = useMemo(
    () => (result === undefined ? undefined : buildDiffNavigator(result)),
    [result],
  );
  const [zoomPercent, setZoomPercent] = useState(ZOOM_DEFAULT_PERCENT);
  const [dark, setDark] = useState(false);
  const [panels, setPanels] = useState({ inspector: true, navigator: true });
  const [navigatorTab, setNavigatorTab] = useState<NavigatorTabId>('scenes');
  const [selectedSceneId, setSelectedSceneId] = useState<string | undefined>(undefined);
  const [selectedCharacterName, setSelectedCharacterName] = useState<string | undefined>(undefined);

  const togglePanel = (panel: 'inspector' | 'navigator') =>
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));

  /*
   * A jump is a scroll, not a caret move: there is no caret on this screen. The target is the
   * manuscript row carrying that block id -- the same `data-diff-block-id` every rendered row already
   * has, so this needs no second index of where anything is. Queried from the document rather than
   * held in a ref map because the rows are produced by a `.map` over the render model and a ref per
   * row would be a parallel structure that could fall out of step with it.
   *
   * `?.` on `scrollIntoView` itself, not only on the element: jsdom implements no scrolling at all and
   * does not define the method, so an unguarded call would make every unit test of this panel throw
   * on a behaviour jsdom cannot have. The unit tests assert the call by stubbing the method, which is
   * the only thing a non-layout environment can honestly check; the real scroll is a browser claim.
   */
  const jumpToBlock = (blockId: string) => {
    document
      .querySelector<HTMLElement>(`[data-diff-block-id="${blockId}"]`)
      ?.scrollIntoView?.({ block: 'center' });
  };

  const selectedScene =
    outline === undefined
      ? undefined
      : (outline.scenes.find((scene) => scene.blockId === selectedSceneId) ?? outline.scenes[0]);

  const navigatorEntries: readonly NavigatorEntry[] =
    outline === undefined
      ? []
      : navigatorTab === 'scenes'
        ? outline.scenes.map((scene) => ({
            key: scene.blockId,
            onSelect: () => {
              setSelectedSceneId(scene.blockId);
              jumpToBlock(scene.blockId);
            },
            primary:
              scene.position === undefined
                ? scene.headingText
                : `${scene.position}. ${scene.headingText}`,
            secondary: sceneSecondary(scene),
            selected: selectedScene?.blockId === scene.blockId,
            status: scene.status === 'unchanged' ? undefined : scene.status,
          }))
        : outline.characters.map((character) => ({
            key: character.name,
            onSelect: () => {
              setSelectedCharacterName(character.name);
              jumpToBlock(character.blockId);
            },
            primary: character.name,
            secondary: characterSecondary(character),
            selected: selectedCharacterName === character.name,
            status: character.status,
          }));

  const documentLevelChanges =
    result === undefined
      ? false
      : result.diff.titleChanged ||
        result.diff.documentSettingsChanges.length > 0 ||
        result.diff.titlePages.length > 0;

  return (
    <ApplicationShell
      banner={
        /*
         * The comparison's own banner: the exact counterpart of the historical-revision preview's
         * "Historical revision." banner (`App.tsx`), down to sharing `.readonly-banner`'s markup, its
         * `auto` grid row and its `justify-content: space-between` action placement. The two say the
         * same thing -- you are reading a stored snapshot, not the live document -- reached two
         * different ways, which is why `styles.css` gives them one accent rule rather than two. The
         * words, not the colour, carry which one this is.
         *
         * It keeps naming the two sides even though the Inspector now names them too. The duplication
         * is deliberate: the banner is the one statement of "what am I looking at" that cannot be
         * closed, and a reader who has collapsed the Inspector must not thereby lose which two
         * revisions are on screen. "Back to revisions" stays here for the same reason -- it is the way
         * out, not a document operation.
         */
        <div className="readonly-banner readonly-banner-comparison" role="status">
          <p>
            <strong>Comparison.</strong>{' '}
            {result !== undefined && (
              <span className="diff-sides">
                {humanizeRevisionDiffSide(result.older)}
                {' → '}
                {humanizeRevisionDiffSide(result.newer)}
              </span>
            )}{' '}
            — a read-only reading view of two stored snapshots, separate from the live document.
          </p>
          <div className="readonly-banner-actions">
            <Link
              className="primary-button"
              params={{ projectId, screenplayId }}
              to="/projects/$projectId/screenplays/$screenplayId/revisions"
            >
              Back to revisions
            </Link>
          </div>
        </div>
      }
      dark={dark}
      menubar={
        /*
         * The same menubar component the editor renders, with the same File item set and the same
         * five inert labels beside it. Every item that has no meaning on a read-only comparison of two
         * stored snapshots is a really-disabled menu item with its reason as its tooltip -- the
         * behaviour `OverflowMenu` already had for the editor's own export items.
         *
         * "Revision history…" is the one that is genuinely live, because it genuinely applies: this
         * comparison came from that list and a reader can go back to it. It leads to the same place as
         * the banner's "Back to revisions"; a command appearing in both a menu and a visible control
         * is ordinary, and dropping it from the menu to avoid the overlap would make the one item that
         * works disappear.
         */
        <ApplicationMenubar
          canvasToggle={{ dark, onToggle: () => setDark((value) => !value) }}
          fileMenuItems={[
            {
              disabled: true,
              disabledReason:
                'A comparison is a read-only reading view of two stored snapshots — open the live document to change its settings.',
              label: 'Document settings…',
            },
            {
              disabled: true,
              disabledReason:
                'A comparison has nothing to save — open the live document to name a revision.',
              label: 'Save named revision…',
            },
            {
              label: 'Revision history…',
              onSelect: () =>
                void navigate({
                  params: { projectId, screenplayId },
                  to: '/projects/$projectId/screenplays/$screenplayId/revisions',
                }),
            },
            {
              disabled: true,
              disabledReason:
                'A comparison is not a screenplay — export the document itself, from the editor.',
              label: 'Download FDX…',
            },
            {
              disabled: true,
              disabledReason:
                'A comparison is not a screenplay — export the document itself, from the editor.',
              label: 'Download DOCX…',
            },
            {
              disabled: true,
              disabledReason:
                'A comparison is not a screenplay — export the document itself, from the editor.',
              label: 'Download PDF…',
            },
          ]}
        />
      }
      outOfFlow={
        /* The print refusal: `display: none` on screen, so it occupies no grid row, and the only
         * thing `@media print` leaves visible (styles.css). See `.diff-print-refusal`. */
        <p className="diff-print-refusal">
          This comparison is a screen-only reading view, not a script. It is not paginated like the
          document and must not be printed or circulated as one — export the screenplay itself
          instead.
        </p>
      }
      statusbar={
        /*
         * The status bar, in the editor's own three-part shape: the active scene on the left, the one
         * report this view is entitled to make in the centre.
         *
         * The editor's centre reports this document's live state: the sync/save state, the word count.
         * A comparison has none of that -- nothing is syncing, nothing is being saved -- and the two
         * figures a reader might expect, a page count and a scene count, are the two this view is
         * least entitled to state: showing removed lines in place puts more content on the sheet than
         * either document holds, so its pages are not the document's pages (see `.diff-caveat`).
         *
         * The counts are the one report that *is* true, and they are document state rather than
         * reading apparatus, which is what makes the bar their right home rather than the sheet's
         * header -- the same distinction that puts the editor's word count here and its legend in the
         * Inspector. The left-hand scene is the Navigator's own selection, which is exactly what the
         * editor's left-hand scene is.
         *
         * No `ParticipantIndicator`: a stored snapshot has no participants, and an empty presence
         * area would be the one piece of chrome here that reported something untrue.
         */
        <footer className="statusbar">
          <span aria-label="Active scene">
            {selectedScene ? selectedScene.headingText : 'No active scene'}
          </span>
          <span className="status-center">
            <span className="diff-summary">
              {diffQuery.isLoading
                ? 'Comparing…'
                : inline === undefined
                  ? 'This comparison could not be loaded'
                  : summarize(inline)}
            </span>
          </span>
        </footer>
      }
      titlebar={
        /* No save-dot `indicator`: the editor's dot reports whether this document is saving, and
         * nothing here is. The title names the newer side's document, which is the spine of the
         * comparison (see `InlineManuscript`). */
        <ApplicationTitlebar
          documentTitle={result?.newerScreenplay.title ?? ''}
          documentType="Comparison"
        />
      }
      toolbar={
        /*
         * The same toolbar component the editor renders, control for control.
         *
         * Live, because they genuinely apply to a read-only sheet: the zoom stepper and its preset
         * dropdown (one sheet to read at more than one scale), and the two panel toggles (both panels
         * carry real content here).
         *
         * Really disabled, because they have no meaning on a comparison of two stored snapshots:
         *  - Undo / Redo -- there is no edit history on this screen to walk, and nothing here can
         *    write to either document.
         *  - The element selector -- there is no caret, so there is no active element. It shows "No
         *    active element" rather than a greyed-out element name, because naming one would be false.
         *  - "Fit page" / "Fit width" -- the two fit modes are computed from `.editor-region`'s
         *    measured available area and recomputed on resize and on panel toggle (`zoom.ts`'s
         *    `resolveZoomPercent`); this view has no such lifecycle, and inventing one would be a
         *    second zoom mechanism rather than a shared control. The options stay present and named,
         *    and are genuinely unselectable.
         *  - Element labels -- the overlay draws each block's element name into the same left margin
         *    this view's own change gutter occupies, so the two cannot both be shown; the gutter is
         *    this screen's reason to exist and wins.
         *  - Continuous scroll -- it switches the drawn page boundary off and on, and this view draws
         *    none at all (`.page.diff-manuscript` removes the gradient, because showing removed lines
         *    in place makes every page boundary it could compute a boundary no real document has).
         *    There is no pagination here to switch between.
         */
        <ApplicationToolbar
          continuousScroll={{ active: false, disabled: true }}
          elementLabels={{ active: false, disabled: true }}
          elementSelector={{ activeElement: undefined, disabled: true, options: [] }}
          inspector={{
            active: panels.inspector,
            disabled: false,
            onClick: () => togglePanel('inspector'),
          }}
          navigator={{
            active: panels.navigator,
            disabled: false,
            onClick: () => togglePanel('navigator'),
          }}
          redo={{ disabled: true }}
          undo={{ disabled: true }}
          zoom={{
            fitModesDisabled: true,
            onChoosePreset: (value) => {
              const percent = Number(value);
              if (Number.isFinite(percent)) setZoomPercent(clampZoomPercent(percent));
            },
            onZoomIn: () =>
              setZoomPercent((percent) => clampZoomPercent(percent + ZOOM_STEP_PERCENT)),
            onZoomOut: () =>
              setZoomPercent((percent) => clampZoomPercent(percent - ZOOM_STEP_PERCENT)),
            percent: zoomPercent,
            presetValue: String(zoomPercent),
          }}
        />
      }
      variant="diff-screen"
      workspace={
        <div className="workspace">
          {panels.navigator && (
            /*
             * The Navigator, carrying what only a comparison knows: which scenes changed, and which
             * characters' lines changed. An empty panel would have been as wrong as a missing one.
             * `diffNavigator.ts` is the model and its own comment carries the reasoning, including why
             * the Characters tab lists changed speakers rather than the whole cast.
             */
            <NavigatorPanel
              activeTabId={navigatorTab}
              emptyMessage={
                navigatorTab === 'scenes'
                  ? 'This comparison has no scenes.'
                  : 'No character’s lines changed.'
              }
              entries={navigatorEntries}
              footer={
                outline === undefined
                  ? 'Comparing…'
                  : navigatorTab === 'scenes'
                    ? `${outline.changedSceneCount} of ${outline.scenes.length} scenes changed`
                    : `${outline.characters.length} with changed lines`
              }
              onChangeTab={setNavigatorTab}
              onClose={() => togglePanel('navigator')}
              tabs={NAVIGATOR_TABS}
            />
          )}
          <section
            aria-label="Screenplay comparison, reading view"
            className="diff-manuscript-region"
          >
            <div className="diff-page-body">
              {diffQuery.isLoading ? (
                <p>Loading diff…</p>
              ) : result === undefined || inline === undefined ? (
                <p role="alert">This diff could not be loaded.</p>
              ) : inline.isEmpty ? (
                <p className="muted">No differences.</p>
              ) : (
                /*
                 * All that is left above the sheet: the one thing a reader must not have to discover
                 * for themselves, and the one thing that must not be hideable. The legend and the
                 * document-level change list both moved into the Inspector this pass -- the previous
                 * pass had flagged a band of reading apparatus above the manuscript as awkward, and
                 * the Inspector is where the editor already keeps per-document detail. This note
                 * stayed, because it is a correctness warning about the sheet directly below it: a
                 * reader who closed the Inspector must still be told that these page breaks are not
                 * the document's.
                 */
                <p className="diff-caveat" role="note">
                  Reading view, not a paginated script — removed lines are shown in place, so the
                  page breaks are not the document's. Nothing here can be edited, accepted, or
                  rejected.
                </p>
              )}
            </div>
            {inline !== undefined && !inline.isEmpty && (
              <InlineManuscript inline={inline} zoomPercent={zoomPercent} />
            )}
          </section>
          {panels.inspector && (
            /*
             * The Inspector, carrying the comparison's own metadata -- the two sides, the change
             * counts, the document-level differences that have no line in the body to be marked on,
             * and the legend. The same panel frame the editor's Inspector uses
             * (`inspectorPanel.tsx`), in the same place, with the same section rhythm.
             */
            <InspectorPanel
              onClose={() => togglePanel('inspector')}
              sections={[
                {
                  content:
                    result === undefined ? (
                      <p className="muted">Comparing…</p>
                    ) : (
                      <>
                        <p className="inspector-value">{humanizeRevisionDiffSide(result.older)}</p>
                        <p className="muted">compared with</p>
                        <p className="inspector-value">{humanizeRevisionDiffSide(result.newer)}</p>
                      </>
                    ),
                  heading: 'Comparing',
                  key: 'comparing',
                },
                {
                  content:
                    inline === undefined ? (
                      <p className="muted">Comparing…</p>
                    ) : (
                      <CountList inline={inline} />
                    ),
                  heading: 'Changes',
                  key: 'changes',
                },
                ...(result !== undefined && documentLevelChanges
                  ? [
                      {
                        content: <DocumentLevelChanges result={result} />,
                        heading: 'Document',
                        key: 'document',
                      },
                    ]
                  : []),
                { content: <DiffLegend />, heading: 'Legend', key: 'legend' },
              ]}
            />
          )}
        </div>
      }
    />
  );
}

/** The change counts as a list rather than as the status bar's one sentence: the Inspector has a
 * column to itemise them in, and a reader who wants to know "how many lines were cut" should not have
 * to parse a comma-joined clause to find out. Built from the same `counts` the bar's summary is, so
 * the two can never disagree. */
function CountList({ inline }: { inline: InlineScreenplayDiff }) {
  const { counts } = inline;
  const rows = [
    clause(counts.added, 'line added', 'lines added'),
    clause(counts.removed, 'line removed', 'lines removed'),
    clause(counts.changed, 'line changed', 'lines changed'),
    clause(counts.movedScenes, 'scene moved', 'scenes moved'),
    clause(counts.movedBlocks, 'line moved', 'lines moved'),
  ].filter((row): row is string => row !== undefined);
  if (rows.length === 0) return <p className="muted">No changes to the script body.</p>;
  return (
    <ul className="inspector-counts">
      {rows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ul>
  );
}

/** A plural-aware clause, omitted entirely when the count is zero -- a summary that reads "0 scenes
 * moved" wastes the one line a reader skims before deciding where to look. */
function clause(count: number, singular: string, plural: string): string | undefined {
  if (count === 0) return undefined;
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarize(inline: InlineScreenplayDiff): string {
  const { counts } = inline;
  const parts = [
    clause(counts.added, 'line added', 'lines added'),
    clause(counts.removed, 'line removed', 'lines removed'),
    clause(counts.changed, 'line changed', 'lines changed'),
    clause(counts.movedScenes, 'scene moved', 'scenes moved'),
    clause(counts.movedBlocks, 'line moved', 'lines moved'),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'No changes to the script body.' : parts.join(', ');
}

/**
 * The legend, which is also the accessibility contract made visible: every mark has a glyph and a
 * word, so the view never depends on telling two colours apart. See `GUTTER_GLYPH` below.
 */
function DiffLegend() {
  return (
    <ul className="diff-legend">
      {(['added', 'removed', 'changed'] as const).map((mark) => (
        <li key={mark} data-diff-legend={mark}>
          <span className="diff-legend-glyph" aria-hidden="true">
            {GUTTER_GLYPH[mark]}
          </span>
          <span className={`diff-legend-sample diff-legend-sample-${mark}`}>
            {MARK_LABEL[mark]}
          </span>
        </li>
      ))}
      <li data-diff-legend="moved">
        <span className="diff-legend-glyph" aria-hidden="true">
          {MOVED_GLYPH}
        </span>
        <span className="diff-legend-sample">Moved</span>
      </li>
    </ul>
  );
}

/**
 * Document-level differences that are not lines of the script and so have nowhere in the manuscript
 * to be marked in place: the screenplay's title, `documentSettings`, and title pages. Deliberately the
 * one surviving piece of the old report form, because these genuinely are metadata about the document
 * rather than content in it, and inventing a position in the body for them would be worse than naming
 * them separately.
 *
 * It names them in the Inspector's "Document" section now, not in a band above the sheet: that is
 * where the editor already keeps per-document detail, and it is what left the space above the
 * manuscript holding nothing but the pagination caveat. The Inspector renders the heading, so this
 * renders only the list; the caller decides whether there is anything to show, which is why there is
 * no emptiness guard here (an empty `<ul>` under a "Document" heading would be the thing to avoid, and
 * the caller is the only place that can avoid the heading too).
 */
function DocumentLevelChanges({ result }: { result: RevisionDiffResult }) {
  const { diff } = result;
  return (
    <div className="diff-document-changes">
      <ul>
        {diff.titleChanged && (
          <li>
            Title: <del>{diff.titleBefore}</del> <ins>{diff.titleAfter}</ins>
          </li>
        )}
        {diff.documentSettingsChanges.map((change) => (
          <li key={change.field}>
            {change.field}: <del>{String(change.before)}</del> <ins>{String(change.after)}</ins>
          </li>
        ))}
        {diff.titlePages.map((entry) => (
          <li key={entry.id}>
            Title page {MARK_LABEL[titlePageMark(entry.status)].toLowerCase()}:{' '}
            {entry.after?.title ?? entry.before?.title ?? 'untitled'}
          </li>
        ))}
      </ul>
    </div>
  );
}

function titlePageMark(status: 'added' | 'removed' | 'matched'): InlineDiffMark {
  return status === 'matched' ? 'changed' : status;
}

/**
 * The manuscript itself. `.pages` / `.page` / `.script-body` are the editor's own containers, reused
 * rather than reimplemented so every indent and measure below comes from one authority -- see this
 * module's own top-of-file comment.
 *
 * The scrolling region around it is the shell's `workspace` row (`.diff-manuscript-region`, the
 * route's `workspace` slot above), not this component: it is the comparison's counterpart to the
 * editor's `.editor-region`, and like it, it is the one region on the screen that scrolls.
 *
 * `.page.diff-manuscript` removes `.page`'s repeating page-boundary gradient. That is not cosmetic:
 * the gradient draws where each physical page ends, and in this view those positions would be wrong
 * by exactly as much removed content as is shown above them. A view that cannot compute truthful page
 * boundaries must not paint any.
 *
 * `applyPageGeometryCssVariables` is applied to this subtree's own root, not to the document element:
 * the route then carries its own geometry regardless of what bootstrapped the application, and it uses
 * the *newer* side's `documentSettings` (`character`'s indent, `parenthetical`'s indent and width are
 * writer-adjustable) because the newer document is the spine.
 */
function InlineManuscript({
  inline,
  zoomPercent,
}: {
  inline: InlineScreenplayDiff;
  zoomPercent: number;
}) {
  const pagesRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (pagesRef.current) applyPageGeometryCssVariables(inline.documentSettings, pagesRef.current);
  }, [inline.documentSettings]);

  return (
    <div
      className="pages"
      data-diff-manuscript
      ref={pagesRef}
      style={{ zoom: zoomPercent / 100 } as CSSProperties}
    >
      <div className="page diff-manuscript">
        <div className="script-body">
          {inline.rows.map((row) => (
            <DiffRow key={row.key} row={row} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DiffRow({ row }: { row: InlineDiffRow }) {
  if (row.kind === 'scene-move') return <SceneMoveRow row={row} />;
  if (row.kind === 'page-break') return <PageBreakRow row={row} />;
  return <BlockRow row={row} />;
}

/**
 * The non-colour cues, all three of them, for every marked row:
 *
 * 1. **A gutter glyph** (`+`, `-`, `~`) absolutely positioned out into the page's own left margin,
 *    plus the word `MOVED` beneath it for a relocated line and the element change (`ACTION>DIAL`)
 *    where one happened. Zero layout contribution, so it cannot move a character.
 * 2. **A text decoration** on the marked words themselves: `line-through` for removed,
 *    `underline` for added. Decorations do not affect metrics, and strikethrough versus underline is
 *    legible with no colour perception at all.
 * 3. **A visually-hidden label** naming the mark in words, first in the block's reading order, so a
 *    screen reader announces "Removed." before the text rather than reading a struck-out line as
 *    though it were still in the script.
 *
 * Colour (the `<del>`/`<ins>` backgrounds) is the fourth cue and the only one that is not sufficient
 * on its own. Nothing in this view is signalled by colour alone.
 */
const GUTTER_GLYPH: Record<InlineDiffMark, string> = {
  unchanged: '',
  added: '+',
  removed: '-',
  changed: '~',
};

const MARK_LABEL: Record<InlineDiffMark, string> = {
  unchanged: 'Unchanged',
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

const MOVED_GLYPH = 'MOVED';

/** Short enough for the page's own left margin, which is where the gutter lives. */
const ELEMENT_ABBREVIATION: Record<ScreenplayElementKind, string> = {
  scene_heading: 'SCENE',
  action: 'ACTION',
  character: 'CHAR',
  dialogue: 'DIAL',
  parenthetical: 'PAREN',
  transition: 'TRANS',
  shot: 'SHOT',
};

/** The words a screen reader hears before the line's own text, and the words the gutter abbreviates.
 * Built once so the visible and the announced cue can never describe the row differently. */
function rowAnnouncement(row: InlineDiffBlockRow): string {
  const parts: string[] = [];
  if (row.mark !== 'unchanged') parts.push(MARK_LABEL[row.mark]);
  if (row.moved) parts.push('Moved');
  if (row.elementTypeChanged && row.previousElement) {
    parts.push(`Element changed from ${row.previousElement} to ${row.element}`);
  }
  if (row.sceneNumberChanged) {
    parts.push(`Scene number ${row.previousSceneNumber ?? 'none'} to ${row.sceneNumber ?? 'none'}`);
  }
  return parts.length === 0 ? '' : `${parts.join('. ')}.`;
}

function BlockRow({ row }: { row: InlineDiffBlockRow }) {
  const announcement = rowAnnouncement(row);
  const glyph = GUTTER_GLYPH[row.mark];
  const note =
    row.elementTypeChanged && row.previousElement
      ? `${ELEMENT_ABBREVIATION[row.previousElement]}>${ELEMENT_ABBREVIATION[row.element]}`
      : undefined;
  return (
    <div
      data-diff-block-id={row.blockId}
      data-diff-mark={row.mark}
      data-diff-moved={row.moved ? 'true' : undefined}
      data-diff-row="block"
      data-screenplay-block=""
      data-screenplay-element={row.element}
    >
      {announcement !== '' && (
        <span className="visually-hidden" data-diff-ornament="label">
          {`${announcement} `}
        </span>
      )}
      {(glyph !== '' || row.moved || note !== undefined) && (
        <span aria-hidden="true" className="diff-gutter" data-diff-ornament="gutter">
          {glyph !== '' && <span className="diff-gutter-glyph">{glyph}</span>}
          {row.moved && <span className="diff-gutter-note">{MOVED_GLYPH}</span>}
          {note !== undefined && <span className="diff-gutter-note">{note}</span>}
        </span>
      )}
      {row.segments.map((segment, index) => (
        <Segment key={index} segment={segment} />
      ))}
    </div>
  );
}

/** `<del>`/`<ins>` rather than styled `<span>`s: they are the HTML elements that *mean* removed and
 * added content, so assistive technology that surfaces them does so without this view having to
 * invent an ARIA vocabulary for it. Neither carries padding, margin or border (see `styles.css`), so
 * neither changes where a glyph sits. */
function Segment({ segment }: { segment: TextDiffSegment }) {
  if (segment.kind === 'removed') return <del>{segment.text}</del>;
  if (segment.kind === 'added') return <ins>{segment.text}</ins>;
  return <>{segment.text}</>;
}

/** An authored forced page break -- a structural instruction with no text of its own, so it is drawn
 * as a labelled interface rule rather than as a manuscript line. Interface chrome, deliberately: it
 * is not the drawn boundary of a real page, which this view cannot know (see `InlineManuscript`). */
function PageBreakRow({ row }: { row: InlineDiffPageBreakRow }) {
  return (
    <div className="diff-structural-row" data-diff-mark={row.mark} data-diff-row="page-break">
      <span aria-hidden="true" className="diff-structural-glyph">
        {GUTTER_GLYPH[row.mark] === '' ? '=' : GUTTER_GLYPH[row.mark]}
      </span>
      {row.mark === 'unchanged'
        ? 'Forced page break'
        : `Forced page break ${MARK_LABEL[row.mark].toLowerCase()}`}
    </div>
  );
}

/**
 * A relocated scene's two markers. The scene's own lines are left unmarked, because nothing in them
 * changed -- the move is stated once at each end instead. See `InlineDiffSceneMoveRow`'s own comment
 * for why this is not rendered as a deletion plus an insertion.
 */
function SceneMoveRow({ row }: { row: InlineDiffSceneMoveRow }) {
  return (
    <div
      className="diff-structural-row diff-scene-move"
      data-diff-move-place={row.place}
      data-diff-row="scene-move"
      data-diff-scene-id={row.sceneId}
    >
      <span aria-hidden="true" className="diff-structural-glyph">
        {MOVED_GLYPH}
      </span>
      {row.place === 'origin'
        ? `Scene moved from here: ${row.headingText} was scene ${row.fromPosition}, now scene ${row.toPosition}`
        : `Scene moved to here: ${row.headingText} was scene ${row.fromPosition}, now scene ${row.toPosition}`}
    </div>
  );
}
