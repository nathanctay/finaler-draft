import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('COLLAB_WS_URL', () => {
  it('uses VITE_COLLAB_WS_URL when set, regardless of MODE', async () => {
    vi.stubEnv('VITE_COLLAB_WS_URL', 'ws://127.0.0.1:4175');
    vi.stubEnv('MODE', 'production');
    const { COLLAB_WS_URL } = await import('./collabConfig.js');
    expect(COLLAB_WS_URL).toBe('ws://127.0.0.1:4175');
  });

  it('falls back to the local collab server in development mode when unset', async () => {
    // VITE_COLLAB_WS_URL deliberately left unstubbed: it is undefined by default under Vitest
    // (`vi.stubEnv` with an empty string would set it to `''`, a defined value, not the same
    // "unset" case a real unconfigured environment produces).
    vi.stubEnv('MODE', 'development');
    const { COLLAB_WS_URL } = await import('./collabConfig.js');
    expect(COLLAB_WS_URL).toBe('ws://localhost:4400');
  });

  it('stays undefined in a production build that never set VITE_COLLAB_WS_URL', async () => {
    // The real `vite build` failure mode this fallback does not (and should not) paper over --
    // a misconfigured deployment. See collabConfig.ts's own comment on why this is a build-time
    // value, not a runtime one, and progress/collaboration-slice-1.md for why this case stays a
    // silent fallback rather than a hard failure in this slice.
    vi.stubEnv('MODE', 'production');
    const { COLLAB_WS_URL } = await import('./collabConfig.js');
    expect(COLLAB_WS_URL).toBeUndefined();
  });

  it('stays undefined under Vitest itself (MODE defaults to "test", not "development")', async () => {
    // The whole reason this reads `MODE` rather than `DEV`: Vite sets `DEV` to `!isProduction`,
    // which is also true under Vitest's own default mode -- gating on `DEV` would have pointed
    // every unit test in this app at a real `HocuspocusProvider` instead of the local `Y.Doc`
    // they are written against.
    const { COLLAB_WS_URL } = await import('./collabConfig.js');
    expect(import.meta.env.MODE).toBe('test');
    expect(COLLAB_WS_URL).toBeUndefined();
  });
});
