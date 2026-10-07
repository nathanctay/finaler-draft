/**
 * The zoom control's own vocabulary: the reachable range, the step, the default, and the preset
 * percentages the toolbar's dropdown offers.
 *
 * These lived in `zoom.ts` until the comparison view grew a real toolbar. `zoom.ts` is the editor's
 * zoom *mechanism* -- `ZoomMode`, the fit-mode resolution that measures `.editor-region`, the
 * pointer-anchored and centred scroll capture/restore -- and it is reachable only from `App.tsx`,
 * which is what keeps it inside the lazily-loaded editor chunk. `applicationToolbar.tsx` is shared
 * by the editor and the read-only comparison, and it needs exactly these numbers and nothing else
 * from zoom: the option list it renders, and the bounds the stepper clamps to.
 *
 * Splitting them out is what lets both screens offer the *identical* zoom control -- same options,
 * same floor, same ceiling, same step -- from one authority rather than from a second preset list
 * written down beside the comparison (which is what the comparison had, deliberately, while it was
 * the only screen with no toolbar: a `COMPARISON_ZOOM_PERCENTS` of its own, now gone). `zoom.ts`
 * re-exports every name below, so nothing that already imported them from there had to change.
 *
 * No React, no DOM, no editor: this module is arithmetic and five constants, which is why it is safe
 * for the comparison chunk to reach.
 */

/**
 * The floor moved from 70 to 50 in the zoom-modes slice. At 100% the page is 8.5in, roughly 816px;
 * fit-width lands around 60-85% on ordinary windows, so 50% only binds where 12pt Courier is
 * already at the edge of legibility. A fit mode clamps to this floor rather than overriding it --
 * the *mode* survives the clamp, so a later resize that creates room recomputes and un-clamps on
 * its own (`zoom.ts`'s `resolveZoomPercent`). At the clamp, fit-width genuinely does not fit and
 * horizontal scroll appears; that is accepted, not a defect to design around.
 */
export const ZOOM_MIN_PERCENT = 50;
/** Unchanged since before the zoom-modes slice. */
export const ZOOM_MAX_PERCENT = 150;
/** The step the zoom in/out controls and their keyboard equivalents move by. */
export const ZOOM_STEP_PERCENT = 10;
export const ZOOM_DEFAULT_PERCENT = 100;

/** The preset dropdown's fixed-percentage options (plan.md: "a set of fixed percentages plus
 * 'Fit page' and 'Fit width'"). Deliberately includes both boundary values -- 50, the floor, and
 * 150, the ceiling -- so every reachable fixed extreme is one click away, not only reachable by
 * repeatedly pressing the stepper. */
export const ZOOM_PRESET_PERCENTS = [50, 60, 70, 80, 90, 100, 110, 125, 150] as const;

export function clampZoomPercent(percent: number): number {
  return Math.min(ZOOM_MAX_PERCENT, Math.max(ZOOM_MIN_PERCENT, percent));
}
