import type { Pool } from 'pg';
import { z } from 'zod';
import { FEEDBACK_BODY_MAX_LENGTH } from '@finaler-draft/config';

/**
 * The "Send feedback" capture path: a signed-in writer types a message in the app (reached from
 * the Help menu -- a deliberate follow-up slice, not built here), it is stored in the database,
 * and a best-effort email notifies the owner. This file is the whole of it: the input schema, the
 * store, and the one security property the owner called out as the most important constraint in
 * the brief.
 *
 * **Authoritative insert, best-effort email -- in that order.** The row is the record of record.
 * `submitFeedback` inserts it, and only once that has committed does it attempt the notification
 * email, swallowing (and logging only the row id and the fact of a failure, never the writer's
 * text or address) anything that goes wrong sending it. The alternative order -- email first, or
 * failing the request when the email fails -- would lose feedback every time the mail provider has
 * an outage, and would report failure to the writer for a submission that in fact fully succeeded.
 * This is the identical discipline `sharing.ts`'s `invite` already established for the invitation
 * email, applied here for the same reason.
 *
 * **No read path. Not one.** Every other store in this codebase pairs its writes with reads an
 * authorized caller can reach (`ProjectStore.getScreenplay`, `RevisionStore.listRevisions`, ...).
 * This one deliberately does not: there is no `listFeedback`, no `getFeedback`, and no route in
 * `app.ts` that selects from this table -- not an unused one, not one waiting for an admin role
 * that doesn't exist yet. The owner reads submissions directly through Drizzle Studio
 * (`pnpm --filter @finaler-draft/database db:studio`). With no reader anywhere in this process,
 * there is no leak surface to audit in the first place, which is what makes storing a table of a
 * writer's own words and context genuinely safe rather than merely unexamined. See
 * `feedbackNoReadPath.test.ts` for how that absence is asserted against the app's real, enumerated
 * route tree -- not against one hardcoded URL, which would pass just as well if the route tree
 * were empty.
 *
 * **Never any manuscript text.** `submitFeedbackInput` is `.strict()` at every level: the payload
 * is the writer's own message plus exactly the three context fields below, and an unknown field
 * (document content, most pointedly) is a 400, not a silently-ignored extra. That is the actual
 * enforcement of the owner's "of course no manuscript text can be copied" -- a schema a future
 * caller cannot smuggle a fourth field past, rather than a convention someone has to remember.
 */

/**
 * `FEEDBACK_BODY_MAX_LENGTH` itself now lives in `@finaler-draft/config` (the "Help menu" slice,
 * `progress/menus-slice-3.md`), the identical move `RESOURCE_TITLE_MAX_LENGTH` made for
 * `projects.ts` -- the feedback dialog (`apps/web`'s `feedbackDialog.tsx`) needs the same bound to
 * show the limit and refuse a doomed submission before a round trip, and a second `4000` literal
 * maintained there independently is exactly the drift risk that constant's own comment names.
 * 4000 characters is generous for a feedback message (this is not a document editor), and a bound
 * against the identical denial-of-service shape the rate limit alone doesn't close: a single
 * request with an enormous body still costs one multi-megabyte insert and, once a notifier is
 * configured, one multi-megabyte email, regardless of how many requests per hour the caller is
 * allowed to make.
 */

/** Bounded for the same reason `FEEDBACK_BODY_MAX_LENGTH` is: a route/screen name has no
 * legitimate reason to approach this length, and an unbounded string here would be exactly as
 * much of a denial-of-service vector as an unbounded `body`. */
const FEEDBACK_ROUTE_MAX_LENGTH = 500;

/** Bounded for the identical reason -- an app version string is a short, fixed-shape value. */
const FEEDBACK_APP_VERSION_MAX_LENGTH = 100;

/**
 * The context a writer does not have to type: the screen/route they were on, the screenplay id if
 * they were in one (absent otherwise -- the Help menu is reachable from screens with no
 * screenplay in view, e.g. the projects dashboard), and the app version. `.strict()` is what keeps
 * this bundle closed -- seen alongside `submitFeedbackInput`'s own `.strict()`, a caller has
 * exactly these three fields and the message body to work with, nothing else.
 */
export const feedbackContextInput = z
  .object({
    route: z.string().trim().min(1).max(FEEDBACK_ROUTE_MAX_LENGTH),
    screenplayId: z.string().uuid().optional(),
    appVersion: z.string().trim().min(1).max(FEEDBACK_APP_VERSION_MAX_LENGTH),
  })
  .strict();
export type FeedbackContext = z.infer<typeof feedbackContextInput>;

export const submitFeedbackInput = z
  .object({
    body: z.string().trim().min(1).max(FEEDBACK_BODY_MAX_LENGTH),
    context: feedbackContextInput,
  })
  .strict();
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackInput>;

/**
 * 12 submissions per hour, per writer -- a deliberately generous *opening* value, not the
 * long-term one. The owner chose 12 over a stricter 5 specifically so that exercising this
 * endpoint by hand during testing (roughly one submission every five minutes) doesn't get
 * throttled mid-test, and has said explicitly that this should come down to 5 once the endpoint
 * has seen real use. A single named export is what makes that a one-line change when the time
 * comes, rather than a value copied into a route registration and a test and risking the two
 * drifting apart.
 */
export const FEEDBACK_SUBMISSIONS_PER_HOUR = 12;

/** The window `FEEDBACK_SUBMISSIONS_PER_HOUR` is measured over, in milliseconds -- `app.ts`'s
 * `@fastify/rate-limit` route configuration takes a plain number, not a unit string. */
export const FEEDBACK_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Everything the best-effort notification email needs, resolved once the row has committed. */
export interface FeedbackNotification {
  readonly feedbackId: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly userName: string;
  readonly body: string;
  readonly context: FeedbackContext;
  readonly createdAt: Date;
}

/**
 * The seam `feedbackMail.ts` implements, mirroring `sharing.ts`'s own `SharingNotifier` --
 * one method, called only after the row it describes has already committed, and never awaited in
 * a way that lets its failure fail the request that triggered it (see `createPostgresFeedbackStore`
 * below for exactly where that boundary is drawn).
 */
export interface FeedbackNotifier {
  feedbackReceived(notification: FeedbackNotification): Promise<void>;
}

export interface SubmittedFeedback {
  readonly id: string;
  readonly createdAt: string;
}

export interface FeedbackStore {
  submitFeedback(userId: string, input: SubmitFeedbackInput): Promise<SubmittedFeedback>;
}

/**
 * `notifier` is optional: a development environment without `FEEDBACK_MAIL_TO` configured (see
 * `@finaler-draft/server-config`'s own comment on that variable) still writes every feedback row --
 * the capture mechanism does not depend on where, or whether, the email goes, which is exactly the
 * authoritative-insert/best-effort-email split the owner asked for taken to its logical end.
 * `server.ts` is the one place that decides whether a notifier exists at all; this store never
 * second-guesses that decision, it only honors `undefined` as "no email was ever meant to be
 * attempted here" rather than treating it as a failure.
 */
export function createPostgresFeedbackStore(
  pool: Pool,
  notifier?: FeedbackNotifier,
): FeedbackStore {
  return {
    async submitFeedback(userId, input) {
      // The one write that matters. Committed by the time this `await` returns -- a single
      // statement needs no explicit transaction -- and everything after this line is the
      // best-effort half: whatever happens next, this row already exists.
      const inserted = await pool.query<{ id: string; created_at: Date }>(
        'insert into feedback (user_id, body, context) values ($1, $2, $3::jsonb) returning id, created_at',
        [userId, input.body, JSON.stringify(input.context)],
      );
      const row = inserted.rows[0]!;
      const result: SubmittedFeedback = { id: row.id, createdAt: row.created_at.toISOString() };

      if (notifier) {
        // Never allowed to throw past this point, and never allowed to delay the caller past a
        // single extra round trip for the writer's own name/email -- both looked up fresh here
        // rather than threaded through from the route (the route only has `userId`), and both
        // failures (the lookup, the send) are folded into the identical best-effort boundary:
        // a reader who cannot be named still gets `'A Finaler Draft writer'` rather than losing
        // the notification outright.
        await notifyBestEffort(pool, notifier, userId, row.id, input, row.created_at);
      }

      return result;
    },
  };
}

async function notifyBestEffort(
  pool: Pool,
  notifier: FeedbackNotifier,
  userId: string,
  feedbackId: string,
  input: SubmitFeedbackInput,
  createdAt: Date,
): Promise<void> {
  try {
    const userRow = (
      await pool.query<{ name: string; email: string }>(
        'select name, email from "user" where id = $1',
        [userId],
      )
    ).rows[0] as { name?: string; email?: string } | undefined;
    await notifier.feedbackReceived({
      feedbackId,
      userId,
      userEmail: userRow?.email ?? '',
      userName: userRow?.name ?? 'A Finaler Draft writer',
      body: input.body,
      context: input.context,
      createdAt,
    });
  } catch (error) {
    // The row id and the fact of a failure, never the writer's text or address: feedback bodies
    // may carry PII, and `error` itself is never logged whole for the same reason `sharing.ts`'s
    // own notifier-failure handler logs only a description, not the object -- here the
    // description is narrowed one step further, to the error's name alone, since this path's
    // inputs (a writer's own message) are more sensitive by construction than an invitation's.
    console.error(
      JSON.stringify({
        event: 'feedback_email_failed',
        feedbackId,
        err: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  }
}
