// E2E test scaffolding for Electron app.
// Run with: npm run test:e2e
// Requires @playwright/test: npm install --save-dev @playwright/test
//
// NOTE: These tests launch the real Electron app and require a display.
// They are NOT run in CI by default (the CI workflow only runs unit tests).
// The activation gate may need to be bypassed for automated testing.
//
// Manual test steps for features that cannot be automated:
//
// ## Manual Test: App Launch & Dashboard
// Steps:
//   1. Run `npm start`
//   2. Verify the manager dashboard window opens
//   3. Verify the version number appears in the footer
//   4. Verify the "Check for updates" button is present
// Expected: Dashboard opens with app list (empty on first run)
// Acceptance: Window title contains "Web to Desktop", footer shows version
//
// ## Manual Test: Add App with Tabs
// Steps:
//   1. Click "+ Add App"
//   2. Enter name "Test App", add URL "https://example.com"
//   3. Click "Add Tab", enter second URL "https://httpbin.org"
//   4. Save the app
// Expected: App card appears on dashboard with correct name and icon
// Acceptance: Card shows "Test App", clicking Launch opens app window with 2 tabs
//
// ## Manual Test: Tab Reorder & Split
// Steps:
//   1. Launch a multi-tab app
//   2. Drag Tab 2 before Tab 1
//   3. Right-click Tab 1 -> "Split right"
//   4. Drag the divider to resize
//   5. Right-click -> "Unsplit"
// Expected: Tabs reorder on drag, split shows two webviews side by side
// Acceptance: Tab order persists after reorder, split/unsplit toggles correctly
//
// ## Manual Test: Notifications & Badges
// Steps:
//   1. Add an app with a site that sends notifications (e.g. Teams, Gmail)
//   2. Enable notifications in tab settings
//   3. Wait for or trigger a notification
// Expected: Windows toast notification appears, badge count shows on tab & dashboard
// Acceptance: Notification sound plays, badge number matches unread count
//
// ## Manual Test: Tray & Startup
// Steps:
//   1. Enable "Minimize to tray" in app settings
//   2. Close the app window (X button)
//   3. Verify app appears in system tray
//   4. Right-click tray icon -> "Show" to restore
//   5. Enable "Launch on startup", restart Windows, verify app auto-launches
// Expected: App hides to tray on close, restores on click, auto-launches on boot
// Acceptance: Tray icon visible, right-click menu works, startup registry entry exists
//
// ## Manual Test: Publish & Update
// Steps:
//   1. Bump version in package.json
//   2. Run `npm run publish`
//   3. Verify GitHub Release is created with installer
//   4. On a machine with the old version, click "Check for updates"
// Expected: New release published, old installs detect and download update
// Acceptance: GitHub Release exists with .exe, update downloads and installs

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');

test.describe('App launch', () => {
  test('app starts and shows a window', async () => {
    const app = await electron.launch({
      args: [path.resolve(__dirname, '..', '..')],
    });
    const window = await app.firstWindow();
    const title = await window.title();
    expect(title).toBeTruthy();
    await app.close();
  });
});
