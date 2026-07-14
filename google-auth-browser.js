// Google sign-in via the user's REAL Chrome/Edge, then import the resulting
// session cookies into our Electron session.
//
// Why: Google blocks sign-in from the Electron/Chromium runtime (the "this
// browser or app may not be secure" wall) — it trusts real Chrome/Edge but not
// an embedded framework. Rather than fight that, we do the login where Google
// is happy (a genuine Chrome window) and carry the session back.
//
// How the cookies come across WITHOUT decrypting Chrome's on-disk store (which
// App-Bound Encryption blocks): we drive that Chrome over the DevTools Protocol
// and ask it for its cookies — it returns them already decrypted, httpOnly
// included. A web session is just those cookies, so setting them into our
// session partition signs the webview in.
//
// The launched Chrome uses a throwaway profile (never the user's real one) and
// is NOT run in automation mode (no navigator.webdriver flag), so Google sees a
// normal browser. We never type into it — the user completes the login by hand.
//
// puppeteer-core is ESM-only; this file is CommonJS, so it's loaded lazily via
// dynamic import() inside the async flow (also keeps it out of app startup).
const path = require('path');
const os = require('os');
const fs = require('fs');

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
];
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function findBrowser() {
  for (const p of CHROME_PATHS) if (safeExists(p)) return { name: 'Chrome', path: p };
  for (const p of EDGE_PATHS) if (safeExists(p)) return { name: 'Edge', path: p };
  return null;
}
function safeExists(p) { try { return fs.existsSync(p); } catch { return false; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Cookies that indicate a completed Google/YouTube web session.
const SESSION_MARKERS = /^(SAPISID|__Secure-3PAPISID|__Secure-3PSID|LOGIN_INFO|SID|SSID)$/;
// Domains whose cookies we carry into the app session.
const WANTED_DOMAIN = /(^|\.)(google\.com|youtube\.com|google\.[a-z.]+|ytimg\.com|googlevideo\.com)$/i;

// Map a CDP cookie object onto an Electron session.cookies.set() call.
async function importCookie(ses, c) {
  const host = (c.domain || '').replace(/^\./, '');
  if (!host) return false;
  const url = (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
  const det = {
    url,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  // Domain cookie (leading dot) vs host-only. __Host- prefix must stay host-only.
  if ((c.domain || '').startsWith('.')) det.domain = c.domain;
  const ss = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' }[c.sameSite];
  if (ss) det.sameSite = ss;
  if (typeof c.expires === 'number' && c.expires > 0) det.expirationDate = c.expires;
  try { await ses.cookies.set(det); return true; }
  catch { return false; }
}

// Launch the user's real Chrome/Edge (throwaway profile, no automation flags)
// on the login URL and attach a CDP session for reading cookies. Returns
// { browser, page, client, cleanup } or null if no browser is installed. Shared
// by the real flow AND the test harness so both exercise identical launch code.
async function openLoginBrowser(loginUrl, log = () => {}) {
  const browserInfo = findBrowser();
  if (!browserInfo) return null;
  log('[sysauth] using', browserInfo.name, browserInfo.path);

  const puppeteer = (await import('puppeteer-core')).default;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-gauth-'));
  const browser = await puppeteer.launch({
    executablePath: browserInfo.path,
    headless: false,
    userDataDir,
    defaultViewport: null,
    // Remove the automation switches so navigator.webdriver stays false and
    // Google sees an ordinary browser.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--new-window',
    ],
  });
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  // Sanity: confirm we are NOT flagged as automated (Google would reject that).
  try { log('[sysauth] navigator.webdriver =', await page.evaluate('navigator.webdriver')); } catch {}
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log('[sysauth] goto err', e.message));
  const client = await page.createCDPSession();
  const cleanup = async () => {
    try { await browser.close(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };
  return { browser, page, client, cleanup };
}

// Run the whole flow. Resolves with { ok, imported, reason }.
//   loginUrl      – the (cleaned) Google sign-in URL to open
//   targetSession – Electron Session to receive the cookies
//   isSignedInUrl – (url) => bool, true once the flow lands back on the app
//   log           – optional logger
async function loginViaSystemBrowser({ loginUrl, targetSession, isSignedInUrl, log = () => {} }) {
  const handle = await openLoginBrowser(loginUrl, log);
  if (!handle) return { ok: false, reason: 'no-browser' };
  const { browser, page, client, cleanup } = handle;
  try {
    const deadline = Date.now() + 5 * 60 * 1000; // up to 5 min for the user to log in
    let signedIn = false;
    while (Date.now() < deadline) {
      if (!browser.connected) { log('[sysauth] browser closed by user'); break; }
      let url = '';
      try { url = page.url(); } catch {}
      let cookies = [];
      try { ({ cookies } = await client.send('Network.getAllCookies')); } catch {}
      const hasSession = cookies.some((c) => /youtube\.com$/i.test(c.domain) && SESSION_MARKERS.test(c.name));
      if (hasSession && (isSignedInUrl(url) || cookies.some((c) => c.name === 'LOGIN_INFO'))) {
        signedIn = true;
        break;
      }
      await sleep(1000);
    }

    if (!signedIn && !browser.connected) return { ok: false, reason: 'closed' };
    if (!signedIn) return { ok: false, reason: 'timeout' };

    // Pull the full cookie set and import the Google/YouTube ones.
    let all = [];
    try { ({ cookies: all } = await client.send('Network.getAllCookies')); } catch {}
    const wanted = all.filter((c) => WANTED_DOMAIN.test(c.domain));
    let imported = 0;
    for (const c of wanted) if (await importCookie(targetSession, c)) imported++;
    log('[sysauth] imported', imported, 'of', wanted.length, 'cookies');
    return { ok: true, imported };
  } catch (e) {
    log('[sysauth] error', e.message);
    return { ok: false, reason: 'error:' + e.message };
  } finally {
    await cleanup();
  }
}

module.exports = { loginViaSystemBrowser, openLoginBrowser, findBrowser };
