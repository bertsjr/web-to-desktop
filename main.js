const { app, BrowserWindow, ipcMain, shell, nativeImage, session, Tray, Menu, net, desktopCapturer, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const log = require('electron-log');
const { loginViaSystemBrowser } = require('./google-auth-browser');

// ---------------------------------------------------------------------------
// Logging — written to <userData>/logs/main.log (always writable on Windows).
// ---------------------------------------------------------------------------
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'logs', 'main.log');
log.initialize?.();
log.info('App starting', { version: app.getVersion() });
process.on('uncaughtException', (err) => log.error('uncaughtException', err));

// Dev-only logger — writes to <projectDir>/logs/dev.log, only active when
// running from source (npm start). Packaged builds skip it.
const isDev = !app.isPackaged;
const dev = isDev ? require('electron-log').create({ processType: 'main' }) : null;
if (dev) {
  const devLogDir = path.join(__dirname, 'logs');
  fs.mkdirSync(devLogDir, { recursive: true });
  dev.transports.file.resolvePathFn = () => path.join(devLogDir, 'dev.log');
  dev.transports.console.level = false; // don't duplicate to console
  dev.info('--- Dev log started ---', { version: app.getVersion() });
}
function devLog(...args) { if (dev) dev.info(...args); }

const APP_ID = 'com.bert.webtodesktop';
app.setAppUserModelId(APP_ID);

// Media keys: let our globalShortcut be the ONLY handler. By default Chromium
// also routes hardware media keys to the page's MediaSession (YouTube Music sets
// one), so a physical press fires BOTH Chromium's handler and our shortcut —
// two toggles that cancel out, so the key appears to do nothing. Disabling
// HardwareMediaKeyHandling stops Chromium from consuming/acting on media keys,
// leaving them to globalShortcut → routeMedia. Must run before app 'ready'.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

// ---------------------------------------------------------------------------
// Activation gate — SHA-256 of the activation key (plaintext never in source).
// Change this hash to set your own key:
//   node -e "console.log(require('crypto').createHash('sha256').update('YOUR_KEY').digest('hex'))"
// ---------------------------------------------------------------------------
const ACTIVATION_HASH = 'af3c0857c4ae127dc188ec822c1e27de854de3019ea77da5f415d20e43fede22';
const activationFile = () => path.join(app.getPath('userData'), '.activated');

function isActivated() {
  try { return fs.existsSync(activationFile()); } catch { return false; }
}

function activate(key) {
  try {
    const hash = crypto.createHash('sha256').update(String(key)).digest('hex');
    if (hash !== ACTIVATION_HASH) return false;
    fs.mkdirSync(path.dirname(activationFile()), { recursive: true });
    fs.writeFileSync(activationFile(), hash, 'utf8');
    return true;
  } catch (err) {
    log.error('Failed to save activation state:', err);
    return false;
  }
}

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

// Present a clean, CONSISTENT desktop-Chrome identity. Electron's default UA
// string carries an "Electron/<ver>" token (plus the app name) that browsers
// like Google flag as an embedded framework — so we override just the UA string
// to a plain Chrome matching our actual engine version. Everything else
// (Sec-CH-UA client hints, navigator.userAgentData) is left as Chromium reports
// it natively, which is already a consistent "Chromium 126" with no Electron
// brand. The engine here is Chromium 126 (Electron 31); the UA MUST stay in sync
// with that major version — a mismatch (e.g. claiming Chrome 137 on a 126
// engine) is exactly the inconsistency Google's "this browser may not be secure"
// check keys on.
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
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
        if (res.statusCode !== 200) { resolve(null); return; }
        res.on('data', (c) => chunks.push(c));
        res.on('error', () => resolve(null));
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
const {
  normalizeUrl, normalizeTabs, migrateApp, partitionFor,
  isAuthUrl, isGoogleAuthUrl, cleanGoogleAuthUrl, cmpVersion,
  sanitizeFileName, appIdFromArgv,
  DEFAULT_APP_SETTINGS, DEFAULT_TAB_SETTINGS,
} = require('./lib/utils');

const STORE_PATH = path.join(app.getPath('userData'), 'apps.json');

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

// ---------------------------------------------------------------------------
// Screen-share source picker (getDisplayMedia → "Choose what to share")
// ---------------------------------------------------------------------------
// Only one picker is live at a time. Holds the capturable sources plus the
// getDisplayMedia callback so the picker window's IPC can resolve the request.
let activePicker = null;

// Remembers the last share choice: system-audio toggle, screen/window tab, and
// the last source id (restored only if that source still exists).
const SHARE_PREFS_PATH = path.join(app.getPath('userData'), 'share-prefs.json');
function loadSharePrefs() {
  try { return JSON.parse(fs.readFileSync(SHARE_PREFS_PATH, 'utf8')); }
  catch { return { audio: false, type: 'screen', sourceId: null }; }
}
function saveSharePrefs(prefs) {
  try { fs.writeFileSync(SHARE_PREFS_PATH, JSON.stringify(prefs), 'utf8'); }
  catch (err) { devLog('[display-media] saveSharePrefs failed', { error: String(err) }); }
}

async function openSourcePicker(parentWin, callback, audioRequested) {
  // Resolve any in-flight picker as a cancel before opening a new one.
  if (activePicker) activePicker.finish(null);

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    });
  } catch (err) {
    devLog('[display-media] getSources failed', { error: String(err) });
    callback(); // deny
    return;
  }
  if (!sources.length) {
    devLog('[display-media] no capturable sources');
    callback();
    return;
  }
  devLog('[display-media] sources', { count: sources.length });

  // parentWin may have been closed during the await above; a destroyed window
  // passed as `parent` throws, so fall back to a top-level (non-modal) picker.
  const parent = parentWin && !parentWin.isDestroyed() ? parentWin : undefined;
  const win = new BrowserWindow({
    width: 780, height: 580,
    parent, modal: !!parent,
    title: 'Choose what to share', backgroundColor: '#1b1f2a',
    autoHideMenuBar: true, minimizable: false, maximizable: false,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'picker', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.removeMenu();

  let settled = false;
  // Windows can capture system audio via the 'loopback' audio source. We only
  // request it when the user opts in (checkbox), since loopback grabs ALL
  // system audio, not just the shared window.
  const finish = (source, withAudio) => {
    if (settled) return;
    settled = true;
    activePicker = null;
    try {
      if (!source) {
        callback(); // cancelled / no source → deny
      } else {
        const response = { video: source };
        if (withAudio) response.audio = 'loopback'; // Windows system audio
        callback(response);
      }
    } catch (err) { devLog('[display-media] callback failed', { error: String(err) }); }
    if (!win.isDestroyed()) win.close();
  };

  activePicker = { sources, audioRequested: !!audioRequested, prefs: loadSharePrefs(), finish };
  // Closing the window (X, Esc, cancel) with nothing chosen == deny the request.
  win.on('closed', () => finish(null));
  win.loadFile(path.join(__dirname, 'picker', 'index.html'));
}

ipcMain.handle('picker:list', () => {
  if (!activePicker) return { sources: [], audioRequested: false, prefs: loadSharePrefs() };
  return {
    audioRequested: activePicker.audioRequested,
    prefs: activePicker.prefs,
    sources: activePicker.sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    })),
  };
});
ipcMain.on('picker:choose', (_e, { id, audio }) => {
  if (!activePicker) return;
  const source = activePicker.sources.find((s) => s.id === id) || null;
  if (source) {
    saveSharePrefs({
      audio: !!audio,
      type: source.id.startsWith('screen:') ? 'screen' : 'window',
      sourceId: source.id,
    });
  }
  activePicker.finish(source, !!audio);
});
ipcMain.on('picker:cancel', () => { if (activePicker) activePicker.finish(null); });

// ---------------------------------------------------------------------------
// Per-tab session: notification permission gating
// ---------------------------------------------------------------------------
// The desktop-Chrome UA is applied globally via app.userAgentFallback (see top
// of file); Sec-CH-UA client hints and navigator.userAgentData are left as
// Chromium reports them natively — a consistent "Chromium 126" identity.
function setupSession(appId, tab) {
  const ses = session.fromPartition(partitionFor(tab));
  const allow = (permission) => {
    if (permission === 'notifications') {
      const t = getTab(appId, tab.id);
      return !t || t.settings.notifications !== false;
    }
    return ['media', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission);
  };
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allow(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allow(permission));

  // Screen/window sharing (Teams "Share screen", Meet, etc.) goes through
  // getDisplayMedia(), which Electron routes here — NOT through the media
  // permission handler above. Without this handler the capture request is
  // rejected, which surfaces in Teams as "issue with content sharing" plus a
  // misleading "couldn't access your camera" toast. We show our own picker so
  // the user can choose which screen or window to share (Electron's
  // useSystemPicker is not honored on Windows for this Electron version).
  ses.setDisplayMediaRequestHandler((request, callback) => {
    openSourcePicker(BrowserWindow.getFocusedWindow(), callback, !!request.audioRequested);
  });

  // Downloads — save to Downloads folder and open in the associated desktop app.
  ses.on('will-download', (_e, item) => {
    const downloadsDir = app.getPath('downloads');
    const savePath = path.join(downloadsDir, item.getFilename());
    item.setSavePath(savePath);
    devLog('[download] started', {
      filename: item.getFilename(),
      url: item.getURL(),
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      contentDisposition: item.getContentDisposition(),
      savePath,
    });
    item.on('updated', (_ev, state) => {
      devLog('[download] progress', { filename: item.getFilename(), state, received: item.getReceivedBytes(), total: item.getTotalBytes() });
    });
    item.once('done', (_ev, state) => {
      devLog('[download] done', { filename: item.getFilename(), state, savePath });
      if (state === 'completed') {
        devLog('[download] saved to', savePath);
        shell.showItemInFolder(savePath);
      }
    });
  });
}

// A small always-on-top hint shown while the external browser login happens.
function showAuthHint(guestContents) {
  let parent;
  try { parent = BrowserWindow.fromWebContents(guestContents.hostWebContents); } catch {}
  const win = new BrowserWindow({
    width: 400, height: 190, parent: parent || undefined, resizable: false,
    minimizable: false, maximizable: false, title: 'Signing in…',
    autoHideMenuBar: true, alwaysOnTop: true,
  });
  win.removeMenu();
  const html = '<!doctype html><meta charset="utf-8"><body style="font-family:Segoe UI,system-ui,sans-serif;'
    + 'margin:0;padding:22px;background:#1f1f1f;color:#eee">'
    + '<h3 style="margin:0 0 10px;font-size:16px">Finish signing in</h3>'
    + '<p style="margin:0;line-height:1.5;font-size:13px">A Chrome window has opened. Complete your '
    + 'Google sign-in there.<br><br>This closes automatically and the app refreshes signed in.</p></body>';
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return win;
}

// Google blocks sign-in from the Electron runtime, so we run the login in the
// user's real Chrome/Edge and import the resulting session cookies into this
// tab's session (see google-auth-browser.js). Then reload the webview signed in.
let googleAuthInProgress = false;
async function startGoogleAuthViaBrowser(authUrl, guestContents) {
  if (googleAuthInProgress) { devLog('[sysauth] already in progress, ignoring'); return; }
  googleAuthInProgress = true;
  const cleanUrl = cleanGoogleAuthUrl(authUrl);
  devLog('[sysauth] starting Google login via system browser', cleanUrl);
  const hint = showAuthHint(guestContents);
  try {
    const res = await loginViaSystemBrowser({
      loginUrl: cleanUrl,
      targetSession: guestContents.session,
      isSignedInUrl: (u) => {
        try {
          const parsed = new URL(u);
          return /(^|\.)youtube\.com$/i.test(parsed.hostname) && !/\/signin/i.test(parsed.pathname);
        } catch { return false; }
      },
      log: (...a) => devLog(...a),
    });
    devLog('[sysauth] result', res);
    try { if (!hint.isDestroyed()) hint.close(); } catch {}
    if (res.ok) {
      try { if (!guestContents.isDestroyed()) guestContents.reload(); } catch {}
    } else {
      const msg = {
        'no-browser': 'No Chrome or Edge was found to sign in with.',
        closed: 'The sign-in window was closed before finishing.',
        timeout: 'Sign-in timed out. Please try again.',
      }[res.reason] || ('Sign-in did not complete (' + res.reason + ').');
      try {
        const parentWin = BrowserWindow.fromWebContents(guestContents.hostWebContents);
        dialog.showMessageBox(parentWin || undefined, { type: 'warning', title: 'Sign-in', message: msg });
      } catch {}
    }
  } finally {
    googleAuthInProgress = false;
    try { if (!hint.isDestroyed()) hint.close(); } catch {}
  }
}

// External links open in the real browser / associated desktop app.
app.on('web-contents-created', (_e, contents) => {
  devLog('[web-contents-created] type:', contents.getType(), 'id:', contents.id);

  // Links that try to open a new window (target="_blank", window.open, etc.)
  contents.setWindowOpenHandler(({ url, disposition }) => {
    devLog('[setWindowOpenHandler]', { url, disposition, type: contents.getType() });
    // about:blank popups from webviews — Outlook etc. use these to initiate downloads.
    // Allow them in a hidden window; navigation/downloads are handled below.
    if (url === 'about:blank' && contents.getType() === 'webview') {
      return { action: 'allow', overrideBrowserWindowOptions: { show: false } };
    }
    // OAuth / SSO popups (e.g. Microsoft/Google login) must stay in-app so they
    // share the tab's session and can postMessage the result back to the opener.
    // This popup is a real top-level window (not a webview), so it presents the
    // clean desktop-Chrome UA set globally via app.userAgentFallback.
    if (isAuthUrl(url)) {
      devLog('[setWindowOpenHandler] → allowing auth popup in-app', url);
      return { action: 'allow' };
    }
    if (url && url !== 'about:blank') {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // When an about:blank popup is created, intercept its navigation so the
  // real URL opens externally or triggers a download via the session handler.
  contents.on('did-create-window', (popup) => {
    devLog('[did-create-window] popup from', contents.getType());
    const pc = popup.webContents;
    // If this is an auth popup, let it run its full sign-in flow untouched.
    if (isAuthUrl(pc.getURL())) {
      devLog('[did-create-window] auth popup — leaving open for sign-in');
      return;
    }
    pc.on('will-navigate', (e, url) => {
      devLog('[popup will-navigate]', url);
      // A popup that starts on about:blank may navigate into an auth flow —
      // keep those in-app too.
      if (isAuthUrl(url)) {
        devLog('[popup will-navigate] → auth URL, keeping in-app', url);
        return;
      }
      e.preventDefault();
      shell.openExternal(url);
      popup.close();
    });
    // Give the popup time for JS to run (e.g. Outlook sets window.location
    // after about:blank loads). Clean up after 30s if nothing happened.
    setTimeout(() => {
      if (!popup.isDestroyed() && !isAuthUrl(popup.webContents.getURL())) {
        devLog('[popup] closing idle popup after timeout');
        popup.close();
      }
    }, 30000);
  });

  // For webview guest pages: intercept main-frame cross-origin navigations and
  // non-http protocols, opening them externally instead of inside the webview.
  contents.on('will-navigate', (e, url) => {
    const cType = contents.getType();
    devLog('[will-navigate]', { url, contentType: cType, currentURL: contents.getURL() });
    if (cType !== 'webview') return;
    // Google sign-in can't run inside the webview (Google blocks embedded
    // frameworks). Divert the initial hop into Google login to a real top-level
    // window that shares this tab's session; skip if we're already mid-flow.
    if (isGoogleAuthUrl(url) && !isGoogleAuthUrl(contents.getURL())) {
      e.preventDefault();
      devLog('[will-navigate] → diverting Google auth to system browser', url);
      startGoogleAuthViaBrowser(url, contents);
      return;
    }
    try {
      const dest = new URL(url);
      // Non-http(s) protocols → open with OS handler (Excel, Teams, etc.)
      if (!/^https?:$/i.test(dest.protocol)) {
        e.preventDefault();
        shell.openExternal(url);
        devLog('[will-navigate] → openExternal (protocol)', url);
        return;
      }
      // Different origin — if it looks like a file download, let the
      // webview handle it so the session's will-download handler fires
      // (preserving auth cookies). Otherwise open in default browser.
      const curr = contents.getURL();
      if (curr && new URL(curr).origin !== dest.origin) {
        // OAuth / SSO redirect — keep it in the webview so the sign-in shares
        // the tab's session. Covers both directions: app → auth provider
        // (e.g. Outlook → login.microsoftonline.com) and the return redirect
        // auth provider → app (e.g. login.microsoftonline.com → Outlook).
        if (isAuthUrl(url) || isAuthUrl(curr)) {
          devLog('[will-navigate] → allowing auth navigation in-app', url);
          return;
        }
        const downloadExts = /\.(docx?|xlsx?|pptx?|pdf|zip|rar|7z|gz|tar|csv|txt|exe|msi|dmg|pkg|ics|eml|msg|odt|ods|odp|rtf|mp3|mp4|wav|avi|mov|png|jpe?g|gif|svg|bmp|webp)(\?.*)?$/i;
        if (downloadExts.test(dest.pathname)) {
          devLog('[will-navigate] → allowing download URL (cross-origin)', url);
          return;
        }
        e.preventDefault();
        shell.openExternal(url);
        devLog('[will-navigate] → openExternal (cross-origin)', url);
      }
    } catch (err) { devLog('[will-navigate] URL parse error:', err.message, url); }
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

function loadCachedIcon(appId) {
  if (appIcons.has(appId)) return;
  try {
    const ico = iconCachePath(appId);
    if (fs.existsSync(ico)) {
      const img = nativeImage.createFromPath(ico);
      if (!img.isEmpty()) appIcons.set(appId, img);
    }
  } catch {}
}

// Give each app window its own taskbar identity (AppUserModelID) so separately
// launched standalone apps don't collapse into a single taskbar group. Windows
// groups by AUMID; without a per-window id, every window inherits the
// process-global id (shared across apps under the single-instance lock) and
// they group together. The id matches the AUMID on the installed shortcut
// (writeShortcuts), so a running window also associates with its pinned entry.
function applyWindowAppId(win, appDef) {
  if (process.platform !== 'win32' || !appDef) return;
  const relaunchArgs = app.isPackaged
    ? `--app-id=${appDef.id}`
    : `"${app.getAppPath()}" --app-id=${appDef.id}`;
  const details = {
    appId: `${APP_ID}.${appDef.id}`,
    relaunchCommand: `"${process.execPath}" ${relaunchArgs}`,
    relaunchDisplayName: appDef.name,
  };
  const ico = iconCachePath(appDef.id);
  if (fs.existsSync(ico)) { details.appIconPath = ico; details.appIconIndex = 0; }
  try { win.setAppDetails(details); } catch (e) { log.warn('setAppDetails failed', e); }
}

function launchApp(appDef) {
  const existing = appWindows.get(appDef.id);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }

  appDef.tabs.forEach((t) => setupSession(appDef.id, t));
  loadCachedIcon(appDef.id);

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
  applyWindowAppId(win, appDef);
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
  loadCachedIcon(appId);
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
  applyWindowAppId(win, getApp(appId));
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
// Standalone desktop apps — per-app .ico generation + Windows shortcuts
// ---------------------------------------------------------------------------
function iconCachePath(id) {
  return path.join(app.getPath('userData'), 'icons', `${id}.ico`);
}

// Wrap a single PNG into a minimal ICO container (Vista+ supports PNG entries).
function pngToIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);     // width  (0 = 256)
  entry.writeUInt8(0, 1);     // height (0 = 256)
  entry.writeUInt8(0, 2);     // palette
  entry.writeUInt8(0, 3);     // reserved
  entry.writeUInt16LE(1, 4);  // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);  // image size
  entry.writeUInt32LE(6 + 16, 12);     // offset to image data
  return Buffer.concat([header, entry, png]);
}

// Rasterize an emoji/letter glyph onto a rounded background → PNG buffer.
function renderGlyphPng(glyph) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 256, height: 256, show: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
    });
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'html,body{margin:0;padding:0}</style></head><body>' +
      '<canvas id="c" width="256" height="256"></canvas><script>' +
        'const ctx = document.getElementById("c").getContext("2d");' +
        'const r = 48;' +
        'ctx.fillStyle = "#3b82f6";' +
        'ctx.beginPath();' +
        'ctx.moveTo(r,0); ctx.arcTo(256,0,256,256,r); ctx.arcTo(256,256,0,256,r);' +
        'ctx.arcTo(0,256,0,0,r); ctx.arcTo(0,0,256,0,r); ctx.closePath(); ctx.fill();' +
        'ctx.fillStyle = "#ffffff";' +
        'ctx.font = "700 140px \'Segoe UI Emoji\', \'Segoe UI\', sans-serif";' +
        'ctx.textAlign = "center"; ctx.textBaseline = "middle";' +
        'const glyph = decodeURIComponent(location.hash.slice(1));' +
        'ctx.fillText(glyph, 128, 138);' +
        'window.__png = document.getElementById("c").toDataURL("image/png");' +
      '</script></body></html>';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html) + '#' + encodeURIComponent(glyph || '?'));
    win.webContents.once('did-finish-load', async () => {
      try {
        const dataUrl = await win.webContents.executeJavaScript('window.__png');
        const png = Buffer.from(String(dataUrl).split(',')[1], 'base64');
        resolve(png);
      } catch (e) { reject(e); }
      finally { win.destroy(); }
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      win.destroy(); reject(new Error(`glyph render failed: ${desc}`));
    });
  });
}

// Build (and cache) a per-app .ico; returns its path, or null on failure.
async function generateIcoForApp(appDef) {
  try {
    let png;
    const icon = (appDef.icon || '').trim();
    if (/^https?:\/\//i.test(icon)) {
      const img = await fetchImage(icon);
      if (!img || img.isEmpty()) throw new Error('icon image decode failed');
      png = img.resize({ width: 256, height: 256 }).toPNG();
    } else {
      const glyph = icon || (appDef.name || '?').charAt(0).toUpperCase();
      png = await renderGlyphPng(glyph);
    }
    const out = iconCachePath(appDef.id);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, pngToIco(png));
    return out;
  } catch (e) {
    log.warn('generateIcoForApp failed', e);
    return null;
  }
}

function shortcutPaths(name) {
  const file = `${sanitizeFileName(name)}.lnk`;
  return {
    desktop: path.join(app.getPath('desktop'), file),
    startMenu: path.join(
      app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', file
    ),
  };
}

function writeShortcuts(appDef, icoPath) {
  const args = app.isPackaged
    ? `--app-id=${appDef.id}`
    : `"${app.getAppPath()}" --app-id=${appDef.id}`;
  const opts = {
    target: process.execPath,
    args,
    description: appDef.name,
    icon: icoPath || process.execPath,
    iconIndex: 0,
    appUserModelId: `${APP_ID}.${appDef.id}`,
  };
  const { desktop, startMenu } = shortcutPaths(appDef.name);
  fs.mkdirSync(path.dirname(startMenu), { recursive: true });
  let ok = true;
  for (const p of [desktop, startMenu]) {
    if (!shell.writeShortcutLink(p, 'create', opts)) ok = false;
  }
  return ok;
}

function removeShortcutFiles(name) {
  const { desktop, startMenu } = shortcutPaths(name);
  for (const p of [desktop, startMenu]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { log.warn('unlink shortcut failed', p, e); }
  }
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
ipcMain.handle('apps:list', () => loadApps().map((a) => ({ ...a, installed: !!a.shortcut })));

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
  // Pre-cache the icon so it's available for the taskbar on first launch.
  generateIcoForApp(appDef).catch(() => {});
  return apps.map((a) => ({ ...a, installed: !!a.shortcut }));
});

ipcMain.handle('apps:update', async (_e, data) => {
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
    // Re-cache the icon so the taskbar picks it up on next launch.
    await generateIcoForApp(apps[idx]).catch(() => {});
    appIcons.delete(apps[idx].id); // clear stale in-memory icon
    // Keep an installed app's shortcut in sync with its (possibly new) name/icon.
    if (apps[idx].shortcut) await installShortcut(apps[idx].id);
  }
  return loadApps().map((a) => ({ ...a, installed: !!a.shortcut }));
});

ipcMain.handle('apps:remove', (_e, id) => {
  const all = loadApps();
  const gone = all.find((a) => a.id === id);
  if (gone && gone.shortcut) removeShortcutFiles(gone.shortcut.name);
  try { fs.unlinkSync(iconCachePath(id)); } catch {}
  const apps = all.filter((a) => a.id !== id);
  saveApps(apps);
  quitApp(id);
  syncLoginItem();
  return apps.map((a) => ({ ...a, installed: !!a.shortcut }));
});

ipcMain.handle('apps:launch', (_e, id) => {
  const appDef = getApp(id);
  if (appDef) launchApp(appDef);
  return true;
});

// Create/refresh Desktop + Start Menu shortcuts that launch this app standalone.
async function installShortcut(id) {
  const apps = loadApps();
  const appDef = apps.find((a) => a.id === id);
  if (!appDef) return { ok: false, installed: false };
  const name = sanitizeFileName(appDef.name);
  // Renamed since last install? Clear the stale .lnk files first.
  if (appDef.shortcut && appDef.shortcut.name && appDef.shortcut.name !== name) {
    removeShortcutFiles(appDef.shortcut.name);
  }
  const ico = await generateIcoForApp(appDef);
  const ok = writeShortcuts(appDef, ico);
  if (ok) {
    appDef.shortcut = { name };
    saveApps(apps);
  }
  log.info('Installed shortcut', appDef.name, { ok });
  return { ok, installed: ok };
}

function uninstallShortcut(id) {
  const apps = loadApps();
  const appDef = apps.find((a) => a.id === id);
  if (!appDef) return { ok: false, installed: false };
  removeShortcutFiles((appDef.shortcut && appDef.shortcut.name) || appDef.name);
  try { fs.unlinkSync(iconCachePath(id)); } catch {}
  delete appDef.shortcut;
  saveApps(apps);
  log.info('Uninstalled shortcut', appDef.name);
  return { ok: true, installed: false };
}

ipcMain.handle('apps:installShortcut', (_e, id) => installShortcut(id));
ipcMain.handle('apps:uninstallShortcut', (_e, id) => uninstallShortcut(id));

ipcMain.handle('app:openManager', () => { createManagerWindow(); return true; });

ipcMain.handle('app:isActivated', () => isActivated());
ipcMain.handle('app:activate', (_e, key) => activate(key));

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
// Absolute file:// URL of the media webview preload — computed here in the
// main process (full Node), since the appshell preload is sandboxed and cannot
// require('path')/require('url').
const MEDIA_PRELOAD_URL = require('url')
  .pathToFileURL(path.join(__dirname, 'appshell', 'media-preload.js')).href;

ipcMain.handle('app:get', (_e, id) => {
  const a = getApp(id);
  if (!a) return null;
  return {
    ...a,
    mediaPreloadPath: MEDIA_PRELOAD_URL,
    tabs: a.tabs.map((t) => ({ ...t, _partition: partitionFor(t) })),
  };
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
// Media controls — taskbar thumbnail-toolbar buttons (shown on taskbar hover /
// when minimized) and global hardware media keys, driving a media tab
// (e.g. YouTube Music). A media webview reports playback state via the appshell
// (media:state); we mirror it into the window's thumbbar and route transport
// commands (media:command) back down. See appshell/media-preload.js.
// ---------------------------------------------------------------------------
const mediaIcons = {};                 // { prev, play, pause, next } nativeImages
const mediaWins = new Set();           // windows currently hosting a media tab
let activeMediaWin = null;             // most recently active media window
let mediaKeysRegistered = false;

// White transport glyph on a transparent square → nativeImage (~32px).
function renderMediaIcon(glyph) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 32, height: 32, show: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
    });
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'html,body{margin:0;padding:0;background:transparent}</style></head><body>' +
      '<canvas id="c" width="32" height="32"></canvas><script>' +
        'const ctx=document.getElementById("c").getContext("2d");' +
        'ctx.fillStyle="#ffffff";ctx.font="600 22px \'Segoe UI Symbol\',\'Segoe UI\',sans-serif";' +
        'ctx.textAlign="center";ctx.textBaseline="middle";' +
        'ctx.fillText(decodeURIComponent(location.hash.slice(1)),16,17);' +
        'window.__png=document.getElementById("c").toDataURL("image/png");' +
      '</script></body></html>';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html) + '#' + encodeURIComponent(glyph));
    win.webContents.once('did-finish-load', async () => {
      try {
        const dataUrl = await win.webContents.executeJavaScript('window.__png');
        resolve(nativeImage.createFromDataURL(String(dataUrl)));
      } catch { resolve(nativeImage.createEmpty()); }
      finally { win.destroy(); }
    });
    win.webContents.once('did-fail-load', () => { win.destroy(); resolve(nativeImage.createEmpty()); });
  });
}

async function initMediaIcons() {
  if (mediaIcons.play) return;
  const [prev, play, pause, next] = await Promise.all(
    ['⏮', '▶', '⏸', '⏭'].map(renderMediaIcon)
  );
  Object.assign(mediaIcons, { prev, play, pause, next });
}

function routeMedia(cmd) {
  const win = (activeMediaWin && !activeMediaWin.isDestroyed()) ? activeMediaWin : null;
  if (win) win.webContents.send('media:command', cmd);
}

function ensureMediaKeys() {
  if (mediaKeysRegistered || mediaWins.size === 0) return;
  try {
    globalShortcut.register('MediaPlayPause', () => routeMedia('playpause'));
    globalShortcut.register('MediaNextTrack', () => routeMedia('next'));
    globalShortcut.register('MediaPreviousTrack', () => routeMedia('prev'));
    mediaKeysRegistered = true;
    devLog('[media] global media keys registered');
  } catch (e) { log.warn('media key register failed', e); }
}

function releaseMediaKeys() {
  if (!mediaKeysRegistered || mediaWins.size > 0) return;
  try {
    globalShortcut.unregister('MediaPlayPause');
    globalShortcut.unregister('MediaNextTrack');
    globalShortcut.unregister('MediaPreviousTrack');
  } catch {}
  mediaKeysRegistered = false;
  devLog('[media] global media keys released');
}

function updateThumbbar(win, s) {
  if (!win || win.isDestroyed() || !mediaIcons.play) return;
  // Remember the window's base title (app name) so we can restore it when no
  // track is playing, and show "Artist — Song" in the taskbar while it is.
  if (win._mediaBaseTitle === undefined) win._mediaBaseTitle = win.getTitle();
  if (!s || !s.enabled) {
    win.setThumbarButtons([]);
    win.setTitle(win._mediaBaseTitle);
    win.setThumbnailToolTip('');
    return;
  }
  // s.artist / s.title from the media adapter (e.g. YouTube Music player bar).
  const label = [s.artist, s.title].filter(Boolean).join(': ');
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: mediaIcons.prev, click: () => win.webContents.send('media:command', 'prev') },
    {
      tooltip: (s.playing ? 'Pause' : 'Play') + (label ? ` · ${label}` : ''),
      icon: s.playing ? mediaIcons.pause : mediaIcons.play,
      click: () => win.webContents.send('media:command', 'playpause'),
    },
    { tooltip: 'Next', icon: mediaIcons.next, click: () => win.webContents.send('media:command', 'next') },
  ]);
  // Show the track in the taskbar (thumbnail caption + hover tooltip). Falls
  // back to the app name when we don't have track metadata yet.
  win.setTitle(label || win._mediaBaseTitle);
  win.setThumbnailToolTip(label || '');
}

ipcMain.on('media:state', async (e, s) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  await initMediaIcons();
  if (s && s.enabled) {
    if (!mediaWins.has(win)) {
      mediaWins.add(win);
      win.once('closed', () => {
        mediaWins.delete(win);
        if (activeMediaWin === win) activeMediaWin = [...mediaWins][mediaWins.size - 1] || null;
        releaseMediaKeys();
      });
    }
    if (s.playing || !activeMediaWin || activeMediaWin.isDestroyed()) activeMediaWin = win;
    ensureMediaKeys();
  }
  updateThumbbar(win, s);
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
app.on('second-instance', (_e, argv) => {
  if (!isActivated()) { createManagerWindow(); return; }
  const id = appIdFromArgv(argv);
  const a = id && getApp(id);
  if (a) { launchApp(a); showApp(a.id); }
  else createManagerWindow();
});

if (gotLock) {
  app.whenReady().then(() => {
    syncLoginItem();
    if (!isActivated()) {
      // Not activated — always show the launcher so the user hits the gate.
      createManagerWindow();
    } else {
      if (process.argv.includes('--autostart')) {
        loadApps().filter((a) => a.settings.launchOnStartup).forEach(launchApp);
      }
      // Launched directly from a standalone app shortcut (--app-id=…): open just
      // that app and skip the launcher dashboard.
      const directId = appIdFromArgv(process.argv);
      const directApp = directId && getApp(directId);
      if (directApp) {
        app.setAppUserModelId(`${APP_ID}.${directApp.id}`);
        launchApp(directApp);
      } else {
        createManagerWindow();
      }
    }
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch((e) => log.warn('update check failed', e));
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createManagerWindow();
    });
  });
}

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });

app.on('window-all-closed', () => {
  if (trays.size > 0) return; // tray-hidden apps keep running
  if (process.platform !== 'darwin') app.quit();
});
