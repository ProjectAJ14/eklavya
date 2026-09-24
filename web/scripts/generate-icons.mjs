/** Export the editable brand master for browsers, launchers and repository use. */
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
const root = new URL('../public/', import.meta.url);
const source = await readFile(new URL('brand/mark.svg', root));
for (const size of [96, 192, 512]) {
  await sharp(source).resize(size, size).png().toFile(new URL(`brand/icon-${size}.png`, root).pathname);
}
await sharp(source).resize(180, 180).png().toFile(new URL('apple-touch-icon.png', root).pathname);
// A PNG-backed ICO is supported by current browsers, including Windows shell consumers.
const png = await sharp(source).resize(32, 32).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header[6] = 32; header[7] = 32;
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await writeFile(new URL('favicon.ico', root), Buffer.concat([header, png]));
await writeFile(new URL('favicon.svg', root), source);
console.log('Exported SVG, ICO, PNG and Apple icons from brand/mark.svg');
