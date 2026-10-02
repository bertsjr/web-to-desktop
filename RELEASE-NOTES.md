# v2026.10.1

## Bug Fixes

### Teams no longer launches itself in your browser

Opening the Teams app opened **Teams in Chrome** instead, leaving the app window stranded — and it happened on every launch.

Teams relocates itself from `teams.microsoft.com` to `teams.cloud.microsoft` (Microsoft's newer domain) as soon as it loads. The webview's navigation rule sent *any* main-frame navigation to a different origin out to the default browser unless it was a known auth host or looked like a file download, so the app handed Teams to Chrome and stopped.

`will-navigate` cannot distinguish a redirect the site performed from a link the user clicked — Electron exposes no user-gesture flag on the event — so the rule now recognises a site relocating itself across origins it owns:

- Same host, or the same registrable domain (`mail.google.com` → `groups.google.com`).
- The same vendor app suite (`teams.microsoft.com` → `teams.cloud.microsoft`, `outlook.cloud.microsoft` → `outlook.office.com`, SharePoint/OneDrive/Office).

Genuinely outbound links still open in your default browser, and lookalike hosts (`microsoft.com.evil.test`, `evil-microsoft.com`) are never treated as internal.

This also restores the Teams unread badge, which had been dead for the same reason — the tab never finished loading, so there was no title to read a count from.

### Tag-triggered publishing actually works now

The publish workflow referenced a `GH_TOKEN` repository secret that was never created, so the expression expanded to an empty string and electron-builder aborted with "Personal Access Token is not set". It now uses the automatically-provided `GITHUB_TOKEN`, which the job's existing `contents: write` permission already covers — nothing to create, rotate, or let expire.

## What's New
- (Nothing — this is a fix-only release.)

## Breaking Changes
- (None)

## Notes
- Unit tests: 63 (was 53). New coverage for `isInternalNavigation` and `registrableDomain`, including the exact Teams redirect as a regression test and lookalike-host rejection.
- Verified against a real signed-in Teams session: before the fix the launch logged two `openExternal (cross-origin)` hops to `teams.cloud.microsoft`; after it, zero, and Teams loads in-app with its chat list and unread count intact.
- **Known gap:** `window.open` / `target="_blank"` navigations are still sent to the browser without the same same-app check, so an internal Teams popup (whiteboard, a meeting window) may still open externally. Not addressed here — no reproduction yet.
- Still outstanding from 2026.9.1: multi-account `/u/N/` tab URLs. The Google sign-in window uses a throwaway profile, so the account signed in there is always index `0`; a tab pinned to `/u/1/` will not resolve against the imported session. Use `/u/0/` or `?authuser=<email>`.
