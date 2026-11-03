'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipdrop', {
  info: () => ipcRenderer.invoke('info'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  pasteLink: () => ipcRenderer.invoke('paste-link'),
  download: request => ipcRenderer.invoke('download', request),
  cancel: () => ipcRenderer.invoke('cancel'),
  copyResult: () => ipcRenderer.invoke('copy-result'),
  revealResult: () => ipcRenderer.invoke('reveal-result'),
  cleanTemporary: () => ipcRenderer.invoke('clean-temporary'),
  onEvent: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('transfer-event', listener);
    return () => ipcRenderer.removeListener('transfer-event', listener);
  }
});
