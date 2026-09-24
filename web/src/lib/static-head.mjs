import { absolute, jsonLd, sharingMeta, structuredData } from './seo.mjs';
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function staticHead({ title, description, path, id = 'home', index = true }) {
  const meta = sharingMeta({ title, description, path, id });
  if (!index) meta.find(({ attrs }) => attrs.name === 'robots').attrs.content = 'noindex, follow';
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(absolute(path))}">`,
    ...meta.map(({ attrs }) => `<meta ${Object.entries(attrs).map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(' ')}>`),
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    '<link rel="icon" href="/brand/icon-96.png" type="image/png" sizes="96x96">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">',
    '<link rel="manifest" href="/site.webmanifest">',
    '<link rel="sitemap" href="/sitemap-index.xml">',
    ...(index ? [`<script type="application/ld+json">${jsonLd(structuredData({ title, description, path }))}</script>`] : []),
  ].join('\n');
}
