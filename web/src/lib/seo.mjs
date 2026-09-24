/** Public identity shared by Astro, social images and the static-page build. */
export const site = {
  url: 'https://eklavya-run.web.app',
  name: 'Eklavya',
  title: 'Eklavya — Learning & memory for Claude Code',
  description: 'Learn the code your agent writes with Eklavya for Claude Code: adaptive questions, spaced repetition, local project memory, and an optional commit gate.',
  repository: 'https://github.com/ProjectAJ14/eklavya',
  imageWidth: 1200,
  imageHeight: 630,
};

export const absolute = (path) => new URL(path, site.url).href;
export const docPath = (id) => `/${id.replace(/\/+$/, '')}/`;
export const socialPath = (id = 'home') => `/social/${id}.png`;
export const imageAlt = (title) => `Eklavya bow-and-arrow mark. ${title}. Learning and memory for Claude Code.`;
export const jsonLd = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

export function structuredData({ title, description, path, docs = false }) {
  const url = absolute(path);
  const website = { '@type': 'WebSite', '@id': absolute('/#website'), name: site.name, url: absolute('/'), inLanguage: 'en' };
  const software = {
    '@type': 'SoftwareSourceCode', '@id': absolute('/#software'), name: site.name,
    description: site.description, url: absolute('/'), codeRepository: site.repository,
    license: 'https://opensource.org/license/mit', programmingLanguage: 'TypeScript',
    runtimePlatform: 'Node.js 22+', image: absolute('/brand/icon-512.png'),
  };
  const crumbs = [ { name: site.name, item: absolute('/') } ];
  if (docs) crumbs.push({ name: 'Documentation', item: absolute('/docs/') });
  if (docs && path !== '/docs/') crumbs.push({ name: title, item: url });
  return {
    '@context': 'https://schema.org',
    '@graph': [website, software, {
      '@type': 'WebPage', '@id': `${url}#page`,
      url, name: title, description, inLanguage: 'en',
      isPartOf: { '@id': website['@id'] }, about: { '@id': software['@id'] },
      image: absolute(socialPath(docs ? path.replace(/^\/|\/$/g, '') : 'home')),
      ...(docs ? { breadcrumb: { '@id': `${url}#breadcrumb` }, mainEntity: { '@id': `${url}#article` } } : {}),
    }, ...(docs ? [{
      '@type': 'TechArticle', '@id': `${url}#article`, headline: title, description,
      mainEntityOfPage: { '@id': `${url}#page` }, about: { '@id': software['@id'] },
      inLanguage: 'en', image: absolute(socialPath(path.replace(/^\/|\/$/g, ''))),
    }, {
      '@type': 'BreadcrumbList', '@id': `${url}#breadcrumb`,
      itemListElement: crumbs.map((crumb, i) => ({ '@type': 'ListItem', position: i + 1, ...crumb })),
    }] : [])],
  };
}

export function sharingMeta({ title, description, path, id = 'home' }) {
  const property = (property, content) => ({ tag: 'meta', attrs: { property, content: String(content) } });
  const name = (name, content) => ({ tag: 'meta', attrs: { name, content } });
  const image = absolute(socialPath(id));
  return [
    property('og:type', 'website'), property('og:site_name', site.name),
    property('og:locale', 'en_US'), property('og:title', title),
    property('og:description', description), property('og:url', absolute(path)),
    property('og:image', image), property('og:image:secure_url', image),
    property('og:image:type', 'image/png'), property('og:image:width', site.imageWidth),
    property('og:image:height', site.imageHeight), property('og:image:alt', imageAlt(title)),
    name('twitter:card', 'summary_large_image'), name('twitter:title', title),
    name('twitter:description', description), name('twitter:image', image),
    name('twitter:image:alt', imageAlt(title)),
    name('robots', 'index, follow, max-image-preview:large'),
    name('theme-color', '#17171a'),
  ];
}
