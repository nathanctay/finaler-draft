import { expect, test } from '@playwright/test';
import { MEASURED_COURIER_PRIME_ADVANCE_EM } from '@finaler-draft/screenplay/pageFormat';
import { requireCourierPrime } from './requireCourierPrime.js';

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

// Zoom modes (progress/zoom-modes.md): this test used to check a single scale factor (0.7, the
// midpoint of the old 70-150 range). Extended per plan.md's own instruction ("extend it to the
// new paths rather than trusting that a new mechanism preserves the property") to cover every
// scale factor the new mode machinery can actually produce: 0.5, the new floor a clamped fit mode
// can land on (zoom.ts's `ZOOM_MIN_PERCENT`); 1.5, the unchanged ceiling; and 0.6125, a
// deliberately non-round fraction standing in for an ordinary fit-width/fit-page result (real
// window dimensions divided by the page's natural size essentially never land on a clean tenth) --
// proving the invariant holds for whatever arbitrary fraction a fit computation happens to produce,
// not only the round percentages a fixed-percent zoom offers. The mechanism under test is still
// exactly `transform: scale()` on `.page` -- new zoom *modes* only changed how the scale factor
// passed to it gets chosen (App.tsx/zoom.ts), never how `.page` itself renders that factor -- so
// this loop extends the existing proof to the new range and the new kind of value, rather than
// hypothesising a new mechanism.
for (const scale of [0.5, 0.6125, 0.7, 1.5]) {
  test(`zoom scales the page visually without changing the character grid, at ${scale}x`, async ({
    page,
  }) => {
    const result = await page.evaluate((scaleFactor) => {
      const pageEl = document.createElement('article');
      pageEl.className = 'page';
      pageEl.style.transform = `scale(${scaleFactor})`;
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
    }, scale);

    expect(Math.abs(result.naturalWidthIn - 6.0)).toBeLessThan(TOLERANCE_IN);
    expect(Math.abs(result.visualWidthIn - 6.0 * scale)).toBeLessThan(TOLERANCE_IN);
  });
}

// A pixel tolerance for the line-grid tests below, distinct from TOLERANCE_IN. These measure
// getBoundingClientRect() top-edge deltas between sibling blocks, which -- unlike the margin and
// indent checks above -- are whole multiples of a single 16px line box (12pt at line-height 1,
// see LINE_HEIGHT_RATIO in pageFormat.ts) with no font-dependent horizontal component at all. A
// real defect here is at minimum a dozen pixels (the old 25px inter-element gap this suite
// replaces), so 0.5px is generous headroom for sub-pixel layout rounding while still failing
// loudly on anything that would actually move a line off the six-per-inch grid.
const LINE_TOLERANCE_PX = 0.5;
const LINE_HEIGHT_PX = 16;

test.describe('vertical spacing between elements is whole lines on the six-per-inch grid', () => {
  test('a character block followed by dialogue occupies two consecutive line boxes with no gap', async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      function block(element: string, text: string): HTMLDivElement {
        const el = document.createElement('div');
        el.setAttribute('data-screenplay-block', '');
        el.setAttribute('data-screenplay-element', element);
        el.textContent = text;
        return el;
      }

      const pageEl = document.createElement('article');
      pageEl.className = 'page';
      const body = document.createElement('div');
      body.className = 'script-body';
      const character = block('character', 'MARA');
      const dialogue = block('dialogue', 'If the ending is true, it earns its way there.');
      body.append(character, dialogue);
      pageEl.appendChild(body);
      document.body.appendChild(pageEl);

      const out = {
        characterTop: character.getBoundingClientRect().top,
        characterHeight: character.getBoundingClientRect().height,
        dialogueTop: dialogue.getBoundingClientRect().top,
      };
      document.body.removeChild(pageEl);
      return out;
    });

    expect(Math.abs(result.characterHeight - LINE_HEIGHT_PX)).toBeLessThan(LINE_TOLERANCE_PX);
    expect(
      Math.abs(result.dialogueTop - (result.characterTop + result.characterHeight)),
    ).toBeLessThan(LINE_TOLERANCE_PX);
  });

  test('character, parenthetical, and dialogue together occupy exactly three consecutive line boxes', async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      function block(element: string, text: string): HTMLDivElement {
        const el = document.createElement('div');
        el.setAttribute('data-screenplay-block', '');
        el.setAttribute('data-screenplay-element', element);
        el.textContent = text;
        return el;
      }

      const pageEl = document.createElement('article');
      pageEl.className = 'page';
      const body = document.createElement('div');
      body.className = 'script-body';
      const character = block('character', 'MARA');
      const parenthetical = block('parenthetical', '(quietly)');
      const dialogue = block('dialogue', 'It has to earn its way there.');
      body.append(character, parenthetical, dialogue);
      pageEl.appendChild(body);
      document.body.appendChild(pageEl);

      const characterTop = character.getBoundingClientRect().top;
      const dialogueRect = dialogue.getBoundingClientRect();
      const out = {
        totalHeight: dialogueRect.top + dialogueRect.height - characterTop,
      };
      document.body.removeChild(pageEl);
      return out;
    });

    expect(Math.abs(result.totalHeight - LINE_HEIGHT_PX * 3)).toBeLessThan(LINE_TOLERANCE_PX);
  });

  test('an action block following dialogue is separated by exactly one blank line', async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      function block(element: string, text: string): HTMLDivElement {
        const el = document.createElement('div');
        el.setAttribute('data-screenplay-block', '');
        el.setAttribute('data-screenplay-element', element);
        el.textContent = text;
        return el;
      }

      const pageEl = document.createElement('article');
      pageEl.className = 'page';
      const body = document.createElement('div');
      body.className = 'script-body';
      const dialogue = block('dialogue', 'It has to earn its way there.');
      const action = block('action', 'She closes the script.');
      body.append(dialogue, action);
      pageEl.appendChild(body);
      document.body.appendChild(pageEl);

      const dialogueRect = dialogue.getBoundingClientRect();
      const out = {
        dialogueBottom: dialogueRect.top + dialogueRect.height,
        actionTop: action.getBoundingClientRect().top,
      };
      document.body.removeChild(pageEl);
      return out;
    });

    expect(Math.abs(result.actionTop - (result.dialogueBottom + LINE_HEIGHT_PX))).toBeLessThan(
      LINE_TOLERANCE_PX,
    );
  });

  test("every element's top edge falls on a six-per-inch boundary relative to the first line of the body", async ({
    page,
  }) => {
    const offsets = await page.evaluate(() => {
      function block(element: string, text: string): HTMLDivElement {
        const el = document.createElement('div');
        el.setAttribute('data-screenplay-block', '');
        el.setAttribute('data-screenplay-element', element);
        el.textContent = text;
        return el;
      }

      const pageEl = document.createElement('article');
      pageEl.className = 'page';
      const body = document.createElement('div');
      body.className = 'script-body';
      const blocks = [
        block('scene_heading', 'INT. APARTMENT - MORNING'),
        block('action', 'Sunlight settles across a drafting table.'),
        block('character', 'MARA'),
        block('parenthetical', '(quietly)'),
        block('dialogue', 'It has to earn its way there.'),
        block('character', 'MARA'),
        block('dialogue', 'Every page.'),
        block('transition', 'CUT TO:'),
        block('scene_heading', 'EXT. UNION STATION - CONTINUOUS'),
        block('shot', 'CLOSE ON the arrival clock.'),
      ];
      body.append(...blocks);
      pageEl.appendChild(body);
      document.body.appendChild(pageEl);

      const firstTop = blocks[0]?.getBoundingClientRect().top ?? 0;
      const result = blocks.map((el) => el.getBoundingClientRect().top - firstTop);
      document.body.removeChild(pageEl);
      return result;
    });

    for (const offset of offsets) {
      const remainder = ((offset % LINE_HEIGHT_PX) + LINE_HEIGHT_PX) % LINE_HEIGHT_PX;
      const distanceFromBoundary = Math.min(remainder, LINE_HEIGHT_PX - remainder);
      expect(distanceFromBoundary).toBeLessThan(LINE_TOLERANCE_PX);
    }
    // The first element itself carries no leading blank line: .page's top padding already
    // places it at the 1.0in top margin.
    expect(offsets[0]).toBe(0);
  });

  test('element positions on the line grid are identical with element-name labels on and off', async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      function block(element: string, text: string): HTMLDivElement {
        const el = document.createElement('div');
        el.setAttribute('data-screenplay-block', '');
        el.setAttribute('data-screenplay-element', element);
        el.textContent = text;
        return el;
      }

      function buildAndMeasure(showLabels: boolean): number[] {
        const pageEl = document.createElement('article');
        pageEl.className = 'page';
        const body = document.createElement('div');
        body.className = showLabels ? 'script-body show-element-labels' : 'script-body';
        const blocks = [
          block('scene_heading', 'INT. APARTMENT - MORNING'),
          block('action', 'Sunlight settles across a drafting table.'),
          block('character', 'MARA'),
          block('parenthetical', '(quietly)'),
          block('dialogue', 'It has to earn its way there.'),
          block('transition', 'CUT TO:'),
        ];
        body.append(...blocks);
        pageEl.appendChild(body);
        document.body.appendChild(pageEl);

        const pageTop = pageEl.getBoundingClientRect().top;
        const tops = blocks.map((el) => el.getBoundingClientRect().top - pageTop);
        document.body.removeChild(pageEl);
        return tops;
      }

      return {
        labelsOff: buildAndMeasure(false),
        labelsOn: buildAndMeasure(true),
      };
    });

    expect(result.labelsOn).toHaveLength(result.labelsOff.length);
    for (let i = 0; i < result.labelsOff.length; i += 1) {
      expect(Math.abs((result.labelsOn[i] ?? 0) - (result.labelsOff[i] ?? 0))).toBeLessThan(
        LINE_TOLERANCE_PX,
      );
    }
  });
});
