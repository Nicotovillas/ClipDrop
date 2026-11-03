'use strict';

// Tauri 2.12.4 replaces the first bundle-type token before creating NSIS, then
// restores the original executable after bundling. Reproduce that exact change
// for verification/staging; every other byte must still match the build.
// Source: https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle.rs
const unknown = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const nsis = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');

function nsisPayload(binary) {
  const offset = binary.indexOf(unknown);
  if (offset === -1) throw new Error('Falta el marcador de tipo de paquete de Tauri en el ejecutable compilado.');
  const result = Buffer.from(binary);
  nsis.copy(result, offset);
  return result;
}

module.exports = { nsisPayload };
