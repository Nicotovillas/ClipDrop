'use strict';
// Generates and inspects an unsigned MSIX. Never installs or starts ClipDrop.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { root, ui, resources, releaseDirectory } = require('./paths.cjs');

const testIdentity = Object.freeze({
  name: 'ClipDrop.PackagingTest', publisher: 'CN=ClipDrop Packaging Test',
  publisherDisplayName: 'ClipDrop Packaging Test', displayName: 'ClipDrop TEST - NO SUBMIT',
  test: true
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function identityFromEnvironment(env = process.env) {
  if (!['', 'true', 'false'].includes(env.STORE_TEST_IDENTITY || '')) throw new Error('STORE_TEST_IDENTITY debe ser true o false.');
  const fields = ['STORE_IDENTITY_NAME', 'STORE_PUBLISHER', 'STORE_PUBLISHER_DISPLAY_NAME', 'STORE_DISPLAY_NAME'];
  if (env.STORE_TEST_IDENTITY === 'true') {
    if (fields.some(key => env[key])) throw new Error('La identidad de prueba no se mezcla con datos de Partner Center.');
    return { ...testIdentity };
  }
  const values = fields.map(key => {
    const value = env[key];
    if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Falta o no es válido ${key}; copiá el dato exacto de Partner Center.`);
    return value;
  });
  const [name, publisher, publisherDisplayName, displayName] = values;
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(name)) throw new Error('Identity Name debe tener 3–50 caracteres alfanuméricos, puntos o guiones.');
  if (!/^CN=\S/.test(publisher) || publisher.length > 8192) throw new Error('Publisher debe ser el CN exacto de Partner Center.');
  if (publisherDisplayName.length > 256 || displayName.length > 256) throw new Error('Los nombres visibles deben tener hasta 256 caracteres.');
  if (name === testIdentity.name || publisher === testIdentity.publisher || /(?:YourCompany|YourPublisher|Contoso|PLACEHOLDER)/i.test(`${name} ${publisher}`)) {
    throw new Error('La identidad de ejemplo no sirve para el paquete de Partner Center.');
  }
  return { name, publisher, publisherDisplayName, displayName, test: false };
}

function packageVersion(sourceVersion) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(sourceVersion)) throw new Error('La versión de origen debe ser major.minor.patch sin sufijos.');
  const [major, minor, patch] = sourceVersion.split('.').map(Number);
  // Store requires first > 0 and fourth = 0. Offset major to keep prerelease-era
  // 0.x source versions valid and future Store updates monotonically ordered.
  if (major >= 65535 || minor > 65535 || patch > 65535) throw new Error('La versión excede el rango MSIX de 16 bits.');
  return `${major + 1}.${minor}.${patch}.0`;
}

function manifest(identity, version) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="${xml(identity.name)}" Publisher="${xml(identity.publisher)}" Version="${xml(version)}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${xml(identity.displayName)}</DisplayName>
    <PublisherDisplayName>${xml(identity.publisherDisplayName)}</PublisherDisplayName>
    <Description>Descargador de videos con copia de archivos al portapapeles.</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="es-AR" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Applications>
    <Application Id="ClipDrop" Executable="ClipDrop.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="${xml(identity.displayName)}" Description="Descargador de videos con copia de archivos al portapapeles."
        Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" BackgroundColor="#202624" />
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
`;
}

function peImports(bytes) {
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ', 'Falta encabezado PE.');
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt32LE(pe), 0x4550, 'Encabezado PE inválido.');
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'El payload debe ser Windows x64.');
  const optional = pe + 24;
  assert.equal(bytes.readUInt16LE(optional), 0x20b, 'Se requiere PE32+ x64.');
  const sectionStart = optional + bytes.readUInt16LE(pe + 20);
  const sectionCount = bytes.readUInt16LE(pe + 6);
  function offset(rva) {
    for (let i = 0; i < sectionCount; i++) {
      const section = sectionStart + i * 40;
      const address = bytes.readUInt32LE(section + 12);
      const size = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
      if (rva >= address && rva < address + size) {
        const position = rva - address + bytes.readUInt32LE(section + 20);
        assert.ok(position < bytes.length, 'RVA fuera del archivo PE.');
        return position;
      }
    }
    throw new Error('RVA de importación fuera de secciones PE.');
  }
  function name(rva) {
    const position = offset(rva);
    const end = bytes.indexOf(0, position);
    assert.ok(end >= position && end - position < 4096, 'Nombre de DLL inválido.');
    return bytes.subarray(position, end).toString('ascii');
  }
  const result = new Set();
  // Import table and delay-load import table; PE32+ uses 32-bit RVAs here.
  for (const [index, stride, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = bytes.readUInt32LE(optional + 112 + index * 8);
    const size = bytes.readUInt32LE(optional + 116 + index * 8);
    if (!rva) continue;
    let cursor = offset(rva);
    const end = Math.min(bytes.length, cursor + size);
    while (cursor + stride <= end) {
      const nameRva = bytes.readUInt32LE(cursor + nameOffset);
      if (!nameRva) break;
      if (index === 13) assert.equal(bytes.readUInt32LE(cursor) & 1, 1, 'Delay import debe usar RVA.');
      result.add(name(nameRva));
      cursor += stride;
    }
  }
  return [...result].sort();
}

function files(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(absolute, relative + '/');
    if (!entry.isFile()) throw new Error(`El payload contiene un enlace o archivo especial: ${relative}`);
    return [relative];
  }).sort();
}

function verifyExtracted(directory, expected) {
  const actual = files(directory).filter(name => !['AppxBlockMap.xml', '[Content_Types].xml'].includes(name));
  assert.deepEqual(actual, Object.keys(expected).sort(), 'El MSIX contiene archivos inesperados o faltantes.');
  for (const [name, digest] of Object.entries(expected)) {
    assert.equal(sha256(fs.readFileSync(path.join(directory, name))), digest, `El payload cambió: ${name}`);
  }
}

function makeAppxPath() {
  if (process.env.MAKEAPPX) {
    assert.ok(path.isAbsolute(process.env.MAKEAPPX) && fs.statSync(process.env.MAKEAPPX).isFile(), 'MAKEAPPX debe ser una ruta absoluta al SDK.');
    return process.env.MAKEAPPX;
  }
  const sdk = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = fs.readdirSync(sdk).filter(v => /^\d+\.\d+\.\d+\.\d+$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(sdk, version, 'x64', 'makeappx.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No se encontró MakeAppx.exe x64 del Windows SDK.');
}

async function build() {
  const identity = identityFromEnvironment();
  const sourceVersion = require('../package.json').version;
  const version = packageVersion(sourceVersion);
  if (process.argv.includes('--validate')) {
    console.log(`Identidad ${identity.test ? 'TEST-NO-SUBMIT' : 'Partner Center'} y versión MSIX ${version} válidas.`);
    return;
  }
  if (process.platform !== 'win32') throw new Error('El empaquetado MSIX requiere Windows SDK; la app no se inicia.');
  const makeappx = makeAppxPath();
  const staging = path.join(root, '.build', 'store', 'staging');
  const unpacked = path.join(root, '.build', 'store', 'unpacked');
  const output = path.join(root, 'dist', 'store');
  for (const directory of [staging, unpacked, output]) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
  }
  const copy = (source, relative) => {
    assert.ok(fs.lstatSync(source).isFile(), `Falta un archivo regular: ${source}`);
    const target = path.join(staging, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  };
  copy(path.join(releaseDirectory('x86_64-pc-windows-msvc'), 'clipdrop.exe'), 'ClipDrop.exe');
  const tools = ['yt-dlp.exe', 'yt-dlp-LICENSE', 'yt-dlp-THIRD_PARTY_LICENSES.txt', 'yt-dlp-README.md', 'provenance.json'];
  for (const name of tools) copy(path.join(resources, 'win32', name), path.join('tools', name));
  const pinned = require(path.join(resources, 'yt-dlp.json'));
  const provenance = JSON.parse(fs.readFileSync(path.join(staging, 'tools', 'provenance.json')));
  assert.equal(sha256(fs.readFileSync(path.join(staging, 'tools', 'yt-dlp.exe'))), pinned.sha256, 'El motor no coincide con la versión fijada.');
  assert.equal(provenance.release, pinned.release);
  assert.equal(provenance.sha256, pinned.sha256);
  const imports = {};
  for (const relative of ['ClipDrop.exe', 'tools/yt-dlp.exe']) imports[relative] = peImports(fs.readFileSync(path.join(staging, relative)));
  const sharp = require('sharp');
  fs.mkdirSync(path.join(staging, 'Assets'));
  const svg = fs.readFileSync(path.join(ui, 'icon.svg'));
  for (const [name, size] of [['StoreLogo', 50], ['Square150x150Logo', 150], ['Square44x44Logo', 44]]) {
    await sharp(svg).resize(size, size).png().toFile(path.join(staging, 'Assets', name + '.png'));
  }
  fs.writeFileSync(path.join(staging, 'AppxManifest.xml'), manifest(identity, version));
  const expected = Object.fromEntries(files(staging).map(name => [name, sha256(fs.readFileSync(path.join(staging, name)))]));
  const packageName = `ClipDrop-Store-${identity.test ? 'TEST-NO-SUBMIT-' : ''}x64-${version}.msix`;
  const filename = path.join(output, packageName);
  // No /nv: MakeAppx must perform semantic validation. No signing/install steps.
  execFileSync(makeappx, ['pack', '/d', staging, '/p', filename, '/o'], { stdio: 'inherit' });
  execFileSync(makeappx, ['unpack', '/p', filename, '/d', unpacked, '/o'], { stdio: 'inherit' });
  verifyExtracted(unpacked, expected);
  const digest = sha256(fs.readFileSync(filename));
  fs.writeFileSync(path.join(output, 'SHA256SUMS-MSIX.txt'), `${digest}  ${packageName}\n`);
  const vcRuntimeImports = [...new Set(Object.values(imports).flat().filter(name => /^(?:vcruntime|msvcp|msvcr|concrt)\d.*\.dll$/i.test(name)))];
  fs.writeFileSync(path.join(output, 'store-report.json'), JSON.stringify({
    sourceVersion, packageVersion: version, sourceCommit: process.env.GITHUB_SHA || null,
    mode: identity.test ? 'TEST-NO-SUBMIT' : 'PARTNER-CENTER-IDENTITY', identity,
    packageName, sha256: digest, payload: expected, imports, vcRuntimeImports,
    signed: false, installed: false, applicationLaunched: false, packagedRuntimeTested: false,
    webview2Bundled: false, readyForSubmission: false,
    verified: ['MakeAppx semantic validation', 'Unpacked payload byte-for-byte SHA256 comparison'],
    pending: ['WebView2 deployment requirements', ...(vcRuntimeImports.length ? ['Visual C++ runtime dependencies'] : []),
      'Installation and behavior with package identity', 'Store listing, privacy policy and certification']
  }, null, 2) + '\n');
  console.log(`MSIX sin firmar preparado: ${packageName}. Runtime MSIX y certificación no verificados.`);
}

if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { identityFromEnvironment, packageVersion, manifest, peImports, verifyExtracted };
