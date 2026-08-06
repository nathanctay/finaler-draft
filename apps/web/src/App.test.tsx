import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('authoring workspace shell', () => {
  it('lets a writer select scenes and adjust page zoom', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /^3\. Westbound/ }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByLabelText('Active scene')).toHaveTextContent('3. Westbound');
    expect(screen.getByLabelText('Zoom level')).toHaveTextContent('110%');
  });

  it('toggles both workspace panes without hiding the screenplay', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Close navigator' }));
    await user.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Navigator' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Toggle navigator' }));
    await user.click(screen.getByRole('button', { name: 'Toggle inspector' }));
    expect(screen.getByRole('complementary', { name: 'Navigator' })).toBeVisible();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    expect(screen.getByLabelText(/screenplay, page 1/i)).toBeVisible();
  });

  it('switches the workspace canvas without losing document context', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Dark canvas' }));

    expect(screen.getByRole('main')).toHaveClass('dark');
    expect(screen.getByRole('button', { name: 'Light canvas' })).toBeVisible();
    expect(screen.getByLabelText(/screenplay, page 1/i)).toBeVisible();
  });
});
