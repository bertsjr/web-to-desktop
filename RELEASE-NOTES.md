# v2026.7.3

## What's New

### Testing Infrastructure
- **Unit tests** — 41 Jest tests covering all pure utility functions (URL normalization, tab migration, auth URL detection, version comparison, and more).
- **E2e scaffolding** — Playwright + Electron test harness with manual test procedures for non-automatable features.
- **Jest & Playwright configs** added (`jest.config.js`, `playwright.config.js`).

### CI/CD Pipelines
- **CI workflow** (`.github/workflows/ci.yml`) — runs unit tests on `windows-latest` for every PR to `main` and pushes to `main`/`stage`.
- **Publish workflow** (`.github/workflows/publish.yml`) — tag-triggered (`v*`) pipeline that runs tests, builds the NSIS installer, publishes to GitHub Releases, and updates release notes automatically.
- **Local publish script** (`scripts/publish.js`) — loads `GH_TOKEN` from `.env` so you don't need to export it manually.

### Code Quality
- **Extracted pure functions** to `lib/utils.js` — `normalizeUrl`, `normalizeTabs`, `migrateApp`, `partitionFor`, `isAuthUrl`, `isGoogleAuthUrl`, `cleanGoogleAuthUrl`, `cmpVersion`, `sanitizeFileName`, `appIdFromArgv` — all testable without Electron.
- **Dev launcher** (`scripts/dev.js`) filters benign Chromium WGC stderr noise during development, keeping the terminal clean.

## Bug Fixes
- (None)

## Breaking Changes
- (None)

## Notes
- The version in `package.json` must be bumped to `2026.7.3` before tagging.
- All future code changes should include corresponding test updates in `test/utils.test.js`.
