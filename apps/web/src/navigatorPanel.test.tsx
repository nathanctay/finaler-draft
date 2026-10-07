import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  NavigatorPanel,
  type NavigatorEntry,
  type NavigatorEntryStatus,
} from './navigatorPanel.js';

/**
 * The Navigator, shared by the editor and the read-only revision comparison. Three properties are
 * pinned here:
 *
 *  1. the panel frame and the WAI-ARIA tabs contract, which moved across from `App.tsx` and must keep
 *     behaving exactly as `App.test.tsx` already asserts it does for the editor;
 *  2. the per-entry **change marking**, which is the comparison's whole reason for having a Navigator
 *     -- a marked entry carries a status attribute, a visible glyph and a word a screen reader hears,
 *     so the marking never depends on telling two colours apart;
 *  3. the jump: selecting an entry calls that entry's own callback and nobody else's.
 */
const TABS = [
  { id: 'scenes', label: 'Scenes' },
  { id: 'characters', label: 'Characters' },
] as const;

function entry(overrides: Partial<NavigatorEntry> = {}): NavigatorEntry {
  return {
    key: 'one',
    onSelect: vi.fn(),
    primary: '1. INT. KITCHEN - DAY',
    secondary: '4 blocks',
    selected: false,
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof NavigatorPanel>[0]> = {}) {
  const onChangeTab = vi.fn();
  const onClose = vi.fn();
  const result = render(
    <NavigatorPanel
      activeTabId="scenes"
      entries={[entry()]}
      footer="1 scenes · local draft"
      onChangeTab={onChangeTab}
      onClose={onClose}
      tabs={TABS}
      {...props}
    />,
  );
  return { ...result, onChangeTab, onClose };
}

describe('navigator panel: the frame', () => {
  it('wears the panel shell, the heading, the close affordance and the footer', () => {
    renderPanel();

    const panel = screen.getByRole('complementary', { name: 'Navigator' });
    expect(panel).toHaveClass('panel');
    expect(panel).toHaveClass('navigator');
    expect(within(panel).getByText('Navigator')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close navigator' })).toHaveAttribute(
      'title',
      'Close navigator',
    );
    expect(panel.querySelector('.navigator-footer')?.textContent).toBe('1 scenes · local draft');
  });

  it('reports the close click', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Close navigator' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wires the tabs to their panel the way the WAI-ARIA tabs pattern requires', () => {
    renderPanel();

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Scenes', 'Characters']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('aria-controls', 'navigator-panel-scenes');
    expect(tabs[0]).toHaveAttribute('id', 'navigator-tab-scenes');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'navigator-panel-scenes');
    expect(panel).toHaveAttribute('aria-labelledby', 'navigator-tab-scenes');
  });

  /** A roving tabindex: the tablist is one Tab stop, and the arrow keys move within it. */
  it('keeps only the selected tab in the Tab order', () => {
    renderPanel();

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
  });

  it('moves selection and focus together on Left and Right, wrapping at both ends', async () => {
    const user = userEvent.setup();
    const { onChangeTab, rerender } = renderPanel();

    screen.getAllByRole('tab')[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChangeTab).toHaveBeenLastCalledWith('characters');

    // Wrapping: Right from the last tab returns to the first, Left from the first to the last.
    rerender(
      <NavigatorPanel
        activeTabId="characters"
        entries={[entry()]}
        footer="footer"
        onChangeTab={onChangeTab}
        onClose={vi.fn()}
        tabs={TABS}
      />,
    );
    screen.getAllByRole('tab')[1]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChangeTab).toHaveBeenLastCalledWith('scenes');
    await user.keyboard('{ArrowLeft}');
    expect(onChangeTab).toHaveBeenLastCalledWith('scenes');
  });

  it('ignores every other key, so typing in the tablist changes nothing', async () => {
    const user = userEvent.setup();
    const { onChangeTab } = renderPanel();

    screen.getAllByRole('tab')[0]!.focus();
    await user.keyboard('{ArrowDown}{End}a');
    expect(onChangeTab).not.toHaveBeenCalled();
  });

  it('reports a tab click', async () => {
    const user = userEvent.setup();
    const { onChangeTab } = renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Characters' }));
    expect(onChangeTab).toHaveBeenCalledWith('characters');
  });
});

describe('navigator panel: the entries', () => {
  it('renders each entry’s own line and trailing figure, and marks the selected one', () => {
    renderPanel({
      entries: [
        entry({ key: 'a', primary: '1. INT. KITCHEN - DAY', secondary: '4 blocks' }),
        entry({ key: 'b', primary: '2. EXT. ROOF - DAWN', secondary: '7 blocks', selected: true }),
      ],
    });

    const buttons = screen.getAllByRole('button').filter((button) => button.closest('.scene-list'));
    expect(buttons.map((button) => button.textContent)).toEqual([
      '1. INT. KITCHEN - DAY4 blocks',
      '2. EXT. ROOF - DAWN7 blocks',
    ]);
    expect(buttons[0]).not.toHaveClass('selected');
    expect(buttons[1]).toHaveClass('selected');
  });

  it('calls the clicked entry’s own callback and nobody else’s', async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    renderPanel({
      entries: [
        entry({ key: 'a', onSelect: first, primary: 'First' }),
        entry({ key: 'b', onSelect: second, primary: 'Second' }),
      ],
    });

    await user.click(screen.getByRole('button', { name: /Second/u }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  /** The editor's own Navigator has always rendered a bare empty list for a screenplay with no scenes;
   * only a caller that supplies `emptyMessage` gets an explanation in its place. */
  it('renders an empty list, with no empty-state row, when the caller offers no message', () => {
    renderPanel({ entries: [] });

    expect(screen.getByRole('tabpanel').children).toHaveLength(0);
    expect(document.querySelector('.navigator-empty')).toBeNull();
  });

  it('explains an empty tab when the caller supplies a message', () => {
    renderPanel({ emptyMessage: 'No scene changed.', entries: [] });

    expect(document.querySelector('.navigator-empty')?.textContent).toBe('No scene changed.');
  });

  it('keeps the caller’s message out of the way when there are entries to show', () => {
    renderPanel({ emptyMessage: 'No scene changed.', entries: [entry()] });

    expect(document.querySelector('.navigator-empty')).toBeNull();
  });
});

/**
 * The change marking: the property the comparison's Navigator exists for, and the one a mutation that
 * drops it must fail on. Each marked entry carries three things that agree with each other -- the
 * status attribute the stylesheet colours, an `aria-hidden` glyph, and the status as a word in the
 * row's reading order -- so the marking is never a colour alone and never only a style hook.
 */
describe('navigator panel: change marking', () => {
  const EXPECTED: Record<NavigatorEntryStatus, { glyph: string; word: string }> = {
    added: { glyph: '+', word: 'Added.' },
    removed: { glyph: '-', word: 'Removed.' },
    changed: { glyph: '~', word: 'Changed.' },
    moved: { glyph: '⇄', word: 'Moved.' },
  };

  it('marks every status with its own attribute, glyph and word', () => {
    const statuses = Object.keys(EXPECTED) as NavigatorEntryStatus[];
    renderPanel({
      entries: statuses.map((status) => entry({ key: status, primary: status, status })),
    });

    // Indexed by position rather than queried by accessible name: "removed" contains "moved", so a
    // name-based query cannot tell those two rows apart.
    const buttons = Array.from(
      screen.getByRole('tabpanel').querySelectorAll<HTMLElement>('li > button'),
    );
    expect(buttons).toHaveLength(statuses.length);
    for (const [index, status] of statuses.entries()) {
      const button = buttons[index]!;
      const expected = EXPECTED[status];
      expect(button).toHaveAttribute('data-navigator-status', status);
      const glyph = button.querySelector('.navigator-status-glyph');
      expect(glyph?.textContent).toBe(expected.glyph);
      expect(glyph).toHaveAttribute('aria-hidden', 'true');
      expect(button.querySelector('.visually-hidden')?.textContent).toBe(`${expected.word} `);
    }
  });

  /** An unmarked entry -- every entry the editor renders -- carries no status attribute, no glyph and
   * no hidden word at all. A scene in a live document is not "added" relative to anything. */
  it('marks nothing on an entry the caller gave no status', () => {
    renderPanel({ entries: [entry()] });

    const button = screen
      .getAllByRole('button')
      .find((candidate) => candidate.closest('.scene-list'));
    expect(button).not.toHaveAttribute('data-navigator-status');
    expect(button?.querySelector('.navigator-status-glyph')).toBeNull();
    expect(button?.querySelector('.visually-hidden')).toBeNull();
  });

  /** The word comes first in the row's reading order, so a screen reader announces what happened to
   * the scene before announcing which scene it is -- the same ordering the manuscript's own marked
   * rows use. */
  it('announces the status before the entry’s own line', () => {
    renderPanel({ entries: [entry({ primary: 'EXT. ROOF - DAWN', status: 'removed' })] });

    const button = screen.getByRole('button', { name: /EXT\. ROOF/u });
    expect(button.textContent?.startsWith('Removed. ')).toBe(true);
  });
});
