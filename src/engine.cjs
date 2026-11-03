'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const BROWSERS = new Set(['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale']);
const PROGRESS_PREFIX = 'CLIPDROP_PROGRESS:';
const FILE_PREFIX = 'CLIPDROP_FILE:';

function searchDirectories() {
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) directories.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    if (process.env.USERPROFILE) directories.push(path.join(process.env.USERPROFILE, 'scoop', 'shims'));
  } else {
    directories.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  }
  return [...new Set(directories)];
}

function findExecutable(name = 'yt-dlp') {
  if (!/^[a-zA-Z0-9_-]+(?:\.exe)?$/.test(name)) return null;
  const filename = process.platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
  for (const directory of searchDirectories()) {
    const candidate = path.join(directory, filename);
    try {
      fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Continue through the configured search path. */ }
  }
  return null;
}

function buildArguments({ url, destination, browser }, ffmpegLocation) {
  if (typeof url !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(url)) {
    throw new Error('Ingresá un enlace completo que empiece con https:// o http://.');
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('El enlace del video no es válido.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('El enlace del video debe empezar con https:// o http://.');
  }
  if (typeof destination !== 'string' || !destination.trim() || destination.includes('\0')) {
    throw new Error('Elegí una carpeta local para guardar el video.');
  }
  if (browser && !BROWSERS.has(browser)) throw new Error('El navegador elegido no es compatible.');
  const args = [
    '--ignore-config', '--no-cache-dir', '--no-playlist', '--no-overwrites', '--newline', '--no-colors',
    '--progress', '--progress-template', `download:${PROGRESS_PREFIX}%(progress._percent_str)s`,
    '--print', `after_move:${FILE_PREFIX}%(filepath)j`,
    '--format', ffmpegLocation ? 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best' : 'b[ext=mp4]/b',
    '--format-sort', 'vcodec:h264,res,acodec:aac',
    '--paths', path.resolve(destination), '--output', '%(title).120B [%(id)s].%(ext)s',
  ];
  if (ffmpegLocation) args.push('--ffmpeg-location', ffmpegLocation, '--merge-output-format', 'mp4');
  if (browser) args.push('--cookies-from-browser', browser);
  return [...args, '--', url];
}

function parseLine(line) {
  line = line.replace(/\r$/, '');
  if (!line) return null;
  if (line.startsWith(PROGRESS_PREFIX)) {
    const raw = line.slice(PROGRESS_PREFIX.length).trim().replace(/%$/, '');
    const number = raw === '' ? NaN : Number(raw);
    return Number.isFinite(number) ? { type: 'progress', value: Math.min(1, Math.max(0, number / 100)) } : null;
  }
  if (line.startsWith(FILE_PREFIX)) {
    try {
      const filename = JSON.parse(line.slice(FILE_PREFIX.length));
      if (typeof filename === 'string' && filename) return { type: 'file', path: filename };
    } catch { /* A malformed marker must never become a trusted file path. */ }
    return null;
  }
  return { type: 'message', message: line.slice(0, 2000) };
}

function cancellationError() {
  const error = new Error('Descarga cancelada.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function stopChild(child) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const killer = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      killer.once('error', () => {
        try { child.kill('SIGKILL'); } catch { /* Already gone. */ }
        resolve();
      });
      killer.once('close', (code) => {
        if (code !== 0) { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
        resolve();
      });
    });
  }
  // Spawned with detached:true, so this PID is the new group leader. Kill the
  // whole owned group together, including ffmpeg or other downloader children.
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if (error.code !== 'ESRCH') { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
  }
  return Promise.resolve();
}

class DownloadEngine {
  constructor({ executable, ffmpegLocation } = {}) {
    this.executable = executable;
    this.ffmpegLocation = ffmpegLocation;
    this.active = null;
  }

  async cancel() {
    const state = this.active;
    if (!state) return;
    state.cancelled = true;
    if (state.child && !state.closed) {
      state.stopPromise ||= stopChild(state.child);
      await state.stopPromise;
    }
  }

  async download(request, onEvent = () => {}) {
    if (this.active) throw new Error('Ya hay una descarga en curso.');
    const ffmpeg = this.ffmpegLocation || findExecutable('ffmpeg');
    const args = buildArguments(request, ffmpeg);
    const executable = this.executable || findExecutable();
    if (!executable) throw new Error('No se encontró yt-dlp. Instalalo y volvé a abrir ClipDrop.');
    const state = { child: null, cancelled: false, closed: false, stopPromise: null };
    this.active = state;
    try {
      await fs.promises.mkdir(path.resolve(request.destination), { recursive: true });
      if (state.cancelled) throw cancellationError();
      const files = await this.run(executable, args, state, onEvent);
      if (state.cancelled) throw cancellationError();
      const root = await fs.promises.realpath(path.resolve(request.destination));
      const verified = [];
      for (const filename of files) {
        if (!path.isAbsolute(filename)) throw new Error('yt-dlp devolvió una ruta de archivo inválida.');
        const actual = await fs.promises.realpath(filename);
        const relative = path.relative(root, actual);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('yt-dlp devolvió un archivo fuera de la carpeta elegida.');
        }
        const stat = await fs.promises.stat(actual);
        if (!stat.isFile() || stat.size === 0) throw new Error('El video descargado está vacío o no es un archivo.');
        if (!verified.includes(actual)) verified.push(actual);
      }
      if (state.cancelled) throw cancellationError();
      if (!verified.length) throw new Error('yt-dlp terminó sin devolver un archivo descargado.');
      return verified;
    } catch (error) {
      if (state.cancelled) throw cancellationError();
      if (error.code === 'ENOENT' && !state.child) throw new Error('No se encontró el ejecutable de yt-dlp o la carpeta elegida.');
      throw error;
    } finally {
      if (this.active === state) this.active = null;
    }
  }

  run(executable, args, state, onEvent) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: searchDirectories().join(path.delimiter) },
      });
      state.child = child;
      const files = [];
      const diagnostics = [];
      let spawnError;
      const consume = (line) => {
        const event = parseLine(line);
        if (!event) return;
        if (event.type === 'file') { files.push(event.path); return; }
        if (event.type === 'message') {
          diagnostics.push(event.message);
          if (diagnostics.length > 12) diagnostics.shift();
        }
        try { onEvent(event); } catch { /* UI observers cannot break pipe draining. */ }
      };
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8');
        let pending = '';
        stream.on('data', (data) => {
          pending += decoder.write(data);
          let index;
          while ((index = pending.indexOf('\n')) !== -1) {
            consume(pending.slice(0, index));
            pending = pending.slice(index + 1);
          }
          if (pending.length > 64 * 1024) { consume(pending); pending = ''; }
        });
        stream.once('end', () => { pending += decoder.end(); if (pending) consume(pending); });
        stream.on('error', (error) => { spawnError ||= error; });
      }
      child.once('error', (error) => { spawnError = error; });
      child.once('close', (code, signal) => {
        state.closed = true;
        if (state.cancelled) { reject(cancellationError()); return; }
        if (spawnError) {
          reject(new Error(`No se pudo ejecutar yt-dlp: ${spawnError.message}`)); return;
        }
        if (code !== 0) {
          const detail = diagnostics.join('\n') || `yt-dlp terminó ${signal ? `por señal ${signal}` : `con código ${code}`}.`;
          reject(new Error(`No se pudo descargar el video.\n${detail}`)); return;
        }
        resolve(files);
      });
      if (state.cancelled) state.stopPromise ||= stopChild(child);
    });
  }
}

module.exports = { DownloadEngine, findExecutable, buildArguments, parseLine };
