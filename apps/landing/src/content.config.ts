import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Legal documents (terms of service, refund policy, privacy policy) live here as plain Markdown
 * files with frontmatter, one file per document. `src/content/legal/` is deliberately empty right
 * now (see the `.gitkeep` there): an LLM must not draft binding legal text, and this content is
 * the owner's to supply, not this build's. `src/pages/legal/[slug].astro` builds one static page
 * per entry that exists here, and nothing else on the site links to a page that doesn't --
 * `src/lib/legalNav.ts` is the single place that decides which links are shown. Adding real copy
 * later is exactly one Markdown file dropped into this directory; nothing else changes.
 */
const legal = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/legal' }),
  schema: z.object({
    title: z.string(),
    updatedOn: z.coerce.date(),
  }),
});

export const collections = { legal };
