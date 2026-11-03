'use strict';
// Sólo prepara el motor. No ejecuta yt-dlp ni inicia ClipDrop.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const directory = path.resolve(__dirname, '..', 'src-tauri', 'resources', 'win32');
const pinned = require('../src-tauri/resources/yt-dlp.json');
const headers = { 'User-Agent': 'ClipDrop-local-build' };

async function get(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`No se pudo descargar ${url}: HTTP ${response.status}`);
  return response;
}
async function prepare() {
  const tag = pinned.release;
  if (!/^[a-zA-Z0-9._-]+$/.test(tag) || pinned.asset !== 'yt-dlp.exe' || !/^[a-f0-9]{64}$/.test(pinned.sha256)) {
    throw new Error('La versión fijada de yt-dlp no es válida.');
  }
  const release = { tag_name: tag };
  const asset = name => {
    return `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/${name}`;
  };
  const sums = await (await get(asset('SHA2-256SUMS'))).text();
  const match = sums.match(/^([a-fA-F0-9]{64})\s+\*?yt-dlp\.exe\s*$/m);
  if (!match) throw new Error('No se encontró el SHA256 oficial de yt-dlp.exe.');
  const expected = match[1].toLowerCase();
  if (expected !== pinned.sha256) throw new Error('El SHA256 publicado no coincide con src-tauri/resources/yt-dlp.json.');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'yt-dlp.exe');
  let binary;
  try { binary = await fs.readFile(filename); } catch { /* Primera preparación. */ }
  if (!binary || createHash('sha256').update(binary).digest('hex') !== expected) {
    console.log(`Descargando yt-dlp ${release.tag_name} para Windows x64…`);
    binary = Buffer.from(await (await get(asset('yt-dlp.exe'))).arrayBuffer());
    if (createHash('sha256').update(binary).digest('hex') !== expected) throw new Error('El SHA256 de yt-dlp.exe no coincide. No se empaquetó.');
    if (binary.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('El archivo no es un ejecutable de Windows.');
    await fs.writeFile(filename + '.tmp', binary);
    await fs.rename(filename + '.tmp', filename);
  }
  for (const document of ['LICENSE', 'THIRD_PARTY_LICENSES.txt', 'README.md']) {
    const url = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${encodeURIComponent(release.tag_name)}/${document}`;
    await fs.writeFile(path.join(directory, `yt-dlp-${document}`), await (await get(url)).text());
  }
  await fs.writeFile(path.join(directory, 'provenance.json'), JSON.stringify({
    project: 'https://github.com/yt-dlp/yt-dlp', release: release.tag_name, url: asset('yt-dlp.exe'),
    sha256: expected, checksums: asset('SHA2-256SUMS'),
    source: `https://github.com/yt-dlp/yt-dlp/archive/refs/tags/${encodeURIComponent(release.tag_name)}.tar.gz`
  }, null, 2) + '\n');
  console.log(`Motor Windows verificado: ${release.tag_name} · SHA256 ${expected}`);
}
prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
