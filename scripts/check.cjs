'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) inspect(filename);
    else if (/\.(cjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
      if (result.status !== 0) { console.error(result.stderr); process.exitCode = 1; }
    }
  }
}
inspect(path.join(root, 'src', 'front'));
inspect(path.join(root, 'scripts'));
if (!process.exitCode) console.log('Sintaxis de todos los archivos JavaScript correcta.');
