'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../src/bridge.js'), 'utf8');
function fixture(invoke = async () => ({ ok: true })) {
  let subscribe;
  let subscribed;
  const ready = new Promise(resolve => { subscribe = resolve; });
  const window = { __TAURI__: { core: { invoke }, event: { listen: (name, callback) => {
    assert.equal(name, 'transfer-event'); subscribed = callback; return ready;
  } } } };
  vm.runInNewContext(source, { window });
  return { api: window.clipdrop, subscribe, event: payload => subscribed({ payload }) };
}
test('bridge waits for events before invoking the download command and preserves request', async () => {
  const calls = [];
  const { api, subscribe, event } = fixture(async (...args) => { calls.push(args); return { ok: true, copied: true }; });
  const events = [];
  const remove = api.onEvent(value => events.push(value));
  const request = { mode: 'copy', url: 'https://x.com/a', destination: 'C:\\Videos' };
  const pending = api.download(request);
  await Promise.resolve();
  assert.equal(calls.length, 0);
  event({ type: 'progress', value: 0.5 });
  subscribe();
  assert.equal((await pending).copied, true);
  assert.equal(calls[0][0], 'download');
  assert.equal(calls[0][1].request, request);
  remove();
  event({ type: 'progress', value: 1 });
  assert.equal(events.length, 1);
});
test('bridge translates every existing UI operation to its Tauri command', async () => {
  const calls = [];
  const { api, subscribe } = fixture(async name => { calls.push(name); return { ok: true }; });
  subscribe();
  for (const name of ['info', 'chooseFolder', 'pasteLink', 'cancel', 'copyResult', 'revealResult', 'cleanTemporary']) await api[name]();
  assert.deepEqual(calls, ['info', 'choose_folder', 'paste_link', 'cancel', 'copy_result', 'reveal_result', 'clean_temporary']);
});
test('native invoke failures become the error contract consumed by the UI', async () => {
  const { api, subscribe } = fixture(async () => { throw 'Clipboard ocupado'; });
  subscribe();
  const result = await api.copyResult();
  assert.equal(result.ok, false);
  assert.match(result.error, /ocupado/);
});
