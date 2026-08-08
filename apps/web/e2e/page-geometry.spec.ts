import { expect, test, type Page } from '@playwright/test';
import { MEASURED_COURIER_PRIME_ADVANCE_EM } from '@finaler-draft/screenplay/pageFormat';

// These specs prove the screenplay page geometry against real rendering rather than asserting
// it: real Courier Prime, real CSS, real Chrome layout. They inject markup using the exact
// classes and data attributes the editor renders (`.page`, `.script-body`,
// `[data-screenplay-block][data-screenplay-element=...]`, see apps/web/src/screenplayEditor.ts
// and apps/web/src/App.tsx) onto an already-served route, rather than driving the authenticated
// editor route, because the geometry is a property of the shipped CSS and font -- not of any
// particular screenplay's content or the API/DB layer that serves it. No database is required,
// which is why this spec runs under the ordinary playwright.config.ts rather than the
// persistence config.
//
// A one-character-per-inch (1 in = 96 px) tolerance budget of 0.01 in is used for the
// margin-based measures below (page size, padding, indents, page number position). Those are
// exact and font-independent -- pure CSS box-model arithmetic -- so 0.01in only exists to absorb
// sub-pixel rendering noise, not any real uncertainty. It is NOT used for the pitch assertion:
// the gap between Courier Prime's real advance and a generic monospace fallback's is roughly
// 0.00489 in over 60 characters (see the em-based tolerance below), well inside 0.01 in, so an
// inch-based check at that tolerance cannot tell the real font from a fallback. See the pitch
// test for the tolerance that can.
const TOLERANCE_IN = 0.01;

/**
 * Forces Courier Prime to actually load and confirms it did, rather than assuming
 * `document.fonts.ready` implies it. `fonts.ready` resolves once every *pending* load settles --
 * if nothing has requested the font yet on this page, it resolves immediately and any
 * measurement that follows silently uses the fallback in the `font-family` stack instead. That
 * is not hypothetical: measuring without this guard measures the fallback about as often as it
 * measures Courier Prime, since which one wins depends on load timing this function exists to
 * remove. A failed check throws here, in the fixture, rather than letting every test downstream
 * fail obscurely against fallback-font numbers.
 */
async function requireCourierPrime(page: Page): Promise<void> {
  const loaded = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load("16px 'Courier Prime'"),
      document.fonts.load("700 16px 'Courier Prime'"),
    ]);
    return (
      document.fonts.check("16px 'Courier Prime'") &&
      document.fonts.check("700 16px 'Courier Prime'")
    );
  });
  if (!loaded) {
    throw new Error(
      'Courier Prime did not report as loaded via document.fonts.check() after an explicit ' +
        'document.fonts.load(). Every measurement in this suite would silently be against ' +
        'whatever fallback monospace the browser substituted, not the real typeface.',
    );
  }
}

test.beforeEach(async ({ page }) => {
  // Any route works: main.tsx's @fontsource imports and styles.css load on every route, and
  // applyPageGeometryCssVariables() runs at bootstrap regardless of which one renders.
  await page.goto('/sign-in');
  await requireCourierPrime(page);
});

test('the page is a fixed 8.5 x 11 in physical page', async ({ page }) => {
  const size = await page.evaluate(() => {
    const el = document.createElement('article');
    el.className = 'page';
    document.body.appendChild(el);
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    // Read every computed value into a plain object before detaching the element: an
    // in-progress CSSStyleDeclaration goes stale (empty strings) once its element is removed.
    const result = {
      widthIn: rect.width / 96,
      paddingTopIn: parseFloat(style.paddingTop) / 96,
      paddingRightIn: parseFloat(style.paddingRight) / 96,
      paddingLeftIn: parseFloat(style.paddingLeft) / 96,
      paddingBottomIn: parseFloat(style.paddingBottom) / 96,
    };
    document.body.removeChild(el);
    return result;
  });

  expect(size.widthIn).toBeCloseTo(8.5, 5);
  expect(size.paddingTopIn).toBeCloseTo(1.0, 5);
  expect(size.paddingRightIn).toBeCloseTo(1.0, 5);
  expect(size.paddingLeftIn).toBeCloseTo(1.5, 5);
  expect(size.paddingBottomIn).toBeCloseTo(0, 5);
});

test('the page never reflows as the viewport narrows', async ({ page }) => {
  const widths: number[] = [];
  for (const width of [1400, 900, 700, 500, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const widthPx = await page.evaluate(() => {
      const el = document.createElement('article');
      el.className = 'page';
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      document.body.removeChild(el);
      return w;
    });
    widths.push(widthPx);
  }

  for (const widthPx of widths) {
    expect(widthPx / 96).toBeCloseTo(8.5, 5);
  }
});

test('12 pt Courier Prime renders at 10 pitch within tolerance: 60, 35, and 20 character measures', async ({
  page,
}) => {
  const measured = await page.evaluate(() => {
    function measureWidthPx(text: string): number {
      const span = document.createElement('span');
      span.style.position = 'absolute';
      span.style.visibility = 'hidden';
      span.style.whiteSpace = 'pre';
      span.style.fontFamily = "'Courier Prime', monospace";
      span.style.fontSize = '12pt';
      span.textContent = text;
      document.body.appendChild(span);
      const width = span.getBoundingClientRect().width;
      document.body.removeChild(span);
      return width;
    }

    return {
      action60Px: measureWidthPx('X'.repeat(60)),
      dialogue35Px: measureWidthPx('X'.repeat(35)),
      parenthetical20Px: measureWidthPx('X'.repeat(20)),
    };
  });

  const action60In = measured.action60Px / 96;
  const dialogue35In = measured.dialogue35Px / 96;
  const parenthetical20In = measured.parenthetical20Px / 96;

  // Margin-of-error checks against the nominal inch figures. Loose on purpose -- see the module
  // comment above for why 0.01in cannot by itself distinguish Courier Prime from a fallback.
  expect(Math.abs(action60In - 6.0)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(dialogue35In - 3.5)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(parenthetical20In - 2.0)).toBeLessThan(TOLERANCE_IN);

  // The assertion that actually pins the typeface: the rendered advance ratio (width per
  // character, as a fraction of the 16px em box at 12pt) must match
  // MEASURED_COURIER_PRIME_ADVANCE_EM, imported directly from the shared geometry module rather
  // than restated here. Tolerance is 1e-4 em. The measured gap between Courier Prime
  // (0.599609375 em) and a generic monospace fallback (0.60009765625 em, measured directly
  // against this same page) is about 4.88e-4 em -- 1e-4 is under a quarter of that gap, so a
  // fallback fails this loudly while the font's own (zero, per the measurement spike) rendering
  // noise passes with room to spare.
  const EM_TOLERANCE = 1e-4;
  const FONT_SIZE_PX = 16;
  const action60Ratio = measured.action60Px / (60 * FONT_SIZE_PX);
  const dialogue35Ratio = measured.dialogue35Px / (35 * FONT_SIZE_PX);
  const parenthetical20Ratio = measured.parenthetical20Px / (20 * FONT_SIZE_PX);

  expect(Math.abs(action60Ratio - MEASURED_COURIER_PRIME_ADVANCE_EM)).toBeLessThan(EM_TOLERANCE);
  expect(Math.abs(dialogue35Ratio - MEASURED_COURIER_PRIME_ADVANCE_EM)).toBeLessThan(EM_TOLERANCE);
  expect(Math.abs(parenthetical20Ratio - MEASURED_COURIER_PRIME_ADVANCE_EM)).toBeLessThan(
    EM_TOLERANCE,
  );
});

test('element indents match the specification, measured from the physical page edge', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const pageEl = document.createElement('article');
    pageEl.className = 'page';
    const body = document.createElement('div');
    body.className = 'script-body';

    function block(element: string, text: string): HTMLDivElement {
      const el = document.createElement('div');
      el.setAttribute('data-screenplay-block', '');
      el.setAttribute('data-screenplay-element', element);
      el.textContent = text;
      return el;
    }

    const action = block('action', 'X'.repeat(60));
    const character = block('character', 'MARA');
    const dialogue = block('dialogue', 'X'.repeat(35));
    const parenthetical = block('parenthetical', 'X'.repeat(20));
    const transition = block('transition', 'CUT TO:');

    body.append(action, character, dialogue, parenthetical, transition);
    pageEl.appendChild(body);
    document.body.appendChild(pageEl);

    const pageRect = pageEl.getBoundingClientRect();
    const relLeftIn = (el: Element) => (el.getBoundingClientRect().left - pageRect.left) / 96;
    const widthIn = (el: Element) => el.getBoundingClientRect().width / 96;
    const relRightIn = (el: Element) => (pageRect.right - el.getBoundingClientRect().right) / 96;
    const textAlign = getComputedStyle(transition).textAlign;

    const out = {
      actionLeftIn: relLeftIn(action),
      actionWidthIn: widthIn(action),
      characterLeftIn: relLeftIn(character),
      dialogueLeftIn: relLeftIn(dialogue),
      dialogueWidthIn: widthIn(dialogue),
      parentheticalLeftIn: relLeftIn(parenthetical),
      parentheticalWidthIn: widthIn(parenthetical),
      transitionRightIn: relRightIn(transition),
      transitionTextAlign: textAlign,
    };

    document.body.removeChild(pageEl);
    return out;
  });

  expect(Math.abs(result.actionLeftIn - 1.5)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(result.actionWidthIn - 6.0)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(result.characterLeftIn - 3.7)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(result.dialogueLeftIn - 2.5)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(result.dialogueWidthIn - 3.5)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(result.parentheticalLeftIn - 3.1)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(result.parentheticalWidthIn - 2.0)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(result.transitionRightIn - 1.0)).toBeLessThan(TOLERANCE_IN);
  expect(result.transitionTextAlign).toBe('right');
});

test('the page number sits 0.5 in from the top and 0.75 in from the right', async ({ page }) => {
  const result = await page.evaluate(() => {
    const pageEl = document.createElement('article');
    pageEl.className = 'page';
    const pageNumber = document.createElement('div');
    pageNumber.className = 'page-number';
    pageNumber.textContent = '2.';
    pageEl.appendChild(pageNumber);
    document.body.appendChild(pageEl);

    const pageRect = pageEl.getBoundingClientRect();
    const numberRect = pageNumber.getBoundingClientRect();
    const out = {
      topIn: (numberRect.top - pageRect.top) / 96,
      rightIn: (pageRect.right - numberRect.right) / 96,
    };
    document.body.removeChild(pageEl);
    return out;
  });

  expect(Math.abs(result.topIn - 0.5)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(result.rightIn - 0.75)).toBeLessThan(TOLERANCE_IN);
});

test('zoom scales the page visually without changing the character grid', async ({ page }) => {
  const result = await page.evaluate(() => {
    const pageEl = document.createElement('article');
    pageEl.className = 'page';
    pageEl.style.transform = 'scale(0.7)';
    const body = document.createElement('div');
    body.className = 'script-body';
    const action = document.createElement('div');
    action.setAttribute('data-screenplay-block', '');
    action.setAttribute('data-screenplay-element', 'action');
    action.textContent = 'X'.repeat(60);
    body.appendChild(action);
    pageEl.appendChild(body);
    document.body.appendChild(pageEl);

    // offsetWidth is the layout (pre-transform) box, which is what a character-count line
    // break would be computed against; getBoundingClientRect().width is the painted, scaled
    // size a user actually sees.
    const naturalWidthIn = action.offsetWidth / 96;
    const visualWidthIn = action.getBoundingClientRect().width / 96;

    document.body.removeChild(pageEl);
    return { naturalWidthIn, visualWidthIn };
  });

  expect(Math.abs(result.naturalWidthIn - 6.0)).toBeLessThan(TOLERANCE_IN);
  expect(Math.abs(result.visualWidthIn - 6.0 * 0.7)).toBeLessThan(TOLERANCE_IN);
});
