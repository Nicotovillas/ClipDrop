'use strict';
// Test finito del proceso principal de Electron. No crea ventanas ni descarga videos.
// Sólo CI: nunca reemplazar el portapapeles cotidiano del desarrollador.
const { app, clipboard } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fileURLToPath } = require('node:url');
const fileClipboard = require('../src/clipboard.cjs');

if (process.env.CI !== 'true') {
  console.error('Este test sólo se ejecuta en CI aislada.');
  app.exit(1);
} else {
  const timeout = setTimeout(() => { console.error('Timeout de clipboard smoke test.'); app.exit(1); }, 20000);
  app.whenReady().then(async () => {
    let root;
    let exitCode = 1;
    try {
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clipdrop-native-')));
      const file = path.join(root, 'Video ñ con espacios.mp4');
      await fs.writeFile(file, 'fixture, no real video');
      await fileClipboard.copyFiles([file]);
      const items = await clipboard.read();
      const item = items.find(item => item.types.includes('text/uri-list'));
      assert.ok(item, 'Falta la referencia nativa de archivos.');
      const uris = (await (await item.getType('text/uri-list')).text()).trim().split(/\r?\n/).filter(Boolean);
      assert.equal(await fs.realpath(fileURLToPath(uris[0])), await fs.realpath(file));
      await fileClipboard.clearIfWithin(root);
      assert.equal(await clipboard.has('text/uri-list'), false);
      console.log(`File clipboard roundtrip OK (${process.platform}).`);
      exitCode = 0;
    } catch (error) {
      console.error(error);
    } finally {
      clearTimeout(timeout);
      if (root) await fs.rm(root, { recursive: true, force: true });
    }
    app.exit(exitCode);
  });
}
