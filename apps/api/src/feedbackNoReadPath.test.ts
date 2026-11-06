import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import type { FeedbackStore } from './feedback.js';
import type { ProjectStore } from './projects.js';
import type { SharingStore } from './sharing.js';

/**
 * The security property the owner called out as the most important constraint in this slice: no
 * role may read feedback back, which means there must be no read *route* -- not an unused one, not
 * one waiting for an admin role that doesn't exist yet. With no reader anywhere in this process,
 * there is no leak surface to audit, which is what makes storing a table of a writer's own words
 * and context genuinely safe rather than merely unexamined.
 *
 * This is asserted against the app's real, enumerated route tree (`app.printRoutes()`), not
 * against one hardcoded URL. A test that only requested `/api/feedback` and expected 404 there
 * would pass identically if the route table were completely empty -- proving nothing about whether
 * a *different* path (`/api/feedback/:id`, `/api/admin/feedback`, a query parameter on some
 * unrelated listing) had quietly grown a reader. Enumerating the tree and asserting that nothing
 * matching "feedback" answers a GET is the only version of this assertion that can actually fail
 * when it should.
 *
 * Built with every optional store `buildApp` accepts, deliberately, including ones that have
 * nothing to do with feedback -- the first assertion below proves the enumeration itself is
 * trustworthy (it reports a real `GET` on a route that genuinely has one) *before* the test leans
 * on it to prove an absence. Skipping that step is exactly the vacuous-assertion trap the rest of
 * this file exists to avoid: an absence assertion that was never shown capable of reporting a
 * presence is not evidence of anything.
 */
function notImplemented(): never {
  throw new Error('not implemented in this fake');
}

function fakeProjectStore(): ProjectStore {
  return {
    listProjects: vi.fn(async () => []),
    createProject: notImplemented,
    renameProject: notImplemented,
    deleteProject: notImplemented,
    restoreProject: notImplemented,
    listScreenplays: notImplemented,
    createScreenplay: notImplemented,
    getScreenplay: notImplemented,
    renameScreenplay: notImplemented,
    deleteScreenplay: notImplemented,
    restoreScreenplay: notImplemented,
    listDeleted: notImplemented,
    listSharedScreenplays: notImplemented,
  };
}

function fakeSharingStore(): SharingStore {
  return {
    listSharing: notImplemented,
    invite: notImplemented,
    changeMemberRole: notImplemented,
    removeMember: notImplemented,
    revokeInvitation: notImplemented,
    listInvitationsForUser: notImplemented,
    respondToInvitation: notImplemented,
  };
}

function fakeFeedbackStore(): FeedbackStore {
  return {
    submitFeedback: vi.fn(async () => ({ id: 'f1', createdAt: '2026-08-06T00:00:00.000Z' })),
  };
}

describe('the feedback table has no read path', () => {
  it('registers real GET routes elsewhere, proving the route-tree enumeration actually works', async () => {
    const app = await buildApp({
      auth: {
        baseUrl: 'https://app.example.test',
        handler: async () => new Response(null, { status: 204 }),
        getActorId: async () => 'actor-1',
        trustedOrigins: ['https://app.example.test'],
      },
      feedback: fakeFeedbackStore(),
      projects: fakeProjectStore(),
      sharing: fakeSharingStore(),
    });
    try {
      const tree = app.printRoutes();
      // Sanity check on the mechanism itself, independent of feedback entirely: a route this
      // slice did not touch (`/api/projects`) really does show up with GET in this tree, so the
      // enumeration below is reading something real rather than an empty table.
      expect(tree).toMatch(/projects.*\bGET\b/);
      expect(tree).toMatch(/invitations.*\bGET\b/);
    } finally {
      await app.close();
    }
  });

  it('answers nothing to GET on any path naming feedback, even when every other optional store is wired up', async () => {
    const app = await buildApp({
      auth: {
        baseUrl: 'https://app.example.test',
        handler: async () => new Response(null, { status: 204 }),
        getActorId: async () => 'actor-1',
        trustedOrigins: ['https://app.example.test'],
      },
      feedback: fakeFeedbackStore(),
      projects: fakeProjectStore(),
      sharing: fakeSharingStore(),
    });
    try {
      const tree = app.printRoutes();
      const feedbackLines = tree
        .split('\n')
        .filter((line) => line.toLowerCase().includes('feedback'));

      // The enumeration does see this slice's route -- proving the next assertion isn't vacuous
      // for the opposite reason (a route tree with nothing matching "feedback" at all would also
      // pass a bare "contains no GET" check, for a different, equally wrong reason).
      expect(feedbackLines.length).toBeGreaterThan(0);

      for (const line of feedbackLines) {
        expect(line).not.toMatch(/\bGET\b/);
        expect(line).not.toMatch(/\bHEAD\b/);
      }
    } finally {
      await app.close();
    }
  });
});
