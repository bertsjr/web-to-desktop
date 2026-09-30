# v2026.9.1

## What's New

### Modern browser engine — no more "unsupported browser" banners
- **Electron 31 → 44** (Chromium 126 → 152, Node 24). Gmail, Google Groups and Teams had begun showing "your browser is no longer supported" banners inside wrapped tabs because the bundled Chromium was years behind what those sites accept.
- **The user-agent is now derived from the engine**, not hardcoded. Previously the UA string claimed `Chrome/126.0.0.0` as a literal, which silently drifted out of sync on every Electron upgrade — and a UA that disagrees with the real Chromium is exactly the inconsistency Google's "this browser may not be secure" check keys on. `desktopUserAgent(process.versions.chrome)` builds it from the running engine and throws rather than emit a bogus version.
- `Sec-CH-UA` client hints and `navigator.userAgentData` are left as Chromium reports them, so the whole identity is self-consistent and carries no Electron token.
- **electron-builder 24 → 26**, required for packaging Electron 44.

## Bug Fixes

### Google sign-in now works for Gmail and Google Groups tabs
The system-browser sign-in flow was written for YouTube Music and had hardcoded that assumption: it decided the login was finished by looking for a **youtube.com** session cookie. A Gmail or Google Groups sign-in never touches youtube.com, so after the user authenticated successfully the flow never registered it, ran out its full 5-minute timeout, and imported **zero cookies** — the tab reloaded still signed out, with no error shown.

- Completion is now determined by `hasGoogleSession(cookies)` (session cookies on `google.com` **or** `youtube.com`) **and** `isPostLoginUrl(url)` (the flow has left `accounts.google.com` for its `continue=` target). Both are pure functions in `lib/utils.js` with regression tests.
- Interstitial pages — account chooser, password, 2FA, consent, and the `youtube.com/signin` hop — correctly count as still in progress.
- Cookie harvesting now waits for the redirect back to the app to settle, so the target site's own cookies are captured.
- YouTube Music sign-in is unaffected.

## Breaking Changes
- (None)

## Notes
- **`lib/utils.js`, `test/utils.test.js` and `.github/workflows/` are included in this release.** They had been created but never committed, so `main.js`'s `require('./lib/utils')` could not resolve in a fresh clone, CI never ran on GitHub, and tag-triggered publishing had no workflow to trigger. Local installer builds were unaffected because electron-builder packages the working directory.
- Unit tests: 53 Jest tests (was 41) — new coverage for `desktopUserAgent`, `isPostLoginUrl` and `hasGoogleSession`.
- **Multi-account `/u/N/` tab URLs:** the sign-in window uses a throwaway Chrome profile, so the account signed in there is always index `0`. A tab URL pinned to `/u/1/` (copied from a normal browser, where it may be the second account) will not resolve against the imported session. Use `/u/0/` or `?authuser=<email>` for those tabs.
- Verified: 53 unit tests pass; a real `<webview>` on Electron 44 presents `Chrome/152.0.0.0` to the server with client hints reporting Chromium 152 and no Electron token; the app boots with windows and webviews created cleanly; `npm run dist` packages successfully on electron-builder 26.
