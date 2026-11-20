import { afterEach, describe, expect, it } from 'vitest';

/**
 * COL-1's process-level backstop (progress/collab-durability-and-checkpoints.md).
 *
 * `server.ts` is a self-executing entrypoint, not an exported config -- every other test of its
 * behaviour (`collaboration.integration.test.ts`, `gracefulShutdown.integration.test.ts`) either
 * rebuilds its hook wiring by hand or spawns it as a real child process. Neither approach can
 * prove *this* line is still there: `process.on('unhandledRejection', ...)`, registered
 * unconditionally at module scope, before the big top-level `try` that does everything else (see
 * `server.ts`'s own comment on why). That placement is exactly what makes a direct, in-process
 * test of it possible without starting a real server at all: the registration runs -- and this
 * test can observe it -- even on the early, synchronous bail-out path
 * `requireCollabPersistenceEnvironment` takes when `DATABASE_URL` is missing, before anything that
 * would open a real socket or a real database connection. `DATABASE_URL` is deleted for the
 * duration of the import specifically to force that path deterministically, regardless of what
 * this worker's ambient environment happens to carry.
 */
describe('server.ts process-level unhandledRejection backstop', () => {
  afterEach(() => {
    // The forced bail-out below sets `process.exitCode = 1` (server.ts's own top-level `catch`) --
    // harmless to this test's own assertions, but left unreset it would make this worker process
    // exit non-zero once vitest finishes, for a failure that never actually happened.
    process.exitCode = undefined;
  });

  it('registers an unhandledRejection listener, even on the early bail-out path with no DATABASE_URL', async () => {
    const before = process.listenerCount('unhandledRejection');
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      // Node's module cache means this import's top-level code runs exactly once per worker --
      // sufficient for this test, since the registration it is proving happens unconditionally,
      // the very first time this module is ever loaded.
      await import('./server.js');
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
    const after = process.listenerCount('unhandledRejection');
    expect(after).toBeGreaterThan(before);
  });
});
