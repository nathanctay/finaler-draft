import { expect, test } from '@playwright/test';
import {
  LINES_PER_INCH,
  MARGIN_TOP_IN,
  PAGE_HEIGHT_IN,
  PAGE_NUMBER_RIGHT_IN,
  PAGE_NUMBER_TOP_IN,
} from '@finaler-draft/screenplay/pageFormat';
import { PAGE_GAP_IN } from '../src/pagination.js';
import { requireCourierPrime } from './requireCourierPrime.js';

// This spec proves four narrow, isolated CSS facts of the pagination rendering technique
// (progress/page-rendering.md) against real Chrome layout, in the same style as
// page-geometry.spec.ts: it builds markup using the exact classes the pagination plugin produces
// (`.page-break-widget`, `.page-break-spacer`, `.page-break-number`, `.page-break-cue-line`,
// `.page.continuous` -- see apps/web/src/pagination.ts's buildPageBreakWidget and the
// corresponding rules in styles.css) on a minimal synthetic node, rather than driving the
// authenticated editor route.
//
// That is a deliberate, narrower scope than this file used to have. It used to also assert
// cross-page block *positions* -- where the real editor places real content relative to real page
// breaks -- against a hand-built multi-page fixture, and that fixture passed throughout two real
// rendering defects it could never have caught (one was a flex cross-size bug in the real
// `.editor-region`, the other was ProseMirror inserting a real DOM node no hand-built fixture ever
// produces). That assertion now lives in `page-rendering-persistence.spec.ts`, which drives the
// real signed-in editor against a real database instead. What remains here is different in kind:
// each test below asserts one declared CSS rule against the real class name -- an indent, a
// background-image swap, a font-weight, a `contenteditable` flag -- and neither historical defect
// could have hidden behind any of them, because none of them reconstruct cross-page arithmetic or
// require a real ProseMirror document to exist. `pagination.test.ts` and `paginationExtension.test.ts`
// already prove, under jsdom, that the plugin builds exactly this structure with exactly these
// computed values from a real `LayoutResult`; this spec proves that structure renders with the
// correct physical geometry in a real browser.
const TOLERANCE_IN = 0.01;
const TOLERANCE_PX = TOLERANCE_IN * 96;

function bottomMarginInFor(lineCount: number): number {
  return PAGE_HEIGHT_IN - MARGIN_TOP_IN - lineCount / LINES_PER_INCH;
}

function spacerHeightInFor(lineCount: number): number {
  return bottomMarginInFor(lineCount) + PAGE_GAP_IN + MARGIN_TOP_IN;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/sign-in');
  await requireCourierPrime(page);
});

test.describe('page rendering: space-before suppression', () => {
  test("space-before is suppressed at the top of every page, not only the document's first block", async ({
    page,
  }) => {
    // action carries one blank line before it (BLANK_LINES_BEFORE.action). A .page-top block
    // must render with none of it, on every page -- not just the first -- proving requirement 1
    // (progress/page-rendering.md): the former :first-child rule only ever suppressed the
    // document's first block.
    const result = await page.evaluate(() => {
      const pageEl = document.createElement('article');
      pageEl.className = 'page';
      // .page-number precedes .script-body in the real markup -- see the fidelity note above.
      const pageNumber = document.createElement('div');
      pageNumber.className = 'page-number';
      pageEl.appendChild(pageNumber);
      const body = document.createElement('div');
      body.className = 'script-body';

      function block(pageTop: boolean): HTMLDivElement {
        const el = document.createElement('div');
        el.setAttribute('data-screenplay-block', '');
        el.setAttribute('data-screenplay-element', 'action');
        if (pageTop) el.classList.add('page-top');
        el.textContent = 'Content.';
        return el;
      }

      // A block that is NOT the document's first child and NOT marked .page-top, to prove the
      // ordinary (non-suppressed) margin is still exactly one blank line -- the baseline this
      // test's .page-top assertion is measured against.
      const before = block(false);
      const midDocumentPageTop = block(true);
      body.append(before, midDocumentPageTop);
      pageEl.appendChild(body);
      document.body.appendChild(pageEl);

      const beforeRect = before.getBoundingClientRect();
      const pageTopRect = midDocumentPageTop.getBoundingClientRect();
      const out = {
        gapAboveOrdinaryBlock: beforeRect.top - pageEl.getBoundingClientRect().top,
        gapAbovePageTopBlock: pageTopRect.top - (beforeRect.top + beforeRect.height),
      };
      document.body.removeChild(pageEl);
      return out;
    });

    // Baseline: an ordinary (non-suppressed) block carries its full one-blank-line margin --
    // .page's 1.0in top margin plus one 16px blank line.
    expect(Math.abs(result.gapAboveOrdinaryBlock - (MARGIN_TOP_IN * 96 + 16))).toBeLessThan(
      TOLERANCE_PX,
    );
    // The suppressed block sits immediately below the previous one's bottom edge -- zero gap --
    // proving suppression is driven by the .page-top class itself, not by document position.
    expect(result.gapAbovePageTopBlock).toBeLessThan(0.5);
  });
});

test.describe('page rendering: continuous scroll is presentation only', () => {
  test('the page-break widget structure is identical in both modes; only the drawn page edge (background) differs', async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      function build(continuous: boolean) {
        const pageEl = document.createElement('article');
        pageEl.className = continuous ? 'page continuous' : 'page';
        pageEl.style.setProperty('--fd-page-gap', '0.25in');
        document.body.appendChild(pageEl);
        const style = getComputedStyle(pageEl);
        const backgroundImage = style.backgroundImage;
        document.body.removeChild(pageEl);
        return backgroundImage;
      }

      return { continuousBackground: build(true), discreteBackground: build(false) };
    });

    expect(result.discreteBackground).not.toBe('none');
    expect(result.continuousBackground).toBe('none');
  });
});

test.describe('page rendering: generated lines', () => {
  test("(MORE) and CONT'D render at the character indent and are excluded from editing", async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      const pageEl = document.createElement('article');
      pageEl.className = 'page';
      // .page-number precedes .script-body in the real markup -- see the fidelity note above.
      const pageNumber = document.createElement('div');
      pageNumber.className = 'page-number';
      pageEl.appendChild(pageNumber);
      const body = document.createElement('div');
      body.className = 'script-body';
      const wrapper = document.createElement('div');
      wrapper.className = 'page-break-widget';
      wrapper.contentEditable = 'false';
      const more = document.createElement('div');
      more.className = 'page-break-cue-line page-break-more';
      more.textContent = '(MORE)';
      const spacer = document.createElement('div');
      spacer.className = 'page-break-spacer';
      spacer.style.height = '2in';
      const continued = document.createElement('div');
      continued.className = 'page-break-cue-line page-break-continued';
      continued.textContent = "MARA (CONT'D)";
      wrapper.append(more, spacer, continued);
      body.appendChild(wrapper);
      pageEl.appendChild(body);
      document.body.appendChild(pageEl);

      const pageRect = pageEl.getBoundingClientRect();
      const out = {
        moreLeftIn: (more.getBoundingClientRect().left - pageRect.left) / 96,
        continuedLeftIn: (continued.getBoundingClientRect().left - pageRect.left) / 96,
        moreFontWeight: getComputedStyle(more).fontWeight,
        continuedFontWeight: getComputedStyle(continued).fontWeight,
        wrapperEditable: wrapper.contentEditable,
        wrapperUserSelect: getComputedStyle(wrapper).userSelect,
      };
      document.body.removeChild(pageEl);
      return out;
    });

    // Same physical indent as an authored character cue (3.7in from the page's left edge).
    expect(Math.abs(result.moreLeftIn - 3.7)).toBeLessThan(TOLERANCE_IN);
    expect(Math.abs(result.continuedLeftIn - 3.7)).toBeLessThan(TOLERANCE_IN);
    expect(result.continuedFontWeight).toBe('700');
    expect(result.wrapperEditable).toBe('false');
    expect(result.wrapperUserSelect).toBe('none');
  });

  test('the page number sits 0.5in from a page top and 0.75in from the right, anchored to its spacer', async ({
    page,
  }) => {
    const spacerHeightIn = spacerHeightInFor(55);
    const result = await page.evaluate(
      ({ spacerHeightIn: height, marginTop, numberTop }) => {
        const pageEl = document.createElement('article');
        pageEl.className = 'page';
        // .page-number precedes .script-body in the real markup -- see the fidelity note above.
        const staticPageNumber = document.createElement('div');
        staticPageNumber.className = 'page-number';
        pageEl.appendChild(staticPageNumber);
        // .page-break-spacer / .page-break-number are scoped under .script-body in styles.css,
        // matching where the pagination plugin actually inserts them (inside the flow the editor
        // renders, not as a direct child of .page).
        const body = document.createElement('div');
        body.className = 'script-body';
        const spacer = document.createElement('div');
        spacer.className = 'page-break-spacer';
        spacer.style.height = `${height}in`;
        const numberEl = document.createElement('div');
        numberEl.className = 'page-break-number';
        numberEl.textContent = '2.';
        numberEl.style.top = `${height - marginTop + numberTop}in`;
        spacer.appendChild(numberEl);
        body.appendChild(spacer);
        pageEl.appendChild(body);
        document.body.appendChild(pageEl);

        const pageRect = pageEl.getBoundingClientRect();
        const spacerRect = spacer.getBoundingClientRect();
        const numberRect = numberEl.getBoundingClientRect();
        // The physical page top this number belongs to, independent of the widget's own math:
        // spacer top + height - margin top.
        const physicalPageTop = spacerRect.top + spacerRect.height - marginTop * 96;
        const out = {
          topFromPhysicalPageTopIn: (numberRect.top - physicalPageTop) / 96,
          rightFromPageEdgeIn: (pageRect.right - numberRect.right) / 96,
        };
        document.body.removeChild(pageEl);
        return out;
      },
      {
        spacerHeightIn,
        marginTop: MARGIN_TOP_IN,
        numberTop: PAGE_NUMBER_TOP_IN,
      },
    );

    expect(Math.abs(result.topFromPhysicalPageTopIn - PAGE_NUMBER_TOP_IN)).toBeLessThan(
      TOLERANCE_IN,
    );
    expect(Math.abs(result.rightFromPageEdgeIn - PAGE_NUMBER_RIGHT_IN)).toBeLessThan(TOLERANCE_IN);
  });
});

test.describe('page rendering: wrap agreement (requirement 5)', () => {
  test('an unbroken run breaks at the same character budget the layout engine hard-breaks at, for action, dialogue, and character', async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      function block(element: string, text: string, extraStyle?: Partial<CSSStyleDeclaration>) {
        const pageEl = document.createElement('article');
        pageEl.className = 'page';
        // .page-number precedes .script-body in the real markup -- see the fidelity note above.
        const pageNumber = document.createElement('div');
        pageNumber.className = 'page-number';
        pageEl.appendChild(pageNumber);
        const body = document.createElement('div');
        body.className = 'script-body';
        const el = document.createElement('div');
        el.setAttribute('data-screenplay-block', '');
        el.setAttribute('data-screenplay-element', element);
        el.textContent = text;
        if (extraStyle) Object.assign(el.style, extraStyle);
        body.appendChild(el);
        pageEl.appendChild(body);
        document.body.appendChild(pageEl);
        // A Range over the element's contents yields one client rect per rendered line box, so
        // its length is exactly the number of visual lines the browser wrapped the text into.
        const range = document.createRange();
        range.selectNodeContents(el);
        const lineCount = range.getClientRects().length;
        const overflowsPage =
          el.getBoundingClientRect().right > pageEl.getBoundingClientRect().right + 1;
        document.body.removeChild(pageEl);
        return { lineCount, overflowsPage };
      }

      return {
        action60: block('action', 'X'.repeat(60)),
        action61: block('action', 'X'.repeat(61)),
        action200: block('action', 'X'.repeat(200)),
        dialogue35: block('dialogue', 'X'.repeat(35)),
        dialogue36: block('dialogue', 'X'.repeat(36)),
        character38: block('character', 'X'.repeat(38)),
        character39: block('character', 'X'.repeat(39)),
      };
    });

    expect(result.action60.lineCount).toBe(1);
    expect(result.action60.overflowsPage).toBe(false);
    expect(result.action61.lineCount).toBe(2);
    expect(result.action61.overflowsPage).toBe(false);
    expect(result.action200.lineCount).toBe(Math.ceil(200 / 60));
    expect(result.action200.overflowsPage).toBe(false);

    expect(result.dialogue35.lineCount).toBe(1);
    expect(result.dialogue35.overflowsPage).toBe(false);
    expect(result.dialogue36.lineCount).toBe(2);
    expect(result.dialogue36.overflowsPage).toBe(false);

    expect(result.character38.lineCount).toBe(1);
    expect(result.character38.overflowsPage).toBe(false);
    expect(result.character39.lineCount).toBe(2);
    expect(result.character39.overflowsPage).toBe(false);
  });
});

/**
 * The page-separation seam (`plan.md`'s "Page presentation": "Discrete separated pages are the
 * default ... in the manner of Microsoft Word"). It is drawn entirely in CSS, and it shipped with
 * no automated coverage at all -- exactly the shape of gap that let `.save-dot.attention` sit with
 * no rule for months while the class was applied and nobody noticed.
 *
 * These assert the two structural properties the seam's appearance actually depends on, both of
 * which were verified by mutation to break it visibly:
 *
 *  - the mask clips (`overflow: hidden`). Without it the caster's far edge escapes and paints a
 *    stray shadow line ~40px inside the page content on both sides.
 *  - the caster is tall relative to the blur radius. A box near the height of the boundary line is
 *    a blurred *point* source rather than a blurred *edge*, and renders a visibly flatter falloff
 *    than `.page`'s own shadow no matter what box-shadow value it is given. That was the first
 *    attempt at this feature and the reason it needed a second iteration.
 *
 * Computed styles rather than pixels: this catches both regressions deterministically, without a
 * screenshot baseline that would have to be regenerated on every unrelated visual change.
 */
test('the page-separation seam clips its mask and keeps a caster taller than the shadow blur', async ({
  page,
}) => {
  const measured = await page.evaluate(() => {
    const body = document.createElement('div');
    body.className = 'script-body';
    const spacer = document.createElement('div');
    spacer.className = 'page-break-spacer';
    spacer.style.height = '2in';

    // The exact structure buildPageBreakWidget builds (pagination.ts).
    const edge = document.createElement('div');
    edge.className = 'page-break-edge page-break-edge-outgoing';
    edge.style.setProperty('--fd-page-break-edge-top', '1in');
    const caster = document.createElement('div');
    caster.className = 'page-break-edge-caster';
    edge.appendChild(caster);
    spacer.appendChild(edge);
    body.appendChild(spacer);
    document.body.appendChild(body);

    const edgeStyle = window.getComputedStyle(edge);
    const casterStyle = window.getComputedStyle(caster);
    const result = {
      casterHeightPx: Number.parseFloat(casterStyle.height),
      casterShadow: casterStyle.boxShadow,
      maskHeightPx: Number.parseFloat(edgeStyle.height),
      overflow: edgeStyle.overflow,
    };
    body.remove();
    return result;
  });

  // The mask must clip, or the caster's far edge paints inside the page.
  expect(measured.overflow).toBe('hidden');

  // The caster must cast a shadow at all, and be far taller than that shadow's blur radius. The
  // blur is read back out of the computed shadow rather than restated here, so this stays true if
  // the shadow value is ever retuned.
  expect(measured.casterShadow).not.toBe('none');
  const blurPx = Number.parseFloat(
    /(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/.exec(
      measured.casterShadow,
    )?.[3] ?? '0',
  );
  expect(blurPx).toBeGreaterThan(0);
  expect(measured.casterHeightPx).toBeGreaterThan(blurPx * 4);

  // The visible strip must comfortably contain that falloff, or the shadow is cut off mid-fade.
  expect(measured.maskHeightPx).toBeGreaterThan(blurPx);
});
