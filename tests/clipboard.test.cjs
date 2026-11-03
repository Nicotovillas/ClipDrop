'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createFileClipboard } = require('../src/clipboard.cjs');

const FILES_TYPE = 'text/uri-list';

class FakeClipboardItem {
  constructor(payload) { this.payload = payload; this.types = Object.keys(payload); }
  async getType(type) { return new Blob([this.payload[type]], { type }); }
}

function fakeClipboard(initial = []) {
  const state = { items: initial, writes: [], clears: 0, reads: 0, writeError: false, readError: false, readQueue: [] };
  const clipboard = {
    async write(items) {
      state.writes.push(items);
      if (state.writeError) throw new Error('fixture write failed');
      state.items = items;
    },
    async read() {
      state.reads++;
      if (state.readError) throw new Error('fixture read failed');
      return state.readQueue.length ? state.readQueue.shift() : state.items;
    },
    clear() { state.clears++; state.items = []; },
  };
  return { state, clipboard };
}

function setup(options = {}, initial = []) {
  const fake = fakeClipboard(initial);
  const service = createFileClipboard({ clipboard: fake.clipboard, ClipboardItem: FakeClipboardItem, ...options });
  return { ...fake, service };
}

function fileItem(files, windows = false) {
  return new FakeClipboardItem({ [FILES_TYPE]: files.map(file => pathToFileURL(file, { windows }).href).join('\r\n') });
}

async function directory(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ClipDropClipboardTest-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Copies existing Unicode files in one native URI-list write without pre-clearing', async (t) => {
  const root = await directory(t);
  const files = [path.join(root, 'Mañana 🎬 #1.mp4'), path.join(root, 'otro video %2.mp4')];
  await Promise.all(files.map(file => fs.writeFile(file, 'fixture')));
  const { service, state } = setup({}, [new FakeClipboardItem({ 'text/plain': 'previous content' })]);
  await service.copyFiles(files);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].length, 1);
  assert.deepEqual(state.writes[0][0].types, [FILES_TYPE]);
  assert.equal(state.writes[0][0].payload[FILES_TYPE], files.map(file => pathToFileURL(file).href).join('\r\n'));
  assert.equal(state.clears, 0);
  assert.equal(state.reads, 0);
});

test('Rejects invalid, missing and directory paths before writing or clearing', async (t) => {
  const root = await directory(t);
  const existing = path.join(root, 'existing.mp4');
  await fs.writeFile(existing, 'fixture');
  const old = [new FakeClipboardItem({ 'text/plain': 'preserve me' })];
  const { service, state } = setup({}, old);
  for (const files of [[], null, ['relative.mp4'], ['https://x.com/video.mp4'], [{ 'text/uri-list': 'file:///bad' }], [existing, path.join(root, 'missing')], [root], [existing + '\0invalid']]) {
    await assert.rejects(service.copyFiles(files), /No hay archivos|ruta del archivo|no está disponible|carpeta/);
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.clears, 0);
  assert.equal(state.items, old);
});

test('Write errors leave prior content intact and report a retryable Spanish error', async (t) => {
  const root = await directory(t);
  const file = path.join(root, 'existing.mp4');
  await fs.writeFile(file, 'fixture');
  const old = [new FakeClipboardItem({ 'text/plain': 'preserve me' })];
  const { service, state } = setup({}, old);
  state.writeError = true;
  await assert.rejects(service.copyFiles([file]), /No se pudo copiar.*reintentá/);
  assert.equal(state.writes.length, 1);
  assert.equal(state.items, old);
  assert.equal(state.clears, 0);
});

test('Clears only file references strictly within the requested temporary root', async (t) => {
  const root = await directory(t);
  const own = fileItem([path.join(root, 'transfer-one', 'Mañana #1.mp4'), path.join(root, 'transfer-two', 'video.mp4')]);
  const { service, state } = setup({}, [own]);
  assert.equal(await service.clearIfWithin(root), true);
  assert.equal(state.clears, 1);
  assert.equal(state.reads, 2);
  assert.deepEqual(state.items, []);
});

test('Preserves foreign refs, sibling prefixes, root itself and mixed owned/foreign files', async (t) => {
  const root = await directory(t);
  const foreign = path.join(root + '-sibling', 'video.mp4');
  for (const files of [[foreign], [root], [path.join(root, 'own.mp4'), foreign]]) {
    const initial = [fileItem(files)];
    const { service, state } = setup({}, initial);
    assert.equal(await service.clearIfWithin(root), false);
    assert.equal(state.clears, 0);
    assert.equal(state.items, initial);
  }
});

test('Preserves plain text, mixed text/image/file entries and empty clipboard', async (t) => {
  const root = await directory(t);
  const uri = pathToFileURL(path.join(root, 'own.mp4')).href;
  for (const initial of [[], [new FakeClipboardItem({ 'text/plain': uri })], [new FakeClipboardItem({ [FILES_TYPE]: uri, 'text/plain': 'preserve text' })], [new FakeClipboardItem({ [FILES_TYPE]: uri, 'image/png': 'image fixture' })], [fileItem([path.join(root, 'own.mp4')]), new FakeClipboardItem({ 'text/plain': 'other item' })]]) {
    const { service, state } = setup({}, initial);
    assert.equal(await service.clearIfWithin(root), false);
    assert.equal(state.clears, 0);
  }
});

test('Malformed and non-file URI lists never trigger clearing', async (t) => {
  const root = await directory(t);
  const own = pathToFileURL(path.join(root, 'own.mp4')).href;
  for (const value of ['https://example.com/video', 'not a URI', 'file:///bad/%ZZ.mp4', 'file:///bad/encoded%2Fslash', own + '?other=1', own + '#fragment', own + '\r\nhttps://example.com/other', '# comment only\r\n', '']) {
    const { service, state } = setup({}, [new FakeClipboardItem({ [FILES_TYPE]: value })]);
    assert.equal(await service.clearIfWithin(root), false, value);
    assert.equal(state.clears, 0);
  }
});

test('RFC URI-list comments and CRLF are handled without treating comments as files', async (t) => {
  const root = await directory(t);
  const uri = pathToFileURL(path.join(root, 'own.mp4')).href;
  const { service, state } = setup({}, [new FakeClipboardItem({ [FILES_TYPE]: '# file list\r\n' + uri + '\r\n' })]);
  assert.equal(await service.clearIfWithin(root), true);
  assert.equal(state.clears, 1);
});

test('Changed clipboard during asynchronous inspection is preserved', async (t) => {
  const root = await directory(t);
  const owned = [fileItem([path.join(root, 'own.mp4')])];
  const foreign = [new FakeClipboardItem({ 'text/plain': 'newly copied content' })];
  const { service, state } = setup({}, foreign);
  state.readQueue.push(owned, foreign);
  assert.equal(await service.clearIfWithin(root), false);
  assert.equal(state.clears, 0);
  assert.equal(state.items, foreign);
});

test('Clipboard read failures preserve content and give a useful cleanup error', async (t) => {
  const root = await directory(t);
  const { service, state } = setup({}, [fileItem([path.join(root, 'own.mp4')])]);
  state.readError = true;
  await assert.rejects(service.clearIfWithin(root), /No se pudo comprobar.*temporales/);
  assert.equal(state.clears, 0);
});

test('Windows native paths use URI encoding and cleanup containment is case-insensitive', async () => {
  const file = 'C:\\Users\\Nico\\ClipDrop\\transfer-one\\Mañana #1.mp4';
  const { service, state } = setup({ platform: 'win32', fileSystem: { async stat() { return { isFile: () => true }; } } });
  await service.copyFiles([file]);
  await assert.rejects(service.copyFiles(['\\video.mp4']), /ruta del archivo/);
  assert.equal(state.writes[0][0].payload[FILES_TYPE], 'file:///C:/Users/Nico/ClipDrop/transfer-one/Ma%C3%B1ana%20%231.mp4');
  assert.equal(await service.clearIfWithin('c:\\users\\NICO\\clipdrop'), true);
  const sibling = setup({ platform: 'win32' }, [fileItem(['C:\\Users\\Nico\\ClipDrop-other\\file.mp4'], true)]);
  assert.equal(await sibling.service.clearIfWithin('c:\\users\\nico\\clipdrop'), false);
  assert.equal(sibling.state.clears, 0);
});

test('Windows UNC file lists retain share boundaries', async () => {
  const { service, state } = setup({ platform: 'win32' }, [fileItem(['\\\\SERVER\\Share\\ClipDrop\\transfer-one\\video.mp4'], true)]);
  assert.equal(await service.clearIfWithin('\\\\server\\share\\clipdrop'), true);
  assert.equal(state.clears, 1);
});
