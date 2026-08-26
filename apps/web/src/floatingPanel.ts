/**
 * Placement for the panels this editor floats at the caret: SmartType's candidate list
 * (`smartTypeList.tsx`) and the element menu (`elementMenu.tsx`).
 *
 * One module rather than one copy each, because the two panels are the same object to a writer --
 * a box that appears under the caret, never off screen, never covering the line being typed -- and
 * two copies of that arithmetic would be two panels free to disagree about it. It holds geometry
 * only: no editor state, no ProseMirror, nothing about what either panel contains. Each caller
 * decides for itself what to measure against and passes the rectangle in.
 *
 * It is deliberately not part of `smartTypeList.tsx`, which is built to be deleted wholesale (see
 * its header): a helper the element menu depends on cannot live inside the layer whose removal is
 * a supported operation.
 */

/** Distance from the caret to the panel, and the smallest gap kept between the panel and the
 * viewport edge. Both in CSS pixels, matching `.overflow-menu-list`'s own 4px offset. */
const CARET_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;

/**
 * Places `panel` at `caret`, in viewport coordinates, and keeps it on screen.
 *
 * Two placements are possible and the choice between them is the only judgement here: below the
 * caret when the panel fits there, above it when it does not. Below is preferred even when the
 * room is tight, because a panel above the caret covers the line the writer is typing; it flips
 * only when staying below would put rows off-screen. When neither side has room -- a very short
 * window -- the panel is clamped into the viewport and scrolls internally (`max-height` in
 * styles.css), which keeps every row reachable by `ArrowDown` even where none of them can be on
 * screen at once.
 *
 * A page seam is deliberately not a case. These panels are fixed-position chrome floating over the
 * canvas, not something laid out on paper: near the bottom of a page one simply paints across the
 * seam and onto the next sheet, the same way it paints over the margin anywhere else. Nudging it
 * clear of a seam would move it away from the caret it belongs to, and clipping it to the page
 * would hide rows -- both worse than an overlay that overlaps a page edge, which is what an
 * overlay is for.
 *
 * Written to the element's own style rather than through React state so that the measurement and
 * the placement happen in one layout pass, with no frame where the panel is painted somewhere
 * else first.
 */
export function placeAtCaret(panel: HTMLElement, caret: DOMRect): void {
  const { height, width } = panel.getBoundingClientRect();
  const { innerHeight, innerWidth } = window;

  const below = caret.bottom + CARET_GAP_PX;
  const above = caret.top - CARET_GAP_PX - height;
  const fitsBelow = below + height <= innerHeight - VIEWPORT_MARGIN_PX;
  const preferred = fitsBelow || above < VIEWPORT_MARGIN_PX ? below : above;

  const top = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(preferred, innerHeight - VIEWPORT_MARGIN_PX - height),
  );
  const left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(caret.left, innerWidth - VIEWPORT_MARGIN_PX - width),
  );
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
}
