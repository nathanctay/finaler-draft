import type { APIRoute } from 'astro';
import { PRODUCT_NAME } from '../site.config.ts';

// Generated, not a static file under public/: a static SVG would bake in the product's first
// initial as a literal, which is exactly the kind of rename-time search-and-replace this app is
// built to avoid (see site.config.ts). This computes the monogram from PRODUCT_NAME at build
// time, the same way Header.astro does for the on-page brand mark.
export const prerender = true;

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

const monogram = escapeXml(PRODUCT_NAME.trim().charAt(0).toUpperCase());
const label = escapeXml(PRODUCT_NAME);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="${label}">
  <rect width="32" height="32" rx="6" fill="#1e2936" />
  <text x="16" y="23" font-family="Georgia, serif" font-size="18" fill="#f4f7f8" text-anchor="middle">${monogram}</text>
</svg>
`;

export const GET: APIRoute = () =>
  new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
