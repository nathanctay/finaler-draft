/**
 * The mail port `auth.ts` sends through, and the two implementations that satisfy it. plan.md's
 * launch-readiness section names Resend specifically, but the point of this file is that nothing
 * outside it knows that: `createAuth` depends on `MailPort`, never on Resend's request shape, so
 * the provider is swappable and -- more importantly for what's actually tested here -- every test
 * of the reset/verification flows can inject a fake `MailPort` and never touch the network.
 */

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

export interface ResendMailPortOptions {
  readonly apiKey: string;
  readonly from: string;
  /**
   * Test-only seam. Defaults to the global `fetch`; the production path never overrides it.
   * Resend's send call is one authenticated POST with a JSON body -- exactly what `fetch` does
   * without a client SDK (see the checkpoint discussion in progress/transactional-email.md for
   * the full case against adding one) -- so this single function is the entire network surface
   * a test needs to fake.
   */
  readonly fetchImplementation?: typeof fetch;
}

const RESEND_SEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * The production implementation. Throws on any failure -- a non-OK response or a rejected
 * `fetch` -- rather than swallowing it: requirement 6 in progress/transactional-email.md is that
 * a send failure fails loudly, and a port that resolves regardless of whether Resend actually
 * accepted the message would make that impossible to tell from here. (Whether that failure
 * reaches an HTTP caller as an error is a separate question, decided in auth.ts -- see the
 * `runInBackgroundOrAwait` comment there for why Better Auth's own password-reset route can't
 * surface it that way even when this throws correctly.)
 */
export function createResendMailPort(options: ResendMailPortOptions): MailPort {
  const doFetch = options.fetchImplementation ?? fetch;
  return {
    async send(message) {
      const response = await doFetch(RESEND_SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html !== undefined ? { html: message.html } : {}),
        }),
      });
      if (!response.ok) {
        // The response body is Resend's own error detail (never the API key, which only ever
        // appears in the outgoing Authorization header) -- safe to include in the thrown message
        // for whatever logs it.
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Resend rejected the send request (status ${response.status}): ${detail || 'no response body'}`,
        );
      }
    },
  };
}

export interface LoggingMailPortOptions {
  /**
   * Called with every message this port "sends," in addition to the console log below. Used
   * only by server.ts's system-test wiring, so a Playwright spec (which has no way to inject a
   * fake `MailPort` the way a unit test does) can complete the real verification/reset HTTP
   * flow against a real, just-generated token instead of writing straight to the database and
   * leaving `requireEmailVerification` itself unexercised. Never set outside `FINALER_SYSTEM_TEST`.
   */
  readonly onSend?: ((message: MailMessage) => void) | undefined;
}

/**
 * Stands in for a real provider whenever one isn't configured -- development without
 * `RESEND_API_KEY`, or a production process that somehow reaches this point despite
 * `requirePersistenceEnvironment` refusing to start without one (see server-config). It never
 * throws and never silently drops the message either: it logs the full content, structured and
 * tagged with an unambiguous event name, specifically so grepping a log cannot mistake this for a
 * real delivery. This is what requirement 5 in progress/transactional-email.md asks for -- the
 * reset/verification flow stays testable offline, but nothing here can be read as "the email was
 * sent."
 */
export function createLoggingMailPort(options: LoggingMailPortOptions = {}): MailPort {
  return {
    async send(message) {
      console.log(
        JSON.stringify({
          event: 'mail_delivery_skipped_no_provider_configured',
          to: message.to,
          subject: message.subject,
          text: message.text,
        }),
      );
      options.onSend?.(message);
    },
  };
}

export interface SelectMailPortOptions {
  /** Mirrors `server.ts`'s `FINALER_SYSTEM_TEST` flag. */
  readonly systemTestMode: boolean;
  readonly resendApiKey: string | undefined;
  readonly mailFromAddress: string | undefined;
  /**
   * Forwarded to `createLoggingMailPort` untouched whenever the logging port is selected --
   * server.ts's system-test mailbox hook. Left `undefined` outside system-test mode, same as
   * before this function existed.
   */
  readonly onSend?: ((message: MailMessage) => void) | undefined;
}

/**
 * Chooses between the two `MailPort` implementations. This is the entire safety property the
 * comment in `server.ts` used to assert without enforcing: in system-test mode the logging port
 * is selected regardless of whether Resend credentials are present, so a real `RESEND_API_KEY`
 * sitting in a developer's environment or `.env` -- which legitimately belongs there for normal
 * local runs -- can never reach a live send during a system-test process. Credentials are
 * ignored, not rejected: refusing to start would break the owner's own local runs, since his
 * `.env` carries a real key.
 *
 * The suppression is deliberately not silent. When system-test mode discards otherwise-usable
 * credentials, this logs one structured line naming the variables that were ignored -- never
 * their values -- so the safety property is observable instead of only asserted in a comment.
 */
export function selectMailPort(options: SelectMailPortOptions): MailPort {
  const { resendApiKey, mailFromAddress, systemTestMode, onSend } = options;

  if (systemTestMode) {
    if (resendApiKey && mailFromAddress) {
      console.log(
        JSON.stringify({
          event: 'mail_credentials_suppressed_system_test_mode',
          variables: ['RESEND_API_KEY', 'MAIL_FROM_ADDRESS'],
        }),
      );
    }
    return createLoggingMailPort({ onSend });
  }

  if (resendApiKey && mailFromAddress) {
    return createResendMailPort({ apiKey: resendApiKey, from: mailFromAddress });
  }

  return createLoggingMailPort({ onSend });
}
