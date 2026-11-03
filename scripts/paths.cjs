'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'ui');
const desktop = path.join(root, 'desktop');
const resources = path.join(desktop, 'resources');
const icons = path.join(desktop, 'icons');

// Ask Cargo for its actual output directory, including CARGO_TARGET_DIR/config.
// Metadata inspection neither compiles nor starts the application.
function releaseDirectory(target) {
  const metadata = JSON.parse(execFileSync('cargo', [
    'metadata', '--manifest-path', path.join(desktop, 'Cargo.toml'),
    '--locked', '--offline', '--no-deps', '--format-version', '1'
  ], { cwd: desktop, encoding: 'utf8' }));
  return path.join(metadata.target_directory, target, 'release');
}

module.exports = { root, ui, desktop, resources, icons, releaseDirectory };
