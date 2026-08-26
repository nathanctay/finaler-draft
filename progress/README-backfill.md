# Why five progress logs are dated later than the work they describe

`progress/` holds one log per slice, written as the slice is built. Five consecutive slices shipped
without one:

| slice                                      | PR       | log                               |
| ------------------------------------------ | -------- | --------------------------------- |
| page-break widget indent                   | #16      | `page-break-widget-indent.md`     |
| character case + `--fd-block-indent` guard | #17      | `character-case-normalization.md` |
| bundle budget (split, then enforcement)    | #18, #19 | `bundle-budget.md`                |
| `(MORE)`/`CONT'D` empty-content rule       | #20      | `empty-dialogue-more-contd.md`    |
| SmartType                                  | #21      | `smarttype.md`                    |

They were backfilled on 2026-08-26 from the work itself while it was still recoverable — the
measurements, the rejected approaches and the reasoning behind each decision, not a reconstruction
from the diffs.

## How it happened

plan.md's protocol says the implementing agent maintains the progress log for its scope. Every brief
for those five slices specified acceptance criteria, standards, mutation testing and a gate list, and
none of them asked for a progress log. The agents followed their briefs. The omission was the lead's,
repeated five times without noticing, and caught only when someone went looking for the logs.

One agent did flag it, at the end of the SmartType ghost stage: it noted that no log existed for the
scope, that plan.md's protocol makes it the implementer's job, and that its brief had not asked. That
flag was not acted on at the time.

## What was nearly lost

These slices contain the least recoverable reasoning of any so far, because in several cases the
valuable part is what did **not** work:

- Two attempts at the entry chunk that saved 50 bytes and 10 bytes, and why neither could work
  alone — two independent eager import paths into the same module.
- A caret-affinity spike whose entire value is a negative result: forcing the DOM selection
  downstream does not survive ProseMirror's re-sync, and flipping the widget's `side` only inverts
  the bug. Recorded in `page-seam-caret-affinity` in the lead's memory and still deferred.
- Why suppressing `CONT'D` on the immediately-following element was argued against, when it was the
  owner's own first proposal.
- Why the `--fd-block-indent` convention is enforced by a unit test rather than the lint rule that
  was asked for.

None of that is in a commit message, and none of it is in the code.

## The rule going forward

Every implementation brief must ask for the progress log by name, and it is part of the deliverable
rather than a courtesy. A slice is not finished when its gates pass; it is finished when the next
person can find out why it looks the way it does.
