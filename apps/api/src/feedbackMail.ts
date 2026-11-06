import type { MailPort } from '@finaler-draft/auth-server/mail';
import type { FeedbackNotification, FeedbackNotifier } from './feedback.js';

/**
 * The "Send feedback" capture path's best-effort notification email, sent through the *existing*
 * mail port (`packages/auth-server/src/mail.ts`) rather than a second mail path -- the identical
 * reasoning `invitationMail.ts`'s own module comment gives: a system-test process still cannot
 * reach a live provider (`selectMailPort` forces the logging port under `FINALER_SYSTEM_TEST`
 * regardless of credentials), a local run with no `RESEND_API_KEY` still logs the message instead
 * of silently dropping it, and there is exactly one place a provider is ever swapped.
 *
 * Unlike the invitation email, this message's whole purpose is to carry content a human (the
 * owner) reads and acts on -- the writer's own message, the context that was auto-attached, and
 * who sent it. That is deliberate and is not the same thing the "never log the writer's text or
 * email address" rule in `feedback.ts` forbids: that rule is about this process's own structured
 * logs, which are not a one-to-one, owner-only inbox the way this email is. Putting the body in
 * the email is the feature; putting it in a log line grepped by anyone with shell access on the
 * server is a different, much wider audience, which is exactly why `feedback.ts`'s own
 * `notifyBestEffort` never does that.
 */
export function createFeedbackMailNotifier(mail: MailPort, toAddress: string): FeedbackNotifier {
  return {
    async feedbackReceived(notification: FeedbackNotification) {
      await mail.send({
        subject: feedbackSubject(notification),
        text: feedbackText(notification),
        to: toAddress,
      });
    },
  };
}

export function feedbackSubject(notification: FeedbackNotification): string {
  return `Finaler Draft feedback from ${notification.userName}`;
}

/**
 * Plain text, not HTML -- matching `invitationText`'s own choice and for the identical reason:
 * one copy of the wording, nothing to drift against a second rendering. The context fields are
 * listed ahead of the message itself, so the owner never has to scroll past a long message to
 * find out which screen it came from.
 */
export function feedbackText(notification: FeedbackNotification): string {
  const lines = [
    `From: ${notification.userName} <${notification.userEmail}>`,
    `Screen: ${notification.context.route}`,
    notification.context.screenplayId
      ? `Screenplay: ${notification.context.screenplayId}`
      : 'Screenplay: (not in a screenplay)',
    `App version: ${notification.context.appVersion}`,
    `Submitted: ${notification.createdAt.toISOString()}`,
    '',
    notification.body,
  ];
  return lines.join('\n');
}
