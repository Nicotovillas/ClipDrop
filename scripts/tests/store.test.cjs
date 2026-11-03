'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { identityFromEnvironment, packageVersion, manifest, peImports, verifyExtracted } = require('../store.cjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const partner = {
  STORE_IDENTITY_NAME: '12345.PublisherProduct', STORE_PUBLISHER: 'CN=12345678-1234-1234-1234-123456789abc',
  STORE_PUBLISHER_DISPLAY_NAME: 'Publisher & Partners', STORE_DISPLAY_NAME: 'ClipDrop'
};

test('Store identity is explicit and fails closed before a production package is built', () => {
  assert.throws(() => identityFromEnvironment({}), /STORE_IDENTITY_NAME/);
  for (const key of Object.keys(partner)) {
    assert.throws(() => identityFromEnvironment({ ...partner, [key]: '' }), new RegExp(key));
  }
  assert.throws(() => identityFromEnvironment({ ...partner, STORE_IDENTITY_NAME: '../product' }), /Identity Name/);
  assert.throws(() => identityFromEnvironment({ ...partner, STORE_PUBLISHER: 'a publisher' }), /Publisher/);
  assert.throws(() => identityFromEnvironment({ ...partner, STORE_IDENTITY_NAME: 'Contoso.Product' }), /ejemplo/);
  assert.throws(() => identityFromEnvironment({ ...partner, STORE_DISPLAY_NAME: 'Clip\u0000Drop' }), /STORE_DISPLAY_NAME/);
  assert.equal(identityFromEnvironment(partner).test, false);
});

test('test identity must be explicitly requested and cannot silently replace Partner Center fields', () => {
  const identity = identityFromEnvironment({ STORE_TEST_IDENTITY: 'true' });
  assert.equal(identity.test, true);
  assert.match(identity.displayName, /TEST - NO SUBMIT/);
  assert.throws(() => identityFromEnvironment({ ...partner, STORE_TEST_IDENTITY: 'true' }), /no se mezcla/);
  assert.throws(() => identityFromEnvironment({ STORE_TEST_IDENTITY: 'yes' }), /true o false/);
  assert.throws(() => identityFromEnvironment({ ...partner, STORE_IDENTITY_NAME: identity.name }), /ejemplo/);
});

test('Store versions offset major, remain monotonic and reserve the fourth component', () => {
  assert.equal(packageVersion('0.3.1'), '1.3.1.0');
  assert.equal(packageVersion('0.3.2'), '1.3.2.0');
  assert.equal(packageVersion('1.0.0'), '2.0.0.0');
  assert.equal(packageVersion('65534.65535.65535'), '65535.65535.65535.0');
  for (const invalid of ['0.3.1-beta', '0.3.1+build', '1.2.3.4', '01.2.3', '-1.2.3', '65535.0.0', '0.65536.0', '0.0.65536']) {
    assert.throws(() => packageVersion(invalid));
  }
});

test('manifest escapes identity text and declares a full-trust desktop app with no installer', () => {
  const identity = identityFromEnvironment({ ...partner, STORE_DISPLAY_NAME: 'Clip "Drop" <local> & friends', STORE_PUBLISHER_DISPLAY_NAME: "Publisher's & Co" });
  const document = new JSDOM(manifest(identity, '1.3.1.0'), { contentType: 'application/xml' }).window.document;
  assert.equal(document.querySelector('parsererror'), null);
  assert.equal(document.querySelector('Identity').getAttribute('Name'), partner.STORE_IDENTITY_NAME);
  assert.equal(document.querySelector('Identity').getAttribute('Version'), '1.3.1.0');
  assert.equal(document.querySelector('DisplayName').textContent, identity.displayName);
  assert.equal(document.querySelector('PublisherDisplayName').textContent, identity.publisherDisplayName);
  const application = document.querySelector('Application');
  assert.equal(application.getAttribute('Executable'), 'ClipDrop.exe');
  assert.equal(application.getAttribute('uap10:RuntimeBehavior'), 'packagedClassicApp');
  assert.equal(application.getAttribute('uap10:TrustLevel'), 'mediumIL');
  const capabilities = document.getElementsByTagNameNS('http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities', 'Capability');
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].getAttribute('Name'), 'runFullTrust');
  assert.equal(document.getElementsByTagNameNS('http://schemas.microsoft.com/appx/manifest/uap/windows10', 'VisualElements')[0].getAttribute('DisplayName'), identity.displayName);
  assert.equal(document.querySelector('Extensions'), null);
});

function fakePE() {
  const bytes = Buffer.alloc(1024);
  bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  const section = 0x98 + 240;
  bytes.writeUInt32LE(512, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(0x1000, 0x98 + 112 + 8); bytes.writeUInt32LE(40, 0x98 + 116 + 8);
  bytes.writeUInt32LE(0x1080, 512 + 12); bytes.write('KERNEL32.dll\0', 640, 'ascii');
  bytes.writeUInt32LE(0x1040, 0x98 + 112 + 13 * 8); bytes.writeUInt32LE(64, 0x98 + 116 + 13 * 8);
  bytes.writeUInt32LE(1, 576); bytes.writeUInt32LE(0x10a0, 580); bytes.write('VCRUNTIME140.dll\0', 672, 'ascii');
  return bytes;
}

test('PE inspection includes delay-load runtime DLLs and rejects non-x64 payloads', () => {
  const bytes = fakePE();
  assert.deepEqual(peImports(bytes), ['KERNEL32.dll', 'VCRUNTIME140.dll']);
  const x86 = Buffer.from(bytes); x86.writeUInt16LE(0x14c, 0x84);
  assert.throws(() => peImports(x86), /Windows x64/);
  const corrupted = Buffer.from(bytes); corrupted.writeUInt32LE(0x2000, 512 + 12);
  assert.throws(() => peImports(corrupted), /RVA/);
});

test('unpacked package verification rejects changed binaries, omitted licenses and extra tools', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ClipDropStoreTest-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const payload = { 'ClipDrop.exe': Buffer.from('synthetic application'), 'tools/yt-dlp.exe': Buffer.from('synthetic engine'), 'tools/yt-dlp-LICENSE': Buffer.from('license fixture') };
  for (const [name, bytes] of Object.entries(payload)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), bytes);
  }
  const expected = Object.fromEntries(Object.entries(payload).map(([name, bytes]) => [name, sha256(bytes)]));
  fs.writeFileSync(path.join(directory, 'AppxBlockMap.xml'), 'generated metadata');
  fs.writeFileSync(path.join(directory, '[Content_Types].xml'), 'generated metadata');
  verifyExtracted(directory, expected);
  fs.writeFileSync(path.join(directory, 'ClipDrop.exe'), 'changed application');
  assert.throws(() => verifyExtracted(directory, expected), /payload cambió/);
  fs.writeFileSync(path.join(directory, 'ClipDrop.exe'), payload['ClipDrop.exe']);
  fs.unlinkSync(path.join(directory, 'tools/yt-dlp-LICENSE'));
  assert.throws(() => verifyExtracted(directory, expected), /faltantes/);
  fs.writeFileSync(path.join(directory, 'tools/yt-dlp-LICENSE'), payload['tools/yt-dlp-LICENSE']);
  fs.writeFileSync(path.join(directory, 'clipboard-smoke.exe'), 'helper fixture');
  assert.throws(() => verifyExtracted(directory, expected), /inesperados/);
});
