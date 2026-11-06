import { describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@finaler-draft/auth-server/mail';
import { createFeedbackMailNotifier, feedbackSubject, feedbackText } from './feedbackMail.js';
import type { FeedbackNotification } from './feedback.js';

const withScreenplay: FeedbackNotification = {
  feedbackId: '6f2b9d7c-1d4e-4a5b-9c8d-3e7f1a2b4c5d',
  userId: 'user-1',
  userEmail: 'writer-one@example.test',
  userName: 'Writer One',
  body: 'The scene heading menu closes before I can pick an option.',
  context: {
    route: '/screenplays/abc/editor',
    screenplayId: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
    appVersion: '1.4.0',
  },
  createdAt: new Date('2026-08-06T12:34:56.000Z'),
};

const withoutScreenplay: FeedbackNotification = {
  ...withScreenplay,
  context: { route: '/projects', appVersion: '1.4.0' },
};

const toAddress = 'owner@example.test';

describe('the feedback notification email', () => {
  it('names the writer in the subject', () => {
    expect(feedbackSubject(withScreenplay)).toBe('Finaler Draft feedback from Writer One');
  });

  it("carries the writer's name and address, the auto-attached context, and the message itself", () => {
    const text = feedbackText(withScreenplay);
    expect(text).toContain('Writer One <writer-one@example.test>');
    expect(text).toContain('Screen: /screenplays/abc/editor');
    expect(text).toContain('Screenplay: ecf1118c-3a2e-4656-84e6-fce75c461710');
    expect(text).toContain('App version: 1.4.0');
    expect(text).toContain('2026-08-06T12:34:56.000Z');
    expect(text).toContain(withScreenplay.body);
  });

  it('says plainly when the writer was not inside a screenplay, rather than omitting the line', () => {
    const text = feedbackText(withoutScreenplay);
    expect(text).toContain('Screenplay: (not in a screenplay)');
    expect(text).not.toContain('ecf1118c-3a2e-4656-84e6-fce75c461710');
  });

  it('sends through the mail port it was given, addressed to the configured destination -- never to the writer', async () => {
    const sent: MailMessage[] = [];
    const mail = { send: vi.fn(async (message: MailMessage) => void sent.push(message)) };
    await createFeedbackMailNotifier(mail, toAddress).feedbackReceived(withScreenplay);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(toAddress);
    expect(sent[0]!.to).not.toBe(withScreenplay.userEmail);
    expect(sent[0]!.subject).toBe(feedbackSubject(withScreenplay));
    expect(sent[0]!.text).toBe(feedbackText(withScreenplay));
    expect(sent[0]!.html).toBeUndefined();
  });

  it('propagates a send failure to its caller rather than swallowing it', async () => {
    // `feedback.ts`'s own `notifyBestEffort` is the layer that decides a failed send must not
    // fail an already-committed submission; this port's job is only to report honestly that the
    // send failed, the same contract `createInvitationMailNotifier` and `createResendMailPort`
    // both already follow.
    const mail = { send: vi.fn(async () => Promise.reject(new Error('Resend is down'))) };
    await expect(
      createFeedbackMailNotifier(mail, toAddress).feedbackReceived(withScreenplay),
    ).rejects.toThrow('Resend is down');
  });
});
