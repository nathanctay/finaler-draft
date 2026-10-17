import type { MailPort } from '@finaler-draft/auth-server/mail';
import type { InvitationNotification, SharingNotifier } from './sharing.js';

/**
 * The invitation notification email, sent through the *existing* mail port
 * (`packages/auth-server/src/mail.ts`) rather than a second mail path -- so a system-test process
 * still cannot reach a live provider (`selectMailPort` forces the logging port under
 * `FINALER_SYSTEM_TEST` regardless of credentials), a local run with no `RESEND_API_KEY` still logs
 * the message instead of silently dropping it, and there is one place a provider is ever swapped.
 *
 * **This email is a notification, not a mechanism.** The owner offered two ways for an invitee to
 * accept -- an emailed link, or the invitation appearing in their dashboard with Accept and Decline
 * -- and the dashboard is the authoritative one: it needs no token that could leak or expire, it is
 * revocable at any time by the inviter, and it does not depend on mail being delivered at all.
 * So this message deliberately carries **no token and no accept link** -- only a link to the
 * dashboard the invitee signs in to as themselves. Nothing in it grants access, which is why
 * failing to send it cannot invalidate an invitation that has already committed (see `invite`'s own
 * comment on why a send failure is logged rather than surfaced as a request failure).
 *
 * It names the project (and, for a screenplay-scoped invitation, the screenplay) and the inviter's
 * display name. All three are things the recipient is being given access to or by, and the message
 * goes only to the address the inviter typed; it carries no other member's address and no
 * information about who else holds access.
 */
export function createInvitationMailNotifier(mail: MailPort, appOrigin: string): SharingNotifier {
  return {
    async invitationCreated(notification: InvitationNotification) {
      await mail.send({
        subject: invitationSubject(notification),
        text: invitationText(notification, appOrigin),
        to: notification.toEmail,
      });
    },
  };
}

function describeTarget(notification: InvitationNotification): string {
  return notification.screenplayTitle === null
    ? `the project “${notification.projectTitle}”`
    : `the screenplay “${notification.screenplayTitle}” in “${notification.projectTitle}”`;
}

export function invitationSubject(notification: InvitationNotification): string {
  return notification.screenplayTitle === null
    ? `${notification.inviterName} shared a project with you on Finaler Draft`
    : `${notification.inviterName} shared a screenplay with you on Finaler Draft`;
}

export function invitationText(notification: InvitationNotification, appOrigin: string): string {
  // `editor`/`reviewer` are spelled out in plain language rather than printed as the raw role
  // name: "reviewer" on its own does not tell a writer they will be able to read and comment on
  // the work but not change it, and that is the single most important thing this message says.
  const capability =
    notification.role === 'editor'
      ? 'You can read and edit it.'
      : 'You can read and export it, but not make changes.';
  const dashboardUrl = new URL('/projects', appOrigin).toString();
  return (
    `${notification.inviterName} invited you to ${describeTarget(notification)} on Finaler Draft. ` +
    `${capability}\n\n` +
    `Nothing has been shared with you yet -- open your Finaler Draft projects and you will find ` +
    `this invitation waiting there with Accept and Decline:\n\n${dashboardUrl}\n\n` +
    `If you were not expecting this, decline it and nothing changes. This email contains no ` +
    `access of its own, so there is nothing in it to act on but the link above.`
  );
}
