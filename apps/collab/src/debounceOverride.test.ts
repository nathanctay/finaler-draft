import { describe, expect, it } from 'vitest';
import { collabDebounceOverride } from './debounceOverride.js';

describe('collabDebounceOverride', () => {
  it('applies a valid pair outside production', () => {
    expect(
      collabDebounceOverride({
        COLLAB_DEBOUNCE_MS: '30000',
        COLLAB_MAX_DEBOUNCE_MS: '30000',
        NODE_ENV: 'test',
      }),
    ).toEqual({ debounce: 30000, maxDebounce: 30000 });
  });

  /*
   * The property this module exists for. A stray variable in a production environment must never
   * leave a server holding edits in memory for minutes -- and because the valid case above proves
   * the same input *is* otherwise honoured, this assertion cannot pass merely because the parsing
   * is broken.
   */
  it('refuses to apply in production, even with a perfectly valid pair', () => {
    expect(
      collabDebounceOverride({
        COLLAB_DEBOUNCE_MS: '30000',
        COLLAB_MAX_DEBOUNCE_MS: '30000',
        NODE_ENV: 'production',
      }),
    ).toEqual({});
  });

  it('ignores an absent pair, which is the ordinary case for development and CI', () => {
    expect(collabDebounceOverride({ NODE_ENV: 'test' })).toEqual({});
  });

  /*
   * A half-applied pair is the one outcome worse than ignoring the variables: `debounce` without
   * `maxDebounce` silently changes how long an edit may sit unflushed, in a configuration nobody
   * wrote down. Each of these must degrade to the defaults rather than apply partially.
   */
  it.each([
    ['only debounce set', { COLLAB_DEBOUNCE_MS: '30000' }],
    ['only maxDebounce set', { COLLAB_MAX_DEBOUNCE_MS: '30000' }],
    ['non-numeric', { COLLAB_DEBOUNCE_MS: 'soon', COLLAB_MAX_DEBOUNCE_MS: 'later' }],
    ['empty strings', { COLLAB_DEBOUNCE_MS: '', COLLAB_MAX_DEBOUNCE_MS: '' }],
    ['zero', { COLLAB_DEBOUNCE_MS: '0', COLLAB_MAX_DEBOUNCE_MS: '0' }],
    ['negative', { COLLAB_DEBOUNCE_MS: '-5', COLLAB_MAX_DEBOUNCE_MS: '-5' }],
    ['fractional', { COLLAB_DEBOUNCE_MS: '1.5', COLLAB_MAX_DEBOUNCE_MS: '1.5' }],
  ])('ignores a malformed pair: %s', (_label, environment) => {
    expect(collabDebounceOverride({ ...environment, NODE_ENV: 'test' })).toEqual({});
  });
});
