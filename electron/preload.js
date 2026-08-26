const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vieneu', {
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  onBackendStatus: (cb) => ipcRenderer.on('backend-status', (_e, payload) => cb(payload)),
});
