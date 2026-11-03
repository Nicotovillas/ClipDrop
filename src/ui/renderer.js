'use strict';
const api = window.clipdrop;
const $ = id => document.getElementById(id);
let busy = false;
let available = false;
let bytes = 0;
let logs = '';

function showError(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
function status(message, success = false) { $('status').textContent = message; $('status').classList.toggle('success', success); }
function updateButtons() {
  const valid = Boolean($('url').value.trim());
  $('fields').disabled = busy;
  $('config-fields').disabled = busy;
  $('save').disabled = busy || !available || !valid;
  $('copy').disabled = busy || !available || !valid;
  $('clean').disabled = busy || bytes === 0;
  $('reveal').disabled = busy;
  $('copy-result').disabled = busy;
  $('cancel').hidden = !busy;
}
function temporarySize(value) {
  bytes = value || 0;
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = bytes, index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++; }
  $('temporary-size').textContent = `${amount.toLocaleString('es-AR', { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
  updateButtons();
}
function showFiles(files) {
  $('file-list').replaceChildren(...files.map(file => {
    const item = document.createElement('li');
    item.textContent = file.name;
    item.title = file.path;
    return item;
  }));
  $('results').hidden = files.length === 0;
}
async function action(work) {
  try {
    const result = await work();
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (error) { showError(error.message); return null; }
}
async function download(mode) {
  if (busy || !available || !$('url').value.trim()) return;
  if (!$('url').reportValidity()) return;
  busy = true;
  updateButtons();
  showError('');
  showFiles([]);
  logs = '';
  $('log').textContent = '';
  $('log-details').hidden = true;
  $('progress').hidden = false;
  $('progress').removeAttribute('value');
  $('cancel').disabled = false;
  status('Buscando el video…');
  const result = await action(() => api.download({ url: $('url').value.trim(),
    destination: $('destination').value, browser: $('browser').value, mode }));
  busy = false;
  $('progress').hidden = true;
  updateButtons();
  if (!result) { status('No se pudo completar la descarga.'); return; }
  if (result.temporaryBytes !== undefined) temporarySize(result.temporaryBytes);
  if (result.cancelled) { status('Descarga cancelada.'); return; }
  showFiles(result.files || []);
  if (result.warning) {
    showError(result.warning);
    status('Video descargado. Podés reintentar la copia o abrir su carpeta.');
  } else status(result.copied ? 'Video copiado. Pegalo con Ctrl+V (⌘V en Mac).' : 'Video guardado en tu carpeta.', true);
}

$('download-form').addEventListener('submit', event => { event.preventDefault(); void download('save'); });
$('copy').addEventListener('click', () => void download('copy'));
$('url').addEventListener('input', updateButtons);
$('paste').addEventListener('click', async () => {
  const result = await action(() => api.pasteLink());
  if (result) { $('url').value = result.text; updateButtons(); $('url').focus(); }
});
$('choose').addEventListener('click', async () => {
  const result = await action(() => api.chooseFolder());
  if (result?.destination) {
    $('destination').value = result.destination;
    $('destination').title = result.destination;
    $('config-status').textContent = 'Carpeta guardada.';
  }
});
$('cancel').addEventListener('click', async () => {
  $('cancel').disabled = true;
  status('Cancelando…');
  await action(() => api.cancel());
});
$('copy-result').addEventListener('click', async () => {
  if (await action(() => api.copyResult())) status('Archivo copiado. Listo para pegar.', true);
});
$('reveal').addEventListener('click', () => void action(() => api.revealResult()));
$('clean').addEventListener('click', async () => {
  const result = await action(() => api.cleanTemporary());
  if (result && !result.cancelled) {
    temporarySize(result.temporaryBytes);
    if (!result.hasFiles) showFiles([]);
    $('config-status').textContent = 'Temporales eliminados.';
  }
});
function selectTab(tab) {
  for (const id of ['download', 'config']) {
    const selected = id === tab;
    $(`${id}-tab`).setAttribute('aria-selected', String(selected));
    $(`${id}-tab`).tabIndex = selected ? 0 : -1;
    $(`${id}-panel`).hidden = !selected;
  }
}
for (const id of ['download', 'config']) {
  $(`${id}-tab`).addEventListener('click', () => selectTab(id));
  $(`${id}-tab`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'download' : event.key === 'End' ? 'config' : id === 'download' ? 'config' : 'download';
    selectTab(target);
    $(`${target}-tab`).focus();
  });
}
api.onEvent(event => {
  if (event.type === 'progress' && busy) {
    $('progress').value = event.value;
    status(`Descargando… ${Math.round(event.value * 100)} %`);
  } else if (event.type === 'message') {
    logs = (logs + event.message + '\n').slice(-24000);
    $('log').textContent = logs;
    $('log-details').hidden = false;
  }
});
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    void download('save');
  }
});
(async () => {
  const info = await action(() => api.info());
  if (!info) return;
  $('destination').value = info.destination;
  $('destination').title = info.destination;
  $('safari').hidden = info.platform !== 'darwin';
  available = info.available;
  if (!available) {
    $('missing').hidden = false;
    $('missing').textContent = info.platform === 'darwin'
      ? 'Falta yt-dlp. Instalalo desde Terminal con: brew install yt-dlp ffmpeg. Después volvé a abrir ClipDrop.'
      : 'Falta yt-dlp.exe. Usá el ZIP completo de ClipDrop o instalá yt-dlp y agregalo al PATH.';
  }
  temporarySize(info.temporaryBytes);
})();
