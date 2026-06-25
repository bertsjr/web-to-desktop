const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal bridge between the manager UI and the main process.
contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('apps:list'),
  add: (data) => ipcRenderer.invoke('apps:add', data),
  update: (data) => ipcRenderer.invoke('apps:update', data),
  remove: (id) => ipcRenderer.invoke('apps:remove', id),
  launch: (id) => ipcRenderer.invoke('apps:launch', id),
  installShortcut: (id) => ipcRenderer.invoke('apps:installShortcut', id),
  uninstallShortcut: (id) => ipcRenderer.invoke('apps:uninstallShortcut', id),
  // Live unread updates pushed from the main process: { id, count }.
  onUnread: (cb) => ipcRenderer.on('app:unread', (_e, data) => cb(data)),
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdates: () => ipcRenderer.invoke('app:checkUpdates'),
});
