# Search and link previews

Eklavya's public identity is **learning and memory for Claude Code**. The site
must describe the shipped product: adaptive questions, spaced repetition,
local project memory, the dashboard, and the optional commit gate. Claims about
privacy retain the local-default / optional-provider distinction. The feature
sources are mapped in `CLAUDE.md`; new metadata follows the same contract.

## Implementation

| Area | Implementation | Acceptance condition |
| --- | --- | --- |
| Page metadata | Distinct descriptions on every manual page; shared homepage/product identity | One accurate title, description, canonical and social tag set per indexable page |
| Share cards | One PNG per public page, generated from its title and description | 1200 × 630, under 1 MB, readable copy and a consistent bow-and-arrow identity |
| Brand assets | Editable SVG master, SVG/ICO favicon, 96/192/512px PNGs, 180px Apple touch icon, manifest | Icons resolve and match their declared dimensions; mark has safe launcher padding |
| Search discovery | Sitemap includes the static homepage and all manual routes; robots.txt advertises it | Exactly the indexable HTML pages appear in the sitemap |
| URLs | Astro matches Firebase's trailing slashes; index.html aliases redirect permanently | Shared URLs, canonical URLs and sitemap URLs agree |
| Structured data | WebSite, SoftwareSourceCode, WebPage/TechArticle, documentation breadcrumbs | JSON parses, describes the real project, and points to existing pages |
| Utility pages | 404 and standalone architecture viewer are noindex; viewer retains share metadata | Neither appears in the sitemap; missing URLs keep a real 404 response |
| Link quality | Check built HTML links, fragments and local resources, plus README website URLs | No missing local targets or anchors |
| Regression prevention | SEO checks run after every build and in the website CI job | Broken metadata, images, sitemap or links fail the build before deployment |
| Presentation | Review homepage and docs at 1280, 900 and 560px, in ink and paper | No horizontal page overflow, browser errors or broken terminal interaction |

## Sources of truth and maintenance

`src/lib/seo.mjs` holds the production origin, product description, shared social
metadata and structured data. `src/components/Head.astro` extends the installed
Starlight head; it preserves its own stylesheet, locale and page-title handling
and lets Starlight deduplicate meta tags. The frontmatter description in each
manual page is also that page's search snippet and share-card summary.

The homepage remains handwritten HTML. After changing the shared identity, run
`npm run seo:refresh` and commit the updated HTML. Normal builds check it for
drift instead of silently modifying tracked source files. The architecture
viewer remains generated upstream: only its copied version gains site metadata.

`public/brand/mark.svg` is the editable icon master. After editing it, run
`npm run icons` and commit the SVG/PNG/ICO exports. Do not replace the mark with
an unrelated illustration. The card layout is `src/lib/social-image.mjs`;
Archivo and Inter are bundled, licensed font packages, so card generation
requires no remote font request. Previews are static PNGs: crawlers do not need
JavaScript, fonts or an image-generation service.

Every manual page automatically gets `/social/<page-id>.png`; for example,
`/docs/memory/` uses `/social/docs/memory.png`. The homepage uses
`/social/home.png`. Add a useful, unique description when adding a page, add it
to the sidebar, then build. The card, sitemap entry and metadata follow it.

Run `npm ci && npm run build` in `web/` for the full build and SEO audit.
`npm run check:seo` checks an existing build. The website CI job runs independently
of the server tests, and the existing Firebase deployment also runs the audit
through `postbuild`. No runtime application or learner data is involved.

## Record validation per change

Include the build result, inspected pages, viewport/theme coverage and any
emulator checks in the PR. Page counts and card sizes belong in that dated
record, not in the ongoing maintenance contract. A local pass does not establish
a production deployment, search indexing or field performance.

## Publication and external verification

After merging and deploying through the existing Firebase workflow:

1. Check the homepage, a manual page, `/robots.txt`, `/sitemap-index.xml`,
   `/social/home.png` and the icon URLs on the live domain. Confirm the
   index.html aliases redirect and an unknown URL returns HTTP 404.
2. In the verified Google Search Console property, submit
   `https://eklavya-run.web.app/sitemap-index.xml`. Inspect the homepage and a
   documentation URL. Property verification needs an authorized owner; no
   verification token or account identifier is invented in this repository.
3. Inspect structured data with Schema.org's validator; use Google's Rich
   Results Test for supported breadcrumb eligibility. Source-code and article
   schema do not promise a special Google result. There are no fabricated
   ratings, reviews, organization details, FAQ eligibility or publication dates.
4. Refresh cached previews using LinkedIn Post Inspector / Facebook Sharing
   Debugger, then paste the homepage and a deep documentation link into the
   actual sharing apps. Those apps control caching, cropping and rendering.
5. If the repository itself needs the same artwork, download the built
   `/social/home.png` and upload it in GitHub repository Settings → Social
   preview. Website metadata cannot control a github.com link preview.
6. Review Search Console indexing and page-experience reports after deployment.
   Search ranking, indexing and link-preview cache refresh are external outcomes,
   not properties a passing local build can guarantee.

Use the existing canonical domain until an explicit domain migration is planned.
A second Firebase hostname is consolidated by the canonical URLs; a future
custom domain needs coordinated redirects, sitemap and metadata changes.
No unnecessary analytics, tracking scripts, speculative keyword pages,
`meta keywords`, synthetic `lastmod` dates, or unsupported rich-result claims
are added. `llms.txt` is not a substitute for crawlable HTML or a sitemap.

## Reference guidance

- [Google: sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google: canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Google: favicons](https://developers.google.com/search/docs/appearance/favicon-in-search)
- [Open Graph protocol](https://ogp.me/)
- [Starlight: component overrides](https://starlight.astro.build/guides/overriding-components/)
