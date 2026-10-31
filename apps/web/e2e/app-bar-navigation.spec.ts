import { expect, test, type Page } from '@playwright/test';
import { contrastRatio, relativeLuminance } from '@finaler-draft/screenplay-editor';

/**
 * The shared app bar (`progress/app-bar-navigation.md`): brand left, breadcrumb trail centre,
 * account menu right, on the dark `.titlebar` surface every screen now wears -- replacing the
 * light `.project-header` treatment the Projects list, the project screen and Deleted items used
 * to carry instead.
 *
 * jsdom performs no layout and resolves no stylesheet (`applicationShell.test.tsx`'s own top
 * comment makes the same point for `.application`'s grid tracks), so none of this -- where the
 * three regions actually land relative to each other, whether the bar is actually the dark
 * surface rather than the page's own light one, whether the account menu's text is legible
 * against it -- is something a unit test can measure. `title-rename-appearance.spec.ts` and
 * `text-contrast.spec.ts` established the technique this file reuses: inject markup using the
 * app's own classes onto an already-served route (no database, no authentication, no particular
 * project or screenplay needed, since every property measured here belongs to the shipped CSS
 * alone) and read real computed styles and real geometry.
 *
 * Every expectation below is a *relationship* between measured values -- ordering, a luminance
 * comparison, a contrast ratio against the WCAG floor -- never a hardcoded pixel or colour
 * literal, for the same reason `text-contrast.spec.ts`'s own top comment gives: a literal would
 * pass even if the token it was copied from changed underneath it.
 */

const TITLEBAR_MARKUP = `
<main class="application">
  <header class="titlebar">
    <a aria-label="Finaler Draft — back to your projects" class="brand" href="/projects" id="brand">
      <span class="brand-mark">F</span>
      <span>Finaler Draft</span>
    </a>
    <nav aria-label="Breadcrumb" class="breadcrumb" id="breadcrumb">
      <span class="breadcrumb-segment">
        <button class="breadcrumb-link" id="ancestor" type="button">Projects</button>
        <span aria-hidden="true" class="breadcrumb-separator">/</span>
      </span>
      <div aria-current="page" class="document-title" id="current">
        Hollow Heart <span class="title-type">Screenplay</span>
      </div>
    </nav>
    <div class="account-menu" id="account-menu">
      <div class="overflow-menu">
        <button aria-expanded="false" aria-haspopup="menu" aria-label="Account menu"
          class="overflow-menu-trigger" id="account-trigger" type="button">Account</button>
      </div>
    </div>
  </header>
</main>`;

/** The plain, light-themed list page the bar now also sits on top of, for the "it is genuinely
 * dark, not merely restyled" comparison below -- `.project-screen`'s own background, unchanged by
 * this slice. */
const PROJECT_SCREEN_MARKUP = `<main class="project-screen" id="project-screen"></main>`;

function toHexColor(value: string, context: string): string {
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/u.exec(
    value.trim(),
  );
  if (!match) throw new Error(`${context}: not an rgb() colour: ${value}`);
  if (match[4] !== undefined && Number(match[4]) !== 1) {
    throw new Error(`${context}: translucent colour ${value} cannot be measured opaquely`);
  }
  return `#${match
    .slice(1, 4)
    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

async function measureBar(page: Page) {
  await page.goto('/sign-in');
  return page.evaluate(
    ({ projectScreenMarkup, titlebarMarkup }) => {
      document.body.innerHTML = titlebarMarkup + projectScreenMarkup;

      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const color = (selector: string) => getComputedStyle(document.querySelector(selector)!);

      return {
        accountMenu: rect('#account-menu'),
        ancestor: rect('#ancestor'),
        ancestorColor: color('#ancestor').color,
        bar: rect('.titlebar'),
        barBackground: color('.titlebar').backgroundColor,
        brand: rect('#brand'),
        // `#breadcrumb` is the `<nav>` itself, which is `flex: 1` and so always spans the whole
        // region between the brand and the account menu regardless of how its own content is
        // justified -- measuring *it* for centring would pass whether `.breadcrumb`'s
        // `justify-content` said `center` or `flex-start`, since the box being measured would be
        // identical either way. `#ancestor`'s left edge to `#current`'s right edge is the actual
        // rendered content span that `justify-content` moves.
        breadcrumb: rect('#breadcrumb'),
        current: rect('#current'),
        currentColor: color('#current').color,
        projectScreenBackground: color('#project-screen').backgroundColor,
        triggerColor: color('#account-trigger').color,
        triggerBackground: (() => {
          // The trigger itself declares no background at rest (styles.css: transparent until
          // hover) -- the surface it is actually read against is the bar behind it, the same
          // "walk up to the nearest painted ancestor" rule text-contrast.spec.ts's own `measure`
          // helper uses.
          let node: Element | null = document.querySelector('#account-trigger');
          while (node) {
            const background = getComputedStyle(node).backgroundColor;
            if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') {
              return background;
            }
            node = node.parentElement;
          }
          return getComputedStyle(document.documentElement).backgroundColor;
        })(),
      };
    },
    { projectScreenMarkup: PROJECT_SCREEN_MARKUP, titlebarMarkup: TITLEBAR_MARKUP },
  );
}

test('lays out brand left, the breadcrumb trail centre, and the account menu right', async ({
  page,
}) => {
  const measured = await measureBar(page);

  // Brand first, and flush against the bar's own left edge (modulo the bar's own padding -- no
  // other chrome sits left of it).
  expect(measured.brand.left).toBeLessThan(measured.breadcrumb.left);
  expect(measured.brand.left - measured.bar.left).toBeLessThan(20);

  // The breadcrumb trail sits strictly between the brand and the account menu -- never
  // overlapping either, in reading order.
  expect(measured.breadcrumb.left).toBeGreaterThanOrEqual(measured.brand.right);
  expect(measured.breadcrumb.right).toBeLessThanOrEqual(measured.accountMenu.left);

  // The account menu is flush against the bar's own right edge.
  expect(measured.bar.right - measured.accountMenu.right).toBeLessThan(20);

  // And the breadcrumb trail is visibly centred *within the room it has*, not merely somewhere
  // left of the account menu: the rendered content's own midpoint (the ancestor link's left edge
  // to the current title's right edge -- not `#breadcrumb` itself, which is `flex: 1` and so
  // spans the same box between the brand and the account menu regardless of how its content is
  // justified, and so cannot distinguish centred from flush-left) sits close to the midpoint of
  // the space between the brand and the account menu. A generous tolerance (15% of that space) is
  // still a tenth of what a flush-left regression actually measures here -- comfortably separates
  // "centred" from "not" without pinning an exact pixel.
  const available = { left: measured.brand.right, right: measured.accountMenu.left };
  const availableCenter = (available.left + available.right) / 2;
  const availableWidth = available.right - available.left;
  const contentCenter = (measured.ancestor.left + measured.current.right) / 2;
  expect(Math.abs(contentCenter - availableCenter)).toBeLessThan(availableWidth * 0.15);
});

test('the bar is the dark surface on every screen, not the plain page’s own light one', async ({
  page,
}) => {
  const measured = await measureBar(page);
  const barBackground = toHexColor(measured.barBackground, 'titlebar background');
  const pageBackground = toHexColor(measured.projectScreenBackground, 'project-screen background');

  expect(barBackground).not.toBe(pageBackground);
  // Darker, not merely different: the light `.project-header` treatment this slice removes was a
  // page-coloured strip: progress/app-bar-navigation.md's before/after table on the two chrome
  // families' ground colour.
  expect(relativeLuminance(barBackground)).toBeLessThan(relativeLuminance(pageBackground));
});

test('the current (non-navigating) segment reads differently from an ancestor link beside it', async ({
  page,
}) => {
  const measured = await measureBar(page);
  expect(measured.ancestorColor).not.toBe(measured.currentColor);
});

/**
 * The regression this slice's own `.titlebar .overflow-menu-trigger` override exists to prevent:
 * `OverflowMenu`'s default trigger colour (`--text-09`) is tuned for the light surfaces every
 * other instance of it sits on and is close to unreadable against the bar's dark background
 * without it -- see that rule's own comment in styles.css. Mutation-tested by deleting the
 * override locally while developing this spec (see progress/app-bar-navigation.md's mutation
 * table): with it removed, this assertion drops under 2:1 and fails.
 */
test('the account menu trigger clears WCAG 1.4.3 against the bar behind it', async ({ page }) => {
  const measured = await measureBar(page);
  const color = toHexColor(measured.triggerColor, 'account menu trigger colour');
  const background = toHexColor(measured.triggerBackground, 'account menu trigger background');
  expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
});
