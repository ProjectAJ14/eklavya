import { getCollection } from 'astro:content';
import type { APIRoute, GetStaticPaths } from 'astro';
import { renderSocialImage } from '../../lib/social-image.mjs';
import { docPath, site } from '../../lib/seo.mjs';

export const getStaticPaths: GetStaticPaths = async () => [
  { params: { slug: 'home' }, props: { title: site.title, description: 'Adaptive questions. Spaced repetition. Local project memory. Built into the work you already do.', path: '/', home: true } },
  ...(await getCollection('docs')).filter(({ data }) => !data.draft).map(({ id, data }) => ({
    params: { slug: id }, props: { title: data.title, description: data.description, path: docPath(id) },
  })),
];

export const GET: APIRoute = async ({ props }) => new Response(
  new Uint8Array(await renderSocialImage(props)),
  { headers: { 'Content-Type': 'image/png' } },
);
