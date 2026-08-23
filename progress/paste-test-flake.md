# The paste test flake

Branch `fix/paste-test-flake`. Test-only change.

## Why this needed its own slice

`persistence.spec.ts`'s "pasting content copied from this editor back into the same document
regenerates ids and keeps saving" failed roughly 25-30% of runs, measured across many samples by
both the lead and an implementation agent. It failed a real pull request in CI, blocking unrelated
work, and CI's two retries only mask it -- a genuinely broken paste path would look identical to a
red build everyone has learned to re-run.

The test has been patched for this twice before. Its own comments record the history: a native
Ctrl+C/Ctrl+V round trip was replaced with `navigator.clipboard.write` because the OS pasteboard
updated asynchronously, and a mouse click was replaced with a keypress for similar reasons. Both
reduced the rate. Neither addressed the cause.

## What it actually was, measured rather than guessed

A temporary probe dumped the document and the selection at three points. One failing run:

```
after-arrowright  selection collapsed=true (Caret)  ids: 8d631d3c, 4bdcaf95, 26638474, b57439ab
after-paste       selection collapsed=true          ids: ad84b0d6, b7fe9293, 72c62e58, 14733af5
```

Four blocks before, four after, **every id different**. The paste fired and replaced the entire
document with a copy of itself.

**ProseMirror keeps its own selection in editor state and syncs it from the DOM asynchronously, on
`selectionchange`.** After `ArrowRight` the DOM selection is already a collapsed caret while
ProseMirror's state can still hold the `AllSelection` from the preceding select-all. A paste inside
that window replaces everything. The block count is unchanged and the text is unchanged, so the
assertion reads as "the paste never happened" -- while a save still fires, because
`ScreenplayPasteSanitizer` gives every block a fresh id and that is a real change to persist.

This also explains why the earlier fixes only reduced the rate: they narrowed the timing window
without removing it, and why an obvious-looking fix does not work either -- polling
`window.getSelection().isCollapsed` waits on the very signal that is lying.

## The fix

**Reload between the copy and the paste.** The editor remounts with fresh state and no selection to
inherit, so the stale `AllSelection` cannot exist. The screenplay was already saved earlier in the
test, so the reload restores the same persisted document, and the test asserts that before pasting.

**Dispatch the paste directly** with a real `DataTransfer`, rather than writing to the OS clipboard
and pressing Ctrl+V. The HTML is still what a real copy really produced, and a dispatched `paste`
event still runs ProseMirror's `parseFromClipboard` and `transformPasted`, including
`ScreenplayPasteSanitizer` -- the thing under test. What is removed is the OS pasteboard, which is
not this product's code and was an independent source of asynchrony.

Nothing about the product changed. This slice touches one test file.

## Evidence

17 consecutive clean runs of the persistence suite after the change. At the previously measured
~28% failure rate, a run of 17 has roughly a 0.4% chance of occurring by luck.

That is strong evidence the identified failure mode is gone. It is **not** proof of zero: a residual
5% flake would still produce 17 clean runs about 42% of the time. What can be said precisely is that
the mechanism was captured directly, the fix removes that mechanism rather than widening a window
around it, and the observed rate has dropped from roughly one run in four to none in seventeen.

## Discarded on the way, deliberately

Two earlier attempts were rolled back rather than kept as partial improvements, at the owner's
instruction and correctly: replacing the OS clipboard alone (reduced the rate to ~1 in 22, did not
fix it) and polling `window.getSelection().isCollapsed` before pasting (did not fix it, because that
signal is the one that lies). Keeping either would have added code that did not address the cause
and would have made the real diagnosis harder for whoever came next.

The clipboard removal was ultimately reintroduced, but on evidence rather than on hypothesis, and
for a different reason than it was first tried: not because it was the cause, but because it removes
a second, independent asynchrony from a test that should depend on as little ambient browser state
as possible.

## Known limitations

- The test now depends on a reload, which makes it slower and couples it to persistence working.
  That is acceptable here: it is a persistence-suite test whose whole premise is a real saved
  document, and it already awaited a real `PUT` before this change.
- The sibling "foreign HTML" paste test still uses the OS clipboard and has not shown this failure,
  because it never performs a select-all and so never creates the stale-selection window. It was
  left alone rather than changed speculatively.
