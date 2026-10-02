import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  computeRevisionPreviewMetadata,
  measureStructuralChange,
  screenplaySchema,
  screenplayToPlainText,
  type Screenplay,
} from '@finaler-draft/screenplay';
import { projectYDocScreenplay } from '@finaler-draft/screenplay-editor';
import {
  insertRevisionIfChanged,
  latestRevision,
  type InsertRevisionResult,
} from '@finaler-draft/database';
import { reconstructDocumentState } from './updateLog.js';

/**
 * Collaboration slice 4a: the two *automatic* revision-creation triggers plan.md assigns to this
 * server (named milestones and export-triggered revisions are explicit user/client actions and are
 * created from `apps/api/src/revisions.ts` instead, against the screenplay's already-current
 * `canonical_screenplay`/`canonical_hash` -- there is no reason for a REST action to need a live
 * Yjs document at all).
 *
 * Both triggers below funnel through `@finaler-draft/database`'s `insertRevisionIfChanged`, the
 * single place that enforces "never create a revision when the canonical projection is unchanged"
 * -- see that function's own doc comment. Nothing in this file duplicates that check; a bug here
 * can decide *wrongly* to attempt a write, but it cannot itself produce a duplicate, unchanged
 * revision.
 */

function canonicalHash(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson).digest('hex');
}

async function insertAutomaticRevision(
  pool: Pool,
  params: {
    screenplayId: string;
    epoch: number;
    kind: 'idle_session' | 'structural_change';
    screenplay: Screenplay;
  },
): Promise<InsertRevisionResult> {
  const canonicalScreenplayJson = JSON.stringify(params.screenplay);
  return insertRevisionIfChanged(pool, {
    screenplayId: params.screenplayId,
    sourceEpoch: params.epoch,
    kind: params.kind,
    // Automatic revisions have no single human author -- see `documentRevisions.authoredBy`'s own
    // schema comment.
    label: null,
    authoredBy: null,
    canonicalScreenplayJson,
    canonicalHash: canonicalHash(canonicalScreenplayJson),
    renderedText: screenplayToPlainText(params.screenplay),
    previewMetadata: computeRevisionPreviewMetadata(params.screenplay),
  });
}

/**
 * The "major structural change" trigger. Called from `database.ts`'s `createStore` after every
 * debounced save that produced a *valid* canonical projection (an invalid, mid-edit projection is
 * never a baseline anything should compare against or record). Compares that projection to the
 * screenplay's latest existing revision -- or an empty baseline, when none exists yet, so a
 * screenplay's very first real content always becomes its first revision (see
 * `measureStructuralChange`'s own comment on why this needs no separate "genesis" trigger) -- via
 * `@finaler-draft/screenplay`'s `measureStructuralChange`, and attempts a write only when its
 * `isMajor` verdict is `true`. `insertRevisionIfChanged`'s own hash dedupe remains the final
 * authority: this function decides *whether to attempt* a write, not whether the attempt actually
 * produces a new row.
 *
 * If the screenplay's latest revision exists but its stored `canonicalScreenplay` fails to parse
 * against the current schema (a defect elsewhere, or data older than a schema migration this
 * table's own writers never had to handle), this deliberately does nothing rather than guess: an
 * unreadable baseline treated as "empty" would make `measureStructuralChange` see the *current*
 * screenplay's entire content as newly added, marking every subsequent save as major indefinitely.
 * That failure mode is logged so it is diagnosable rather than silently harmless-looking.
 */
export async function maybeCreateStructuralChangeRevision(
  pool: Pool,
  params: { screenplayId: string; epoch: number; screenplay: Screenplay },
): Promise<InsertRevisionResult | undefined> {
  const baseline = await latestRevision(pool, params.screenplayId);
  if (!baseline) {
    const measure = measureStructuralChange(undefined, params.screenplay);
    if (!measure.isMajor) return undefined;
    return insertAutomaticRevision(pool, {
      screenplayId: params.screenplayId,
      epoch: params.epoch,
      kind: 'structural_change',
      screenplay: params.screenplay,
    });
  }

  const parsedBaseline = screenplaySchema.safeParse(baseline.canonicalScreenplay);
  if (!parsedBaseline.success) {
    console.error(
      JSON.stringify({
        event: 'structural_change_baseline_unreadable',
        screenplayId: params.screenplayId,
        revisionId: baseline.id,
      }),
    );
    return undefined;
  }

  const measure = measureStructuralChange(parsedBaseline.data, params.screenplay);
  if (!measure.isMajor) return undefined;
  return insertAutomaticRevision(pool, {
    screenplayId: params.screenplayId,
    epoch: params.epoch,
    kind: 'structural_change',
    screenplay: params.screenplay,
  });
}

async function fetchScreenplayIdentity(
  pool: Pool,
  screenplayId: string,
): Promise<{ title: string } | undefined> {
  const result = await pool.query<{ title: string; canonicalScreenplay: { title?: string } }>(
    `select title, canonical_screenplay as "canonicalScreenplay"
       from screenplays
      where id = $1 and deleted_at is null`,
    [screenplayId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return { title: row.canonicalScreenplay.title ?? row.title };
}

/**
 * The "meaningful idle session" trigger. Reconstructs the screenplay's current durable state
 * purely from Postgres (`updateLog.ts`'s `reconstructDocumentState` -- the same "never trust a
 * live in-memory `Y.Doc`" discipline `createCheckpoint` already follows), projects it, and attempts
 * a revision write if the projection is valid. Returns `undefined` with no write attempted when:
 * the screenplay has never been opened collaboratively (nothing durable to reconstruct from), the
 * screenplay row is gone (deleted while this was scheduled), or the reconstructed document does not
 * currently project to a valid canonical screenplay (matching `createStore`'s own "never persist an
 * invalid projection" rule).
 *
 * Called by `IdleSessionRevisionScheduler` below once `IDLE_SESSION_REVISION_MS` has passed with no
 * further activity on this screenplay -- never on a fixed interval, and never by anything that
 * inspects a live Hocuspocus `Document` directly.
 */
export async function maybeCreateIdleSessionRevision(
  pool: Pool,
  params: { screenplayId: string; epoch: number },
): Promise<InsertRevisionResult | undefined> {
  const reconstruction = await reconstructDocumentState(pool, params.screenplayId, params.epoch);
  if (!reconstruction) return undefined;

  const identity = await fetchScreenplayIdentity(pool, params.screenplayId);
  if (!identity) return undefined;

  const projection = projectYDocScreenplay(reconstruction.doc, {
    id: params.screenplayId,
    title: identity.title,
  });
  if (!projection.valid) return undefined;

  return insertAutomaticRevision(pool, {
    screenplayId: params.screenplayId,
    epoch: params.epoch,
    kind: 'idle_session',
    screenplay: projection.screenplay,
  });
}

/**
 * **The "meaningful idle session" threshold: 10 minutes.**
 *
 * Too short and history fills with noise: a writer composing a scene pauses constantly -- to think
 * about the next line, to check a previous page, to take a phone call -- and those pauses
 * routinely run well past a minute without the writer having stopped working in any sense that
 * deserves its own place in history. Too long and a genuine session goes unrecorded until long
 * after it ends, or never (if the tab is simply left open with no further edits, nothing else in
 * this slice creates a revision for that session at all until this timer fires).
 *
 * 10 minutes is chosen specifically to sit above the range ordinary composition pauses occupy
 * (seconds to a few minutes) and below the range that would make a solid writing session -- this
 * codebase's own reference point, a feature-length screenplay, is conventionally discussed in
 * pages-per-sitting terms that correspond to tens of minutes of continuous or near-continuous
 * attention -- go unrecorded for unreasonably long. It is a deliberate, documented, tunable
 * constant, not a value plan.md specifies; `createIdleSessionRevisionScheduler`'s own `idleMs`
 * option exists precisely so a later, evidence-driven adjustment (or a test) never has to wait out
 * the real duration.
 */
export const IDLE_SESSION_REVISION_MS = 10 * 60 * 1000;

export interface IdleSessionRevisionScheduler {
  /** Resets this screenplay's idle timer -- call once per accepted edit (`server.ts`'s `onChange`
   * hook, which by construction only ever fires for a write that was actually applied to the live
   * document; a quarantined, read-only writer's edit never reaches this). */
  noteActivity(screenplayId: string, epoch: number): void;
  /** Cancels every pending timer with no further action -- called once, from `server.ts`'s
   * `onDestroy`, so a graceful shutdown never leaves a `setTimeout` outliving the process's own
   * database pool (which `onDestroy` closes in the same hook). A revision that would have been
   * created here is simply not created on this timeline; the screenplay's content itself is not at
   * risk either way (durability is `document_yjs_updates`'s job, not this one's). */
  dispose(): void;
}

/**
 * `idleMs` is overridable specifically so a test can prove this scheduler's own timer/reset/fire
 * behaviour without waiting out `IDLE_SESSION_REVISION_MS` for real -- production (`server.ts`)
 * never passes it, and always gets the real 10-minute threshold above.
 *
 * **A known, honestly-stated limitation: this scheduler's state is process-local.** If `apps/collab`
 * is ever run as more than one replica, each process tracks idle timers independently for whatever
 * screenplays its own connections touch, and two replicas that each handled edits to the same
 * screenplay (a writer's connection migrating between them, or a deploy overlap) could each fire
 * their own idle timer and each attempt an idle-session revision. This cannot corrupt anything or
 * produce a real duplicate -- `insertRevisionIfChanged`'s dedupe is authoritative regardless of
 * which process calls it, backed by a real Postgres advisory lock, not an in-memory one -- but it
 * could occasionally produce one extra, close-together automatic revision where a single-process
 * deployment would have produced one. Worth revisiting if and when this server is ever scaled
 * horizontally -- nothing in `progress/deploy-config.md` configures more than one `apps/collab`
 * replica, but this was not independently re-verified against the live Railway configuration while
 * writing this slice, so it is stated here as "should be checked," not as a settled fact.
 */
// Takes `onIdle` as a callback rather than a `Pool` directly -- deliberately decoupling this
// scheduler's own timer/reset/fire logic (pure, and the thing worth unit-testing in isolation)
// from `maybeCreateIdleSessionRevision`'s database access. `server.ts` wires the two together with
// a one-line closure; `revisions.test.ts` exercises the scheduler with a plain spy and no database
// or fake pool at all -- proving the scheduling behaviour itself (per-screenplay reset, firing only
// after real silence, `dispose` cancelling pending work) independent of what firing actually does.
export function createIdleSessionRevisionScheduler(
  onIdle: (screenplayId: string, epoch: number) => Promise<unknown>,
  options: {
    idleMs?: number;
    onError?: (error: unknown, screenplayId: string) => void;
  } = {},
): IdleSessionRevisionScheduler {
  const idleMs = options.idleMs ?? IDLE_SESSION_REVISION_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    noteActivity(screenplayId, epoch) {
      const existing = timers.get(screenplayId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timers.delete(screenplayId);
        onIdle(screenplayId, epoch).catch((error: unknown) => {
          options.onError?.(error, screenplayId);
        });
      }, idleMs);
      // Never keeps the Node process alive on its own -- a pending idle timer must not stop a
      // graceful shutdown from proceeding. `server.ts`'s `onDestroy` still calls `dispose()`
      // explicitly (this is defense in depth, not the only guard): `unref` only stops this timer
      // from being a *reason* the process stays up, it does not cancel the timer.
      timer.unref?.();
      timers.set(screenplayId, timer);
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
