'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'dist', 'win-unpacked', 'resources');
const archive = path.join(resources, 'app.asar');

function verifyPE(filename, machines = [0x8664]) {
  const bytes = fs.readFileSync(filename);
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt32LE(pe), 0x00004550);
  assert.ok(machines.includes(bytes.readUInt16LE(pe + 4)), 'Arquitectura PE inesperada.');
  return bytes;
}
function verifySources(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) verifySources(relative);
    else {
      assert.deepEqual(asar.extractFile(archive, relative), fs.readFileSync(path.join(root, relative)), `${relative} empaquetado desactualizado.`);
    }
  }
}
const version = require('../package.json').version;
const installer = path.join(root, 'dist', `ClipDrop-Setup-x64-${version}.exe`);
// NSIS uses an x86 bootstrapper even when the bundled application is x64.
const installerBytes = verifyPE(installer, [0x014c, 0x8664]);
assert.ok(installerBytes.includes(Buffer.from('NullsoftInst')), 'Falta la cabecera NSIS del instalador.');
verifyPE(path.join(root, 'dist', 'win-unpacked', 'ClipDrop.exe'));
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(packaged.version, version, 'Versión empaquetada desactualizada.');
assert.equal(packaged.name, 'clipdrop');
verifyPE(path.join(resources, 'tools', 'yt-dlp.exe'));
verifySources('src');
verifySources('assets');
const provenance = JSON.parse(fs.readFileSync(path.join(resources, 'tools', 'provenance.json'), 'utf8'));
const binary = fs.readFileSync(path.join(resources, 'tools', 'yt-dlp.exe'));
const pinned = require('../tools/yt-dlp.json');
assert.equal(provenance.release, pinned.release);
assert.equal(provenance.sha256, pinned.sha256);
assert.equal(createHash('sha256').update(binary).digest('hex'), provenance.sha256);
assert.ok(fs.existsSync(path.join(resources, 'tools', 'yt-dlp-THIRD_PARTY_LICENSES.txt')));
assert.ok(fs.existsSync(path.join(root, 'dist', 'win-unpacked', 'LICENSES.chromium.html')));
assert.ok(!asar.listPackage(archive).some(file => /node_modules|\.env|preferences\.json|test\.cjs|\.ps1$|src\/native/.test(file.replaceAll('\\', '/'))));
assert.equal(asar.extractFile(archive, path.join('src', 'clipboard.cjs')).includes(Buffer.from('execFile')), false);
console.log(`Instalador NSIS presente (sin ejecutar) y paquete Windows x64 verificado: fuente e iconos exactos, sin scripts auxiliares, motor ${provenance.release}, SHA256 y licencias.`);
