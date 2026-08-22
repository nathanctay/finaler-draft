import type { DocumentSettings } from '@finaler-draft/screenplay';

/**
 * Duplicated from `apps/web/src/pagination.ts`'s identically-named function and its
 * `ROMAN_NUMERAL_DIGITS` table, not imported -- that module is the ProseMirror editor's own
 * pagination-decoration layer, which this pure, server-eligible package must not depend on (the
 * same boundary `packages/fdx`/`packages/docx` already hold against `apps/web`). Unlike
 * `graphemeLength` (shared via `packages/layout` because two implementations of character-cell
 * counting could silently disagree), this is a small, self-contained numeral formatter with
 * nothing normative to drift -- plan.md's "Page numbering" states the two styles directly
 * ("Arabic numerals by default... Roman numerals are available as a document setting"), and both
 * copies implement that same fixed rule independently.
 */
const ROMAN_NUMERAL_DIGITS: ReadonlyArray<readonly [number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function toRomanNumeral(value: number): string {
  let remaining = value;
  let numeral = '';
  for (const [digitValue, digitNumeral] of ROMAN_NUMERAL_DIGITS) {
    while (remaining >= digitValue) {
      numeral += digitNumeral;
      remaining -= digitValue;
    }
  }
  return numeral;
}

/**
 * Formats a 1-based page number per `documentSettings.pageNumberStyle`. `packages/layout`'s
 * `Page.pageNumber` is a position, never a printed label (see that package's `model.ts`), so
 * choosing the numeral system is entirely a renderer's job -- independently true here and in
 * `apps/web/src/pagination.ts`.
 */
export function formatPageNumber(
  pageNumber: number,
  style: DocumentSettings['pageNumberStyle'],
): string {
  return style === 'roman' ? toRomanNumeral(pageNumber) : String(pageNumber);
}
