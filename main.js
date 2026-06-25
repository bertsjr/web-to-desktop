const { app, BrowserWindow, ipcMain, shell, nativeImage, session, Tray, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const log = require('electron-log');

// ---------------------------------------------------------------------------
// Logging — written to <userData>/logs/main.log (always writable on Windows).
// ---------------------------------------------------------------------------
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'logs', 'main.log');
log.initialize?.();
log.info('App starting', { version: app.getVersion() });
process.on('uncaughtException', (err) => log.error('uncaughtException', err));

const APP_ID = 'com.bert.webtodesktop';
app.setAppUserModelId(APP_ID);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const BADGE_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAb0lEQVR42mP4b23AgAVLAHEkEFdDcSRUDEMtNo1zgfg/DjwX3SBkzRZA/BiPZhh+DFWLYoAEkZqRDZFANmAuCZqRvcMAs/0/mViCARrC5BoQyQCNJnINqKaKARR7geJApDgaqZKQKE7KVMlMZGVnAFq0GoOOaauhAAAAAElFTkSuQmCC'
);
const TRAY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAbklEQVR42mOI7vnPgIYtgHg6EN8E4l9QfBMqZoGuHl0zSNF/Ang6LgN2EKEZhnegG4BhMzrA5RKYn3FqJGCQBYbtuGzEIT6dARrCeDXjkb/JAI0mcg34RRUDKPYCxYFIcTRSnJCokpSpkpnIys4AYjPia5JNItsAAAAASUVORK5CYII='
);

// The launcher / default window + tray icon (replace assets/icon.png to rebrand).
const APP_ICON = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));

// Per-app icons (set at runtime from each app's configured icon or favicon).
const appIcons = new Map(); // appId -> nativeImage

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0';
app.userAgentFallback = DESKTOP_UA;

// Download an image URL (no CORS limits in main) into a nativeImage.
function fetchImage(url) {
  return new Promise((resolve) => {
    try {
      const req = net.request(url);
      const chunks = [];
      req.on('response', (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
          return fetchImage(loc).then(resolve);
        }
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const img = nativeImage.createFromBuffer(Buffer.concat(chunks));
          resolve(img.isEmpty() ? null : img);
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    } catch { resolve(null); }
  });
}

// Apply an icon to an app's window(s) and its tray entry.
function applyAppIcon(appId, img) {
  if (!img || img.isEmpty()) return;
  appIcons.set(appId, img);
  const win = appWindows.get(appId);
  if (win && !win.isDestroyed()) win.setIcon(img);
  const tray = trays.get(appId);
  if (tray) tray.setImage(img);
}

// ---------------------------------------------------------------------------
// Persistent store
// ---------------------------------------------------------------------------
const STORE_PATH = path.join(app.getPath('userData'), 'apps.json');
const DEFAULT_APP_SETTINGS = { minimizeToTray: false, launchOnStartup: false };
const DEFAULT_TAB_SETTINGS = { notifications: true, persistSession: true };

function normalizeUrl(url) {
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) return 'https://' + url;
  return url;
}

function normalizeTabs(tabs, legacyTabSettings) {
  const out = (tabs || [])
    .filter((t) => t && (t.url || '').trim())
    .map((t) => ({
      id: t.id || crypto.randomUUID(),
      name: (t.name || '').trim() || 'Tab',
      url: normalizeUrl((t.url || '').trim()),
      settings: { ...DEFAULT_TAB_SETTINGS, ...(legacyTabSettings || {}), ...(t.settings || {}) },
    }));
  return out;
}

// Migrate older records (single url, or app-level notifications/persist).
function migrateApp(a) {
  const legacy = {};
  if (a.settings && 'notifications' in a.settings) legacy.notifications = a.settings.notifications;
  if (a.settings && 'persistSession' in a.settings) legacy.persistSession = a.settings.persistSession;

  let tabs = Array.isArray(a.tabs)
    ? a.tabs
    : [{ id: crypto.randomUUID(), name: a.name || 'Tab', url: a.url || '' }];
  a.tabs = normalizeTabs(tabs, legacy);
  if (a.tabs.length === 0) {
    a.tabs = [{ id: crypto.randomUUID(), name: a.name || 'Tab', url: '', settings: { ...DEFAULT_TAB_SETTINGS } }];
  }

  a.settings = {
    minimizeToTray: !!(a.settings && a.settings.minimizeToTray),
    launchOnStartup: !!(a.settings && a.settings.launchOnStartup),
  };
  return a;
}

function loadApps() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')).map(migrateApp);
  } catch {
    return [];
  }
}

function saveApps(apps) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(apps, null, 2), 'utf8');
}

function getApp(id) { return loadApps().find((a) => a.id === id); }
function getTab(appId, tabId) {
  const a = getApp(appId);
  return a && a.tabs.find((t) => t.id === tabId);
}

// Each TAB is its own entity, with its own persisted (or private) session.
function partitionFor(tab) {
  const prefix = tab.settings.persistSession !== false ? 'persist:' : '';
  return `${prefix}tab-${tab.id}`;
}

// ---------------------------------------------------------------------------
// Per-tab session: user-agent + notification permission gating
// ---------------------------------------------------------------------------
function setupSession(appId, tab) {
  const ses = session.fromPartition(partitionFor(tab));
  ses.setUserAgent(DESKTOP_UA);
  const allow = (permission) => {
    if (permission === 'notifications') {
      const t = getTab(appId, tab.id);
      return !t || t.settings.notifications !== false;
    }
    return ['media', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission);
  };
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allow(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allow(permission));
}

// External links open in the real browser.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// ---------------------------------------------------------------------------
// Windows, tray, detached tab windows
// ---------------------------------------------------------------------------
let managerWindow = null;
const appWindows = new Map(); // appId -> main app window
const detachedWindows = new Map(); // tabId -> detached window
const trays = new Map(); // appId -> Tray
app.isQuitting = false;

function createManagerWindow() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    return;
  }
  managerWindow = new BrowserWindow({
    width: 980, height: 700, minWidth: 720, minHeight: 480,
    title: 'Web to Desktop', backgroundColor: '#0f1115', icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  managerWindow.removeMenu();
  managerWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  managerWindow.on('closed', () => { managerWindow = null; });
}

function sendUnread(id, count) {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.webContents.send('app:unread', { id, count });
  }
}

function ensureTray(appDef) {
  if (trays.has(appDef.id)) return;
  const tray = new Tray(appIcons.get(appDef.id) || APP_ICON || TRAY_ICON);
  tray.setToolTip(appDef.name);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Show ${appDef.name}`, click: () => showApp(appDef.id) },
    { type: 'separator' },
    { label: 'Exit', click: () => quitApp(appDef.id) },
  ]));
  tray.on('click', () => showApp(appDef.id));
  trays.set(appDef.id, tray);
}

function destroyTray(id) {
  const t = trays.get(id);
  if (t) { t.destroy(); trays.delete(id); }
}

function showApp(id) {
  const win = appWindows.get(id);
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  destroyTray(id);
}

function quitApp(id) {
  const win = appWindows.get(id);
  if (win && !win.isDestroyed()) { win._forceClose = true; win.close(); }
  // Also close any detached tabs belonging to it.
  for (const [tabId, w] of detachedWindows) {
    const t = getTab(id, tabId);
    if (t && w && !w.isDestroyed()) { w._forceClose = true; w.close(); }
  }
  destroyTray(id);
}

function launchApp(appDef) {
  const existing = appWindows.get(appDef.id);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }

  appDef.tabs.forEach((t) => setupSession(appDef.id, t));

  const win = new BrowserWindow({
    width: appDef.width || 1200, height: appDef.height || 800,
    title: appDef.name, backgroundColor: '#1b1f2a', autoHideMenuBar: true,
    icon: appIcons.get(appDef.id) || APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'appshell', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'appshell', 'index.html'), { query: { id: appDef.id } });
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(appDef.name); });

  win.on('close', (e) => {
    const a = getApp(appDef.id);
    if (a && a.settings.minimizeToTray && !win._forceClose && !app.isQuitting) {
      e.preventDefault();
      win.hide();
      ensureTray(a);
    }
  });

  appWindows.set(appDef.id, win);
  win.on('closed', () => {
    appWindows.delete(appDef.id);
    destroyTray(appDef.id);
    sendUnread(appDef.id, 0);
  });
  log.info('Launched app', appDef.name);
}

// Move one tab into its own window; closing it returns the tab to the app.
function detachTab(appId, tabId) {
  const tab = getTab(appId, tabId);
  if (!tab) return false;
  const open = detachedWindows.get(tabId);
  if (open && !open.isDestroyed()) { open.focus(); return true; }

  setupSession(appId, tab);
  const win = new BrowserWindow({
    width: 1000, height: 760, title: tab.name,
    backgroundColor: '#1b1f2a', autoHideMenuBar: true,
    icon: appIcons.get(appId) || APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'appshell', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'appshell', 'index.html'), {
    query: { id: appId, tab: tabId, detached: '1' },
  });
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(tab.name); });

  detachedWindows.set(tabId, win);

  // Tell the source window to remove the tab from its view.
  const src = appWindows.get(appId);
  if (src && !src.isDestroyed()) src.webContents.send('shell:tabDetached', { tabId });

  win.on('closed', () => {
    detachedWindows.delete(tabId);
    const s = appWindows.get(appId);
    if (s && !s.isDestroyed()) {
      s.webContents.send('shell:tabReturned', { tabId });
    } else if (!app.isQuitting) {
      const a = getApp(appId); // source gone — bring the app back with this tab
      if (a) launchApp(a);
    }
  });
  log.info('Detached tab', tab.name);
  return true;
}

// ---------------------------------------------------------------------------
// Launch-on-login
// ---------------------------------------------------------------------------
function syncLoginItem() {
  const any = loadApps().some((a) => a.settings.launchOnStartup);
  app.setLoginItemSettings({ openAtLogin: any, args: ['--autostart'] });
}

// ---------------------------------------------------------------------------
// IPC — manager dashboard
// ---------------------------------------------------------------------------
ipcMain.handle('apps:list', () => loadApps());

ipcMain.handle('apps:add', (_e, data) => {
  const apps = loadApps();
  const appDef = migrateApp({
    id: crypto.randomUUID(),
    name: (data.name || '').trim() || 'Untitled',
    icon: data.icon || '',
    tabs: normalizeTabs(data.tabs),
    settings: { ...DEFAULT_APP_SETTINGS, ...(data.settings || {}) },
    createdAt: Date.now(),
  });
  apps.push(appDef);
  saveApps(apps);
  syncLoginItem();
  return apps;
});

ipcMain.handle('apps:update', (_e, data) => {
  const apps = loadApps();
  const idx = apps.findIndex((a) => a.id === data.id);
  if (idx !== -1) {
    apps[idx] = migrateApp({
      ...apps[idx],
      name: (data.name || '').trim() || apps[idx].name,
      icon: data.icon ?? apps[idx].icon,
      tabs: data.tabs ? normalizeTabs(data.tabs) : apps[idx].tabs,
      settings: { ...apps[idx].settings, ...(data.settings || {}) },
    });
    saveApps(apps);
    syncLoginItem();
  }
  return apps;
});

ipcMain.handle('apps:remove', (_e, id) => {
  const apps = loadApps().filter((a) => a.id !== id);
  saveApps(apps);
  quitApp(id);
  syncLoginItem();
  return apps;
});

ipcMain.handle('apps:launch', (_e, id) => {
  const appDef = getApp(id);
  if (appDef) launchApp(appDef);
  return true;
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:checkUpdates', async () => {
  if (!app.isPackaged) return { status: 'dev', message: 'Updates only run in the installed app.' };
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r && r.updateInfo && r.updateInfo.version;
    const newer = v ? cmpVersion(v, app.getVersion()) > 0 : false;
    return { status: 'checked', version: v, newer };
  } catch (e) {
    log.warn('checkForUpdates failed', e);
    return { status: 'error', message: String(e && e.message || e) };
  }
});

// Apply a downloaded update (or rollback) by restarting into the new version.
ipcMain.handle('app:installUpdate', () => { autoUpdater.quitAndInstall(); return true; });

// Deliberate rollback: lift the downgrade block once and install whatever the
// feed currently offers (the maintainer points it at the rollback target).
ipcMain.handle('app:rollback', async () => {
  if (!app.isPackaged) return { status: 'dev', message: 'Rollback only runs in the installed app.' };
  rollbackMode = true;
  autoUpdater.allowDowngrade = true;
  log.info('Rollback requested from', app.getVersion());
  try {
    const r = await autoUpdater.checkForUpdates();
    return { status: 'checked', version: r && r.updateInfo && r.updateInfo.version };
  } catch (e) {
    rollbackMode = false;
    autoUpdater.allowDowngrade = false;
    return { status: 'error', message: String(e && e.message || e) };
  }
});

// ---------------------------------------------------------------------------
// IPC — app shell (per-tab + app-level settings, tabs, detach, exit)
// ---------------------------------------------------------------------------
ipcMain.handle('app:get', (_e, id) => {
  const a = getApp(id);
  if (!a) return null;
  return { ...a, tabs: a.tabs.map((t) => ({ ...t, _partition: partitionFor(t) })) };
});

ipcMain.handle('app:setTabSettings', (_e, { appId, tabId, settings }) => {
  const apps = loadApps();
  const a = apps.find((x) => x.id === appId);
  const t = a && a.tabs.find((x) => x.id === tabId);
  if (!t) return null;
  t.settings = { ...t.settings, ...settings };
  saveApps(apps);
  return t.settings;
});

ipcMain.handle('app:setAppSettings', (_e, { appId, settings }) => {
  const apps = loadApps();
  const a = apps.find((x) => x.id === appId);
  if (!a) return null;
  a.settings = { ...a.settings, ...settings };
  saveApps(apps);
  syncLoginItem();
  return a.settings;
});

ipcMain.handle('app:setTabsOrder', (_e, { appId, tabIds }) => {
  const apps = loadApps();
  const a = apps.find((x) => x.id === appId);
  if (!a) return null;
  a.tabs.sort((x, y) => tabIds.indexOf(x.id) - tabIds.indexOf(y.id));
  saveApps(apps);
  return a.tabs;
});

ipcMain.handle('app:clearCache', async (_e, { appId, tabId }) => {
  const t = getTab(appId, tabId);
  if (!t) return false;
  await session.fromPartition(partitionFor(t)).clearCache();
  return true;
});

ipcMain.handle('app:clearData', async (_e, { appId, tabId }) => {
  const t = getTab(appId, tabId);
  if (!t) return false;
  const ses = session.fromPartition(partitionFor(t));
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'caches', 'indexdb', 'serviceworkers', 'websql'],
  });
  await ses.clearCache();
  return true;
});

ipcMain.handle('tab:detach', (_e, { appId, tabId }) => detachTab(appId, tabId));

ipcMain.handle('app:exit', (_e, appId) => { quitApp(appId); return true; });

// App icon: rendered emoji/letter comes as a data URL; an image/favicon URL is
// fetched here (no CORS limits in the main process).
ipcMain.handle('app:setIconData', (_e, { appId, dataUrl }) => {
  try { applyAppIcon(appId, nativeImage.createFromDataURL(dataUrl)); } catch {}
  return true;
});
ipcMain.handle('app:setIconUrl', async (_e, { appId, url }) => {
  const img = await fetchImage(url);
  if (img) applyAppIcon(appId, img);
  return !!img;
});

// Unread badge from a shell window (app window or detached tab window).
ipcMain.on('shell:unread', (e, { id, count }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) {
    if (count && count !== 0) win.setOverlayIcon(BADGE_ICON, `${count > 0 ? count : ''} unread`.trim());
    else win.setOverlayIcon(null, '');
  }
  sendUnread(id, count);
});

// ---------------------------------------------------------------------------
// Auto-update (electron-updater, GitHub Releases)
//
// Policy: install only versions >= the current one (no silent downgrades), and
// accept newer builds even if they're pre-releases (i.e. not officially
// published as "latest"). A deliberate rollback can still be performed, which
// temporarily lifts the downgrade block to install an older target.
// ---------------------------------------------------------------------------
const { autoUpdater } = require('electron-updater');
autoUpdater.logger = log;
autoUpdater.autoDownload = false;     // we decide whether to download per policy
autoUpdater.allowDowngrade = false;   // never auto-install an older version
autoUpdater.allowPrerelease = true;   // accept newer pre-release / unpublished builds

let rollbackMode = false;

// Compare dotted versions ("2026.6.2", "1.2.3-beta.1"). Returns -1 / 0 / 1.
function cmpVersion(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const A = parse(a);
  const B = parse(b);
  const len = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (A.nums[i] || 0) - (B.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;     // a release outranks a pre-release of the same core
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

function sendUpdate(payload) {
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send('update:status', payload);
}

autoUpdater.on('update-available', (info) => {
  const cur = app.getVersion();
  if (rollbackMode) {
    log.info('Rollback: downloading', info.version);
    sendUpdate({ status: 'downloading', version: info.version, rollback: true });
    autoUpdater.downloadUpdate();
  } else if (cmpVersion(info.version, cur) > 0) {
    log.info('Update available (newer)', info.version);
    sendUpdate({ status: 'downloading', version: info.version });
    autoUpdater.downloadUpdate();
  } else {
    log.warn('Refusing non-newer version', info.version, 'current', cur);
    sendUpdate({ status: 'blocked', version: info.version, current: cur });
  }
});
autoUpdater.on('download-progress', (p) => sendUpdate({ status: 'progress', percent: Math.round(p.percent) }));
autoUpdater.on('update-not-available', (info) => sendUpdate({ status: 'current', version: info && info.version }));
autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded', info.version, 'rollback:', rollbackMode);
  sendUpdate({ status: 'downloaded', version: info.version, rollback: rollbackMode });
  rollbackMode = false;
  autoUpdater.allowDowngrade = false; // re-arm the downgrade block after a rollback
});
autoUpdater.on('error', (err) => {
  sendUpdate({ status: 'error', message: String(err && err.message || err) });
  log.warn('Updater error', err);
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', () => createManagerWindow());

if (gotLock) {
  app.whenReady().then(() => {
    syncLoginItem();
    if (process.argv.includes('--autostart')) {
      loadApps().filter((a) => a.settings.launchOnStartup).forEach(launchApp);
    }
    createManagerWindow();
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch((e) => log.warn('update check failed', e));
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createManagerWindow();
    });
  });
}

app.on('before-quit', () => { app.isQuitting = true; });

app.on('window-all-closed', () => {
  if (trays.size > 0) return; // tray-hidden apps keep running
  if (process.platform !== 'darwin') app.quit();
});
