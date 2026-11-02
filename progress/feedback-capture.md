# Send feedback: capture path

The backend half of `Help > Send feedback`. A signed-in writer's message is stored in the database
and emailed to the owner. There is no UI in this slice: the Help menu item that calls this endpoint
is a deliberate follow-up, so that the capture path can be finished and reviewed without a menu
depending on it.

## The owner's decisions, and what each one forced

All five were settled before implementation, and none were re-litigated:

**Both a row and an email.** Not either/or. The row is the durable record; the email is how he hears
about it.

**The insert is authoritative; the email is best-effort.** `submitFeedback` inserts, and only once
that has committed does it attempt the notification, swallowing any send failure and logging only
the row id and the fact of failure. The alternative order loses feedback whenever the mail provider
is down _and_ shows the writer an error for something that actually succeeded. The accepted cost is
stated plainly: a silently failed email means a row sits unseen until someone looks at the table.

**No read path at all** -- not an unused one, not a role-gated one waiting for the admin role that
does not exist. See the next section; this is the security property the table's PII depends on.

**12 submissions per hour, per writer.** The owner chose 12 over a stricter 5 so that someone
mid-testing can submit roughly every five minutes, and said explicitly he wants it lowered to 5 once
the endpoint is battle-tested. `FEEDBACK_SUBMISSIONS_PER_HOUR` is therefore a single named exported
constant whose comment records that 12 is an opening value, so lowering it stays a one-line edit
rather than an archaeology exercise.

**Authenticated-only.** The entry point is the in-app Help menu, so there is no anonymous path to
support, and the abuse surface is bounded to real accounts.

## The security property, and how it is asserted

Because no role may read this table, there is no read endpoint anywhere. With no reader there is no
leak surface, which is what makes storing a table of PII that nobody can read genuinely safe rather
than merely unexamined. The owner reads it through Drizzle Studio
(`pnpm --filter @finaler-draft/database db:studio`).

`feedbackNoReadPath.test.ts` asserts that against the app's **real, enumerated route tree**
(`app.printRoutes()`), and is careful to be non-vacuous on both axes -- which matters, because the
obvious version of this test is one of the most convincingly wrong tests it is possible to write:

- It first proves the enumeration can see a real `GET` at all, by asserting that `/api/projects` and
  `/api/invitations` -- routes this slice never touched -- do appear with `GET` in that tree. Without
  this, an empty or malformed route table would satisfy everything below.
- It then asserts `feedbackLines.length > 0`, so the feedback route _is_ present. A test that merely
  requested `/api/feedback` and expected a 404 would also pass if the route had never been
  registered, for an entirely different and equally wrong reason.
- Only then does it assert that no line naming feedback carries `GET` or `HEAD`.

Adding a reader later therefore has to fail a test first, deliberately.

Feedback bodies are PII and are never logged. The failure path logs the row id and the fact of a
send failure, never the writer's text or address -- and the test fake's own over-query error message
prints the SQL and the _count_ of bound values rather than the values, for the same reason.

## Never any manuscript text

The owner's requirement was absolute: _"of course no manuscript text can be copied."_

The enforcement is that `submitFeedbackInput` and its nested `feedbackContextInput` are **`.strict()`
at every level**, so an unknown field is rejected at the write boundary rather than silently
accepted into a free-form blob. That is a stronger guarantee than "we only read the fields we want":
a future caller cannot smuggle document content through this route even by accident, because the
payload shape itself refuses it.

The context bundle carries exactly the route or screen the writer was on, the screenplay id if there
was one, and the app version. Each is length-bounded (`FEEDBACK_ROUTE_MAX_LENGTH`,
`FEEDBACK_APP_VERSION_MAX_LENGTH`) for the same reason the body is: unbounded text is a
denial-of-service vector even behind a per-user rate limit, since one request still costs one
insert and one email sized by the payload.

`FEEDBACK_BODY_MAX_LENGTH` is 4000 characters -- long enough for a detailed bug report, far short of
anything that could carry a scene.

## Rate limiting, and one lifecycle detail worth recording

This is the **first route in the app to override the global rate limit** (300/60s per IP,
`DEFAULT_API_RATE_LIMIT_MAX`). It is keyed **per user**, not per IP: several writers can share an
office IP, and the global IP limit already covers IP-level abuse, so keying this one per IP would
punish colleagues for each other's submissions while leaving one account free to fill the table from
several addresses.

`keyGenerator: (request) => request.actorId!` therefore needs `request.actorId`, which the route's
own `preValidation` hook sets. Fastify's lifecycle runs onRequest -> preParsing -> preValidation ->
preHandler, so the limiter is registered with `hook: 'preHandler'` rather than the inherited default
`'onRequest'` -- at `onRequest` time `actorId` is still undefined and every submission would share a
single `undefined` bucket. This is the kind of thing that works in a unit test and silently
collapses in production, so it is called out here rather than left to the reader.

## Account deletion: cascade, deliberately

`feedback.userId` references `user.id` with `onDelete: 'cascade'`, unlike
`documentRevisions.authoredBy` and `membershipInvitations.invitedByUserId`, which both keep their row
alive with authorship merely un-attributed once the author is gone.

The distinction is whether the row has a _second_ subject. A revision belongs to a project's shared
history; an invitation belongs to the person invited. Both still need to exist after the author's
account is deleted. A feedback row has no second subject: it is a message from and about exactly one
account, read by nobody but the owner. Account deletion is a request that a person's data stop
existing, and keeping their message text attributed to a user id that no longer resolves to anyone
would serve no reader this table has -- it would only be PII outliving the request meant to remove
it.

Verified behaviourally rather than by reading the DDL: inserting a user and a feedback row, deleting
the user, and confirming the feedback row count goes 1 -> 0.

## Where the email goes

Through the existing `MailPort` (`packages/auth-server/src/mail.ts`), never Resend's request shape
directly, exactly as `apps/api/src/invitationMail.ts` already does -- so every test injects a fake
and none touch the network. `selectMailPort` in `server.ts` already forces the logging port outside
production, which is a second, independent guarantee of the same thing.

The destination address is configuration, never hardcoded, and follows how `server-config` handles
other required-in-production settings so a missing value is obvious at startup rather than at the
first submission. A notifier that is simply absent is honoured as "no email was ever meant to be
sent" rather than treated as an error -- the capture mechanism does not depend on where, or whether,
the email goes, which is the authoritative-insert/best-effort-email split taken to its logical end.

## Gate results

The implementing agent was killed mid-gates by a session limit and wrote no document; everything
below is the lead's own run, after moving the work onto current `main` (`0a39773`) and fixing the one
real defect it left behind.

| Gate                             | Result                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | exit 0                                                                                                                  |
| `pnpm lint`                      | **failed first** -- see below; exit 0 after the fix                                                                     |
| `pnpm typecheck`                 | exit 0                                                                                                                  |
| `pnpm test`                      | exit 0 -- `apps/api` 344 passed, 106 skipped (19 files passed, 8 skipped; the skips are the DB-gated integration files) |
| `pnpm test:integration`          | exit 0 -- `apps/api` 106/106 across 8 files, `packages/database` 11/11, `apps/collab` 32/32                             |
| `pnpm test:coverage`             | exit 0, every per-file threshold met                                                                                    |
| `pnpm build`                     | exit 0                                                                                                                  |
| `pnpm format:check`              | exit 0, run bare and last                                                                                               |

`pnpm lint` failed on two trailing unused parameters in `feedback.test.ts`'s pool fake. Worth
recording because the near-miss is instructive: this repo _does_ use `_`-prefixed unused parameters
elsewhere (`init(_config, instance)` in `paginationExtension.ts`, `handleKeyDown(_view, event)` in
`seamCaret.ts`), and lint passes on those -- because ESLint's default `args: 'after-used'` only
forgives an unused parameter that a used one follows. Two _trailing_ unused parameters are an error.
The signature had to stay, since one test reads `pool.query.mock.calls[0]` as `[sql, values]`, so the
fix names both parameters into the fake's over-query error message instead of deleting them.

### Postgres

Isolated container on port 55458, deliberately not 5432, which is the owner's own development
database:

```
docker run -d --name fb-test-pg -e POSTGRES_PASSWORD=postgres -p 55458:5432 postgres:16
```

Removed afterwards. The migration was additionally applied to a fresh database of its own
(`mig_check`) to confirm it reaches 12 applied migrations from empty, independently of whatever state
a test run leaves behind.

## Known limitations / things not done

- **No UI.** The Help menu item is the next slice. Until it exists this endpoint has no caller in
  the product, which is deliberate -- the brief separated them so the capture path could be reviewed
  on its own.
- **No read surface of any kind, by design.** Reading feedback means Drizzle Studio until an admin
  role exists. That role is explicitly deferred and nothing here anticipates it beyond the test that
  makes adding a reader a deliberate act.
- **A silently failed email is invisible** until someone looks at the table. This follows directly
  from the owner's chosen ordering and is the accepted cost of not losing feedback during a provider
  outage; there is no dead-letter queue or retry.
- **12/hour is an opening value**, to be lowered to 5 once the endpoint has seen real use.
