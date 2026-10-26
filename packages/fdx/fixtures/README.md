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

## `multi-page-script.fdx`

The owner's own reproduction of a real import defect: a 47 KB, 118-paragraph screenplay exported
from this product, which then failed to re-import with `unmapped_content` ("a title page whose
paragraph sequence does not match the structure this product recognizes"). Every body paragraph
`Type` in this file is mappable (`Action`, `Dialogue`, `Character`, `Scene Heading`,
`Parenthetical`, `Shot`) -- the body was never the problem. The defect was entirely in the title
page: its `authors` field is `['Nathan', '', '']`, two trailing blank author lines that
`decodeTitlePageContent`'s fixed-gap grammar mis-swallowed into the following field's own gap.
See `packages/fdx/src/import.ts`'s `decodeTitlePageContent` doc comment and `progress/fdx-import.md`'s
Task 1 (this pass) for the full diagnosis and fix.

This file is also the first confirmation that `TITLE_PAGE_LINES_BEFORE_DRAFT_DATE` and
`TITLE_PAGE_LINES_BEFORE_CONTACT` (`packages/fdx/src/index.ts`) are the correct gaps for a
genuine, non-synthetic Final Draft title page: both fields were populated only in this file, not
in `final-draft-13-reference.fdx`, whose own test script left them blank.

Contains no personal data beyond the writer's first name ("Nathan") and placeholder contact lines
("line 1" through "line 15") the owner typed directly into the title page while reproducing this
defect.
