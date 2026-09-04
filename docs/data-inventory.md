# Data inventory

What this application actually collects, stores, and sends to third parties, read off the code
rather than assumed. Written to be handed to a privacy-policy generator, a template, or a lawyer.

**This is a factual record, not legal advice and not a privacy policy.** It says what the system
does. What must be disclosed, and how, is a legal question. The point of the document is that
generic boilerplate is routinely wrong about the specifics below — particularly the IP address and
user-agent storage, which is easy to forget you do.

Accurate as of 2026-09-03, against `packages/database/src/schema.ts` and `apps/api/src`.

## Stored in the application's own PostgreSQL database

Ten tables. Personal data lives in the first four.

| Table                   | Personal data it holds                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `user`                  | Name, email address, email-verified flag                                                      |
| `session`               | Session token, **IP address**, **user agent**, expiry                                         |
| `account`               | Password, hashed by Better Auth — never stored in plaintext                                   |
| `verification`          | Email-verification and password-reset tokens                                                  |
| `projects`              | Project titles                                                                                |
| `projectMembers`        | Which users belong to which project, and their role                                           |
| `screenplays`           | **Screenplay content** — the user's own creative work, as canonical JSON                      |
| `subscriptions`         | Stripe customer id, subscription id, price id, status, current period end, cancellation state |
| `stripeProcessedEvents` | Stripe event ids, for webhook deduplication                                                   |
| `editableSlots`         | Which screenplay a restricted account may edit, and when that last changed                    |

Two things worth calling out because boilerplate usually misses them:

- **`session` stores IP address and user agent.** These are personal data in most regimes. They
  come from Better Auth's own session model.
- **`screenplays` holds user-generated creative content.** For a screenwriting product this is the
  most sensitive thing in the system — unpublished creative work — and deserves explicit treatment
  rather than being folded into "user content".

## Sent to third parties

Only two services receive data, both from the server:

**Stripe** (`https://api.stripe.com`) — payments and subscriptions.

- Hosted Checkout and the Customer Portal mean **no card details ever reach this application's
  servers or its frontend**. Stripe collects them directly.
- The application sends: the user's id as `metadata.userId`, and the selected price id.
- The application stores from Stripe only: customer id, subscription id, price id, status, period
  end, cancellation state. No payment instrument data.
- Stripe collects a billing address at checkout for tax calculation. That address lives with
  Stripe, not here.

**Resend** (`https://api.resend.com`) — transactional email only.

- Receives the recipient's email address and the message body for verification and password-reset
  mail. No marketing email exists.

**Railway** — hosting and the managed PostgreSQL instance. A processor in the usual sense; it
holds everything above by virtue of running the database and the application.

No analytics service, no advertising, no tracking pixels, and no third-party embeds are present.
Nothing is sent to an AI service.

## Not collected, not stored

Stated explicitly because a generated policy will often claim otherwise:

- **No card or payment-instrument data**, at any point, on any server of ours.
- **No object storage.** Exports (PDF, FDX, DOCX) are generated and downloaded without being
  retained server-side; there is no bucket. `plan.md` anticipates one for future asynchronous
  exports, but it does not exist today.
- **No analytics or telemetry.** The owner has expressed interest in usage analytics later, with a
  standing constraint that screenplay content must never reach such a service.
- **No cookies beyond the session cookie** set by Better Auth.

## Logging

Fastify's logger runs at `info` in production and `warn` otherwise, and **redacts**
`req.headers.authorization`, `req.headers.cookie`, and `res.headers.set-cookie`
(`apps/api/src/app.ts:447-450`).

Request bodies are not logged, so screenplay content does not reach the logs. Note that ordinary
request logging still records IP addresses and paths, which is worth stating accurately rather
than claiming logs are anonymous.

The Stripe webhook route deliberately logs only an error's _name_ on a signature failure, never
the error object, because that object carries the raw request payload and signature header.

## Retention and deletion

- Projects and screenplays are **soft-deleted** (`deleted_at`), and restorable from the Deleted
  page. They are not immediately purged.
- Sessions expire on their own schedule.
- `stripeProcessedEvents` grows without bound; it is a deduplication ledger with no pruning today.
- **There is no account-deletion flow.** A user cannot currently delete their account or erase
  their data through the product. If the privacy policy promises deletion on request, that is a
  manual process today — and worth building before promising it in writing.

## Gaps worth closing before publishing a policy

1. **No account deletion.** The most likely gap between what a generated policy will promise and
   what the product can do.
2. **No data export of personal data** (as distinct from screenplay export, which exists and works
   on every tier).
3. **`stripeProcessedEvents` never prunes** — minor, but it is unbounded retention of a Stripe
   identifier.
4. **The contact form, once built, adds a new category**: unauthenticated submissions containing an
   email address and free-text message, stored and emailed. It does not exist yet and is not
   covered above.
