export interface LegalDocSummary {
  /** The content collection entry id -- the filename without extension, e.g. "terms". */
  id: string;
  title: string;
}

export interface LegalNavItem {
  title: string;
  href: string;
}

/**
 * Derives footer links from whatever legal documents actually exist. Deliberately independent of
 * `astro:content` (a plain array in, a plain array out): this is the one place that decides
 * whether a legal page is ever linked, so "do not link to a page that says nothing" (the brief's
 * words) is enforced in a single, directly-unit-testable function rather than re-derived in every
 * template that might want a legal link. An empty collection -- the default, since no legal copy
 * has been supplied yet -- produces an empty list.
 */
export function legalNavItems(entries: LegalDocSummary[]): LegalNavItem[] {
  return [...entries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({ title: entry.title, href: `/legal/${entry.id}/` }));
}
