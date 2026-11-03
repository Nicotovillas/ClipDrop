'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { nsisPayload } = require('../windows.cjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const compiled = Buffer.concat([Buffer.from([0x4d, 0x5a, 0, 255]), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'), Buffer.from([0, 42, 128])]);

test('packaged NSIS variant matches exactly and leaves the compiler output intact', () => {
  const original = Buffer.from(compiled);
  const installed = Buffer.concat([Buffer.from([0x4d, 0x5a, 0, 255]), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS'), Buffer.from([0, 42, 128])]);
  assert.equal(sha256(installed), sha256(nsisPayload(compiled)));
  assert.deepEqual(compiled, original);
  assert.notEqual(sha256(installed), sha256(compiled));
  for (const offset of [0, installed.length - 1]) {
    const corrupted = Buffer.from(installed);
    corrupted[offset] ^= 1;
    assert.notEqual(sha256(corrupted), sha256(nsisPayload(compiled)), 'unrelated payload changes must fail verification');
  }
});

test('missing or already packaged bundle marker fails rather than weakening comparison', () => {
  assert.throws(() => nsisPayload(Buffer.from('different executable')), /marcador/);
  assert.throws(() => nsisPayload(nsisPayload(compiled)), /marcador/);
});

test('only the first token is patched, matching Tauri bundler behavior', () => {
  const input = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK;__TAURI_BUNDLE_TYPE_VAR_UNK');
  assert.equal(nsisPayload(input).toString(), '__TAURI_BUNDLE_TYPE_VAR_NSS;__TAURI_BUNDLE_TYPE_VAR_UNK');
});
