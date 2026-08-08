import { describe, expect, it } from 'vitest';
import { paginateScreenplay, UnsupportedBlockError } from './index.js';

describe('public API surface', () => {
  it('exports paginateScreenplay and it works end-to-end through the barrel', () => {
    const result = paginateScreenplay([{ id: 'a0', type: 'action', text: 'Hello.' }]);
    expect(result.pages).toHaveLength(1);
  });

  it('exports UnsupportedBlockError', () => {
    expect(() =>
      paginateScreenplay([
        {
          id: 'dd0',
          type: 'dual_dialogue',
          left: { id: 'l', blocks: [{ id: 'lc', type: 'character', text: 'A' }] },
          right: { id: 'r', blocks: [{ id: 'rc', type: 'character', text: 'B' }] },
        },
      ]),
    ).toThrow(UnsupportedBlockError);
  });
});
