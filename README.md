# Web to Desktop

A Windows desktop application that turns websites into desktop apps. It bundles Chromium (via Electron), so each app launches in its own browser-free window. Each **tab is its own entity** — its own session, cookies, and settings — and you arrange tabs however you like.

## What it does

- A **manager dashboard** lists all the apps you've added.
- Click **+ Add App**, give it a name, an optional icon, and **one or more tabs**. Each tab is a website with its **own settings** (notifications, keep-cookies).
- Click **Launch** to open the app: a tab bar plus a toolbar (back / forward / reload).
- **Desktop notifications with sound** (registered with a Windows App ID) and **unread badges** on the taskbar icon, the tabs, and the dashboard card.
- External links open in your normal browser instead of hijacking the window.
- Everything is saved automatically and persists between restarts.

## Working with tabs

Tabs are defined in the dashboard editor (there's no in-app "new tab" button — each tab is a managed entity). Inside an app window you can:

- **Reorder** tabs by dragging them.
- **Right-click a tab** for: **Move to new window**, **Split right (side by side)**, **Split down (stacked)**, and **Unsplit**.
- **Split view** shows two tabs at once with a **draggable divider** to resize the panes (horizontal or vertical).
- **Move to new window** pops a tab out into its own window. **Closing that window returns the tab** to the app as a tab again.
- **Reload** the active tab with the toolbar button or **Ctrl+R / F5**.

## Settings

Open an app and click the **⚙ gear** (or edit it in the dashboard).

**Per tab** (each tab is independent):

- **Enable notifications** — on/off for that tab.
- **Keep cookies & logins** — persist that tab's session (off = private session each launch; applies next launch).
- **Clear cache** and **Clear cookies & data** — scoped to that one tab.

**Per app:**

- **Minimize to tray on close** — the X hides the app to the system tray (notifications keep arriving). Right-click the tray icon to exit.
- **Launch on Windows startup** — open the app automatically when you sign in.
- **Exit app** — fully quits the app even when minimize-to-tray is on.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (you have v22).

## Run it (development)

```bash
npm install
npm start
```

The first `npm install` downloads Electron plus `electron-updater` and `electron-log` (~150 MB), so it may take a minute.

## Build a Windows installer (.exe)

```bash
npm run dist
```

Produces an NSIS installer in `dist/` that installs "Web to Desktop" like a normal Windows program (Start-menu entry and desktop shortcut).

## Auto-updates (GitHub Releases)

The app uses `electron-updater` against **GitHub Releases**. To enable it:

1. In `package.json`, set `build.publish.owner` to your GitHub username and `repo` to your repository name.
2. Set a `GH_TOKEN` environment variable with a token that has `repo` scope, then run `npm run publish` to build and upload a release.
3. Bump the `version` in `package.json` for each new release.

The installed app checks for updates on launch; the dashboard footer shows the current version, a **Check for updates** button, a **Restart & install** button (once an update is downloaded), and a **Roll back…** button. Update checks are no-ops in `npm start` (dev) — they only run in the installed build.

### Version policy

- **No downgrades.** The updater installs a version only when it is **newer than** the installed one (`allowDowngrade = false`). A version equal to or older than the current one is reported and skipped.
- **Newer builds, even if not "official".** Pre-releases are accepted (`allowPrerelease = true`), so a newer build published as a pre-release (not marked the latest stable) will still install. Publish such builds to GitHub Releases as a pre-release.
- Version comparison handles both calendar versions (`2026.6.2`) and semver-style tags (`1.2.3-beta.1`).

### Enforcing a rollback

Downgrades are blocked by default, but **Roll back…** performs a deliberate one: it lifts the block for a single check and installs whatever version the feed is currently serving, then re-arms the block. To push a fleet-wide rollback, point the GitHub Releases "latest" at the known-good older version (or re-publish it) and have users click **Roll back…** (or trigger it programmatically). Every rollback is confirmed in the UI and recorded in the log.

## Logs

The installed app writes logs to **`%APPDATA%\Web to Desktop\logs\main.log`** (via `electron-log`). This folder is always writable and survives reinstalls. (Writing into the Program Files install directory was avoided because it normally requires admin rights.)

## Where your data lives

Apps, tabs, and settings are stored in `apps.json` in the per-user data folder (`%APPDATA%\Web to Desktop` on Windows). Each tab's cookies/logins live in its own session partition in the same area.

## Project layout

| File | Purpose |
|------|---------|
| `main.js` | Main process — windows, per-tab sessions, tray, startup, detached-tab windows, logging, auto-update. |
| `preload.js` | Secure bridge for the dashboard. |
| `renderer/` | Manager dashboard (list / add / edit, per-tab settings, version + updates). |
| `appshell/` | The window each app opens into: toolbar, draggable tabs, split panes, right-click menu, settings drawer. |
| `package.json` | Dependencies and the electron-builder / publish config. |

## Notes

- Each tab gets an isolated session keyed by tab id, so two tabs (even the same site) can be logged into different accounts.
- Notification *sounds* also depend on Windows: if Focus Assist / Do Not Disturb is on, Windows mutes toast sounds globally.
- Popup/`window.open` links open in your real browser; most sites (including Teams) log in inline and work fine.
