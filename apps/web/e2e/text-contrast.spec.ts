import { expect, test, type Page } from '@playwright/test';
import { contrastRatio } from '@finaler-draft/screenplay-editor';

/**
 * Measures the *resolved* contrast of this app's muted and inactive text against the surface each
 * rule actually sits on, in a real browser, with the real stylesheet, under both themes.
 *
 * Why a browser and not a unit test: every colour here arrives through a `var()` chain, and the
 * values at the two ends of that chain are not the interesting thing -- what matters is what the
 * cascade resolves them to on a given element, which depends on which theme class an ancestor
 * carries and which container re-anchored the token. `apps/landing/e2e/header-contrast.spec.ts`
 * records the same reasoning for the same reason ("jsdom has no computed styles worth trusting --
 * a unit/render test asserting a class name or even the raw CSS custom-property *source* would
 * have passed while this defect shipped"), and `app-shell.spec.ts` established the fixture
 * technique: inject markup using the exact classes the app renders onto an already-served route,
 * so no database, no authentication and no particular screenplay is involved -- these are
 * properties of the shipped CSS alone.
 *
 * Why ratios and not hex values: the tokens are shared, so the next person to retune one needs to
 * be *stopped*, not merely noticed -- the same reasoning `progress/screenplay-diff.md` records for
 * the diff marks' hue-dominance assertion. Nothing below names a colour; every expectation is
 * computed from what the browser painted.
 *
 * What was measured before this pass, and the floor each case now holds (the full tables are in
 * `progress/contrast-and-participant-palette.md`):
 *
 * | rule                              | before | floor |
 * | --------------------------------- | ------ | ----- |
 * | `.ruler`                          | 3.21   | 4.5   |
 * | `.muted` (white dialog)           | 3.84   | 4.5   |
 * | `.muted` (app chrome)             | 3.61   | 4.5   |
 * | `.muted` (dark Inspector)         | 2.70   | 4.5   |
 * | placeholder hints, SmartType ghost| 2.29   | 4.5   |
 * | `.element-menu-key`               | 2.29   | 4.5   |
 * | `.primary-button:disabled`        | 1.67   | 3     |
 * | the other three disabled rules    | 2.15   | 3     |
 *
 * The 4.5 cases are WCAG 1.4.3 at normal text size -- every one of them is 10-13px, well under the
 * 18pt/14pt-bold threshold that would have allowed 3:1. The 3 cases are inactive controls, which
 * 1.4.3 exempts outright; they are held to 3:1 anyway because the comparison view this project
 * shipped is deliberately almost entirely disabled controls, which turned a rare state into a whole
 * screen.
 */

/** WCAG 1.4.3, normal-size text. */
const REAL_TEXT = 4.5;

/** Inactive controls: exempt from 1.4.3, held to the non-text floor regardless. */
const INACTIVE_CONTROL = 3;

type Theme = 'light' | 'dark';

type ContrastCase = {
  /** What is being measured, in the failure message. */
  readonly name: string;
  /** Markup using the app's own classes. Placed inside `<main class="application">` when `shell`
   * is true -- which is what puts a `.dark` ancestor above it in the dark run. */
  readonly markup: string;
  /** The element whose text colour is measured. */
  readonly target: string;
  /** Set when the rule paints a pseudo-element rather than the element itself. */
  readonly pseudo?: string;
  readonly minimum: number;
  readonly shell: boolean;
  /** `['light']` alone for a surface that only exists outside the editor shell, which is the only
   * place this app's dark theme is ever applied (`applicationShell.tsx` puts `.dark` on
   * `<main class="application">`). */
  readonly themes: readonly Theme[];
};

const BOTH: readonly Theme[] = ['light', 'dark'];
const LIGHT_ONLY: readonly Theme[] = ['light'];

const CASES: readonly ContrastCase[] = [
  {
    name: '.ruler',
    markup: '<div class="ruler">1</div>',
    target: '.ruler',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.muted in the Inspector',
    markup:
      '<div class="workspace"><aside class="panel inspector"><div class="inspector-section"><p class="muted">Element changes keep the local block identity.</p></div></aside></div>',
    target: '.muted',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.muted in a dialog (white under both themes)',
    markup: '<div class="dialog"><p class="muted">Named revisions are permanent.</p></div>',
    target: '.muted',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.muted on a project screen',
    markup: '<main class="project-screen"><p class="muted">No revisions yet.</p></main>',
    target: '.muted',
    minimum: REAL_TEXT,
    shell: false,
    themes: LIGHT_ONLY,
  },
  {
    name: '.scene-list small',
    markup:
      '<div class="workspace"><aside class="panel"><ol class="scene-list"><li><button type="button">INT. ROOM<small>page 1</small></button></li></ol></aside></div>',
    target: '.scene-list small',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.navigator-empty',
    markup:
      '<div class="workspace"><aside class="panel"><ol class="scene-list"><li class="navigator-empty">No scenes yet.</li></ol></aside></div>',
    target: '.navigator-empty',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.toast-message (white under both themes)',
    markup:
      '<div class="toast"><div class="toast-body"><p class="toast-title">Export failed</p><p class="toast-message">The PDF could not be written.</p></div></div>',
    target: '.toast-message',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.title-page-line-remove (the title page stays white under both themes)',
    markup:
      '<div class="title-page"><div class="title-page-line"><span>Author</span><button class="title-page-line-remove" type="button">×</button></div></div>',
    target: '.title-page-line-remove',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: "the empty block's placeholder hint",
    markup:
      '<div class="page"><div class="script-body"><div data-screenplay-block data-screenplay-element="action"></div></div></div>',
    target: '[data-screenplay-block]',
    pseudo: '::after',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: "the title page field's placeholder hint",
    markup: '<div class="title-page"><div data-title-page-field="title"></div></div>',
    target: '[data-title-page-field]',
    pseudo: '::after',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: "SmartType's inline ghost completion",
    markup:
      '<div class="page"><div class="script-body"><div data-screenplay-block data-screenplay-element="scene_heading">INT. K<span class="smarttype-ghost">ITCHEN - DAY</span></div></div></div>',
    target: '.smarttype-ghost',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.element-menu-key on an unselected row',
    markup:
      '<ul class="element-menu"><li class="element-menu-option" role="option"><span>Action</span><span class="element-menu-key">A</span></li></ul>',
    target: '.element-menu-key',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.element-menu-key on the selected row (its own darker background)',
    markup:
      '<ul class="element-menu"><li aria-selected="true" class="element-menu-option" role="option"><span>Action</span><span class="element-menu-key">A</span></li></ul>',
    target: '.element-menu-key',
    minimum: REAL_TEXT,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.tool-button:disabled',
    markup:
      '<section class="toolbar"><button class="tool-button" disabled type="button">Bold</button></section>',
    target: '.tool-button:disabled',
    minimum: INACTIVE_CONTROL,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.primary-button:disabled',
    markup:
      '<div class="dialog"><div class="dialog-actions"><button class="primary-button" disabled type="button">Save revision</button></div></div>',
    target: '.primary-button:disabled',
    minimum: INACTIVE_CONTROL,
    shell: true,
    themes: BOTH,
  },
  {
    name: '.text-button:disabled',
    markup:
      '<main class="project-screen"><button class="text-button" disabled type="button">Restore</button></main>',
    target: '.text-button:disabled',
    minimum: INACTIVE_CONTROL,
    shell: false,
    themes: LIGHT_ONLY,
  },
  {
    name: '.overflow-menu-list button:disabled (white under both themes)',
    markup:
      '<div class="overflow-menu-list" role="menu"><button disabled role="menuitem" type="button">Export PDF</button></div>',
    target: '.overflow-menu-list button:disabled',
    minimum: INACTIVE_CONTROL,
    shell: true,
    themes: BOTH,
  },
];

/** An `rgb()`/`rgba()` computed value, returned to the hex form `contrastRatio` reads. A
 * translucent colour is rejected rather than composited: nothing in these fixtures is supposed to
 * paint through, and quietly treating alpha as opaque would report a contrast the viewer never
 * sees. */
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

type Measured = { readonly color: string; readonly background: string };

async function measure(page: Page, theme: Theme, testCase: ContrastCase): Promise<Measured> {
  return page.evaluate(
    ({ markup, pseudo, shell, target, themeName }) => {
      document.body.innerHTML = '';
      const host = document.createElement('div');
      host.innerHTML = shell
        ? `<main class="application${themeName === 'dark' ? ' dark' : ''}">${markup}</main>`
        : markup;
      document.body.append(host);

      const element = host.querySelector(target);
      if (!(element instanceof HTMLElement)) throw new Error(`Fixture has no ${target}.`);

      const own = getComputedStyle(element, pseudo ?? null);
      const transparent = (value: string) =>
        value === 'rgba(0, 0, 0, 0)' || value === 'transparent';

      // The surface the text is actually read against: the nearest painted background at or above
      // the measured box. This is the browser's own rule, walked explicitly, rather than an
      // assumption about which fixture element carries the colour -- several of these rules
      // (`.muted`, `.tool-button:disabled`, the placeholder pseudo-elements) declare no background
      // of their own precisely because they inherit the surface of whatever they were placed on.
      let background = own.backgroundColor;
      let node: Element | null = element;
      while (transparent(background) && node) {
        background = getComputedStyle(node).backgroundColor;
        node = node.parentElement;
      }
      if (transparent(background)) {
        background = getComputedStyle(document.documentElement).backgroundColor;
      }

      return { background, color: own.color };
    },
    {
      markup: testCase.markup,
      pseudo: testCase.pseudo ?? null,
      shell: testCase.shell,
      target: testCase.target,
      themeName: theme,
    },
  );
}

for (const theme of BOTH) {
  test.describe(`${theme} theme`, () => {
    for (const testCase of CASES) {
      if (!testCase.themes.includes(theme)) continue;

      test(`${testCase.name} clears ${testCase.minimum}:1 against the surface it sits on`, async ({
        page,
      }) => {
        await page.goto('/sign-in');
        const measured = await measure(page, theme, testCase);

        const color = toHexColor(measured.color, `${testCase.name} colour`);
        const background = toHexColor(measured.background, `${testCase.name} background`);
        // A rule whose text resolves to the same colour as its surface is the failure mode
        // `apps/landing/e2e/header-contrast.spec.ts` was written for; the ratio below subsumes it,
        // but naming it separately makes that case read as itself in the output.
        expect(color).not.toBe(background);
        expect(
          contrastRatio(color, background),
          `${testCase.name}: ${color} on ${background}`,
        ).toBeGreaterThanOrEqual(testCase.minimum);
      });
    }
  });
}

/*
 * The companion to `.tool-button:disabled`'s ratio above, and the reason that rule needed a `.dark`
 * restatement at all: the dark theme's `color: inherit` for toolbar buttons has the same
 * specificity and comes later in the stylesheet, so it used to win outright and a disabled toolbar
 * button was painted in precisely the enabled colour. A contrast assertion cannot see that -- the
 * enabled colour has excellent contrast -- so the property is asserted directly, the same one
 * `app-shell.spec.ts` pins for `.primary-button` ("a disabled instance rendered visually identical
 * to an enabled one"), in the theme that spec does not exercise.
 */
for (const theme of BOTH) {
  test(`${theme} theme: a disabled tool button is not painted the enabled colour`, async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const colors = await page.evaluate((themeName) => {
      document.body.innerHTML = '';
      const host = document.createElement('div');
      host.innerHTML = `<main class="application${themeName === 'dark' ? ' dark' : ''}"><section class="toolbar"><button class="tool-button" id="enabled" type="button">Bold</button><button class="tool-button" disabled id="disabled" type="button">Italic</button></section></main>`;
      document.body.append(host);
      return {
        disabled: getComputedStyle(host.querySelector('#disabled')!).color,
        enabled: getComputedStyle(host.querySelector('#enabled')!).color,
      };
    }, theme);

    expect(colors.disabled).not.toBe(colors.enabled);
  });
}

/*
 * The participant colours are not in the stylesheet at all -- `buildRemoteCursorWidget` and
 * `ParticipantAvatar` set both the swatch and the text colour inline, from awareness data, and
 * `apps/collab/src/participantPalette.test.ts` is what holds the palette itself to its ratios.
 *
 * What only a real browser can say is whether the *stylesheet* still leaves that decision alone.
 * Both rules used to declare `color: #fff` beside those inline backgrounds, and re-adding either
 * would silently take the choice back -- not by overriding the inline style (it cannot) but by
 * becoming the value for any future caller that sets only the background. So the assertion is that
 * the cascade supplies no `color` of its own for these two elements: with nothing set inline, each
 * inherits its context rather than resolving to a colour of the rule's choosing.
 */
for (const theme of BOTH) {
  test(`${theme} theme: the stylesheet claims no text colour for a participant swatch`, async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const resolved = await page.evaluate((themeName) => {
      document.body.innerHTML = '';
      const host = document.createElement('div');
      host.innerHTML = `<main class="application${themeName === 'dark' ? ' dark' : ''}"><div class="statusbar"><span class="participant-indicator" id="indicator" role="group"><span class="participant-avatar" id="avatar">M</span></span></div><div class="page"><span class="remote-cursor" id="cursor"><span class="remote-cursor-caret"></span><span class="remote-cursor-label" id="label">Mara</span></span></div></main>`;
      document.body.append(host);
      const read = (id: string) => getComputedStyle(host.querySelector(`#${id}`)!).color;
      return {
        avatar: read('avatar'),
        indicator: read('indicator'),
        label: read('label'),
        cursor: read('cursor'),
      };
    }, theme);

    expect(resolved.avatar).toBe(resolved.indicator);
    expect(resolved.label).toBe(resolved.cursor);
  });
}
