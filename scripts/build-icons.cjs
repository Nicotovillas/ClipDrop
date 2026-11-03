'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const directory = path.resolve(__dirname, '..', 'assets');

async function build() {
  const svg = await fs.readFile(path.join(directory, 'icon.svg'));
  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  const pngs = new Map(await Promise.all(sizes.map(async size => [size, await sharp(svg).resize(size, size).png().toBuffer()])));
  await fs.writeFile(path.join(directory, 'icon.png'), pngs.get(512));

  // Windows Vista+ supports PNG images in standard ICO directory entries.
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6 + icoSizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);
  let offset = header.length;
  for (const [index, size] of icoSizes.entries()) {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(pngs.get(size).length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += pngs.get(size).length;
  }
  await fs.writeFile(path.join(directory, 'icon.ico'), Buffer.concat([header, ...icoSizes.map(size => pngs.get(size))]));

  const chunks = [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => {
    const chunk = Buffer.alloc(8);
    chunk.write(type, 0, 'ascii');
    chunk.writeUInt32BE(8 + pngs.get(size).length, 4);
    return Buffer.concat([chunk, pngs.get(size)]);
  });
  const icns = Buffer.alloc(8);
  icns.write('icns', 0, 'ascii');
  icns.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  await fs.writeFile(path.join(directory, 'icon.icns'), Buffer.concat([icns, ...chunks]));
  console.log('Iconos PNG, ICO e ICNS generados desde assets/icon.svg.');
}
build().catch(error => { console.error(error); process.exitCode = 1; });
