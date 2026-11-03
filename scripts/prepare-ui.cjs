'use strict';
// Static assets only: no server, app, watcher or bundler.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, '.build', 'frontend');
fs.mkdirSync(path.join(destination, 'assets'), { recursive: true });
for (const name of ['index.html', 'styles.css', 'bridge.js', 'renderer.js']) {
  fs.copyFileSync(path.join(root, 'src', 'ui', name), path.join(destination, name));
}
fs.copyFileSync(path.join(root, 'assets', 'icon.svg'), path.join(destination, 'assets', 'icon.svg'));
console.log('Interfaz estática preparada.');
