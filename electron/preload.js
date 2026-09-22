const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vieneu', {
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  onBackendStatus: (cb) => ipcRenderer.on('backend-status', (_e, payload) => cb(payload)),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  importVoiceFiles: () => ipcRenderer.invoke('import-voice-files'),
});
