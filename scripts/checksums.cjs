'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const directory = path.resolve(__dirname, '..', 'dist');
const version = require('../package.json').version;
const names = [`ClipDrop-Setup-x64-${version}.exe`, `ClipDrop-Mac-arm64-${version}.zip`];
const packages = names.filter(name => fs.existsSync(path.join(directory, name)));
const required = process.platform === 'win32' ? names[0] : process.platform === 'darwin' ? names[1] : null;
if (!packages.length || (required && !packages.includes(required))) {
  throw new Error('Falta el paquete de esta versión para la plataforma actual.');
}
const lines = packages.sort().map(name => `${createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}`);
fs.writeFileSync(path.join(directory, `SHA256SUMS-${version}.txt`), lines.join('\n') + '\n');
console.log(lines.join('\n'));
