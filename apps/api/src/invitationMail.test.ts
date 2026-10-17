import { describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@finaler-draft/auth-server/mail';
import {
  createInvitationMailNotifier,
  invitationSubject,
  invitationText,
} from './invitationMail.js';
import type { InvitationNotification } from './sharing.js';

const projectInvitation: InvitationNotification = {
  toEmail: 'invitee@example.test',
  toName: 'Invitee',
  inviterName: 'The Inviter',
  projectTitle: 'Night Shoot',
  screenplayTitle: null,
  role: 'editor',
};

const screenplayInvitation: InvitationNotification = {
  ...projectInvitation,
  screenplayTitle: 'Act One',
  role: 'reviewer',
};

const appOrigin = 'https://app.example.test';

describe('the invitation notification email', () => {
  it('names the project for a project-scoped invitation and the screenplay for a screenplay-scoped one', () => {
    expect(invitationSubject(projectInvitation)).toContain('shared a project with you');
    expect(invitationSubject(screenplayInvitation)).toContain('shared a screenplay with you');
    expect(invitationText(projectInvitation, appOrigin)).toContain('the project “Night Shoot”');
    expect(invitationText(screenplayInvitation, appOrigin)).toContain(
      'the screenplay “Act One” in “Night Shoot”',
    );
  });

  it('explains what the role actually permits, in words rather than by naming it', () => {
    // "reviewer" on its own does not tell a writer they will be able to read the work but not
    // change it, and that is the single most important thing this message has to say.
    expect(invitationText(projectInvitation, appOrigin)).toContain('read and edit it');
    expect(invitationText(screenplayInvitation, appOrigin)).toContain('not make changes');
  });

  it('carries no token and no accept link -- only a link to the recipient’s own dashboard', () => {
    // The whole security argument for choosing the dashboard as the authoritative accept mechanism:
    // there is nothing in this email to leak, expire, or replay. If a token ever appeared here, the
    // invitation would stop being revocable in the way the owner asked for.
    const text = invitationText(screenplayInvitation, appOrigin);
    const urls = text.match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toEqual(['https://app.example.test/projects']);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/accept\/|invitations\//);
    expect(text).toContain('contains no access of its own');
  });

  it('tells the recipient nothing has been shared with them yet, and that declining is safe', () => {
    const text = invitationText(projectInvitation, appOrigin);
    expect(text).toContain('Nothing has been shared with you yet');
    expect(text).toContain('decline it and nothing changes');
  });

  it('names the inviter but no other collaborator, and no other address', () => {
    const text = invitationText(projectInvitation, appOrigin);
    expect(text).toContain('The Inviter');
    // The recipient's own address is the `to:` header's business, not the body's, and nobody
    // else's address belongs in a message about one person's access.
    expect(text).not.toContain('invitee@example.test');
    expect(text).not.toContain('@');
  });

  it('resolves the dashboard link against whatever origin this deployment serves the app from', () => {
    expect(invitationText(projectInvitation, 'http://localhost:5173')).toContain(
      'http://localhost:5173/projects',
    );
  });

  it('sends through the mail port it was given, addressed to the invitee', async () => {
    const sent: MailMessage[] = [];
    const mail = { send: vi.fn(async (message: MailMessage) => void sent.push(message)) };
    await createInvitationMailNotifier(mail, appOrigin).invitationCreated(screenplayInvitation);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('invitee@example.test');
    expect(sent[0]!.subject).toBe(invitationSubject(screenplayInvitation));
    expect(sent[0]!.text).toBe(invitationText(screenplayInvitation, appOrigin));
    // Text only. An HTML body is not offered, so there is no second copy of this wording to drift.
    expect(sent[0]!.html).toBeUndefined();
  });

  it('propagates a send failure to its caller rather than swallowing it', async () => {
    // `sharing.ts` is the layer that decides a failed notification must not fail an already
    // committed invitation; this port's job is only to report honestly that the send failed, the
    // same contract `createResendMailPort` has.
    const mail = { send: vi.fn(async () => Promise.reject(new Error('Resend is down'))) };
    await expect(
      createInvitationMailNotifier(mail, appOrigin).invitationCreated(projectInvitation),
    ).rejects.toThrow('Resend is down');
  });
});
