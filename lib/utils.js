const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------
const DEFAULT_APP_SETTINGS = { minimizeToTray: false, launchOnStartup: false };
const DEFAULT_TAB_SETTINGS = { notifications: true, persistSession: true, mediaControls: false };

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function normalizeUrl(url) {
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) return 'https://' + url;
  return url;
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------
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

function partitionFor(tab) {
  const prefix = tab.settings.persistSession !== false ? 'persist:' : '';
  return `${prefix}tab-${tab.id}`;
}

// ---------------------------------------------------------------------------
// Auth URL helpers
// ---------------------------------------------------------------------------
const AUTH_HOSTS = [
  'login.microsoftonline.com', 'login.microsoftonline.us',
  'login.microsoft.com', 'login.live.com', 'login.windows.net',
  'account.live.com', 'account.microsoft.com',
  'msauth.net', 'msftauth.net', 'microsoftonline.com',
  'accounts.google.com', 'accounts.youtube.com',
  'okta.com', 'auth0.com', 'onelogin.com',
  'pingidentity.com', 'duosecurity.com',
];

const GOOGLE_AUTH_HOSTS = ['accounts.google.com', 'accounts.youtube.com'];

function isAuthUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AUTH_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

function isGoogleAuthUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return GOOGLE_AUTH_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Cookies that only exist once a Google web session is established. Account
// sign-in sets these on .google.com; LOGIN_INFO is YouTube's equivalent.
const GOOGLE_SESSION_COOKIES =
  /^(SID|SSID|HSID|APISID|SAPISID|LOGIN_INFO|__Secure-1PSID|__Secure-3PSID|__Secure-1PAPISID|__Secure-3PAPISID)$/;
// Domains those cookies land on. Deliberately NOT youtube-only: a Gmail or
// Google Groups sign-in never touches youtube.com, so keying this on
// youtube.com made every non-YouTube tab wait out the full sign-in timeout and
// import nothing, even after the user had signed in successfully.
const GOOGLE_SESSION_DOMAIN = /(^|\.)(google\.com|youtube\.com)$/i;

// Given a CDP cookie list, has the user completed a Google sign-in?
function hasGoogleSession(cookies) {
  return (cookies || []).some(
    (c) => c && GOOGLE_SESSION_DOMAIN.test(c.domain || '') && GOOGLE_SESSION_COOKIES.test(c.name)
  );
}

// True once the system-browser sign-in has left Google's account domain — it
// followed the `continue=` target back to the app (mail.google.com,
// groups.google.com, music.youtube.com, ...). Pages on accounts.google.com
// (account chooser, password, 2FA, consent) and the youtube.com/signin hop are
// still mid-flow, so they must NOT count as done.
function isPostLoginUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return false;
    if (/\/signin/i.test(u.pathname)) return false;
    const host = u.hostname.toLowerCase();
    return !GOOGLE_AUTH_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

function cleanGoogleAuthUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('uilel');
    u.searchParams.delete('ltmpl');
    return u.toString();
  } catch { return rawUrl; }
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------
function cmpVersion(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).replace(/^v/i, '').split('-');
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
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------
function sanitizeFileName(name) {
  return String(name || 'App').replace(/[\\\/:*?"<>|]/g, '').trim() || 'App';
}

function appIdFromArgv(argv) {
  const a = (argv || []).find((x) => typeof x === 'string' && x.startsWith('--app-id='));
  return a ? a.slice('--app-id='.length) : null;
}

// ---------------------------------------------------------------------------
// Browser identity
// ---------------------------------------------------------------------------
// Present a clean desktop-Chrome UA for the Chromium version we ACTUALLY run.
// Electron's default UA carries an "Electron/<ver>" token plus the app name,
// which Google flags as an embedded framework; a hardcoded version is worse
// still, because it drifts out of sync with the engine on every Electron bump
// and both mismatched and stale versions trip the "browser no longer
// supported" / "this browser may not be secure" checks. Derive it instead.
function desktopUserAgent(chromeVersion) {
  const major = (String(chromeVersion ?? '').match(/^\d+/) || [])[0];
  if (!major) {
    throw new Error(`desktopUserAgent: unusable Chromium version ${JSON.stringify(chromeVersion)}`);
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

module.exports = {
  DEFAULT_APP_SETTINGS,
  DEFAULT_TAB_SETTINGS,
  AUTH_HOSTS,
  GOOGLE_AUTH_HOSTS,
  normalizeUrl,
  normalizeTabs,
  migrateApp,
  partitionFor,
  isAuthUrl,
  isGoogleAuthUrl,
  cleanGoogleAuthUrl,
  isPostLoginUrl,
  hasGoogleSession,
  desktopUserAgent,
  cmpVersion,
  sanitizeFileName,
  appIdFromArgv,
};
