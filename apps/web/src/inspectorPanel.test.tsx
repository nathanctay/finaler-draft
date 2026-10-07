import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InspectorPanel } from './inspectorPanel.js';

/**
 * The Inspector's frame, shared by the editor and the read-only revision comparison. The two screens'
 * *contents* differ by design; what these tests pin is the frame a reader recognises -- the panel's
 * label, the heading with its close affordance in the same place, and the `.inspector-section`/`<h2>`
 * rhythm every section is rendered in regardless of who supplied it.
 */
describe('inspector panel', () => {
  it('wears the panel shell, the heading and the close affordance', () => {
    render(<InspectorPanel onClose={vi.fn()} sections={[]} />);

    const panel = screen.getByRole('complementary', { name: 'Inspector' });
    expect(panel).toHaveClass('panel');
    expect(panel).toHaveClass('inspector');
    expect(within(panel).getByText('Inspector')).toBeInTheDocument();
    const close = within(panel).getByRole('button', { name: 'Close inspector' });
    expect(close).toHaveAttribute('title', 'Close inspector');
  });

  it('reports the close click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<InspectorPanel onClose={onClose} sections={[]} />);

    await user.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders each section in order, as a heading plus the caller’s content', () => {
    render(
      <InspectorPanel
        onClose={vi.fn()}
        sections={[
          { content: <p>Action</p>, heading: 'Active element', key: 'a' },
          { content: <p>Everything</p>, heading: 'Scope', key: 'b' },
        ]}
      />,
    );

    const sections = Array.from(document.querySelectorAll('.inspector-section'));
    expect(sections.map((section) => section.querySelector('h2')?.textContent)).toEqual([
      'Active element',
      'Scope',
    ]);
    expect(sections[0]?.textContent).toContain('Action');
    expect(sections[1]?.textContent).toContain('Everything');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2);
  });
});
