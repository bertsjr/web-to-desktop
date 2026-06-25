const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  get: (id) => ipcRenderer.invoke('app:get', id),
  setTabSettings: (appId, tabId, settings) =>
    ipcRenderer.invoke('app:setTabSettings', { appId, tabId, settings }),
  setAppSettings: (appId, settings) =>
    ipcRenderer.invoke('app:setAppSettings', { appId, settings }),
  setTabsOrder: (appId, tabIds) => ipcRenderer.invoke('app:setTabsOrder', { appId, tabIds }),
  clearCache: (appId, tabId) => ipcRenderer.invoke('app:clearCache', { appId, tabId }),
  clearData: (appId, tabId) => ipcRenderer.invoke('app:clearData', { appId, tabId }),
  detach: (appId, tabId) => ipcRenderer.invoke('tab:detach', { appId, tabId }),
  exit: (appId) => ipcRenderer.invoke('app:exit', appId),
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdates: () => ipcRenderer.invoke('app:checkUpdates'),
  openManager: () => ipcRenderer.invoke('app:openManager'),
  setIconData: (appId, dataUrl) => ipcRenderer.invoke('app:setIconData', { appId, dataUrl }),
  setIconUrl: (appId, url) => ipcRenderer.invoke('app:setIconUrl', { appId, url }),
  unread: (id, count) => ipcRenderer.send('shell:unread', { id, count }),
  onTabDetached: (cb) => ipcRenderer.on('shell:tabDetached', (_e, d) => cb(d)),
  onTabReturned: (cb) => ipcRenderer.on('shell:tabReturned', (_e, d) => cb(d)),
});
