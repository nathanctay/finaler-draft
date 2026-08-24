import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoggingMailPort, createResendMailPort } from './mail.js';

describe('createResendMailPort', () => {
  it('POSTs the message to Resend with the API key and from address, never touching the real network', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue({ ok: true } as Response);
    const port = createResendMailPort({
      apiKey: 'test-key',
      from: 'Finaler Draft <noreply@example.test>',
      fetchImplementation,
    });

    await port.send({ to: 'writer@example.test', subject: 'Reset your password', text: 'Link: x' });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      from: 'Finaler Draft <noreply@example.test>',
      to: 'writer@example.test',
      subject: 'Reset your password',
      text: 'Link: x',
    });
  });

  it('includes html only when the message carries it', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue({ ok: true } as Response);
    const port = createResendMailPort({
      apiKey: 'test-key',
      from: 'noreply@example.test',
      fetchImplementation,
    });

    await port.send({
      to: 'writer@example.test',
      subject: 'Subject',
      text: 'Text',
      html: '<p>Hi</p>',
    });

    const [, init] = fetchImplementation.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toMatchObject({ html: '<p>Hi</p>' });
  });

  it('throws with the response status and body when Resend rejects the request, rather than resolving as if it had succeeded', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"message":"invalid from address"}',
    } as Response);
    const port = createResendMailPort({
      apiKey: 'test-key',
      from: 'noreply@example.test',
      fetchImplementation,
    });

    await expect(
      port.send({ to: 'writer@example.test', subject: 'Subject', text: 'Text' }),
    ).rejects.toThrow(/422.*invalid from address/s);
  });

  it('propagates a network-level rejection rather than swallowing it', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(new Error('DNS failure'));
    const port = createResendMailPort({
      apiKey: 'test-key',
      from: 'noreply@example.test',
      fetchImplementation,
    });

    await expect(
      port.send({ to: 'writer@example.test', subject: 'Subject', text: 'Text' }),
    ).rejects.toThrow('DNS failure');
  });

  it('defaults to the global fetch when no implementation is supplied', async () => {
    const globalFetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', globalFetch);
    try {
      const port = createResendMailPort({ apiKey: 'test-key', from: 'noreply@example.test' });
      await port.send({ to: 'writer@example.test', subject: 'Subject', text: 'Text' });
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('createLoggingMailPort', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('resolves without throwing, and logs a structured line naming the address, subject, and text -- never a message claiming delivery', async () => {
    const port = createLoggingMailPort();

    await expect(
      port.send({ to: 'writer@example.test', subject: 'Reset your password', text: 'Link: x' }),
    ).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({
      event: 'mail_delivery_skipped_no_provider_configured',
      to: 'writer@example.test',
      subject: 'Reset your password',
      text: 'Link: x',
    });
  });

  it('never touches fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await createLoggingMailPort().send({
        to: 'writer@example.test',
        subject: 'Subject',
        text: 'Text',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('invokes the optional onSend hook with the message, for the system-test mailbox seam', async () => {
    const onSend = vi.fn();
    const port = createLoggingMailPort({ onSend });
    const message = { to: 'writer@example.test', subject: 'Subject', text: 'Text' };

    await port.send(message);

    expect(onSend).toHaveBeenCalledWith(message);
  });

  it('works with no onSend hook at all', async () => {
    await expect(
      createLoggingMailPort({}).send({ to: 'writer@example.test', subject: 'S', text: 'T' }),
    ).resolves.toBeUndefined();
  });
});
