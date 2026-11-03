'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { TemporaryStorage } = require('../src/storage.cjs');

const sourceDirectory = path.resolve(__dirname, '..', 'src');
const sourcePath = path.join(sourceDirectory, 'main.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ClipDropMainTest-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { temp: path.join(root, 'temp'), userData: path.join(root, 'profile'), downloads: path.join(root, 'downloads') };
  await Promise.all(Object.values(paths).map((directory) => fs.mkdir(directory, { recursive: true })));
  const handlers = new Map();
  const events = [];
  const engineCalls = [];
  const clipboardCalls = [];
  const clearCalls = [];
  const controls = { copyError: options.copyError, cancelCalls: 0, revealed: [], readyError: null };
  let initialization;
  let window;

  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      window = this;
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, event) => events.push({ channel, event });
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.session = { setPermissionRequestHandler() {} };
    }
    isDestroyed() { return false; }
    async loadFile() {}
  }
  class FakeEngine {
    async download(request, onEvent) {
      engineCalls.push(request);
      if (options.download) return options.download(request, onEvent);
      await fs.mkdir(request.destination, { recursive: true });
      const file = path.join(request.destination, `Video ñ ${engineCalls.length}.mp4`);
      await fs.writeFile(file, 'synthetic video fixture');
      onEvent({ type: 'progress', value: 1 });
      return [file];
    }
    async cancel() { controls.cancelCalls++; }
  }
  class TestStorage extends TemporaryStorage {
    async create() {
      const directory = await super.create();
      if (options.createGate) {
        options.createGate.started.resolve(directory);
        await options.createGate.finish.promise;
      }
      return directory;
    }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    getPath: (name) => paths[name],
    getAppPath: () => path.resolve(sourceDirectory, '..'),
    quit() {},
    whenReady: () => ({ then(callback) { initialization = Promise.resolve().then(callback); return initialization; } }),
  });
  const electron = {
    app, BrowserWindow: FakeWindow,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    clipboard: { readText: async () => ' https://x.com/user/status/123 ' },
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [paths.downloads] }),
      showErrorBox: (_title, message) => { controls.readyError = message; },
    },
    shell: { showItemInFolder: (file) => controls.revealed.push(file) },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => template },
  };
  const fileClipboard = {
    async copyFiles(files) {
      if (!files.length) throw new Error('No hay archivos para copiar.');
      for (const file of files) assert.ok((await fs.stat(file)).isFile());
      clipboardCalls.push([...files]);
      if (options.copyGate?.enabled) {
        options.copyGate.started.resolve();
        await options.copyGate.finish.promise;
      }
      if (controls.copyError) throw new Error(controls.copyError);
    },
    async clearIfWithin(directory) { clearCalls.push(directory); },
  };
  const sandboxRequire = (name) => {
    if (name === 'electron') return electron;
    if (name === './engine.cjs') return { DownloadEngine: FakeEngine, findExecutable: () => process.execPath };
    if (name === './clipboard.cjs') return fileClipboard;
    if (name === './storage.cjs') return { TemporaryStorage: TestStorage };
    return require(name);
  };
  vm.runInNewContext(await fs.readFile(sourcePath, 'utf8'), {
    require: sandboxRequire, __dirname: sourceDirectory, __filename: sourcePath,
    process, console, Buffer, setTimeout, clearTimeout,
  }, { filename: sourcePath });
  await initialization;
  assert.equal(controls.readyError, null);
  assert.ok(window);
  const sender = () => ({ sender: window.webContents, senderFrame: { url: pathToFileURL(path.join(sourceDirectory, 'ui', 'index.html')).href } });
  const invoke = (channel, ...args) => {
    assert.ok(handlers.has(channel), `handler registered: ${channel}`);
    return handlers.get(channel)(sender(), ...args);
  };
  return { root, paths, controls, handlers, sender, invoke, engineCalls, clipboardCalls, clearCalls, events,
    temporaryRoot: path.join(paths.temp, 'ClipDrop', 'transfers') };
}

test('Paste awaits the Electron clipboard promise before trimming the link', async t => {
  const app = await harness(t);
  const result = await app.invoke('paste-link');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'https://x.com/user/status/123');
});

test('Main save pipeline preserves destination, returns files and supports copy/reveal', async (t) => {
  const app = await harness(t);
  const destination = path.join(app.paths.downloads, 'carpeta elegida');
  const result = await app.invoke('download', { mode: 'save', url: ' https://x.com/user/status/123 ', destination });
  assert.equal(result.ok, true);
  assert.equal(result.copied, false);
  assert.equal(result.files.length, 1);
  assert.equal(app.engineCalls[0].destination, destination);
  assert.equal(app.engineCalls[0].url, 'https://x.com/user/status/123');
  assert.equal(app.clipboardCalls.length, 0);
  assert.ok((await fs.stat(result.files[0].path)).isFile());
  const preferences = JSON.parse(await fs.readFile(path.join(app.paths.userData, 'preferences.json'), 'utf8'));
  assert.equal(preferences.destination, destination);
  assert.equal((await app.invoke('copy-result')).ok, true);
  assert.equal(app.clipboardCalls[0][0], result.files[0].path);
  assert.equal((await app.invoke('reveal-result')).ok, true);
  assert.equal(app.controls.revealed[0], result.files[0].path);
  const busy = app.events.filter(({ event }) => event.type === 'busy').map(({ event }) => event.value);
  assert.deepEqual(busy, [true, false]);
});

test('Main copy pipeline writes private temporary file; cleaning preserves saved videos', async (t) => {
  const app = await harness(t);
  const saved = await app.invoke('download', { mode: 'save', url: 'https://x.com/user/status/1', destination: app.paths.downloads });
  const copied = await app.invoke('download', { mode: 'copy', url: 'https://x.com/user/status/2' });
  assert.equal(copied.ok, true);
  assert.equal(copied.copied, true);
  assert.ok(copied.temporaryBytes > 0);
  assert.ok(path.relative(app.temporaryRoot, copied.files[0].path).startsWith('transfer-'));
  assert.equal(app.clipboardCalls[0][0], copied.files[0].path);
  const clean = await app.invoke('clean-temporary');
  assert.equal(clean.ok, true);
  assert.equal(clean.temporaryBytes, 0);
  assert.equal(clean.hasFiles, false);
  assert.equal(await fs.readFile(saved.files[0].path, 'utf8'), 'synthetic video fixture');
  await assert.rejects(fs.stat(copied.files[0].path), { code: 'ENOENT' });
  assert.equal(app.clearCalls.length, 1);
  assert.equal((await app.invoke('copy-result')).ok, false);
});

test('Clipboard failure retains downloaded temporary result and allows retry', async (t) => {
  const app = await harness(t, { copyError: 'Clipboard ocupado (fixture)' });
  const result = await app.invoke('download', { mode: 'copy', url: 'https://x.com/user/status/123' });
  assert.equal(result.ok, true);
  assert.equal(result.copied, false);
  assert.match(result.warning, /Clipboard ocupado/);
  assert.ok(result.temporaryBytes > 0);
  assert.equal(await fs.readFile(result.files[0].path, 'utf8'), 'synthetic video fixture');
  app.controls.copyError = null;
  assert.equal((await app.invoke('copy-result')).ok, true);
  assert.equal(app.clipboardCalls[1][0], result.files[0].path);
});

test('Cancel while temporary creation awaits prevents engine start and removes job', async (t) => {
  const createGate = { started: deferred(), finish: deferred() };
  const app = await harness(t, { createGate });
  const pending = app.invoke('download', { mode: 'copy', url: 'https://x.com/user/status/123' });
  const job = await createGate.started.promise;
  assert.ok((await fs.stat(job)).isDirectory());
  assert.equal((await app.invoke('cancel')).ok, true);
  createGate.finish.resolve();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, true);
  assert.equal(app.engineCalls.length, 0);
  assert.equal(app.clipboardCalls.length, 0);
  await assert.rejects(fs.stat(job), { code: 'ENOENT' });
});

test('Permanent downloads into application temporary area are rejected', async (t) => {
  const app = await harness(t);
  for (const destination of [app.temporaryRoot, path.join(app.temporaryRoot, 'transfer-owned', 'nested')]) {
    const result = await app.invoke('download', { mode: 'save', url: 'https://x.com/user/status/123', destination });
    assert.equal(result.ok, false);
    assert.match(result.error, /fuera de los temporales/);
  }
  assert.equal(app.engineCalls.length, 0);
});

test('Symlink alias into temporary storage cannot be used for permanent saves', { skip: process.platform === 'win32' ? 'Creating a directory symlink may require Windows developer mode.' : false }, async (t) => {
  const app = await harness(t);
  const alias = path.join(app.paths.downloads, 'alias-to-temporary');
  await fs.symlink(app.temporaryRoot, alias, 'dir');
  const result = await app.invoke('download', { mode: 'save', url: 'https://x.com/user/status/123', destination: path.join(alias, 'transfer-example') });
  assert.equal(result.ok, false);
  assert.match(result.error, /fuera de los temporales/);
  assert.equal(app.engineCalls.length, 0);
});

test('A retry copying files excludes concurrent cleanup and new downloads', async (t) => {
  const copyGate = { enabled: false, started: deferred(), finish: deferred() };
  const app = await harness(t, { copyGate });
  const saved = await app.invoke('download', { mode: 'save', url: 'https://x.com/user/status/123', destination: app.paths.downloads });
  copyGate.enabled = true;
  const copying = app.invoke('copy-result');
  await copyGate.started.promise;
  const cleaning = await app.invoke('clean-temporary');
  const downloading = await app.invoke('download', { mode: 'copy', url: 'https://x.com/user/status/456' });
  assert.equal(cleaning.ok, false);
  assert.equal(downloading.ok, false);
  assert.match(cleaning.error, /operación actual/);
  assert.equal(app.clearCalls.length, 0);
  assert.equal(app.engineCalls.length, 1);
  copyGate.finish.resolve();
  assert.equal((await copying).ok, true);
  assert.equal(await fs.readFile(saved.files[0].path, 'utf8'), 'synthetic video fixture');
});

test('Engine failure removes only copy jobs and preserves partial permanent downloads', async (t) => {
  const app = await harness(t, { download: async ({ destination }) => {
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'partial.mp4.part'), 'partial fixture');
    throw new Error('Download failed (fixture)');
  } });
  const copy = await app.invoke('download', { mode: 'copy', url: 'https://x.com/user/status/123' });
  assert.equal(copy.ok, false);
  assert.match(copy.error, /Download failed/);
  assert.equal((await app.invoke('info')).temporaryBytes, 0);
  const save = await app.invoke('download', { mode: 'save', url: 'https://x.com/user/status/123', destination: app.paths.downloads });
  assert.equal(save.ok, false);
  assert.equal(await fs.readFile(path.join(app.paths.downloads, 'partial.mp4.part'), 'utf8'), 'partial fixture');
  assert.equal(app.clipboardCalls.length, 0);
});

test('IPC requires both trusted webContents and exact page frame URL', async (t) => {
  const app = await harness(t);
  const info = app.handlers.get('info');
  const valid = app.sender();
  await assert.rejects(info({ ...valid, sender: {} }), /Solicitud no permitida/);
  await assert.rejects(info({ ...valid, senderFrame: { url: 'https://evil.example/' } }), /Solicitud no permitida/);
  await assert.rejects(info({ ...valid, senderFrame: undefined }), /Solicitud no permitida/);
  assert.equal((await info(valid)).ok, true);
  assert.equal((await app.invoke('paste-link')).text, 'https://x.com/user/status/123');
});
