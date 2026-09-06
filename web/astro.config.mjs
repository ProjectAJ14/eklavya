// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

/**
 * The site is two halves that share one ground.
 *
 *   /       the landing page — hand-written HTML in public/, copied verbatim.
 *           It carries the interactive terminal and the arrow flight, which
 *           are the showpieces; there is nothing for a framework to add.
 *   /docs/  the manual — Starlight, for search, per-topic URLs, a right-hand
 *           contents list and prev/next. One file per topic under
 *           src/content/docs/docs/, which is what puts them at /docs/*.
 *
 * Both read the same tokens.css, and the ground toggle writes one localStorage
 * key, so a choice made on either half carries to the other.
 */
export default defineConfig({
  site: 'https://eklavya-run.web.app',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'Eklavya',
      description:
        'The complete Eklavya manual: install it, run it, and understand every dial, command and config key.',
      logo: { src: './src/assets/bow.svg', alt: 'Eklavya' },
      favicon: '/favicon.svg',
      social: { github: 'https://github.com/ProjectAJ14/eklavya' },
      customCss: ['./src/styles/docs.css'],
      // Expressive Code ships its own syntax themes; these two are the closest
      // neutrals to our grounds, so code does not arrive in a third palette.
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styles: { borderRadius: '0', frames: { shadowColor: 'transparent' } },
      },
      // Starlight's own toggle would fight ours; ours is in the shared nav and
      // writes the key both halves read.
      components: {
        ThemeSelect: './src/components/GroundToggle.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { slug: 'docs' },
            { slug: 'docs/before-you-start' },
            { slug: 'docs/installing' },
            { slug: 'docs/first-run' },
            { slug: 'docs/first-session' },
          ],
        },
        {
          label: 'Using it',
          items: [
            { slug: 'docs/dials' },
            { slug: 'docs/levels-and-tiers' },
            { slug: 'docs/commands' },
            { slug: 'docs/cli' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'docs/configuration' },
            { slug: 'docs/commit-gate' },
            { slug: 'docs/dashboard' },
          ],
        },
        {
          label: 'Going deeper',
          items: [
            { slug: 'docs/grading-engine' },
            { slug: 'docs/your-data' },
            { slug: 'docs/troubleshooting' },
            { slug: 'docs/faq' },
          ],
        },
      ],
    }),
  ],
});
