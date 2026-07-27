const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchFund: (code) => ipcRenderer.invoke('fetch-fund', code),
  fetchMultipleFunds: (funds) => ipcRenderer.invoke('fetch-multiple-funds', funds),
  loadFunds: () => ipcRenderer.invoke('load-funds'),
  saveFunds: (funds) => ipcRenderer.invoke('save-funds', funds),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings)
});