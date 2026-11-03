'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TemporaryStorage } = require('../src/storage.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clipdrop-storage-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('limpia temporales propios y conserva descargas y carpetas desconocidas', async t => {
  const root = await fixture(t);
  const storage = new TemporaryStorage(path.join(root, 'cache'));
  const job = await storage.create();
  await fs.writeFile(path.join(job, 'video.mp4'), 'video');
  const saved = path.join(root, 'guardado.mp4');
  await fs.writeFile(saved, 'conservar');
  await fs.mkdir(path.join(storage.root, 'ajeno'));
  await fs.writeFile(path.join(storage.root, 'ajeno', 'dato.txt'), 'dato');
  assert.equal(await storage.bytes(), 9);
  await storage.clean();
  assert.equal(await fs.readFile(saved, 'utf8'), 'conservar');
  assert.equal(await fs.readFile(path.join(storage.root, 'ajeno', 'dato.txt'), 'utf8'), 'dato');
  await assert.rejects(fs.stat(job), { code: 'ENOENT' });
});
test('rechaza borrar fuera del root y diferencia prefijos parecidos', async t => {
  const root = await fixture(t);
  const storage = new TemporaryStorage(path.join(root, 'cache'));
  await storage.initialize();
  assert.equal(storage.contains(path.join(storage.root, 'transfer-123', 'video.mp4')), true);
  assert.equal(storage.contains(storage.root), false);
  assert.equal(storage.contains(path.join(root, 'cache-extra', 'video.mp4')), false);
  await assert.rejects(storage.removeJob(root), /no pertenece/);
  await assert.rejects(storage.removeJob(path.join(storage.root, 'desconocida')), /no pertenece/);
});
test('symlink temporal no sigue ni borra el destino externo', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  const storage = new TemporaryStorage(path.join(root, 'cache'));
  await storage.initialize();
  const outside = path.join(root, 'descargas');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'video.mp4'), 'original');
  await fs.symlink(outside, path.join(storage.root, 'transfer-link'));
  assert.equal(await storage.bytes(), 0);
  await storage.clean();
  assert.equal(await fs.readFile(path.join(outside, 'video.mp4'), 'utf8'), 'original');
});
test('canonicaliza aliases para comparar con rutas devueltas por el motor', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'real'));
  await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'));
  const storage = new TemporaryStorage(path.join(root, 'alias', 'cache'));
  const job = await storage.create();
  assert.equal(job.startsWith(await fs.realpath(path.join(root, 'real'))), true);
  assert.equal(storage.contains(path.join(job, 'video.mp4')), true);
});
