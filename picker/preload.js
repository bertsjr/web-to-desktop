// Preload for the "choose what to share" picker window.
// Exposes a minimal bridge so the picker UI can request the capturable
// sources from main and report the user's choice back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  // Returns [{ id, name, type: 'screen'|'window', thumbnail, appIcon }]
  list: () => ipcRenderer.invoke('picker:list'),
  choose: (id) => ipcRenderer.send('picker:choose', id),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
