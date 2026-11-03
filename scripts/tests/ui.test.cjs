'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const api = {
    info: async () => ({ ok: true, available: true, destination: 'C:\\Users\\Nico\\Videos', platform: 'win32', temporaryBytes: 0 }),
    onEvent: callback => { api.event = callback; },
    pasteLink: async () => ({ ok: true, text: 'https://x.com/test/status/123' }),
    ...overrides
  };
  dom.window.clipdrop = api;
  dom.window.eval(script);
  await tick();
  return { dom, api, document: dom.window.document, $: id => dom.window.document.getElementById(id) };
}
test('pegar enlace habilita descarga y conserva carpeta de Windows', async t => {
  const { $ } = await fixture(t);
  assert.equal($('save').disabled, true);
  $('paste').click();
  await tick();
  assert.equal($('url').value, 'https://x.com/test/status/123');
  assert.equal($('save').disabled, false);
  assert.equal($('destination').value, 'C:\\Users\\Nico\\Videos');
  assert.equal($('config-panel').hidden, true);
  assert.equal($('download-panel').contains($('destination')), false);
});
test('copiar mantiene bloqueo hasta terminar y muestra nombres como texto', async t => {
  let finish;
  let request;
  const { $, api, dom } = await fixture(t, { download: value => {
    request = value;
    return new Promise(resolve => { finish = resolve; });
  } });
  $('url').value = 'https://x.com/test/status/123';
  $('url').dispatchEvent(new dom.window.Event('input'));
  $('copy').click();
  assert.equal($('fields').disabled, true);
  assert.equal(request.mode, 'copy');
  assert.equal(request.destination, 'C:\\Users\\Nico\\Videos');
  api.event({ type: 'progress', value: 0.42 });
  assert.equal($('progress').value, 0.42);
  finish({ ok: true, copied: true, files: [{ name: '<img src=x onerror=bad>.mp4', path: 'C:\\temp\\archivo.mp4' }], temporaryBytes: 1024 });
  await tick();
  assert.equal($('fields').disabled, false);
  assert.match($('status').textContent, /copiado/);
  assert.equal($('file-list').querySelector('img'), null);
  assert.equal($('file-list').textContent, '<img src=x onerror=bad>.mp4');
  assert.equal($('clean').disabled, false);
});
test('error de descarga vuelve a habilitar el formulario y ofrece mensaje', async t => {
  const { $, dom } = await fixture(t, { download: async () => ({ ok: false, error: 'El sitio requiere sesión.' }) });
  $('url').value = 'https://x.com/test/status/123';
  $('url').dispatchEvent(new dom.window.Event('input'));
  $('copy').click();
  await tick();
  assert.equal($('fields').disabled, false);
  assert.equal($('copy').disabled, false);
  assert.equal($('error').textContent, 'El sitio requiere sesión.');
  assert.equal($('progress').hidden, true);
});
test('sin motor bloquea descarga y explica instalación de Mac', async t => {
  const { $ } = await fixture(t, { info: async () => ({ ok: true, available: false, destination: '/tmp/Videos', platform: 'darwin' }) });
  assert.equal($('copy').disabled, true);
  assert.equal($('missing').hidden, false);
  assert.match($('missing').textContent, /brew install/);
});
test('Config guarda la carpeta y Descarga la usa al volver sin perder el enlace', async t => {
  let request;
  const { $, dom } = await fixture(t, {
    chooseFolder: async () => ({ ok: true, destination: 'C:\\Videos elegidos' }),
    download: async value => { request = value; return { ok: true, files: [] }; }
  });
  $('url').value = 'https://x.com/test/status/123';
  $('url').dispatchEvent(new dom.window.Event('input'));
  $('config-tab').click();
  assert.equal($('config-panel').hidden, false);
  assert.equal($('download-panel').hidden, true);
  assert.equal($('config-tab').getAttribute('aria-selected'), 'true');
  $('choose').click();
  await tick();
  assert.equal($('destination').value, 'C:\\Videos elegidos');
  $('config-tab').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal($('download-panel').hidden, false);
  assert.equal($('config-panel').hidden, true);
  assert.equal(dom.window.document.activeElement, $('download-tab'));
  $('save').click();
  await tick();
  assert.equal(request.destination, 'C:\\Videos elegidos');
  assert.equal(request.url, 'https://x.com/test/status/123');
});
