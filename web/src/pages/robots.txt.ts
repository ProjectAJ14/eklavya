import { absolute } from '../lib/seo.mjs';
export function GET() {
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${absolute('/sitemap-index.xml')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
