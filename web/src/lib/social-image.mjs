import { readFile } from 'node:fs/promises';
import satori from 'satori';
import sharp from 'sharp';
import { site } from './seo.mjs';
import mark from '../../public/brand/mark.svg?raw';

// Bundled fonts make previews reproducible and keep builds independent of font CDNs.
const fonts = Promise.all([
  readFile(new URL(import.meta.resolve('@fontsource/archivo/files/archivo-latin-800-normal.woff'))),
  readFile(new URL(import.meta.resolve('@fontsource/inter/files/inter-latin-400-normal.woff'))),
]);
const el = (type, style, children, extra = {}) => ({ type, props: { style, children, ...extra } });
const ink = '#17171a', paper = '#EAE7E1', accent = '#79D5C4', dim = '#A29C93';

export async function renderSocialImage({ title, description, path, home = false }) {
  const [displayFont, bodyFont] = await fonts;
  const icon = `data:image/svg+xml;base64,${Buffer.from(mark).toString('base64')}`;
  const tree = el('div', {
    width: site.imageWidth, height: site.imageHeight, display: 'flex', position: 'relative',
    flexDirection: 'column', padding: '48px 56px', backgroundColor: ink, color: paper,
    fontFamily: 'Inter', overflow: 'hidden',
  }, [
    el('div', { position: 'absolute', left: 0, top: 0, bottom: 0, width: 8, backgroundColor: accent }),
    el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #33333a', paddingBottom: 28 }, [
      el('div', { display: 'flex', alignItems: 'center', gap: 18 }, [
        el('img', { width: 48, height: 48 }, undefined, { src: icon }),
        el('div', { fontFamily: 'Archivo', fontSize: 36, fontWeight: 800, letterSpacing: -1.5, color: accent }, 'Eklavya'),
      ]),
      el('div', { fontSize: 15, letterSpacing: 2, color: dim }, 'LEARNING + MEMORY'),
    ]),
    el('div', { display: 'flex', flexDirection: 'column', width: 800, marginTop: 32 }, [
      el('div', { fontSize: 15, letterSpacing: 2.5, color: accent }, home ? 'FOR CLAUDE CODE' : 'THE EKLAVYA MANUAL'),
      el('div', { fontFamily: 'Archivo', fontWeight: 800, fontSize: home ? 72 : 62, lineHeight: 1.04, letterSpacing: -2.8, marginTop: 20, whiteSpace: 'pre-wrap' },
        home ? 'Learn the code.\nRemember the work.' : title),
      el('div', { fontSize: 25, color: dim, lineHeight: 1.45, marginTop: 22, maxWidth: 760 }, description),
    ]),
    el('div', { position: 'absolute', right: 56, top: 212, display: 'flex', width: 212, height: 212, border: '1px solid #33333a', padding: 16 }, [
      el('img', { width: 178, height: 178 }, undefined, { src: icon }),
    ]),
    el('div', { position: 'absolute', bottom: 38, left: 56, right: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #33333a', paddingTop: 21, fontSize: 16, color: dim }, [
      el('div', {}, `eklavya-run.web.app${path === '/' ? '' : path}`),
      el('div', { color: accent }, home ? 'Understand what you ship' : 'Read the documentation'),
    ]),
  ]);
  const svg = await satori(tree, {
    width: site.imageWidth, height: site.imageHeight,
    fonts: [ { name: 'Archivo', data: displayFont, weight: 800, style: 'normal' }, { name: 'Inter', data: bodyFont, weight: 400, style: 'normal' } ],
  });
  return sharp(Buffer.from(svg)).png().toBuffer();
}
