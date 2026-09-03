# Integration-test teardown race

## The failure

CI failed `pnpm --filter @finaler-draft/api test:integration` with **40 tests passed and a
non-zero exit**. Vitest reported one unhandled error:

```
error: terminating connection due to administrator command
code: '57P01'
This error originated in "src/entitlements.integration.test.ts"
```

Nothing had failed. The run was killed by an error raised after the assertions were done.

## The mechanism

Each integration file created a throwaway database, ran migrations into it, and tore it down with:

```ts
await pool?.end();
await admin.query(
  `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
  [databaseName],
);
await admin.query(`drop database if exists ...`);
```

`pg_terminate_backend` was there for a real reason: `drop database` fails while any session is
still connected. But it fired **unconditionally**, including in the ordinary case where
`pool.end()` had already done its job.

`await pool.end()` resolves once the pool considers itself closed, which is not the same instant
as every client having finished its own socket shutdown. The serialized client in the CI error
shows exactly that state — `_ending: true, _ended: false`, `_poolUseCount: 52`. A client
mid-graceful-close was killed by the test's own terminate, and `pg` surfaced the resulting `57P01`
asynchronously with nothing awaiting it. Node treats an unhandled `error` event on a pool as a
process-level exception, and Vitest fails the run.

So the test suite was killing itself, and only when the timing was unlucky enough.

## Why it was never seen locally

It is environment-dependent, not branch-specific. Before changing anything:

- `test:integration` on `main`: three runs, zero occurrences.
- `test:integration` on the branch whose CI run failed: three runs, zero occurrences.

It reproduces on CI's slower, more contended runner. The branch CI happened to fail on had
nothing to do with it — the race arrived with the `entitlements.integration.test.ts` file itself.

All three integration files (`persistence`, `stripeSubscriptions`, `entitlements`) carried the
same copied teardown, so all three carried the same latent race. All three are fixed, not only
the one that happened to lose the dice roll.

## The fix

`apps/api/src/integrationTestDatabase.ts` — one shared helper replacing three near-identical
copies of the create/migrate/terminate/drop sequence.

Two changes, and they address different halves of the problem:

1. **Attempt the plain `drop database` first.** Only if Postgres reports `55006`
   (`object_in_use`) does it fall back to `pg_terminate_backend` and retry. The ordinary path —
   where `pool.end()` really did finish — now never terminates anything, so it cannot race with a
   client that is closing itself.
2. **Attach an `error` listener to every pool.** A `pg` pool with no listener turns an idle-client
   error into an unhandled process exception. With one, a client killed during shutdown is a
   non-event.

The first removes the cause; the second removes the failure mode. Keeping both matters: the
fallback still terminates in the genuinely exceptional case, and without the listener that path
would reintroduce the same unhandled error under a different set of circumstances.

## Proof

A green run proves nothing here — `main` is green too. The fix was verified against a **forced**
race: a script that creates a database, checks out and releases a real pooled client, then runs
the old unconditional `pg_terminate_backend` against it while the pool shuts down.

| pool error listener | result                                                      |
| ------------------- | ----------------------------------------------------------- |
| absent              | `UNCAUGHT: 57P01`, unhandledErrors=1 — the exact CI failure |
| present             | unhandledErrors=0                                           |

That reproduces the reported error on demand and shows the listener is load-bearing rather than
defensive padding. The probe was removed after use.

## Gates

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck` — all exit 0.
- `pnpm test` — 562 web unit tests, all packages green.
- `pnpm --filter @finaler-draft/api test:integration` — **five consecutive runs**, 40/40 passing,
  exit 0, zero `57P01` occurrences.
- `pnpm test:system:persistence` — 18/18.

## Left open

The five clean local runs are evidence of no regression, not evidence the race is gone — it never
reproduced locally in the first place. The forced-race table above is the actual proof. If
`57P01` ever appears in a CI integration run again, the first thing to check is whether a new
integration file has been added that does its own teardown instead of using
`integrationTestDatabase.ts`.
