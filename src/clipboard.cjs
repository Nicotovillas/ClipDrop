'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');

const FILES_TYPE = 'text/uri-list';

// Dependencies are injectable so Node tests never touch the system clipboard.
// Production callers receive only file operations, not arbitrary MIME payloads.
function createFileClipboard({ clipboard, ClipboardItem, platform = process.platform, fileSystem = fs }) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;

  function isAbsoluteFilePath(file) {
    if (typeof file !== 'string' || !paths.isAbsolute(file) || file.includes('\0')) return false;
    // On Windows, isAbsolute also accepts a current-drive-relative path such as
    // \\video.mp4. Require an explicit drive or complete UNC server/share before
    // URL conversion, which otherwise may silently fill in the current drive.
    return !windows || /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(file);
  }

  function supported() {
    if (!clipboard || typeof ClipboardItem !== 'function' || typeof clipboard.write !== 'function' || typeof clipboard.read !== 'function') {
      throw new Error('Esta versión de ClipDrop no puede copiar archivos. Actualizá la aplicación y reintentá.');
    }
  }

  async function copyFiles(files) {
    supported();
    if (!Array.isArray(files) || files.length === 0) throw new Error('No hay archivos para copiar.');
    const uris = [];
    // Validate every file before constructing or writing the single clipboard item.
    for (const file of files) {
      if (!isAbsoluteFilePath(file)) {
        throw new Error('La ruta del archivo no es válida. Volvé a descargar el video.');
      }
      let stat;
      try { stat = await fileSystem.stat(file); }
      catch { throw new Error('El archivo ya no está disponible. Volvé a descargar el video.'); }
      if (!stat.isFile()) throw new Error('No se puede copiar una carpeta como video.');
      try {
        const uri = pathToFileURL(file, { windows });
        if (uri.protocol !== 'file:' || !isAbsoluteFilePath(fileURLToPath(uri, { windows }))) throw new Error();
        uris.push(uri.href);
      } catch { throw new Error('La ruta del archivo no es válida. Volvé a descargar el video.'); }
    }
    try {
      // Electron maps this to CF_HDROP on Windows and the native macOS file list.
      // A single write is atomic and does not require clearing existing content.
      await clipboard.write([new ClipboardItem({ [FILES_TYPE]: uris.join('\r\n') })]);
    } catch {
      throw new Error('No se pudo copiar el video al portapapeles. Cerrá diálogos abiertos y reintentá.');
    }
  }

  function isWithin(root, file) {
    const relative = paths.relative(root, file);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
  }

  async function ownedSnapshot(root) {
    const items = await clipboard.read();
    if (!Array.isArray(items) || items.length === 0) return null;
    const snapshot = [];
    for (const item of items) {
      const types = item?.types;
      // Preserve text/images/custom entries. Native OS aliases may accompany
      // the file MIME without carrying an independent clipboard item.
      if (!Array.isArray(types) || !types.includes(FILES_TYPE) || types.some(type => typeof type !== 'string' || (type !== FILES_TYPE && !type.startsWith('electron application/osclipboard;')))) return null;
      const blob = await item.getType(FILES_TYPE);
      const text = await blob.text();
      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
      if (lines.length === 0) return null;
      const files = [];
      for (const line of lines) {
        let file;
        try {
          const uri = new URL(line);
          if (uri.protocol !== 'file:' || uri.search || uri.hash) return null;
          file = fileURLToPath(uri, { windows });
        } catch { return null; }
        if (!isAbsoluteFilePath(file) || !isWithin(root, file)) return null;
        files.push(file);
      }
      snapshot.push({ types: [...types].sort(), files });
    }
    return JSON.stringify(snapshot);
  }

  async function clearIfWithin(root) {
    supported();
    if (!isAbsoluteFilePath(root)) {
      throw new Error('La carpeta temporal no es válida.');
    }
    root = paths.resolve(root);
    try {
      const before = await ownedSnapshot(root);
      if (before === null) return false;
      // Another application can replace the clipboard while Blob reads await.
      // Re-check immediately before clearing and preserve changed/mixed content.
      if (await ownedSnapshot(root) !== before) return false;
      await clipboard.clear();
      return true;
    } catch {
      throw new Error('No se pudo comprobar el portapapeles. Reintentá limpiar los temporales.');
    }
  }

  return { copyFiles, clearIfWithin };
}

let nativeClipboard;
function implementation() {
  if (!nativeClipboard) {
    const { clipboard, ClipboardItem } = require('electron');
    nativeClipboard = createFileClipboard({ clipboard, ClipboardItem });
  }
  return nativeClipboard;
}

module.exports = {
  copyFiles: files => implementation().copyFiles(files),
  clearIfWithin: root => implementation().clearIfWithin(root),
  createFileClipboard,
};
