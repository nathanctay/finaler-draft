import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  it('is the same identity and the same way out on every screen that wears it', () => {
    render(<ApplicationTitlebar documentTitle="Hollow Heart" documentType="Screenplay" />);

    const brand = screen.getByRole('link', { name: 'Finaler Draft — back to your projects' });
    expect(brand).toHaveAttribute('href', '/projects');
    expect(brand).toHaveClass('brand');
    expect(screen.getByLabelText('Signed-in writer')).toHaveTextContent('FD');
  });

  it('names the document and what kind of view this is', () => {
    render(<ApplicationTitlebar documentTitle="Hollow Heart" documentType="Comparison" />);

    const title = document.querySelector('.document-title');
    expect(title?.textContent).toBe('Hollow Heart Comparison');
    expect(title?.querySelector('.title-type')?.textContent).toBe('Comparison');
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
