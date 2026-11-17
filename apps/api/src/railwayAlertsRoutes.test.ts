import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailMessage, MailPort } from '@finaler-draft/auth-server/mail';
import { buildApp } from './app.js';
import { RAILWAY_WEBHOOK_SECRET_HEADER } from './railwayAlerts.js';

/**
 * Route-level coverage for `POST /api/webhooks/railway`: that it does not exist at all without a
 * configured port, that the shared-secret header is checked before anything else and that the
 * correctly-authenticated case still works (not just that rejection happens -- see this project's
 * own "a test that asserts a rejection must also assert the accepted case still works" rule), that
 * only alertable events trigger an email, that a retried delivery emails at most once, and that a
 * mail-send failure answers 5xx rather than swallowing it into a 200. Follows
 * `feedbackRoutes.test.ts`'s shape: a fake dependency that records what it was called with, and
 * `app.inject` against a real `buildApp`, so the header check, the zod parse, the alertability
 * decision, the dedupe cache, and the route's own response codes are all genuinely in the path.
 */
const WEBHOOK_SECRET = 'test-only-shared-secret-FAKE';

const crashedPayload = {
  type: 'Deployment.crashed',
  details: {
    id: 'deploy-1',
    source: 'GitHub',
    status: 'CRASHED',
    branch: 'main',
    commitHash: 'abc123',
    commitAuthor: 'nathanctay',
    commitMessage: 'Add the purge cron',
  },
  resource: {
    workspace: { id: 'ws-1', name: 'finaler draft' },
    project: { id: 'proj-1', name: 'finaler draft' },
    environment: { id: 'env-1', name: 'production', isEphemeral: false },
    service: { id: 'svc-1', name: 'account-purge' },
    deployment: { id: 'deploy-1' },
  },
  severity: 'WARNING',
  timestamp: '2026-11-16T03:00:00.000Z',
};

const successPayload = {
  ...crashedPayload,
  type: 'Deployment.success',
  details: { ...crashedPayload.details, status: 'SUCCESS' },
};

let sent: MailMessage[];

function fakeMail(): MailPort {
  return { send: vi.fn(async (message: MailMessage) => void sent.push(message)) };
}

function withHeader(extra: Record<string, string> = {}) {
  return { [RAILWAY_WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET, ...extra };
}

beforeEach(() => {
  sent = [];
});

describe('POST /api/webhooks/railway', () => {
  it('is not registered at all when no railwayAlerts port is supplied', async () => {
    const app = await buildApp({});
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: crashedPayload,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejects a request with no shared-secret header at all', async () => {
    const mail = fakeMail();
    const app = await buildApp({
      railwayAlerts: { secret: WEBHOOK_SECRET, mailTo: 'oncall@example.test', mail },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        payload: crashedPayload,
      });
      expect(response.statusCode).toBe(401);
      expect(sent).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('rejects a request with the wrong shared-secret header value', async () => {
    const mail = fakeMail();
    const app = await buildApp({
      railwayAlerts: { secret: WEBHOOK_SECRET, mailTo: 'oncall@example.test', mail },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader({ [RAILWAY_WEBHOOK_SECRET_HEADER]: 'definitely-not-the-secret' }),
        payload: crashedPayload,
      });
      expect(response.statusCode).toBe(401);
      expect(sent).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('accepts a request with the correct shared-secret header and emails the alert', async () => {
    const mail = fakeMail();
    const app = await buildApp({
      railwayAlerts: { secret: WEBHOOK_SECRET, mailTo: 'oncall@example.test', mail },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: crashedPayload,
      });
      expect(response.statusCode).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe('oncall@example.test');
      expect(sent[0]!.subject).toContain('account-purge');
      expect(sent[0]!.text).toContain('Deployment: deploy-1');
    } finally {
      await app.close();
    }
  });

  it('acknowledges a successful deployment with 2xx and sends no email', async () => {
    const mail = fakeMail();
    const app = await buildApp({
      railwayAlerts: { secret: WEBHOOK_SECRET, mailTo: 'oncall@example.test', mail },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: successPayload,
      });
      // Asserted ahead of the "no email" check deliberately: a 404 or a 400 would also leave
      // `sent` empty, which is exactly the vacuous-pass shape this project has been bitten by
      // before. Proving the request was genuinely accepted and acknowledged is what makes the
      // "no email" assertion below mean something.
      expect(response.statusCode).toBe(200);
      expect(sent).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('rejects a payload that does not match the documented shape', async () => {
    const mail = fakeMail();
    const app = await buildApp({
      railwayAlerts: { secret: WEBHOOK_SECRET, mailTo: 'oncall@example.test', mail },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: { details: {} },
      });
      expect(response.statusCode).toBe(400);
      expect(sent).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('emails exactly once despite a retried delivery of the identical event', async () => {
    const mail = fakeMail();
    const app = await buildApp({
      railwayAlerts: { secret: WEBHOOK_SECRET, mailTo: 'oncall@example.test', mail },
    });
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: crashedPayload,
      });
      const retry = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: crashedPayload,
      });
      expect(first.statusCode).toBe(200);
      expect(retry.statusCode).toBe(200);
      expect(sent).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('still emails separately for a different deployment, despite sharing the same route and app instance', async () => {
    const mail = fakeMail();
    const app = await buildApp({
      railwayAlerts: { secret: WEBHOOK_SECRET, mailTo: 'oncall@example.test', mail },
    });
    try {
      await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: crashedPayload,
      });
      await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: {
          ...crashedPayload,
          details: { ...crashedPayload.details, id: 'deploy-2' },
          resource: { ...crashedPayload.resource, deployment: { id: 'deploy-2' } },
        },
      });
      expect(sent).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('returns 5xx and sends no email when the mail port throws', async () => {
    const mail: MailPort = { send: vi.fn(async () => Promise.reject(new Error('Resend is down'))) };
    const app = await buildApp({
      railwayAlerts: { secret: WEBHOOK_SECRET, mailTo: 'oncall@example.test', mail },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: crashedPayload,
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.statusCode).toBeLessThan(600);
    } finally {
      await app.close();
    }
  });

  it('retries a genuinely new delivery after a failed send, rather than permanently suppressing it', async () => {
    let shouldFail = true;
    const mail: MailPort = {
      send: vi.fn(async (message: MailMessage) => {
        if (shouldFail) throw new Error('Resend is down');
        sent.push(message);
      }),
    };
    const app = await buildApp({
      railwayAlerts: { secret: WEBHOOK_SECRET, mailTo: 'oncall@example.test', mail },
    });
    try {
      const failedAttempt = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: crashedPayload,
      });
      expect(failedAttempt.statusCode).toBeGreaterThanOrEqual(500);
      expect(sent).toEqual([]);

      shouldFail = false;
      const retried = await app.inject({
        method: 'POST',
        url: '/api/webhooks/railway',
        headers: withHeader(),
        payload: crashedPayload,
      });
      expect(retried.statusCode).toBe(200);
      expect(sent).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
