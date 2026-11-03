'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DownloadEngine, findExecutable } = require('./engine.cjs');
const fileClipboard = require('./clipboard.cjs');
const { TemporaryStorage } = require('./storage.cjs');

let window;
let engine;
let activeJob = false;
let clipboardBusy = false;
let cancelled = false;
let resultFiles = [];
let storage;
let destination;
const pageURL = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
app.name = 'ClipDrop';

function emit(event) {
  if (window && !window.isDestroyed()) window.webContents.send('transfer-event', event);
}
function verifySender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pageURL) {
    throw new Error('Solicitud no permitida.');
  }
}
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    verifySender(event);
    try { return { ok: true, ...(await action(...args)) }; }
    catch (error) { return { ok: false, error: error.message || 'Ocurrió un error inesperado.' }; }
  });
}
function idle() { if (activeJob || clipboardBusy) throw new Error('Esperá a que termine la operación actual.'); }
function ytDlp() {
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
    : path.join(app.getAppPath(), 'tools', process.platform, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  return fsSync.existsSync(bundled) ? bundled : findExecutable('yt-dlp');
}
async function info() {
  return { destination, available: Boolean(ytDlp()), platform: process.platform,
    temporaryBytes: await storage.bytes(), ffmpeg: Boolean(findExecutable('ffmpeg')) };
}

function registerHandlers() {
  handle('info', info);
  handle('paste-link', async () => ({ text: (await clipboard.readText()).trim() }));
  handle('choose-folder', async () => {
    idle();
    const choice = await dialog.showOpenDialog(window, { defaultPath: destination,
      properties: ['openDirectory', 'createDirectory'], title: 'Carpeta para los videos' });
    if (choice.canceled) return { cancelled: true };
    destination = choice.filePaths[0];
    await savePreferences();
    return { destination };
  });
  handle('download', async request => {
    idle();
    if (!request || !['save', 'copy'].includes(request.mode) || typeof request.url !== 'string' || request.url.length > 8192) {
      throw new Error('Ingresá el enlace del video.');
    }
    const executable = ytDlp();
    if (!executable) throw new Error('No se encontró yt-dlp. Revisá las instrucciones de instalación.');
    let target;
    activeJob = true;
    cancelled = false;
    resultFiles = [];
    emit({ type: 'busy', value: true });
    try {
      if (request.mode === 'copy') target = await storage.create();
      else {
        if (typeof request.destination !== 'string' || request.destination.length > 4096 || !path.isAbsolute(request.destination.trim())) {
          throw new Error('Elegí una carpeta o ingresá una ruta completa.');
        }
        target = path.resolve(request.destination.trim());
        await fs.mkdir(target, { recursive: true });
        target = await fs.realpath(target);
        // Las descargas permanentes deben mantenerse fuera del área que limpia la app.
        if (target === storage.root || storage.contains(target)) throw new Error('Elegí una carpeta fuera de los temporales de ClipDrop.');
        destination = target;
        await savePreferences();
      }
      if (cancelled) throw Object.assign(new Error('Descarga cancelada.'), { code: 'ABORT_ERR' });
      engine = new DownloadEngine({ executable });
      const files = await engine.download({ url: request.url.trim(), destination: target, browser: request.browser || undefined }, emit);
      if (cancelled) throw Object.assign(new Error('Descarga cancelada.'), { code: 'ABORT_ERR' });
      resultFiles = files;
      if (request.mode === 'copy') {
        try { await fileClipboard.copyFiles(files); }
        catch (error) {
          return { files: files.map(file => ({ name: path.basename(file), path: file })), copied: false,
            warning: error.message, temporaryBytes: await storage.bytes() };
        }
      }
      return { files: files.map(file => ({ name: path.basename(file), path: file })),
        copied: request.mode === 'copy', temporaryBytes: await storage.bytes() };
    } catch (error) {
      if (request.mode === 'copy' && target) await storage.removeJob(target).catch(() => {});
      if (cancelled || error.code === 'ABORT_ERR') return { cancelled: true, temporaryBytes: await storage.bytes() };
      throw error;
    } finally {
      engine = undefined;
      activeJob = false;
      emit({ type: 'busy', value: false });
    }
  });
  handle('cancel', async () => {
    if (activeJob) { cancelled = true; await engine?.cancel(); }
    return {};
  });
  handle('copy-result', async () => {
    idle();
    clipboardBusy = true;
    try { await fileClipboard.copyFiles(resultFiles); return {}; }
    finally { clipboardBusy = false; }
  });
  handle('reveal-result', async () => {
    idle();
    if (!resultFiles.length) throw new Error('No hay archivos para mostrar.');
    if (!fsSync.existsSync(resultFiles[0])) throw new Error('El archivo ya no está disponible.');
    shell.showItemInFolder(resultFiles[0]);
    return {};
  });
  handle('clean-temporary', async () => {
    idle();
    clipboardBusy = true;
    try {
    const answer = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancelar', 'Limpiar'],
      defaultId: 0, cancelId: 0, title: 'Limpiar temporales', message: '¿Eliminar los videos temporales?',
      detail: 'Un video copiado desde esa carpeta dejará de estar disponible para pegar. Los videos guardados en tu carpeta se conservan.' });
    if (answer.response !== 1) return { cancelled: true };
    // Si otro contenido reemplazó el portapapeles, se conserva intacto.
    await fileClipboard.clearIfWithin(storage.root);
    await storage.clean();
    resultFiles = resultFiles.filter(file => !storage.contains(file));
    return { temporaryBytes: await storage.bytes(), hasFiles: resultFiles.length > 0 };
    } finally { clipboardBusy = false; }
  });
}

async function savePreferences() {
  const file = path.join(app.getPath('userData'), 'preferences.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify({ destination }), { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    destination = app.getPath('downloads');
    try {
      const saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'preferences.json'), 'utf8'));
      if (typeof saved.destination === 'string' && path.isAbsolute(saved.destination)) destination = saved.destination;
    } catch { /* Primera apertura o preferencias inválidas: usar Descargas. */ }
    storage = new TemporaryStorage(path.join(app.getPath('temp'), 'ClipDrop', 'transfers'));
    await storage.initialize();
    registerHandlers();
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
      { label: 'ClipDrop', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'windowMenu' }
    ]) : null);
    window = new BrowserWindow({ width: 560, height: 300, minWidth: 520, minHeight: 280, useContentSize: true,
      title: 'ClipDrop', icon: path.join(__dirname, '..', 'assets', 'icon.png'), backgroundColor: '#202624', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('close', event => {
      if (activeJob) {
        event.preventDefault();
        dialog.showMessageBox(window, { type: 'info', message: 'Hay una descarga en curso.',
          detail: 'Cancelala antes de cerrar ClipDrop.', buttons: ['Volver'] });
      }
    });
    await window.loadFile(path.join(__dirname, 'ui', 'index.html'));
  }).catch(error => { dialog.showErrorBox('ClipDrop', error.message); app.quit(); });
  app.on('before-quit', event => { if (activeJob) event.preventDefault(); });
  app.on('window-all-closed', () => app.quit());
}
