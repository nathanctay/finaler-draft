import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationShell, ApplicationTitlebar } from './applicationShell.js';

/**
 * `styles.css`'s `.application` sizes each chrome row from its own custom property and places each
 * chrome element into its own named grid area. Which rows exist at all is decided here, in the
 * shell, from which slots it was given -- so these tests are about the one thing a stylesheet cannot
 * check for itself: that the class naming a row's size and the child occupying that row are always
 * derived from the same fact.
 *
 * jsdom runs no layout, so nothing here can prove what the rows *measure*. That is
 * `page-rendering-persistence.spec.ts`'s shell-geometry measurement against real Chrome, and the
 * reason this file deliberately asserts classes and children rather than pretending to assert
 * geometry.
 */
function shellWith(props: Partial<Parameters<typeof ApplicationShell>[0]> = {}) {
  render(
    <ApplicationShell
      titlebar={<header className="titlebar">Title bar</header>}
      workspace={<div className="workspace">Workspace</div>}
      {...props}
    />,
  );
  return screen.getByRole('main');
}

describe('application shell: the rows it is given', () => {
  it('renders every slot it is given, in grid-track order', () => {
    const main = shellWith({
      banner: <div className="readonly-banner">Banner</div>,
      menubar: <nav className="menubar">Menu bar</nav>,
      statusbar: <footer className="statusbar">Status bar</footer>,
      toolbar: <section className="toolbar">Tool bar</section>,
    });

    // Document order is still the track order the stylesheet lists, even though placement is now
    // explicit: a reader of either file should find the same sequence in both.
    expect(Array.from(main.children).map((child) => child.className)).toEqual([
      'titlebar',
      'menubar',
      'readonly-banner',
      'toolbar',
      'workspace',
      'statusbar',
    ]);
  });

  it('omits the rows it is not given, and says so in the class that sizes them', () => {
    const main = shellWith();

    expect(Array.from(main.children).map((child) => child.className)).toEqual([
      'titlebar',
      'workspace',
    ]);
    expect(main).toHaveClass('shell-without-menubar');
    expect(main).toHaveClass('shell-without-toolbar');
    expect(main).toHaveClass('shell-without-statusbar');
    expect(main).not.toHaveClass('has-readonly-banner');
  });

  it('names no missing row when every row is present', () => {
    const main = shellWith({
      banner: <div className="readonly-banner">Banner</div>,
      menubar: <nav className="menubar">Menu bar</nav>,
      statusbar: <footer className="statusbar">Status bar</footer>,
      toolbar: <section className="toolbar">Tool bar</section>,
    });

    expect(main.className).toBe('application has-readonly-banner');
  });

  /**
   * The production defect `.application`'s own comment in `styles.css` records: a banner child with
   * no row budgeted for it took the toolbar's 47px track, shoving the toolbar into the workspace's
   * `minmax(0, 1fr)`, the workspace into the status bar's 30px, and the status bar past the end of
   * the list. The class and the child are now the same decision, which is what makes that state
   * unreachable rather than merely currently-absent.
   */
  it('opens the banner row exactly when, and only when, there is a banner to put in it', () => {
    const withBanner = shellWith({ banner: <div className="readonly-banner">Banner</div> });
    expect(withBanner).toHaveClass('has-readonly-banner');
    expect(withBanner.querySelector('.readonly-banner')).not.toBeNull();

    cleanup();

    const withoutBanner = shellWith();
    expect(withoutBanner).not.toHaveClass('has-readonly-banner');
    expect(withoutBanner.querySelector('.readonly-banner')).toBeNull();
  });

  it('carries the dark-canvas modifier only for a screen that asks for it', () => {
    expect(shellWith({ dark: true })).toHaveClass('dark');
    cleanup();
    expect(shellWith({ dark: false })).not.toHaveClass('dark');
    cleanup();
    expect(shellWith()).not.toHaveClass('dark');
  });

  it('adds a screen-specific variant class without disturbing the row classes', () => {
    const main = shellWith({ variant: 'diff-screen' });
    expect(main).toHaveClass('diff-screen');
    expect(main).toHaveClass('shell-without-toolbar');
  });

  /** Out-of-flow children are rendered last, after the status bar, precisely so that anything in
   * flow that is not one of the six chrome rows is a measurable defect rather than a silent one --
   * see this slot's own comment, and the real-browser measurement it points at. */
  it('renders out-of-flow children last, after every chrome row', () => {
    const main = shellWith({
      outOfFlow: <p className="diff-print-refusal">Screen only</p>,
      statusbar: <footer className="statusbar">Status bar</footer>,
    });

    expect(Array.from(main.children).map((child) => child.className)).toEqual([
      'titlebar',
      'workspace',
      'statusbar',
      'diff-print-refusal',
    ]);
  });

  it('contains no editing surface of any kind: it is layout, not an editor', () => {
    shellWith({ toolbar: <section className="toolbar">Tool bar</section> });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('[contenteditable]')).toBeNull();
  });
});

describe('application title bar', () => {
  it('is a plain, static link to the brand’s own destination when the caller supplies one with no wipe', () => {
    render(
      <ApplicationTitlebar
        brand={{ href: '/projects' }}
        documentTitle="Hollow Heart"
        documentType="Screenplay"
      />,
    );

    const brand = screen.getByRole('link', { name: 'Finaler Draft — back to your projects' });
    expect(brand).toHaveAttribute('href', '/projects');
    expect(brand).toHaveClass('brand');
    expect(brand).not.toHaveClass('brand-wipe');
  });

  it('is the current page’s own inert identity, not a link to anywhere, when no brand destination is supplied', () => {
    // The writing desk's own shape (`routes/projects/index.tsx` passes no `brand` prop at all):
    // a link to the page already on screen would be a control with nowhere to go.
    render(<ApplicationTitlebar documentTitle="Projects" />);
    expect(screen.queryByRole('link', { name: /Finaler Draft/ })).toBeNull();
    const brand = document.querySelector('.brand');
    expect(brand?.tagName).toBe('SPAN');
    expect(brand).toHaveTextContent('Finaler Draft');
  });

  it('offers no account control at all when the caller supplies none', () => {
    // No caller does this in production -- every screen mounts `AccountMenu` and hands it in --
    // but this component's own contract is that the slot degrades to nothing, the same as
    // `indicator`/`rename` below, rather than silently rendering a placeholder.
    render(<ApplicationTitlebar documentTitle="Hollow Heart" documentType="Screenplay" />);
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });

  it('renders whatever account control it is handed, without knowing what it is', () => {
    render(
      <ApplicationTitlebar
        accountMenu={<button type="button">Account menu stand-in</button>}
        documentTitle="Hollow Heart"
        documentType="Screenplay"
      />,
    );
    expect(screen.getByRole('button', { name: 'Account menu stand-in' })).toBeVisible();
  });

  it('names the document and what kind of view this is', () => {
    render(<ApplicationTitlebar documentTitle="Hollow Heart" documentType="Comparison" />);

    const title = document.querySelector('.document-title');
    expect(title?.textContent).toBe('Hollow Heart Comparison');
    expect(title?.querySelector('.title-type')?.textContent).toBe('Comparison');
  });

  it('omits the type suffix entirely for a screen with no "kind of view" to say -- not an empty one', () => {
    render(<ApplicationTitlebar documentTitle="Projects" />);

    const title = document.querySelector('.document-title');
    expect(title?.textContent).toBe('Projects');
    expect(title?.querySelector('.title-type')).toBeNull();
  });

  it('shows a document-state indicator only for a screen that has one', () => {
    const { rerender } = render(
      <ApplicationTitlebar
        documentTitle="Hollow Heart"
        documentType="Screenplay"
        indicator={<span aria-label="Local draft" className="save-dot" />}
      />,
    );
    expect(screen.getByLabelText('Local draft')).toHaveClass('save-dot');

    rerender(<ApplicationTitlebar documentTitle="Hollow Heart" documentType="Comparison" />);
    expect(screen.queryByLabelText('Local draft')).toBeNull();
    expect(document.querySelector('.save-dot')).toBeNull();
  });
});

/**
 * The brand's second behaviour (`progress/app-bar-navigation.md`'s Task 2): in the editor and the
 * revision-diff view, the logo returns to *that screenplay's project*, not the dashboard, and
 * wipes over to say so on hover or focus. `BrandDestination`'s own comment covers the full
 * reasoning; this suite proves the contract jsdom actually can -- the markup, the href, the
 * accessible name, and that the label is real DOM content rather than something only the
 * animation ever reveals. The wipe's own *visual* behaviour (a slide, not a fade; the motion
 * itself; `prefers-reduced-motion`) is `app-bar-logo.spec.ts`'s job -- jsdom resolves no
 * stylesheet and so cannot tell a CSS transition from its absence.
 */
describe('ApplicationTitlebar brand: returning to a project, not the dashboard', () => {
  it('targets the given project, not /projects, when the caller supplies a wipe destination', () => {
    render(
      <ApplicationTitlebar
        brand={{ href: '/projects/project-1', wipeLabel: 'Return to project' }}
        documentTitle="Hollow Heart"
        documentType="Screenplay"
      />,
    );
    const brand = screen.getByRole('link', { name: 'Finaler Draft — Return to project' });
    expect(brand).toHaveAttribute('href', '/projects/project-1');
    expect(brand).toHaveClass('brand-wipe');
  });

  it('carries the destination in its accessible name regardless of hover or focus state', () => {
    // The owner's own bar: a screen-reader user must be told where this goes without depending
    // on the animation. jsdom runs no CSS transition at all, which is exactly the state this
    // asserts against -- the name is already correct before any hover or focus could have run.
    render(
      <ApplicationTitlebar
        brand={{ href: '/projects/project-1', wipeLabel: 'Return to project' }}
        documentTitle="Hollow Heart"
      />,
    );
    expect(screen.getByRole('link')).toHaveAccessibleName('Finaler Draft — Return to project');
  });

  it('renders the wipe label as real content, not something the animation alone would reveal', () => {
    render(
      <ApplicationTitlebar
        brand={{ href: '/projects/project-1', wipeLabel: 'Return to project' }}
        documentTitle="Hollow Heart"
      />,
    );
    // Present in the DOM unconditionally -- CSS, not React state, drives whether it is the part
    // of the control actually shown at a given moment (see `.brand-wipe-label` in styles.css).
    expect(document.querySelector('.brand-wipe-label')).toHaveTextContent('Return to project');
    expect(document.querySelector('.brand-face')).toHaveTextContent('Finaler Draft');
  });

  it('hides the back-arrow from assistive technology, keeping it out of the accessible name', () => {
    render(
      <ApplicationTitlebar
        brand={{ href: '/projects/project-1', wipeLabel: 'Return to project' }}
        documentTitle="Hollow Heart"
      />,
    );

    const arrow = document.querySelector('.brand-wipe-arrow');
    expect(arrow).not.toBeNull();
    expect(arrow).toHaveAttribute('aria-hidden', 'true');

    // The point of hiding it: the label doubles as this control's accessible name, and an arrow
    // folded into that string would be read aloud. Asserted on the name itself, not just on the
    // attribute, so putting the glyph back into `wipeLabel` fails here rather than only sounding
    // wrong to someone who happens to listen.
    expect(screen.getByRole('link')).toHaveAccessibleName('Finaler Draft — Return to project');
  });
});

/**
 * The breadcrumb trail (`progress/app-bar-navigation.md`): the one thing besides the account menu
 * that now differs between screens wearing this chrome. `breadcrumb` is a plain `ReactNode` --
 * in production always `<RouteBreadcrumb />` (routeBreadcrumb.tsx), which derives the ancestor
 * trail from the matched route tree rather than being handed a hand-built list here. This
 * component's own contract, proven without that router-aware component, is only: render whatever
 * it is given ahead of the current title, and mark the current title as the trail's current page.
 */
describe('ApplicationTitlebar breadcrumb', () => {
  it('renders no breadcrumb region content at all for the screen at the root of the trail', () => {
    render(<ApplicationTitlebar documentTitle="Projects" />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.querySelectorAll('.breadcrumb-link')).toHaveLength(0);
    expect(nav).toHaveTextContent('Projects');
  });

  it('renders whatever ancestor trail it is handed, ahead of the current title', () => {
    render(
      <ApplicationTitlebar
        breadcrumb={
          <>
            <a className="breadcrumb-link" href="/projects">
              Projects
            </a>
            <a className="breadcrumb-link" href="/projects/project-1">
              Hollow Heart
            </a>
          </>
        }
        documentTitle="Act One"
        documentType="Screenplay"
      />,
    );
    const links = screen.getAllByRole('link', { name: /Projects|Hollow Heart/ });
    expect(links.map((link) => link.textContent)).toEqual(['Projects', 'Hollow Heart']);
    // The current segment is not itself part of the handed-in trail -- it is still the plain
    // title text/rename control this component has always rendered, just now inside the same nav.
    expect(screen.queryByRole('link', { name: 'Act One' })).toBeNull();
  });

  it('marks the current segment for assistive technology, the way a breadcrumb trail should', () => {
    render(
      <ApplicationTitlebar
        breadcrumb={
          <a className="breadcrumb-link" href="/projects">
            Projects
          </a>
        }
        documentTitle="Hollow Heart"
      />,
    );
    expect(document.querySelector('.document-title')).toHaveAttribute('aria-current', 'page');
  });
});

/**
 * The title bar's inline rename (the owner's "double click on the name inside the editor, similar
 * to the google docs mechanic"). `ApplicationTitlebar` owns the interaction and nothing else: the
 * write itself, the role check that decides whether to offer this at all, and the error handling
 * all live in `App.tsx`, which is why every test here passes `onRename` as a spy and asserts only
 * whether and with what it was called.
 *
 * The capability being *optional* is the load-bearing part of that seam: a caller that supplies
 * nothing gets the inert text this element always rendered, which is what both a non-owner viewer
 * and the read-only revision-diff route rely on.
 */
describe('ApplicationTitlebar inline rename', () => {
  const RENAME_LABEL = 'Rename "Hollow Heart"';

  function renderTitlebar(onRename = vi.fn()) {
    render(
      <ApplicationTitlebar
        documentTitle="Hollow Heart"
        documentType="Screenplay"
        rename={{ maxLength: 200, onRename }}
      />,
    );
    return onRename;
  }

  it('offers nothing at all when no rename capability is supplied', () => {
    render(<ApplicationTitlebar documentTitle="Hollow Heart" documentType="Screenplay" />);
    // The text is still there; it is simply not a control. This is what a reviewer, an editor, and
    // the revision-diff route all see.
    expect(screen.getByText(/Hollow Heart/u)).toBeVisible();
    expect(screen.queryByRole('button', { name: RENAME_LABEL })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('names the control for what it does, rather than relying on a hover or cursor cue', () => {
    renderTitlebar();
    expect(screen.getByRole('button', { name: RENAME_LABEL })).toBeVisible();
  });

  it('does not enter edit mode on a single click', async () => {
    // The distinction the owner asked for: a single click must leave the title alone, so that
    // clicking near it while writing never swallows the next keystrokes into a rename field.
    const user = userEvent.setup();
    renderTitlebar();
    await user.click(screen.getByRole('button', { name: RENAME_LABEL }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('enters edit mode on a double click, pre-filled and selected', async () => {
    const user = userEvent.setup();
    renderTitlebar();
    await user.dblClick(screen.getByRole('button', { name: RENAME_LABEL }));
    const input = screen.getByRole('textbox', { name: 'Screenplay title' });
    expect(input).toHaveValue('Hollow Heart');
    expect(input).toHaveFocus();
    // Selected, so typing replaces rather than appends -- the Docs behaviour.
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe('Hollow Heart'.length);
  });

  it.each(['{Enter}', ' '])(
    'enters edit mode from the keyboard with %s, so this is not a mouse-only affordance',
    async (key) => {
      // A keyboard has no "double-press", so one ordinary activation has to be enough. Without
      // this the three exports behind the title would be unreachable without a mouse.
      const user = userEvent.setup();
      renderTitlebar();
      screen.getByRole('button', { name: RENAME_LABEL }).focus();
      await user.keyboard(key);
      expect(screen.getByRole('textbox', { name: 'Screenplay title' })).toHaveFocus();
    },
  );

  it('commits the trimmed value on Enter', async () => {
    const user = userEvent.setup();
    const onRename = renderTitlebar();
    await user.dblClick(screen.getByRole('button', { name: RENAME_LABEL }));
    await user.clear(screen.getByRole('textbox', { name: 'Screenplay title' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Screenplay title' }),
      '  Mercury Rising  ',
    );
    await user.keyboard('{Enter}');
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Mercury Rising');
  });

  it('commits on blur, the way clicking away from the field does', async () => {
    const user = userEvent.setup();
    const onRename = renderTitlebar();
    await user.dblClick(screen.getByRole('button', { name: RENAME_LABEL }));
    await user.clear(screen.getByRole('textbox', { name: 'Screenplay title' }));
    await user.type(screen.getByRole('textbox', { name: 'Screenplay title' }), 'Mercury Rising');
    fireEvent.blur(screen.getByRole('textbox', { name: 'Screenplay title' }));
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Mercury Rising');
  });

  it('discards the draft on Escape, writing nothing and restoring the name', async () => {
    const user = userEvent.setup();
    const onRename = renderTitlebar();
    await user.dblClick(screen.getByRole('button', { name: RENAME_LABEL }));
    await user.clear(screen.getByRole('textbox', { name: 'Screenplay title' }));
    await user.type(screen.getByRole('textbox', { name: 'Screenplay title' }), 'Abandoned');
    await user.keyboard('{Escape}');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: RENAME_LABEL })).toBeVisible();
  });

  // There is deliberately no test here for the component's `exitingRef` double-commit guard.
  // Removing that guard entirely leaves every test in this file green, because jsdom does not
  // fire a `blur` when a focused element is unmounted -- which is the only sequence the guard
  // exists to catch. A test asserting "commits once" therefore passes whether the guard is there
  // or not, and a test that cannot fail is worse than none: it reports coverage that does not
  // exist. The guard's own comment records that it is unverified; see this slice's progress notes.

  it.each([
    ['an unchanged title', 'Hollow Heart'],
    ['a blank title', ''],
    ['a whitespace-only title', '   '],
  ])('writes nothing for %s', async (_label, typed) => {
    // All three are silently discarded rather than surfaced as validation errors: there is nothing
    // for the server to do in any of them, and the writer's own name is kept either way.
    const user = userEvent.setup();
    const onRename = renderTitlebar();
    await user.dblClick(screen.getByRole('button', { name: RENAME_LABEL }));
    await user.clear(screen.getByRole('textbox', { name: 'Screenplay title' }));
    if (typed !== '') {
      await user.type(screen.getByRole('textbox', { name: 'Screenplay title' }), typed);
    }
    await user.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('bounds the field with the caller-supplied maxLength rather than a literal of its own', async () => {
    // Shared with `RenameDialog` and the server's own schema through
    // `RESOURCE_TITLE_MAX_LENGTH`; this component never restates the number.
    const user = userEvent.setup();
    render(
      <ApplicationTitlebar
        documentTitle="Hollow Heart"
        documentType="Screenplay"
        rename={{ maxLength: 12, onRename: vi.fn() }}
      />,
    );
    await user.dblClick(screen.getByRole('button', { name: RENAME_LABEL }));
    expect(screen.getByRole('textbox', { name: 'Screenplay title' })).toHaveAttribute(
      'maxlength',
      '12',
    );
  });
});
