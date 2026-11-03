'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'dist', 'win-unpacked', 'resources');
const archive = path.join(resources, 'app.asar');

function verifyPE(filename) {
  const bytes = fs.readFileSync(filename);
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt32LE(pe), 0x00004550);
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'Se esperaba Windows x64.');
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
verifyPE(path.join(root, 'dist', 'win-unpacked', 'ClipDrop.exe'));
verifyPE(path.join(resources, 'tools', 'yt-dlp.exe'));
verifySources('src');
verifySources('assets');
const provenance = JSON.parse(fs.readFileSync(path.join(resources, 'tools', 'provenance.json'), 'utf8'));
const binary = fs.readFileSync(path.join(resources, 'tools', 'yt-dlp.exe'));
assert.equal(createHash('sha256').update(binary).digest('hex'), provenance.sha256);
assert.ok(fs.existsSync(path.join(resources, 'tools', 'yt-dlp-THIRD_PARTY_LICENSES.txt')));
assert.ok(fs.existsSync(path.join(root, 'dist', 'win-unpacked', 'LICENSES.chromium.html')));
assert.ok(!asar.listPackage(archive).some(file => /node_modules|\.env|preferences\.json|test\.cjs|\.ps1$|src\/native/.test(file.replaceAll('\\', '/'))));
assert.equal(asar.extractFile(archive, path.join('src', 'clipboard.cjs')).includes(Buffer.from('execFile')), false);
console.log(`Paquete Windows x64 verificado: fuente e iconos exactos, sin scripts auxiliares, motor ${provenance.release}, SHA256 y licencias.`);
