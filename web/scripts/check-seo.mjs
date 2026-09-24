/** Validate what crawlers receive, rather than merely testing template helpers. */
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load } from 'cheerio';
import sharp from 'sharp';
import { site, absolute } from '../src/lib/seo.mjs';
import { staticHead } from '../src/lib/static-head.mjs';

const dist = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const files = await readdir(dist, { recursive: true });
const pages = new Map();
for (const file of files.filter((file) => file.endsWith('.html'))) {
  pages.set(file, load(await readFile(path.join(dist, file), 'utf8')));
}
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const one = ($, selector, file) => {
  check($(selector).length === 1, `${file}: expected one ${selector}, found ${$(selector).length}`);
  return $(selector).first();
};
const meta = ($, key, file) => one($, `meta[${key.includes(':') ? 'property' : 'name'}="${key}"]`, file).attr('content');
const getName = ($, key, file) => one($, `meta[name="${key}"]`, file).attr('content');
const exists = async (file) => { try { return (await stat(file)).isFile(); } catch { return false; } };
async function resolveLocal(url) {
  const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
  for (const file of [relative || 'index.html', `${relative.replace(/\/$/, '')}/index.html`]) {
    const resolved = path.resolve(dist, file);
    if (resolved.startsWith(`${dist}${path.sep}`) && await exists(resolved)) return path.relative(dist, resolved);
  }
}
const indexed = new Set(), titles = new Set(), descriptions = new Set(), images = new Set();
for (const [file, $] of pages) {
  const utility = file === '404.html' || file === 'eklavya-runtime.html';
  const pathname = file === 'index.html' ? '/' : `/${file.replace(/index\.html$/, '')}`;
  const base = absolute(pathname);
  check($('html').attr('lang') === 'en', `${file}: missing English language`);
  const robots = getName($, 'robots', file);
  if (utility) check(robots?.includes('noindex'), `${file}: utility page must be noindex`);
  else {
    check(robots?.includes('index') && !robots.includes('noindex'), `${file}: page is not indexable`);
    one($, 'h1', file);
    const title = one($, 'title', file).text();
    const description = meta($, 'description', file);
    check(title.includes('Eklavya'), `${file}: title lacks product name`);
    check(title.length <= 85, `${file}: overly long title`);
    check(description?.length >= 60 && description.length <= 180, `${file}: description missing or outside editorial length budget`);
    check(!titles.has(title), `${file}: duplicate title`); titles.add(title);
    check(!descriptions.has(description), `${file}: duplicate description`); descriptions.add(description);
    const canonical = one($, 'link[rel="canonical"]', file).attr('href');
    check(canonical === base, `${file}: canonical ${canonical} does not match ${base}`);
    indexed.add(canonical);
    for (const [key, value] of Object.entries({ 'og:title': title, 'og:description': description, 'og:url': canonical, 'og:site_name': site.name, 'og:type': 'website', 'og:locale': 'en_US' })) {
      check(meta($, key, file) === value, `${file}: inconsistent ${key}`);
    }
    check(getName($, 'twitter:card', file) === 'summary_large_image', `${file}: missing large preview card`);
    check(getName($, 'twitter:title', file) === title, `${file}: inconsistent Twitter title`);
    check(getName($, 'twitter:description', file) === description, `${file}: inconsistent Twitter description`);
    const image = meta($, 'og:image', file);
    check(image?.startsWith(`${site.url}/social/`), `${file}: image must use absolute production URL`);
    check(!images.has(image), `${file}: expected a page-specific preview image`); images.add(image);
    check(getName($, 'twitter:image', file) === image, `${file}: Twitter and OG images differ`);
    check(meta($, 'og:image:secure_url', file) === image, `${file}: secure image URL differs`);
    check(meta($, 'og:image:type', file) === 'image/png', `${file}: image MIME type mismatch`);
    check(meta($, 'og:image:width', file) === '1200' && meta($, 'og:image:height', file) === '630', `${file}: incorrect image dimensions`);
    check(Boolean(meta($, 'og:image:alt', file)) && Boolean(getName($, 'twitter:image:alt', file)), `${file}: missing image description`);
    try {
      const imageFile = await resolveLocal(new URL(image));
      assert(imageFile, 'image URL has no built file');
      const buffer = await readFile(path.join(dist, imageFile));
      const dimensions = await sharp(buffer).metadata();
      check(dimensions.width === 1200 && dimensions.height === 630 && dimensions.format === 'png', `${file}: invalid preview file`);
      check(buffer.length < 1_000_000, `${file}: preview exceeds 1 MB budget`);
    } catch (error) { failures.push(`${file}: invalid image: ${error.message}`); }
    try {
      const data = JSON.parse(one($, 'script[type="application/ld+json"]', file).text());
      const graph = data['@graph'];
      check(data['@context'] === 'https://schema.org', `${file}: invalid schema context`);
      const page = graph.find((node) => node['@id'] === `${base}#page`);
      check(page?.name === title && page?.description === description && page?.url === base, `${file}: structured page disagrees with visible metadata`);
      if (pathname.startsWith('/docs/')) {
        const article = graph.find((node) => node['@type'] === 'TechArticle');
        check(page?.['@type'] === 'WebPage' && article?.mainEntityOfPage?.['@id'] === page?.['@id'], `${file}: documentation needs a TechArticle linked to its WebPage`);
        const crumbs = graph.find((node) => node['@type'] === 'BreadcrumbList')?.itemListElement;
        check(crumbs?.at(-1)?.item === canonical, `${file}: breadcrumbs do not end on current page`);
        for (const crumb of crumbs || []) check(Boolean(await resolveLocal(new URL(crumb.item))), `${file}: breadcrumb target missing`);
      }
    } catch (error) { failures.push(`${file}: invalid JSON-LD: ${error.message}`); }
  }
  // All actual local links, fragments, styles, scripts, images and embeds must resolve.
  for (const element of $('a[href],link[href],script[src],img[src],iframe[src]').toArray()) {
    const raw = $(element).attr('href') || $(element).attr('src');
    if (!raw || /^(?:mailto:|tel:|data:|javascript:)/.test(raw)) continue;
    const target = new URL(raw, base);
    if (target.origin !== site.url) continue;
    const localFile = await resolveLocal(target);
    check(Boolean(localFile), `${file}: broken local URL ${raw}`);
    if (localFile && target.hash && pages.has(localFile)) {
      const id = decodeURIComponent(target.hash.slice(1));
      const targetPage = pages.get(localFile);
      check(targetPage('[id]').toArray().some((element) => targetPage(element).attr('id') === id), `${file}: broken fragment ${raw}`);
    }
  }
}
const sitemapIndex = load(await readFile(path.join(dist, 'sitemap-index.xml'), 'utf8'), { xml: true });
const sitemapUrls = [];
for (const loc of sitemapIndex('sitemap > loc').toArray()) {
  const url = new URL(sitemapIndex(loc).text());
  check(url.origin === site.url, `Sitemap index uses wrong origin: ${url}`);
  const xml = load(await readFile(path.join(dist, url.pathname), 'utf8'), { xml: true });
  sitemapUrls.push(...xml('url > loc').toArray().map((entry) => xml(entry).text()));
}
check(sitemapUrls.length === new Set(sitemapUrls).size, 'Sitemap contains duplicate URLs');
check(JSON.stringify([...indexed].sort()) === JSON.stringify(sitemapUrls.sort()), 'Sitemap must include exactly all indexable HTML pages, including the homepage');
const robots = await readFile(path.join(dist, 'robots.txt'), 'utf8');
check(robots.includes(`Sitemap: ${absolute('/sitemap-index.xml')}`) && !/Disallow:\s*\//.test(robots), 'robots.txt blocks pages or lacks sitemap');
const home = await readFile(path.join(dist, 'index.html'), 'utf8');
check(home.includes(staticHead({ ...site, path: '/' })), 'Homepage SEO is stale: run npm run seo:refresh');
const manifest = JSON.parse(await readFile(path.join(dist, 'site.webmanifest'), 'utf8'));
for (const icon of [...manifest.icons, { src: '/apple-touch-icon.png', sizes: '180x180' }, { src: '/brand/icon-96.png', sizes: '96x96' }]) {
  const info = await sharp(path.join(dist, icon.src)).metadata();
  check(`${info.width}x${info.height}` === icon.sizes, `${icon.src}: incorrect icon dimensions`);
}
// README links are a public entry point into the manual too.
const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
for (const match of readme.matchAll(/https:\/\/eklavya-run\.web\.app[^\s)"<>]*/g)) {
  check(Boolean(await resolveLocal(new URL(match[0]))), `README: broken website link ${match[0]}`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`SEO verified: ${indexed.size} indexable pages, ${images.size} unique 1200×630 previews, sitemap, structured data, icons, README links and all local links/anchors (${pages.size} HTML files).`);
