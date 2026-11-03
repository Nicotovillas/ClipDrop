'use strict';
// Keep the UI contract independent of the desktop runtime.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const callbacks = new Set();
  // Commands wait for the event subscription, so fast jobs cannot lose progress.
  const ready = listen('transfer-event', ({ payload }) => {
    for (const callback of callbacks) callback(payload);
  });
  const call = async (command, args) => {
    try { await ready; return await invoke(command, args); }
    catch (error) { return { ok: false, error: String(error) }; }
  };
  window.clipdrop = Object.freeze({
    info: () => call('info'),
    chooseFolder: () => call('choose_folder'),
    pasteLink: () => call('paste_link'),
    download: request => call('download', { request }),
    cancel: () => call('cancel'),
    copyResult: () => call('copy_result'),
    revealResult: () => call('reveal_result'),
    cleanTemporary: () => call('clean_temporary'),
    onEvent: callback => { callbacks.add(callback); return () => callbacks.delete(callback); }
  });
})();
