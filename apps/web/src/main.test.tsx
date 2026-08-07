import { beforeEach, describe, expect, it, vi } from 'vitest';

const render = vi.hoisted(() => vi.fn());
const createRoot = vi.hoisted(() => vi.fn(() => ({ render })));

vi.mock('react-dom/client', () => ({ createRoot }));

describe('application bootstrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    createRoot.mockClear();
    render.mockClear();
    vi.resetModules();
  });

  it('creates the router application at the document root', async () => {
    await import('./main.js');
    expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'));
    expect(render).toHaveBeenCalledOnce();
  });

  it('fails visibly when the document root is absent', async () => {
    document.body.innerHTML = '';
    await expect(import('./main.js')).rejects.toThrow('Application root was not found.');
  });
});
