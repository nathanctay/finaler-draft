# (MORE) and CONT'D require real content on both sides

Branch `fix/empty-dialogue-more-contd`, merged as PR #20.

Backfilled after the fact; see `progress/README-backfill.md`.

## What the writer saw

A dialogue block continued across a page break. The writer put the caret at the start of the
continued text on page 2 and pressed Enter, leaving an empty dialogue block behind. Page 2 then
showed a `CHARACTER (CONT'D)` heading followed by blank space — a heading announcing a continuation
of nothing.

## What it was, and what it was not

**This was not a bug in the existing code, and the distinction matters for anyone reading the
paginator.** A speech is a character cue plus its contiguous parentheticals and dialogue. An empty
dialogue block is still a member of that speech. The paginator did exactly what it was specified to
do. The case was simply never specified.

That framing was established by measuring the model rather than guessing, and it also explained two
further observations the writer reported as separate oddities:

```
one dialogue block, splits          -> (MORE) + CONT'D
split into 2 dialogue blocks        -> (MORE) + CONT'D
empty dialogue inserted between     -> (MORE) + CONT'D
action inserted between             -> none
```

Splitting a paragraph keeps it one speech, so the pair correctly stays. Changing a block to action
breaks the speech, so it correctly goes. And the writer's "if I go more than 2 down it doesn't work"
was the same rule seen from another angle — what matters is whether the interrupting block lands
before or after the break:

| interrupting action at new block # | lands on page | markers     |
| ---------------------------------- | ------------- | ----------- |
| 0, 1, 2                            | 2             | gone        |
| 3, 4                               | 3             | gone        |
| 5                                  | 3             | **returns** |

Once the interruption moves far enough down, the speech spanning the break is intact again and the
heading correctly comes back.

## What was deliberately NOT changed

The owner initially proposed suppressing `CONT'D` whenever the immediately following element is
empty. That was argued against and dropped, for a reason worth keeping: if page 2 begins with an
empty block and _then_ real dialogue, the character genuinely is still speaking. Suppressing the
heading there means a reader turns the page into unattributed dialogue — precisely what the
convention exists to prevent. The blank line is the empty block's fault, not the heading's.

A third option was raised and deferred: choose the split point so the continuation begins with real
content, leaving empty blocks at the foot of the outgoing page where a blank line before `(MORE)`
reads as nothing more than the page ending. That keeps attribution correct _and_ removes the
whitespace. It was deferred because `findDialogueSplitIndex` is the most delicate function in the
paginator — the two-line minimum, orphan avoidance and the `(MORE)` line reservation all interact
there — and because the element menu will make empty blocks hard to create in the first place. Worth
revisiting only if the whitespace still bothers anyone after that lands.

## The rule shipped

Both sides of the split must carry real spoken content. The character cue's own lines do not count as
spoken content on the outgoing side, which is what makes a cue followed only by an empty dialogue
block at the foot of a page suppress its `(MORE)` too.

**Emptiness is measured after trimming.** Nothing in `screenplayTextSchema` rejects a block holding
only spaces, and plan.md's "a line cannot begin with a space" is an editor behaviour that has not
shipped, so whitespace-only text reaches the engine today and a writer cannot tell it apart from an
empty block.

**Geometry is untouched.** The empty block still occupies its line; only the generated heading is
suppressed. A test asserts the affected page equals the ordinary case minus exactly the marker row.
A line that renders but is not counted is the model/DOM drift fixed in PR #16 and PR #19, and this
deliberately does not reintroduce it.

## A trade-off left in place, documented rather than fixed

`maxContentRoom` still reserves a line for the `(MORE)` unconditionally. Making the reservation
content-aware is circular: the room decides where the split falls, and the split decides whether
either side is empty. The consequence is that a page whose markers are suppressed ends one line short
of capacity. Deliberate, and stated in the code.

## Verification

Disabling the rule (`hasSpokenContent` forced true) fails five tests: the reported case, the
symmetric foot-of-page case, whitespace-only, the second split of a multi-split monologue, and the
control proving an ordinary split still emits both markers.

One of the three new gates sits on a branch unreachable through the public API at current constants.
It is kept for consistency and was reported as untested rather than claimed as covered.

## Scope note

Verified that this fix does _not_ change the case where an empty block sits after the break with real
dialogue following it — the pair is still emitted, correctly. Whether that matches what the writer
originally saw could not be reconstructed in a fixture, and that was stated at handover rather than
assumed.
