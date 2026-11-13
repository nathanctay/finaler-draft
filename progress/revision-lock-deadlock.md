# A lock-ordering deadlock between restore and revision writes

`restoreRevisionAsCurrent` and `insertRevisionIfChanged` could deadlock against each other, killing
one with SQLSTATE `40P01`. Found while verifying an unrelated branch, confirmed from Postgres's own
deadlock report, reproduced deterministically, and fixed by making both paths acquire their locks in
the same order.

**This fix is a large measured improvement, not a complete one.** At least one further cycle remains
and is documented as open at the end of this file. That is stated up front because the headline
number here is easy to misread as "deadlocks are gone".

## The cycle

Both functions write `document_revisions`, and both take the same advisory lock
(`REVISION_LOCK_NAMESPACE = -1`), so they _are_ correctly serialized against each other. The defect
was never the lock keys -- it was the **order** in which each acquired two different locks:

```
restore:   SELECT ... FROM screenplays ... FOR UPDATE   then  advisory lock
revisions: advisory lock                                then  INSERT document_revisions
```

That insert is not lock-free. `document_revisions.screenplay_id` references `screenplays.id`, so
Postgres takes a `KEY SHARE` lock on the parent row to verify the foreign key, and `FOR UPDATE`
conflicts with `KEY SHARE`. So each path held one of the pair and waited for the other:

1. restore takes `FOR UPDATE` on `screenplays[X]`
2. a revision writer takes the advisory lock for X
3. restore waits for that advisory lock
4. the revision writer inserts, needs `KEY SHARE` on `screenplays[X]`, waits for restore

Postgres's own report, which is what identified it:

```
Process 158 waits for ExclusiveLock on advisory lock [17467,2328864066,4294967295,2]; blocked by 157.
Process 157 waits for ShareLock on transaction 1962; blocked by process 158.
Process 158: select pg_advisory_xact_lock(hashtext($1), $2)
Process 157: insert into document_revisions (...)
```

`4294967295` is `-1` as an unsigned 32-bit integer, which is how the lock was identified as the
revision namespace rather than `updateLog.ts`'s epoch lock.

### A wrong diagnosis worth recording

The first reading of that report was that `restore.ts` locked on `-1` while `revisions.ts` locked on
`epoch`, so the two never excluded each other. **That was wrong**, and it was asserted confidently
several times before being checked: both files define `REVISION_LOCK_NAMESPACE = -1` and take the
identical lock. The `epoch`-keyed lock is `apps/collab/src/updateLog.ts`'s
`acquireDocumentEpochLock`, a deliberately separate lock for the update log, and `revisions.ts`'s own
comment explains why `-1` can never collide with it.

The lesson is narrow and practical: a deadlock report names the lock _one_ process is waiting for. It
does not say the two processes wanted different locks. Reading "different namespaces" into it meant
inventing a mechanism instead of reading the two call sites.

## The fix

`restore.ts` now takes the advisory lock as the first statement after `begin`, before the
`FOR UPDATE` read. Both paths therefore acquire advisory-then-row, and no cycle exists.

The cost is that a restore for a screenplay that does not exist takes the lock briefly before
discovering that, released on the rollback immediately after. Not worth reordering the checks to
avoid.

Rejected alternatives:

- **Drop the `FOR UPDATE`.** It is load-bearing: it is what stops a concurrent writer clobbering the
  live screenplay during the epoch cutover (`database.ts`'s own comment on that interaction).
- **Give restore its own advisory namespace.** That would remove the deadlock by removing the mutual
  exclusion the two paths actually need -- `restore` reads the current revision head to set
  `previous_head_revision_id`, so it must serialize against revision writers, not avoid them.
- **Retry on `40P01`.** Treats the symptom, leaves the cycle, and makes a durability path's behaviour
  depend on how many times it is willing to lose a race.

## Verification

### Deterministic, against the real function

`restore.integration.test.ts` now drives the exact interleaving with two clients:

1. a revision writer takes the advisory lock and holds it;
2. the real `restoreRevisionAsCurrent` starts and blocks on that lock -- confirmed by polling
   `pg_locks` for an **ungranted** advisory entry, so the test cannot race ahead of the restore;
3. the writer inserts, which needs `KEY SHARE` on the live screenplay row.

With the corrected order, the waiting restore holds nothing for step 3 to collide with, the insert
succeeds, and the restore completes once the writer commits. 4 consecutive runs, 4 passes.

The first version of this test hand-rolled restore's locks in raw SQL instead of calling the real
function, which would have tested the imitation rather than the product. It was replaced.

### The mutation

Moving the lock back after the `FOR UPDATE` read -- the exact previous ordering -- fails the test
with `deadlock detected`, the same SQLSTATE as production.

### A vacuous test caught by its own diagnostic

The reproduction passed on the first attempt _before_ the fix existed, which should have been
impossible. A diagnostic printing both query outcomes showed why: the test inserted a
`canonical_hash` built as `${hash}-racer`, and the column is `varchar(64)`, so the insert failed with
`22001 value too long` **before Postgres ever reached the foreign-key check**. No lock was taken and
no cycle formed. With a real 64-character sha256 it reproduced immediately.

That is the fifth assertion on this project that passed for the wrong reason, and the second caught
only by instrumenting it. The general rule it keeps arguing for: when a test passes before the fix it
is testing, treat that as a bug in the test, not as luck.

### Measured under load

The deadlock was originally found with the full `pnpm test` run _with_ `TEST_DATABASE_URL` set --
an invocation CI never uses, which runs integration files in parallel across packages against one
database. A/B on this branch, 4 runs each, identical conditions:

| Lock order                         | Runs failing with `deadlock detected` |
| ---------------------------------- | ------------------------------------- |
| Old (`FOR UPDATE` then advisory)   | **4 of 4**                            |
| Fixed (advisory then `FOR UPDATE`) | **1 of 13**                           |

The fixed figure started as 1 of 4 and was revised down after nine further runs, all clean.
Recorded as a range rather than a point estimate: the residual is rare enough that four runs
could not distinguish 25% from 8%, and quoting the first sample would have overstated it. The
old-order figure needs no such caution -- it failed every single run.

## Open: at least one more cycle

The surviving failure is a different interleaving and is **not** explained by this fix. Postgres
reports:

```
Process 409 waits for ExclusiveLock on advisory lock [...,4294967295,2]; blocked by process 406.
Process 406 waits for ShareLock on transaction 4541; blocked by process 409.
Process 409: select pg_advisory_xact_lock(hashtext($1), $2)
Process 406: insert into document_revisions (... 9 params ...) returning id, ...
```

Process 406 is `insertRevisionIfChanged` (nine placeholders and a `returning` clause). 406 holds the
advisory lock and waits on 409's transaction; 409 wants the advisory lock. What was ruled out:

- **Not the one fixed here.** Both lock-takers now acquire the advisory lock as their first statement
  after `begin`, so neither should hold a conflicting lock while waiting for it.
- **Not a unique-index collision.** `document_revisions` has exactly one unique index, partial on
  `restore_request_id where not null`, and a structural-change insert leaves that column null.
- **Not the test holding the row.** `collaboration.integration.test.ts` has no open transaction
  against `screenplays`; its one `update screenplays` is an autocommit `pool.query`.
- **Not the update-log lock.** `updateLog.ts`'s three transactions touch only
  `document_yjs_updates` and `document_yjs_checkpoints` and take the _epoch_-keyed advisory lock.
  The report's waiter asks for key2 `4294967295` (`-1`), the revision namespace, so an epoch-lock
  cycle would have shown a different key.
- **Not a third lock-taker.** `pg_advisory_xact_lock` appears in exactly three files: `restore.ts`
  and `revisions.ts` (both `-1`) and `updateLog.ts` (epoch). Only the first two can be the waiter,
  and both now take that lock as their first statement after `begin`.

### Why it resisted capture

The obvious next step -- rerun with `log_statement=all` and correlate both backends' full
transaction histories by pid -- was attempted and **did not reproduce**: nine consecutive full runs
passed with that logging on, against one failure in four without it. The logging's own overhead moves
the race window, which is the textbook heisenbug shape, and is why the empirical route was abandoned
rather than retried indefinitely.

What would settle it without depending on catching the race: a deterministic reproduction built the
way this slice's own test was -- two clients, a forced interleaving, `pg_locks` polled for the
ungranted request. That needs to know which statement the waiting transaction ran _before_ asking for
the advisory lock, which the deadlock report does not include. The cheapest way to learn it is to
make each call site's lock acquisition textually distinguishable (a comment literal in the SQL), so
the report itself names which function is waiting.

The failing test is `collaboration.integration.test.ts`'s "an offline writer who reconnects after a
restore...", so a restore is involved. Identifying it needs each backend's **full transaction
history**, not just its current statement -- `log_statement=all` plus correlating by backend pid.
That is a distinct piece of work and was not attempted here rather than guessed at.

Two things worth knowing about its blast radius: the invocation that reproduces it is not one CI
runs (CI runs `pnpm test:integration` with the variable and `pnpm test` without it, and both pass
here), and a deadlock aborts one transaction rather than corrupting anything. But it is reachable in
production under concurrent load, on a durability path, so it should not be left indefinitely.

## A second, smaller change: the lock sites now identify themselves

All three `pg_advisory_xact_lock` call sites in this repo issued **byte-identical SQL**, and
Postgres's deadlock report prints each process's current statement. So a report could say "a process
is waiting for the revision lock" without saying _which function_ was waiting -- which is precisely
what blocked the residual cycle above from being pinned down.

Each site now carries a marker in the statement text:

```
select pg_advisory_xact_lock(hashtext($1), $2) /* restore.acquireRevisionLock */
select pg_advisory_xact_lock(hashtext($1), $2) /* revisions.acquireRevisionLock */
select pg_advisory_xact_lock(hashtext($1), $2) /* updateLog.acquireDocumentEpochLock */
```

Verified against a real server's log rather than assumed: all three appear distinctly in
`log_statement=all` output. No behavioural change -- a SQL comment is inert -- and the next deadlock
report names its own call sites, which converts the open question above from "catch a rare race under
instrumentation that suppresses it" into "read the report".

## Gate results

| Gate                                           | Result                                |
| ---------------------------------------------- | ------------------------------------- |
| `pnpm lint`                                    | exit 0                                |
| `pnpm typecheck`                               | exit 0                                |
| `pnpm test` (CI-style, no `TEST_DATABASE_URL`) | exit 0                                |
| `pnpm test:integration`                        | exit 0 -- 11/11, 106/106, 32/32       |
| `pnpm build`                                   | exit 0                                |
| `pnpm format:check`                            | exit 0, bare and last                 |
| the new reproduction, repeated                 | 4/4 pass                              |
| A/B under load                                 | 4/4 fail without the fix, 1/4 with it |

Isolated Postgres on port 55469, deliberately not 5432 (the owner's own development database).
Removed afterwards.
