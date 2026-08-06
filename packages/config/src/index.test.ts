import { describe, expect, it } from 'vitest';
import { parseServerEnvironment } from './index.js';

describe('parseServerEnvironment', () => {
  it('uses safe development defaults', () => {
    expect(parseServerEnvironment({})).toEqual({ NODE_ENV: 'development', PORT: 3001 });
  });

  it('rejects ports outside the TCP range', () => {
    expect(() => parseServerEnvironment({ PORT: '70000' })).toThrow(/65535/);
  });
});
