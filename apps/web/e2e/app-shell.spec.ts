import { expect, test, type Page } from '@playwright/test';

// Proves "Application shell" in plan.md against real Chrome layout: the shell is fixed to the
// viewport and only the editor region scrolls. Like page-geometry.spec.ts, this injects markup
// using the exact classes App.tsx renders (`.application`, `.titlebar`, `.menubar`, `.toolbar`,
// `.workspace`, `.panel`, `.editor-region`, `.statusbar`) onto an already-served route, rather
// than driving the authenticated editor route -- the shell's fixed-viewport behaviour is a
// property of the shipped CSS, not of any particular screenplay's content or the API/DB layer
// that serves it, so no database is required and this spec runs under the ordinary
// playwright.config.ts rather than the persistence config.
//
// The bug this replaces was measured at an 800px-tall viewport (see progress/line-grid-and-shell.md
// and plan.md): the shell computed to 1290px, 490px of it below the fold, and the editor region
// never scrolled at all. This spec pins that same viewport height so a regression reproduces the
// original defect's numbers, not an unrelated one.
const VIEWPORT = { width: 1280, height: 800 };

async function buildShell(page: Page, overflowingContentHeightPx: number): Promise<void> {
  await page.evaluate((contentHeightPx) => {
    // The route's own rendered content (the sign-in form, styled `min-height: 100vh` via
    // .entry-screen) would otherwise stack above this fixture in normal document flow and skew
    // every viewport-relative measurement below -- unlike page-geometry.spec.ts's fixtures, which
    // only compare positions *within* their own injected element and so are immune to it, this
    // spec measures document- and viewport-relative geometry directly and needs a clean body.
    document.body.innerHTML = '';

    const application = document.createElement('main');
    application.className = 'application';

    const titlebar = document.createElement('header');
    titlebar.className = 'titlebar';
    titlebar.textContent = 'Finaler Draft';

    const menubar = document.createElement('nav');
    menubar.className = 'menubar';
    menubar.textContent = 'File Edit View';

    const toolbar = document.createElement('section');
    toolbar.className = 'toolbar';
    toolbar.textContent = 'Tools';

    const workspace = document.createElement('div');
    workspace.className = 'workspace';

    const navigator = document.createElement('aside');
    navigator.className = 'panel navigator';
    const navigatorContent = document.createElement('div');
    navigatorContent.style.height = `${contentHeightPx}px`;
    // .panel is a column flex container, so its child is a flex item on the main (vertical)
    // axis. An empty div's content-based minimum height is near zero, so without flex-shrink: 0
    // the flexbox algorithm would shrink this synthetic fixture to fit the available space
    // instead of overflowing it -- collapsing the very overflow this test exists to force. Real
    // Navigator/Inspector content doesn't need this: it's built from many actual rows (scene
    // list items, form fields), and a block box's min-content height in the vertical axis is its
    // natural content height, not a compressible minimum the way width can wrap to shrink.
    navigatorContent.style.flexShrink = '0';
    navigatorContent.textContent = 'Scene list';
    navigator.appendChild(navigatorContent);

    const editorRegion = document.createElement('section');
    editorRegion.className = 'editor-region';
    const page_ = document.createElement('article');
    page_.className = 'page';
    page_.style.height = `${contentHeightPx}px`;
    page_.textContent = 'Screenplay page';
    editorRegion.appendChild(page_);

    const inspector = document.createElement('aside');
    inspector.className = 'panel inspector';
    const inspectorContent = document.createElement('div');
    inspectorContent.style.height = `${contentHeightPx}px`;
    inspectorContent.style.flexShrink = '0';
    inspectorContent.textContent = 'Inspector fields';
    inspector.appendChild(inspectorContent);

    workspace.append(navigator, editorRegion, inspector);

    const statusbar = document.createElement('footer');
    statusbar.className = 'statusbar';
    statusbar.textContent = 'Save state';

    application.append(titlebar, menubar, toolbar, workspace, statusbar);
    document.body.appendChild(application);
  }, overflowingContentHeightPx);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  // Any already-served route works, same reasoning as page-geometry.spec.ts.
  await page.goto('/sign-in');
});

test('the application shell is fixed to the viewport and the document itself never scrolls', async ({
  page,
}) => {
  await buildShell(page, 3000);

  const measurements = await page.evaluate(() => {
    const application = document.querySelector('.application');
    if (!application) {
      throw new Error('Missing .application in the injected fixture.');
    }
    return {
      applicationHeight: application.getBoundingClientRect().height,
      documentScrollHeight: document.documentElement.scrollHeight,
    };
  });

  expect(measurements.applicationHeight).toBeCloseTo(VIEWPORT.height, 0);
  // The whole point of the fix: the outer document never grows past the viewport, no matter how
  // tall the manuscript inside the editor region is.
  expect(measurements.documentScrollHeight).toBeLessThanOrEqual(VIEWPORT.height);
});

test('the editor region is the only thing that scrolls; the shell chrome stays put', async ({
  page,
}) => {
  await buildShell(page, 3000);

  const measurements = await page.evaluate(() => {
    const editorRegion = document.querySelector('.editor-region');
    if (!editorRegion) {
      throw new Error('Missing .editor-region in the injected fixture.');
    }
    return {
      editorClientHeight: editorRegion.clientHeight,
      editorScrollHeight: editorRegion.scrollHeight,
    };
  });

  // The old defect, verbatim: scrollHeight === clientHeight meant the region never scrolled
  // because .application had already grown to fit the 3000px page instead of clipping it.
  expect(measurements.editorScrollHeight).toBeGreaterThan(measurements.editorClientHeight);
});

test('title bar, menu bar, toolbar, and status bar stay visible when the editor content overflows', async ({
  page,
}) => {
  await buildShell(page, 3000);

  const rects = await page.evaluate(() => {
    function rect(selector: string) {
      const el = document.querySelector(selector);
      if (!el) {
        throw new Error(`Missing ${selector} in the injected fixture.`);
      }
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }
    return {
      titlebar: rect('.titlebar'),
      menubar: rect('.menubar'),
      toolbar: rect('.toolbar'),
      statusbar: rect('.statusbar'),
    };
  });

  for (const [name, r] of Object.entries(rects)) {
    expect(r.top, `${name} top`).toBeGreaterThanOrEqual(0);
    // This is the exact defect from the bug report: the status bar's bottom edge landing 490px
    // below an 800px fold. Every shell region must stay fully within the viewport.
    expect(r.bottom, `${name} bottom`).toBeLessThanOrEqual(VIEWPORT.height);
  }
});

test('the Navigator and Inspector panels scroll their own overflowing content independently', async ({
  page,
}) => {
  await buildShell(page, 3000);

  const measurements = await page.evaluate(() => {
    function panelOverflow(selector: string) {
      const el = document.querySelector(selector);
      if (!el) {
        throw new Error(`Missing ${selector} in the injected fixture.`);
      }
      return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
    }
    return {
      inspector: panelOverflow('.panel.inspector'),
      navigator: panelOverflow('.panel.navigator'),
    };
  });

  expect(measurements.navigator.scrollHeight).toBeGreaterThan(measurements.navigator.clientHeight);
  expect(measurements.inspector.scrollHeight).toBeGreaterThan(measurements.inspector.clientHeight);
});

/**
 * `.save-dot.attention` is the small always-visible half of the "this document is not saving"
 * indicator (`App.tsx` applies it next to the document title whenever the projection is invalid).
 * It shipped with the class applied and **no CSS rule at all** -- the dot stayed the neutral colour
 * whether the document was saving or not -- and nothing caught that, because jsdom does not load
 * `styles.css` and the unit tests only prove the class is applied, not that it resolves to
 * anything. The owner reported seeing no signal that saving had stopped; this was one reason why.
 *
 * Asserting the *resolved* colour is the only level at which that class of defect is visible, and
 * it needs a real browser with the real stylesheet. It deliberately does not drive an invalid
 * document: paste sanitisation closed the ordinary route to one, and the property under test here
 * is the stylesheet's, not the projection's -- `App.test.tsx` already covers the class being
 * applied for the right reason.
 */
test('the not-saving dot resolves to a visibly different colour from the saving one', async ({
  page,
}) => {
  const colours = await page.evaluate(() => {
    const neutral = document.createElement('span');
    neutral.className = 'save-dot';
    const attention = document.createElement('span');
    attention.className = 'save-dot attention';
    document.body.append(neutral, attention);
    const read = (el: HTMLElement) => window.getComputedStyle(el).backgroundColor;
    const result = { attention: read(attention), neutral: read(neutral) };
    neutral.remove();
    attention.remove();
    return result;
  });

  // Both must actually resolve: an unmatched class yields a transparent default, which is exactly
  // the state this shipped in and is indistinguishable from "no rule" if only inequality is checked.
  expect(colours.neutral).not.toBe('rgba(0, 0, 0, 0)');
  expect(colours.attention).not.toBe('rgba(0, 0, 0, 0)');
  expect(colours.attention).not.toBe(colours.neutral);
});
