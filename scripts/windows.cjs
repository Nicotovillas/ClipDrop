'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

// Tauri 2.12.4 replaces the first bundle-type token before creating NSIS, then
// restores the original executable after bundling. Reproduce that exact change
// for verification/staging; every other byte must still match the build.
// Source: https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle.rs
const unknown = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const nsis = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');

function nsisPayload(binary) {
  const offset = binary.indexOf(unknown);
  if (offset === -1) throw new Error('Falta el marcador de tipo de paquete de Tauri en el ejecutable compilado.');
  const result = Buffer.from(binary);
  nsis.copy(result, offset);
  return result;
}

function verify() {
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  const pinned = require('../src-tauri/resources/yt-dlp.json');
  const installer = path.join(root, 'dist', `ClipDrop-Setup-x64-${version}.exe`);
  function verifyPE(file, machines = [0x8664]) {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(pe), 0x00004550);
    assert.ok(machines.includes(bytes.readUInt16LE(pe + 4)), 'Arquitectura PE inesperada.');
    return bytes;
  }
  assert.ok(verifyPE(installer, [0x014c, 0x8664]).includes(Buffer.from('NullsoftInst')), 'Falta la cabecera NSIS.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ClipDropPackageVerify-'));
  function files(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
  }
  try {
    const sevenZip = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe') : '7z';
    execFileSync(sevenZip, ['x', '-y', `-o${temporary}`, installer], { stdio: 'pipe' });
    const extracted = files(temporary);
    const app = extracted.find(file => path.basename(file).toLowerCase() === 'clipdrop.exe');
    const engine = extracted.find(file => path.basename(file).toLowerCase() === 'yt-dlp.exe');
    assert.ok(app, 'Falta ClipDrop.exe en el instalador.');
    assert.ok(engine, 'Falta yt-dlp.exe en el instalador.');
    const packagedApp = verifyPE(app);
    const expectedApp = nsisPayload(verifyPE(path.join(root, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'clipdrop.exe')));
    const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256(packagedApp), sha256(expectedApp), 'El instalador no contiene la app de este build con el marcador NSIS de Tauri.');
    assert.equal(sha256(verifyPE(path.join(root, 'dist', 'win-unpacked', 'ClipDrop.exe'))), sha256(packagedApp), 'La app preparada para Defender difiere del payload instalado.');
    const binary = verifyPE(engine);
    assert.equal(createHash('sha256').update(binary).digest('hex'), pinned.sha256, 'SHA256 del motor incorrecto.');
    const provenancePath = extracted.find(file => path.basename(file) === 'provenance.json');
    assert.ok(provenancePath, 'Falta procedencia del motor.');
    const provenance = JSON.parse(fs.readFileSync(provenancePath));
    assert.equal(provenance.release, pinned.release);
    assert.equal(provenance.sha256, pinned.sha256);
    assert.ok(extracted.some(file => path.basename(file) === 'yt-dlp-THIRD_PARTY_LICENSES.txt'));
    assert.ok(!extracted.some(file => /^(electron\.exe|app\.asar|node\.exe|fixture-downloader\.exe|clipboard-smoke\.exe|\.env)$/i.test(path.basename(file))));
    console.log(`Instalador NSIS Tauri ${version}: payload x64 coincide con el build (marcador NSIS), staging Defender idéntico, motor SHA256/licencias correctos (sin ejecutarlo).`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (require.main === module) verify();
module.exports = { nsisPayload };
