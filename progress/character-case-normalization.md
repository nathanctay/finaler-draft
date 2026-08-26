# Case-insensitive character grouping, and the --fd-block-indent guard

Branch `feature/character-case-normalization`, merged as PR #17. Two independent fixes, one commit
each.

Backfilled after the fact; see `progress/README-backfill.md`.

## Fix 1 — a character is one character regardless of case

`deriveCharacters` treated case as significant. Verified directly against the built package:

```
VIVAMUS          -> character "VIVAMUS"
Vivamus          -> character "Vivamus"
vivamus (V.O.)   -> character "vivamus", extensions ["V.O."]
```

Three navigator rows, three highlight targets, for one person. This is the same class of defect as
the extension stripping plan.md already specifies — `MARA` and `MARA (V.O.)` are one character — just
along a different axis, and it was never written down because nobody thought of case.

**The rule shipped:** grouping folds the extension-stripped name to uppercase, and extension dedup
compares case-insensitively so `(v.o.)` and `(V.O.)` collapse rather than accumulating.

**The display decision, which is the owner's and is deliberate.** The stored `name` is that canonical
uppercase form, and that is also what the Navigator shows and what SmartType later inserts on accept.
What the writer types is never rewritten. The reasoning, in the owner's framing: screenplay
convention is that cues are uppercase, the Navigator is presentation we control, and forcing the
document to uppercase would take away a choice that is theirs. So the transform lives in the
derivation and never touches the canonical model.

A later correction is worth recording because it could mislead someone reading the commit: the
canonical screenplay stores whatever was typed. It is only the _derived_ vocabulary that
normalises. "The canonical version we store is uppercase" is not true, and building on it — for
instance assuming an exporter can skip case handling — would be a mistake.

`App.tsx` needed no change at all. It renders the derived name, keys selection off `blockIds` and
navigation off `cueBlockIds`, none of which depended on spelling. That the display transform fell out
of the derivation, with no UI edit, is the sign the layering was right.

Verified directly:

```
VIVAMUS | ext: ["V.O."]                 | cues: c1,c2,c3
MARA    | ext: ["V.O.","CONT'D","O.S."] | cues: c4,c5
JOE     | ext: ["subtitled"]            | cues: c6
orphan dialogue attributed to nobody
```

Unconventional extensions keep the spelling they were cued with, since there is no convention to
canonicalise them to. Conventional ones were already normalised by
`CONVENTIONAL_CHARACTER_EXTENSIONS` regardless of input case.

## Fix 2 — a guard test for a convention that had no enforcement

PR #16 made every indented element declare `--fd-block-indent` so a nested page-break widget can
cancel what it inherits. Load-bearing, and unenforced: an element added later that sets
`margin-left` without it silently reintroduces a displaced cue line, page number and seam masks. The
existing browser parity tests loop a hardcoded list of hosts, so they cannot notice a host that did
not exist when they were written.

**Why a test and not a lint rule.** The owner asked for a lint rule and it was worth correcting: the
project has no stylelint, only eslint on JS/TS. A real CSS lint rule means a new toolchain, config
and CI wiring. A unit test that scans `styles.css` enforces the identical invariant with no new
dependency, inside the gate that already runs.

It is a brace-depth scanner over the stylesheet text, not a CSS parser — enough to enforce one
invariant over one file.

**Proven against the scenario it exists for**, not the easy one. Adding a rule for a
`dual_dialogue_left` element with `margin-left` and no declaration fails the test, naming
`dual_dialogue_left` in the message. Dual dialogue is already in the layout model and will have
column offsets, so that is the real future case rather than a synthetic one.

## Why these shipped together

They are unrelated, and rode one branch for convenience. The owner's standing preference, recorded
during this slice: separate fixes get separate commits even when they share a branch and a PR. That
constraint has to be decided before the work is dispatched, because two fixes edited into one file
cannot be split afterwards — the implementing agent was told to keep the file sets disjoint, and
they came out cleanly separable.

## Verification

Disabling the case fold fails the grouping tests. The guard test was mutation-proven as above. Gates
at merge: screenplay 118 equivalent for its state, web 354, system 31, persistence 12x3.

## Known gaps at merge

- Unconventional extensions keep their authored casing, so a character can carry `subtitled`
  lowercase beside an uppercase name. Invisible today because the Navigator renders only the name;
  it would become visible if extensions ever surface in the UI.
- `.sign-out-button` is orphaned CSS, found during the audit for this slice and deliberately left
  rather than fixed silently. Still open.
- The Characters row shows the cue count rather than the larger speech-block count. A product
  decision, still open.
