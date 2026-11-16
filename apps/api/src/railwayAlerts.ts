import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { MailPort } from '@finaler-draft/auth-server/mail';

/**
 * `POST /api/webhooks/railway` -- the deployment-crash alert route
 * (progress/deployment-crash-alerts.md). `.github/workflows/quality.yml`'s `deploy-outcome` job
 * already turns "the build or deploy itself failed" into a failed CI run a human sees; nothing
 * previously turned "a deployment that built and shipped fine then crashed at runtime" into
 * anything visible at all -- exactly what happened to the `account-purge` cron's first scheduled
 * run (`MODULE_NOT_FOUND`), which went unnoticed until a worktree cleanup turned it up by chance,
 * weeks later, with the grace-period purge having never once run. This file is the whole of that
 * gap's closing: the payload's shape, which events are worth a human's attention, the retry-safe
 * dedupe, and the email body. The HTTP route itself is registered in app.ts, mirroring
 * `stripeWebhook.ts`'s own split between "the event-handling logic lives here" and "the wiring
 * lives in app.ts."
 *
 * **Not signed the way Stripe's webhook is -- verified from docs.railway.com/observability/
 * webhooks directly, not assumed from `stripeWebhook.ts`'s shape.** Railway's webhook delivery
 * carries no signature header and there is no `constructEvent`-style function to verify one
 * against. The documented mechanism is a custom header whose name the receiver chooses (Railway's
 * own form only refuses names starting with `X-Railway-`, which it reserves for itself, plus the
 * handful of headers it sets unconditionally). This file picks `x-finaler-draft-webhook-secret`
 * and compares it with `secretsMatch` below, in constant time -- there is nothing resembling an
 * HMAC to compute, since Railway never signs the body, so copying `stripeWebhook.ts`'s
 * `constructEvent` shape here would verify nothing.
 */
export const RAILWAY_WEBHOOK_SECRET_HEADER = 'x-finaler-draft-webhook-secret';

/**
 * Constant-time comparison of the configured secret against the header value a request actually
 * supplied, so a caller probing for the right value cannot learn anything from how long the
 * comparison took. `timingSafeEqual` throws if the two buffers differ in length, so the length
 * check runs first and short-circuits to `false` rather than letting that exception reach the
 * route as an unexpected 500. The length check itself only leaks the length of the *secret*, not
 * of anything attacker-controlled relative to a target -- it does not reintroduce a timing
 * channel on the value itself.
 *
 * `received` is typed to allow `undefined` so the one call site (the route) can pass a missing
 * header straight through without first coercing it to a string: a missing header is simply never
 * equal to anything.
 */
export function secretsMatch(expected: string, received: string | undefined): boolean {
  if (typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received, 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Railway's documented webhook payload
 * (docs.railway.com/observability/webhooks#webhook-payload), treated as untrusted network input
 * and parsed before any field is read, logged, or placed in an email -- the identical discipline
 * `feedback.ts`'s `submitFeedbackInput` applies to a signed-in writer's own request, applied here
 * to an external service's.
 *
 * Deliberately **not** `.strict()` the way `feedback.ts`'s schemas are. `.strict()` exists there
 * to close a field-smuggling path against a caller this process authenticates and trusts
 * selectively (a signed-in writer); Railway is a single external service whose own docs describe
 * this payload shape as covering several event categories already (deployment status changes,
 * volume usage alerts, resource alerts) and evolving over time. Rejecting a payload outright for
 * carrying a field this schema does not yet model would turn Railway's own forward-compatible
 * additions into a production incident for this route specifically -- the opposite of what a
 * crash-alerting route should do. Every field this file actually reads is still fully validated
 * for type before use; nothing unvalidated ever reaches a log line or the alert email.
 */
export const railwayWebhookEventSchema = z.object({
  type: z.string().min(1),
  details: z
    .object({
      id: z.string().optional(),
      source: z.string().optional(),
      status: z.string().optional(),
      branch: z.string().optional(),
      commitHash: z.string().optional(),
      commitAuthor: z.string().optional(),
      commitMessage: z.string().optional(),
    })
    .optional(),
  resource: z
    .object({
      workspace: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
      project: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
      environment: z
        .object({
          id: z.string().optional(),
          name: z.string().optional(),
          isEphemeral: z.boolean().optional(),
        })
        .optional(),
      service: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
      deployment: z.object({ id: z.string().optional() }).optional(),
    })
    .optional(),
  severity: z.string().optional(),
  timestamp: z.string().optional(),
});
export type RailwayWebhookEvent = z.infer<typeof railwayWebhookEventSchema>;

/**
 * The three `type` literals this route treats as an alertable deployment failure.
 *
 * **These are Railway's own published values, not an extrapolation.** Railway's API enumerates the
 * complete set of webhook event types, and it is exactly: `Deployment.crashed`,
 * `Deployment.oom_killed`, `Deployment.failed`, `Deployment.deployed`, `Deployment.redeployed`,
 * `Deployment.slept`, `Deployment.resumed`, `Deployment.restarted`, `Deployment.removed`,
 * `Deployment.building`, `Deployment.deploying`, `Deployment.waiting`,
 * `Deployment.needs_approval`, `Deployment.queued`, `VolumeAlert.triggered`,
 * `VolumeAlert.resolved`, `Monitor.triggered`, `Monitor.resolved`, `Monitor.deleted`. Railway's
 * prose docs publish only one literal (`"Deployment.failed"`, in their example payload), so this
 * list came from the API's own schema instead of being guessed from a naming convention.
 *
 * The three chosen are precisely the three Railway itself defaults a new webhook to -- failed,
 * crashed, and oom_killed -- which is a strong independent signal that they are the set a human
 * needs unprompted. `oom_killed` matters here specifically: this project's cron reads and deletes
 * in batches, so "the box ran out of memory" is a plausible future failure, and it is a *distinct*
 * type from `crashed`. Omitting it would acknowledge an OOM kill with a 2xx and no email -- the
 * exact silent failure this route exists to end.
 *
 * `FAILED` is the build/deploy failing; `CRASHED` is "crashed after starting", which is the
 * `account-purge` incident (a runtime `MODULE_NOT_FOUND` on the first 03:00 trigger) this route was
 * built for. Both are in scope, not just one.
 */
const ALERTABLE_DEPLOYMENT_TYPES = new Set([
  'Deployment.failed',
  'Deployment.crashed',
  'Deployment.oom_killed',
]);

/**
 * Decides whether a (validated) Railway webhook event is worth emailing a human about.
 * Deliberately keyed on `type` alone, never on `details.status`: Railway's own example payload
 * pairs `"type": "Deployment.failed"` with `"details": { "status": "SUCCESS" }`, an inconsistency
 * this file cannot resolve from the docs alone (placeholder sample data, or a real case of
 * `status` lagging the event that reports a deployment's failure -- either is plausible). Gating
 * on `type` is the one reading that survives that inconsistency either way; gating on
 * `details.status` instead risks silently going quiet the day the two fields genuinely disagree
 * in production.
 *
 * This single URL also receives volume usage alerts and CPU/RAM "resource" alerts --
 * `docs.railway.com/observability/webhooks#platform-events` groups all three ("Deployment status
 * changes", "Volume usage alerts", "CPU/RAM monitor alerts") under "Platform events" delivered to
 * the same webhook -- and Railway's docs never publish the literal `type` string either alert
 * category uses. Hardcoding a guessed literal here would either alert on nothing (wrong guess) or
 * silently stop alerting the day Railway renames an internal string (brittle guess even if
 * right). Since the only three categories this URL ever receives are deployment status changes,
 * volume alerts, and resource alerts, and the latter two are alerts by their own name, "this is
 * not a `Deployment.*` status transition" is sufficient on its own to alert. A `Deployment.*`
 * event, by contrast, is alertable only when it names one of the two crash/failure transitions
 * above -- a successful deploy, a build starting, or an operator-initiated removal are all
 * acknowledged with no email, which is exactly requirement 3 in
 * progress/deployment-crash-alerts.md: alerting on every event trains the reader to ignore all of
 * them, the same failure mode as building nothing at all.
 */
export function isAlertableRailwayEvent(event: RailwayWebhookEvent): boolean {
  if (event.type.startsWith('Deployment.')) {
    return ALERTABLE_DEPLOYMENT_TYPES.has(event.type);
  }
  return true;
}

/**
 * How long a deployment id + event type pair is remembered as "already alerted," in milliseconds.
 * Railway retries an undelivered webhook up to 3 times with exponential backoff if it does not
 * see a 2xx/3xx response within a 30-second-per-attempt timeout
 * (docs.railway.com/observability/webhooks#delivery) -- comfortably inside ten minutes even in the
 * worst case, with wide margin for a slow mail provider on top of that.
 */
const RAILWAY_ALERT_DEDUPE_TTL_MS = 10 * 60 * 1000;

/**
 * The retry-safe dedupe this route needs (requirement 4, progress/deployment-crash-alerts.md): a
 * delivery Railway retries because it never saw our response in time -- including one where the
 * first attempt actually succeeded and emailed, just too slowly for Railway to see the reply --
 * must not email a second time.
 *
 * An in-process `Map`, not a persisted store. This route's own process restarts far less often
 * than once per `RAILWAY_ALERT_DEDUPE_TTL_MS`, and the one gap an in-memory cache cannot close --
 * a restart landing in the narrow window between a real delivery and its retry -- trades a
 * theoretical duplicate email for not standing up a database row (or a second service) purely to
 * remember "already sent" for ten minutes. **A restart loses every entry**: the next delivery of
 * a given deployment+type pair after a restart is treated as new, which is the one thing this
 * cache does not survive and is worth stating plainly rather than leaving implicit.
 *
 * `markSeen` is a separate method from `hasSeen`, deliberately never called automatically by it --
 * see the route's own call site in app.ts for why a key is only ever marked seen *after* a
 * successful send, never before attempting one: marking it earlier would let a transient mail
 * failure permanently suppress the very retry that was Railway's only mechanism for getting the
 * alert out at all.
 */
export interface RailwayAlertDedupe {
  hasSeen(key: string): boolean;
  markSeen(key: string): void;
}

/**
 * Keyed on the deployment id plus the event type, per requirement 4's own wording: two distinct
 * alertable transitions for the *same* deployment (a CRASHED after an earlier FAILED, say) must
 * still produce two separate emails, so the event type has to be part of the key, not just the
 * deployment id alone. Falls back to `details.id` (present in every documented example alongside
 * `resource.deployment.id`) and then to a fixed placeholder for the one case the documented shape
 * does not cover at all -- a volume/resource alert with no deployment in scope -- so a missing
 * identifier degrades to "dedupe by type alone" rather than throwing.
 */
export function railwayAlertDedupeKey(event: RailwayWebhookEvent): string {
  const deploymentId = event.resource?.deployment?.id ?? event.details?.id ?? 'no-deployment-id';
  return `${deploymentId}:${event.type}`;
}

export function createRailwayAlertDedupe(
  ttlMs: number = RAILWAY_ALERT_DEDUPE_TTL_MS,
  now: () => number = Date.now,
): RailwayAlertDedupe {
  const seenUntil = new Map<string, number>();

  // Swept on every call rather than on a timer: this route's traffic is low enough (crash alerts,
  // not a hot path) that an O(map size) scan per request costs nothing real, and it avoids a
  // `setInterval` that would otherwise need its own lifecycle (started, and explicitly stopped on
  // `onClose`) for a cache this small.
  function sweepExpired(currentTime: number): void {
    for (const [key, expiresAt] of seenUntil) {
      if (expiresAt <= currentTime) seenUntil.delete(key);
    }
  }

  return {
    hasSeen(key) {
      const currentTime = now();
      sweepExpired(currentTime);
      const expiresAt = seenUntil.get(key);
      return expiresAt !== undefined && currentTime < expiresAt;
    },
    markSeen(key) {
      seenUntil.set(key, now() + ttlMs);
    },
  };
}

/**
 * Plain text, one copy of the wording, context fields ahead of anything else -- the identical
 * discipline `feedbackMail.ts`'s own `feedbackText`/`feedbackSubject` follow, for the identical
 * reason: nothing to drift against a second rendering, and the reader never has to hunt for which
 * service and environment this is about.
 */
export function railwayAlertSubject(event: RailwayWebhookEvent): string {
  const serviceName = event.resource?.service?.name ?? 'an unknown service';
  const environmentName = event.resource?.environment?.name ?? 'an unknown environment';
  return `Finaler Draft deploy alert: ${serviceName} (${environmentName})`;
}

export function railwayAlertText(event: RailwayWebhookEvent): string {
  const deploymentId = event.resource?.deployment?.id ?? event.details?.id ?? '(unknown)';
  const lines = [
    `Service: ${event.resource?.service?.name ?? '(unknown)'}`,
    `Environment: ${event.resource?.environment?.name ?? '(unknown)'}`,
    `Event: ${event.type}`,
    `Status: ${event.details?.status ?? '(unknown)'}`,
    `Deployment: ${deploymentId}`,
    `Commit: ${event.details?.commitHash ?? '(unknown)'}`,
    `Commit message: ${event.details?.commitMessage ?? '(none)'}`,
    `Timestamp: ${event.timestamp ?? '(unknown)'}`,
  ];
  return lines.join('\n');
}

/**
 * The webhook route's dependencies (app.ts's `POST /api/webhooks/railway` registration). Absent
 * means the route is not registered at all -- never registered-and-rejecting, mirroring every
 * other optional dependency in `BuildAppOptions` -- which is requirement 2 in
 * progress/deployment-crash-alerts.md stated as plainly as the brief states anything: "An
 * unauthenticated endpoint that emails on request is worse than no endpoint." A missing secret
 * must never be the only thing standing between the open internet and this inbox.
 */
export interface RailwayAlertsPort {
  /**
   * Compared against the `x-finaler-draft-webhook-secret` header via `secretsMatch`, never in
   * plain `===`. Never logged, and never echoed back in a response or an error message -- the
   * route's own rejection log line names the fact of a rejection, nothing about the value that
   * caused it.
   */
  secret: string;
  /**
   * Where the alert email is sent -- `ALERT_MAIL_TO`, deliberately not `FEEDBACK_MAIL_TO`. See
   * `@finaler-draft/server-config`'s own comment on that variable for why the two destinations
   * must be free to diverge.
   */
  mailTo: string;
  mail: MailPort;
}
