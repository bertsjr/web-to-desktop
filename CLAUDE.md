# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

```bash
npm install         # Downloads Electron (~150 MB) + dependencies
npm start          # Launch in development (live reload with Ctrl+R)
npm run dist       # Build Windows NSIS installer (outputs to dist/)
npm run publish    # Build and publish release to GitHub (requires GH_TOKEN)
```

## Project Overview

**Web to Desktop** is a Windows desktop application that wraps websites into isolated desktop apps. Each app can have multiple tabs (each with its own session, cookies, and settings), draggable/reorderable tabs, split-pane views, detachable windows, and Windows integration (notifications with sound, taskbar badges, tray icon, startup launch).

**Key tech:** Electron 31+, Node 18+, electron-builder (NSIS), electron-updater (GitHub releases), electron-log.

## Architecture

### File Structure

| File/Dir | Purpose |
|----------|---------|
| `main.js` | **Electron main process** — window lifecycle, per-tab session creation, tray menu, single-instance lock, startup launch, detached-tab windows, IPC handlers, logging, auto-update checks |
| `preload.js` | **Secure context bridge** — exposes `api` global to renderer (dashboard), handles IPC with main |
| `renderer/renderer.js` | **Dashboard UI** — list/add/edit apps, per-app settings (tray, startup), per-tab settings (notifications, session persistence), version display, update check button |
| `renderer/index.html` | Dashboard HTML (modal, grid cards, tab editor) |
| `appshell/appshell.js` | **App window UI** — toolbar (back/forward/reload), tab bar, webview hosting, drag-reorder tabs, right-click context menu, split-pane logic (horizontal/vertical divider), settings drawer, detached window mode |
| `appshell/index.html` | App window HTML (tabstrip, webview container, divider, toolbar) |
| `appshell/preload.js` | **Preload for app windows** — minimal, exposes `api.onXyz` listeners for unread/settings updates |
| `package.json` | Dependencies, electron-builder config (NSIS, GitHub publish), app version |

### Data Model

**Persistent store:** `apps.json` in `%APPDATA%\Web to Desktop` (on Windows). Structure:

```js
[
  {
    id: "uuid",
    name: "App Name",
    icon: "https://..." or emoji/text,
    settings: { minimizeToTray, launchOnStartup },  // app-level
    tabs: [
      {
        id: "uuid",
        name: "Tab Name",
        url: "https://...",
        settings: { notifications, persistSession }  // per-tab
      }
    ]
  }
]
```

**Per-tab sessions:** Each tab's cookies/storage live in an isolated Electron session partition: `persist:${tabId}` (or no prefix if `persistSession: false`). Two tabs at the same site can be logged into different accounts.

### Key Flows

**Dashboard (renderer process):**
- Renderer calls `api.list()` → main sends back all apps
- Renderer calls `api.save(appDef)` → main updates apps.json, saves to disk
- Renderer calls `api.launch(appId)` → main opens app window (appshell)
- Main broadcasts `api.onUnread({ id, count })` → renderer updates badges on cards

**App window (appshell process):**
- Appshell loads `api.get(appId)` → receives app + tabs + settings
- Each tab is a `<webview>` with `partition` set to the tab's session
- Dragging a tab reorders its position in the tabs array
- Right-click menu: "Move to new window" → main opens a detached window with `DETACHED=1&tab=${tabId}`
- Split/unsplit → modifies layout object, updates pane rendering
- Settings drawer updates tab settings → calls `api.updateTab(appId, tabId, newSettings)`

**Notifications & unread:**
- Appshell listens for `webContents.on('page-title-updated')` and parses unread badge from title (e.g., Teams "(3)")
- Main broadcasts `api.onUnread({ id, count })` to renderer and other windows
- Clicking notification calls IPC to focus the app window and activate the tab

### IPC Endpoints

Main process exposes these via ipcMain.handle/on:

- `api.list()` — return all apps
- `api.get(appId)` — return one app + tabs + settings
- `api.save(appDef)` — save/update app, return updated def
- `api.delete(appId)` — remove app
- `api.launch(appId)` → open app window
- `api.updateTab(appId, tabId, settings)` — update tab settings
- `api.checkForUpdates()` — trigger electron-updater
- `api.onUnread(listener)` — listen for badge updates (broadcast)

## Development Notes

### Running Development

```bash
npm start
```

- Main process runs `main.js` directly via electron
- Renderer can reload with Ctrl+R (refreshes dashboard)
- AppShell can reload with Ctrl+R (refreshes app window)
- Devtools: `Ctrl+Shift+I` in any window
- No hot reload; edit files and reload windows

### Building & Publishing

**Local build (for testing):**
```bash
npm run dist
# Outputs dist/Web to Desktop 1.0.0.exe
```

**Publishing to GitHub (production):**
```bash
export GH_TOKEN="your_github_token"  # Must have 'repo' scope
npm run publish
```

- Builds the installer
- Creates a GitHub release with the version from `package.json`
- Installed apps check for updates on launch; electron-updater downloads in background
- Version bump in `package.json` is required for each new release

### Logging

The app logs to **`%APPDATA%\Web to Desktop\logs\main.log`** (via electron-log). In development (npm start), logs also go to console.

### URL Normalization

- `normalizeUrl()` in main.js adds `https://` prefix if no protocol is present
- All tab URLs are validated and normalized on load/save

### Session Partitions

- Tabs with `persistSession: true` use `persist:${tabId}` → cookies survive app restart
- Tabs with `persistSession: false` use no partition prefix (ephemeral) → private session, cleared on app close
- Each tab can change `persistSession` in settings; takes effect on next app launch

### Detached Windows

- "Move to new window" in appshell context menu → opens a new window with `DETACHED=1&tab=${tabId}`
- Detached windows hide the tab bar (`tabstrip.style.display = 'none'`)
- Closing a detached window returns the tab to the main app window (no data loss; tab state is in main process)

### External Links

- Links that open in `window.open()` or have `target="_blank"` are intercepted and opened in the user's default browser (via `shell.openExternal()`)
- This prevents popups from hijacking the embedded window

## Cursor/Copilot Rules

None detected (no `.cursorrules` or `.github/copilot-instructions.md`).

## Common Tasks

### Adding a new IPC endpoint

1. In `main.js`: Define the handler with `ipcMain.handle('endpoint-name', handler)`
2. In `preload.js`: Expose via `contextBridge.exposeInMainWorld('api', { endpointName: (...) => ipcRenderer.invoke('endpoint-name', ...) })`
3. In renderer/appshell: Call `api.endpointName()`
4. For broadcast events (like unread), use `mainWindow.webContents.send()` or `appshellWindow.webContents.send()`

### Adding a new app setting

1. Add field to `DEFAULT_APP_SETTINGS` in main.js
2. Add UI control in renderer/index.html
3. Add event listener in renderer/renderer.js to call `api.save()`
4. Add handler in main.js if settings affect app behavior (e.g., tray, startup)

### Adding a new tab setting

1. Add field to `DEFAULT_TAB_SETTINGS` in main.js
2. In renderer tab editor: add input, bind to tab.settings
3. In appshell: add UI control or settings drawer toggle
4. Call `api.updateTab(appId, tabId, newSettings)` from appshell
5. Handle in main.js `updateTab` handler if it affects session or partition

### Testing notifications

- In appshell, the unread badge is parsed from window title (e.g., "(3) GitHub")
- To test: webview can be forced to reload with toolbar reload button or Ctrl+R
- Check `main.js` notification code for Windows App ID registration (uses `com.bert.webtodesktop`)

## Known Patterns

- **Data flow:** renderer ↔ main (IPC) ↔ file system (apps.json)
- **Window isolation:** renderer (dashboard) runs in one BrowserWindow; appshell runs in separate windows
- **Session isolation:** each tab partition is isolated; IPC broadcasts unread count to sync UI across windows
- **Preload bridges:** two preload files (one for dashboard, one for appshell) expose only necessary APIs
- **No framework:** vanilla JS (no React/Vue); DOM manipulation with vanilla selectors and innerHTML
