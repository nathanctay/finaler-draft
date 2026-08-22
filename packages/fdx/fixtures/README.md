# Final Draft reference files

Ground truth for this package's FDX output, authored in **Final Draft 13** by the project owner and
saved from the application itself. Both files cover as many element types as the application will
produce in one script.

These exist because the first version of this exporter was built from third-party sources (an older
sample file, a reference gist, and two open-source exporters) and produced a document Final Draft
rejected outright:

> This file was created in an older Final Draft format. Please open it in FD13 first, save the
> file, and then upload that to Vault.

A format whose entire purpose is that other tools read what we write cannot be verified against
second-hand descriptions of it. Anything this package emits is checked against these files, and any
divergence must be a deliberate, recorded decision rather than an assumption.

They contain no personal data: the script body is placeholder text, and the writer, contact and
header fields are empty or default.

- `final-draft-13-reference.fdx` -- a saved script.
- `final-draft-13-reference.fdxt` -- the same content saved as a template, kept so the difference
  between the two document types is visible rather than guessed at.

The reference contains element types this product has no canonical equivalent for (`Outline 1-3`,
`Sequence`, `Beat`, `Summary`, `New Act`, `End of Act`, `Cast List`, `Note`, `Page #`). Export
ignores them by definition, since nothing in our model produces them. What to do with them on
**import** is an open question for that slice, not this one.
