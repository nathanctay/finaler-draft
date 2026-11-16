import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRailwayAlertDedupe,
  isAlertableRailwayEvent,
  railwayAlertDedupeKey,
  railwayAlertSubject,
  railwayAlertText,
  railwayWebhookEventSchema,
  secretsMatch,
  type RailwayWebhookEvent,
} from './railwayAlerts.js';

/**
 * Unit coverage for the pure logic `railwayAlerts.ts` exports: the constant-time secret
 * comparison, which events are alertable, the retry-safe dedupe cache, and the email rendering.
 * Route-level wiring (header check -> parse -> alertability -> dedupe -> mail -> response code)
 * lives in `railwayAlertsRoutes.test.ts`, mirroring the split `feedback.test.ts`/
 * `feedbackRoutes.test.ts` already use for the identical reason.
 */

function crashedEvent(overrides: Partial<RailwayWebhookEvent> = {}): RailwayWebhookEvent {
  return {
    type: 'Deployment.crashed',
    details: {
      id: 'deploy-1',
      status: 'CRASHED',
      commitHash: 'abc123',
      commitMessage: 'Add the purge cron',
    },
    resource: {
      service: { id: 'svc-1', name: 'account-purge' },
      environment: { id: 'env-1', name: 'production' },
      deployment: { id: 'deploy-1' },
    },
    severity: 'WARNING',
    timestamp: '2026-11-16T03:00:00.000Z',
    ...overrides,
  };
}

describe('secretsMatch', () => {
  it('accepts the exact configured secret', () => {
    expect(secretsMatch('correct-secret', 'correct-secret')).toBe(true);
  });

  it('rejects a different secret of the same length', () => {
    expect(secretsMatch('correct-secret', 'wrong-secrettt')).toBe(false);
  });

  it('rejects a shorter or longer value without throwing', () => {
    expect(secretsMatch('correct-secret', 'short')).toBe(false);
    expect(secretsMatch('correct-secret', 'correct-secret-but-longer')).toBe(false);
  });

  it('rejects a missing header value', () => {
    expect(secretsMatch('correct-secret', undefined)).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(secretsMatch('correct-secret', '')).toBe(false);
  });

  // The property that actually distinguishes this function from a plain `===` comparison is not
  // observable from its return value alone -- both implementations return identical booleans for
  // every input above. Proving the comparison is genuinely constant-time, rather than merely
  // correct, needs `node:crypto.timingSafeEqual` itself to be observed deciding the answer --
  // which `railwayAlertsSecretComparison.test.ts` does, in its own file, because mocking a Node
  // built-in module is file-scoped in Vitest (`vi.mock` replaces the module for every import in
  // that file) and this file's other describe blocks below have no reason to run against a
  // mocked `node:crypto`.
});

describe('railwayWebhookEventSchema', () => {
  it('accepts the documented payload shape', () => {
    const result = railwayWebhookEventSchema.safeParse(crashedEvent());
    expect(result.success).toBe(true);
  });

  it('accepts a payload carrying fields this schema does not model, rather than rejecting it', () => {
    const result = railwayWebhookEventSchema.safeParse({
      ...crashedEvent(),
      somethingRailwayAddsLater: { nested: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a payload with no type at all', () => {
    const result = railwayWebhookEventSchema.safeParse({ details: {} });
    expect(result.success).toBe(false);
  });

  it('rejects a payload whose type is not a string', () => {
    const result = railwayWebhookEventSchema.safeParse({ type: 42 });
    expect(result.success).toBe(false);
  });
});

describe('isAlertableRailwayEvent', () => {
  it('alerts on a crashed deployment', () => {
    expect(isAlertableRailwayEvent(crashedEvent({ type: 'Deployment.crashed' }))).toBe(true);
  });

  it('alerts on a failed deployment', () => {
    expect(isAlertableRailwayEvent(crashedEvent({ type: 'Deployment.failed' }))).toBe(true);
  });

  // Railway defaults a new webhook to exactly failed + crashed + oom_killed, so an OOM kill is a
  // first-class failure and a *distinct* type from `crashed`. Omitting it would acknowledge an OOM
  // with a 2xx and no email, which is the silent failure this whole route exists to end.
  it('alerts on an out-of-memory kill', () => {
    expect(isAlertableRailwayEvent(crashedEvent({ type: 'Deployment.oom_killed' }))).toBe(true);
  });

  // Every `type` below is a real value from Railway's own published event-type enum. An earlier
  // revision of this file asserted against invented names (`Deployment.success`,
  // `Volume.usageAlert`), which pass against any implementation precisely because Railway never
  // sends them -- the assertion proved nothing about real traffic.
  it('does not alert on a successful deployment', () => {
    for (const type of ['Deployment.deployed', 'Deployment.redeployed']) {
      expect(isAlertableRailwayEvent(crashedEvent({ type }))).toBe(false);
    }
  });

  it('does not alert on an in-progress deployment transition', () => {
    for (const type of [
      'Deployment.building',
      'Deployment.deploying',
      'Deployment.queued',
      'Deployment.waiting',
      'Deployment.needs_approval',
    ]) {
      expect(isAlertableRailwayEvent(crashedEvent({ type }))).toBe(false);
    }
  });

  it('does not alert on an operator-initiated or lifecycle transition', () => {
    for (const type of [
      'Deployment.removed',
      'Deployment.slept',
      'Deployment.resumed',
      'Deployment.restarted',
    ]) {
      expect(isAlertableRailwayEvent(crashedEvent({ type }))).toBe(false);
    }
  });

  it('alerts on a non-deployment platform event (volume and monitor alerts)', () => {
    for (const type of ['VolumeAlert.triggered', 'Monitor.triggered']) {
      expect(isAlertableRailwayEvent(crashedEvent({ type }))).toBe(true);
    }
  });
});

describe('railwayAlertDedupeKey', () => {
  it('combines the deployment id and the event type', () => {
    expect(railwayAlertDedupeKey(crashedEvent())).toBe('deploy-1:Deployment.crashed');
  });

  it('distinguishes two different event types for the same deployment', () => {
    const failed = railwayAlertDedupeKey(crashedEvent({ type: 'Deployment.failed' }));
    const crashed = railwayAlertDedupeKey(crashedEvent({ type: 'Deployment.crashed' }));
    expect(failed).not.toBe(crashed);
  });

  it('falls back to details.id when resource.deployment is absent', () => {
    const event = crashedEvent({ resource: { service: { name: 'account-purge' } } });
    expect(railwayAlertDedupeKey(event)).toBe('deploy-1:Deployment.crashed');
  });

  it('falls back to a fixed placeholder when no deployment identifier is present at all', () => {
    const event = crashedEvent({ details: undefined, resource: undefined });
    expect(railwayAlertDedupeKey(event)).toBe('no-deployment-id:Deployment.crashed');
  });
});

describe('createRailwayAlertDedupe', () => {
  let currentTime: number;
  const now = () => currentTime;

  beforeEach(() => {
    currentTime = 0;
  });

  it('has not seen a key before it is marked', () => {
    const dedupe = createRailwayAlertDedupe(60_000, now);
    expect(dedupe.hasSeen('deploy-1:Deployment.crashed')).toBe(false);
  });

  it('remembers a key as seen once marked, within the TTL', () => {
    const dedupe = createRailwayAlertDedupe(60_000, now);
    dedupe.markSeen('deploy-1:Deployment.crashed');
    currentTime = 59_999;
    expect(dedupe.hasSeen('deploy-1:Deployment.crashed')).toBe(true);
  });

  it('forgets a key once the TTL has elapsed', () => {
    const dedupe = createRailwayAlertDedupe(60_000, now);
    dedupe.markSeen('deploy-1:Deployment.crashed');
    currentTime = 60_000;
    expect(dedupe.hasSeen('deploy-1:Deployment.crashed')).toBe(false);
  });

  it('tracks distinct keys independently', () => {
    const dedupe = createRailwayAlertDedupe(60_000, now);
    dedupe.markSeen('deploy-1:Deployment.crashed');
    expect(dedupe.hasSeen('deploy-2:Deployment.crashed')).toBe(false);
  });
});

describe('railwayAlertSubject / railwayAlertText', () => {
  it('names the service and environment in the subject', () => {
    expect(railwayAlertSubject(crashedEvent())).toBe(
      'Finaler Draft deploy alert: account-purge (production)',
    );
  });

  it('includes every field the brief requires in the body', () => {
    const text = railwayAlertText(crashedEvent());
    expect(text).toContain('Service: account-purge');
    expect(text).toContain('Environment: production');
    expect(text).toContain('Event: Deployment.crashed');
    expect(text).toContain('Status: CRASHED');
    expect(text).toContain('Deployment: deploy-1');
    expect(text).toContain('Commit: abc123');
    expect(text).toContain('Commit message: Add the purge cron');
    expect(text).toContain('Timestamp: 2026-11-16T03:00:00.000Z');
  });

  it('renders a readable placeholder instead of throwing when optional fields are absent', () => {
    const sparse: RailwayWebhookEvent = { type: 'Volume.usageAlert' };
    expect(() => railwayAlertSubject(sparse)).not.toThrow();
    const text = railwayAlertText(sparse);
    expect(text).toContain('Service: (unknown)');
    expect(text).toContain('Deployment: (unknown)');
  });
});
