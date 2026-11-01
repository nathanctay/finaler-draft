import { expect, test } from '@playwright/test';

/**
 * `.section-head`: a page heading with one action aligned to its right. Its only use today is the
 * revision-history list's "Back to screenplay" beside its own `<h1>`, which the owner asked to be
 * right-aligned and styled like the comparison view's "Back to revisions".
 *
 * Measured in a real browser because every property that can go wrong here is geometric, and jsdom
 * resolves no stylesheet and runs no layout -- the unit suite passes whether the control is
 * right-aligned, centred, or stacked underneath. Three visual defects on this project have already
 * reached the owner through a green unit suite, so a `.section-head` with no measurement would be
 * the fourth.
 */
const MARKUP = `
<main class="project-screen">
  <section class="project-list">
    <p class="eyebrow">HISTORY</p>
    <div class="section-head" id="row">
      <h1 id="heading">Revision history</h1>
      <a class="primary-button" href="/x" id="action">Back to screenplay</a>
    </div>
    <p id="after">First revision</p>
  </section>
</main>`;

test('the action sits at the right of the heading, vertically centred on it', async ({ page }) => {
  await page.goto('/sign-in');
  const measured = await page.evaluate((markup) => {
    document.body.innerHTML = markup;
    const box = (id: string) =>
      document.querySelector<HTMLElement>(`#${id}`)!.getBoundingClientRect();
    const action = box('action');
    const heading = box('heading');
    const row = box('row');
    return {
      // Right-aligned: the action's right edge meets the row's, and it starts after the heading ends.
      rightGap: row.right - action.right,
      clearsHeading: action.left - heading.right,
      // Vertically centred on the heading rather than hanging below its baseline.
      centreOffset: Math.abs(action.top + action.height / 2 - (heading.top + heading.height / 2)),
      // Filled, not a bare text link -- the owner asked for the "Back to revisions" treatment.
      background: getComputedStyle(document.querySelector<HTMLElement>('#action')!).backgroundColor,
      // One row, not stacked: both sit on the same line.
      sameRow: Math.abs(action.top - heading.top) < heading.height,
      // The heading's own margin was hoisted to the row; this is what proves the page's rhythm
      // survived that move rather than collapsing or doubling.
      gapToNextParagraph: Math.round(box('after').top - row.bottom),
      rowBottomMargin: getComputedStyle(document.querySelector<HTMLElement>('#row')!).marginBottom,
      headingMargin: getComputedStyle(document.querySelector<HTMLElement>('#heading')!)
        .marginBottom,
    };
  }, MARKUP);

  expect(measured.rightGap).toBeLessThan(1);
  expect(measured.clearsHeading).toBeGreaterThan(0);
  expect(measured.sameRow).toBe(true);

  // Within a pixel of a shared centre line. Baseline alignment, which this used while it was a
  // text link, puts a padded control's box below the heading's baseline and fails this.
  expect(measured.centreOffset).toBeLessThan(1.5);

  // A real fill, not transparent.
  expect(measured.background).not.toBe('rgba(0, 0, 0, 0)');

  // The 28px of rhythm the heading used to own now belongs to the row, and is not applied twice.
  expect(measured.rowBottomMargin).toBe('28px');
  expect(measured.headingMargin).toBe('0px');
  expect(measured.gapToNextParagraph).toBe(28);
});
