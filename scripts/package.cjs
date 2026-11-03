'use strict';
// Copies/archives build output. Does not run the app or installers.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { nsisPayload } = require('./windows.cjs');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const version = require('../package.json').version;
fs.mkdirSync(dist, { recursive: true });
if (process.platform === 'win32') {
  const release = path.join(root, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release');
  const installer = path.join(release, 'bundle', 'nsis', `ClipDrop_${version}_x64-setup.exe`);
  fs.copyFileSync(installer, path.join(dist, `ClipDrop-Setup-x64-${version}.exe`));
  const unpacked = path.join(dist, 'win-unpacked');
  fs.rmSync(unpacked, { recursive: true, force: true });
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'ClipDrop.exe'), nsisPayload(fs.readFileSync(path.join(release, 'clipdrop.exe'))));
  fs.cpSync(path.join(root, 'src-tauri', 'resources', 'win32'), path.join(unpacked, 'tools'), { recursive: true });
} else if (process.platform === 'darwin') {
  const bundle = path.join(root, 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'macos', 'ClipDrop.app');
  // Local ad hoc signing seals the bundle/resources; it does not grant Apple
  // Developer ID trust or notarization and never contacts a signing service.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle,
    path.join(dist, `ClipDrop-Mac-arm64-${version}.zip`)], { stdio: 'inherit' });
} else throw new Error('Compilá los paquetes en Windows o Mac.');
console.log(`Paquete Tauri ${version} preparado en dist.`);

const name = process.platform === 'win32' ? `ClipDrop-Setup-x64-${version}.exe` : `ClipDrop-Mac-arm64-${version}.zip`;
const digest = createHash('sha256').update(fs.readFileSync(path.join(dist, name))).digest('hex');
fs.writeFileSync(path.join(dist, `SHA256SUMS-${version}.txt`), `${digest}  ${name}\n`);
console.log(`${digest}  ${name}`);
