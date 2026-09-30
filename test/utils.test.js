const {
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
  DEFAULT_TAB_SETTINGS,
} = require('../lib/utils');

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------
describe('normalizeUrl', () => {
  test('returns null/undefined unchanged', () => {
    expect(normalizeUrl(null)).toBeNull();
    expect(normalizeUrl(undefined)).toBeUndefined();
    expect(normalizeUrl('')).toBe('');
  });

  test('prepends https:// when no protocol', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('example.com/path')).toBe('https://example.com/path');
  });

  test('preserves existing http:// or https://', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  });

  test('handles uppercase protocol', () => {
    expect(normalizeUrl('HTTP://example.com')).toBe('HTTP://example.com');
    expect(normalizeUrl('HTTPS://example.com')).toBe('HTTPS://example.com');
  });
});

// ---------------------------------------------------------------------------
// normalizeTabs
// ---------------------------------------------------------------------------
describe('normalizeTabs', () => {
  test('filters out tabs with empty URLs', () => {
    const result = normalizeTabs([{ url: '' }, { url: '  ' }, { url: 'example.com' }]);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com');
  });

  test('assigns default id if missing', () => {
    const result = normalizeTabs([{ url: 'example.com' }]);
    expect(result[0].id).toBeDefined();
    expect(typeof result[0].id).toBe('string');
    expect(result[0].id.length).toBeGreaterThan(0);
  });

  test('preserves existing id', () => {
    const result = normalizeTabs([{ id: 'my-id', url: 'example.com' }]);
    expect(result[0].id).toBe('my-id');
  });

  test('defaults tab name to "Tab"', () => {
    const result = normalizeTabs([{ url: 'example.com' }]);
    expect(result[0].name).toBe('Tab');
  });

  test('merges default settings, legacy settings, and tab settings', () => {
    const result = normalizeTabs(
      [{ url: 'example.com', settings: { notifications: false } }],
      { persistSession: false }
    );
    expect(result[0].settings.notifications).toBe(false);
    expect(result[0].settings.persistSession).toBe(false);
    expect(result[0].settings.mediaControls).toBe(false);
  });

  test('tab settings override legacy settings', () => {
    const result = normalizeTabs(
      [{ url: 'example.com', settings: { persistSession: true } }],
      { persistSession: false }
    );
    expect(result[0].settings.persistSession).toBe(true);
  });

  test('returns empty array for null/empty input', () => {
    expect(normalizeTabs(null)).toEqual([]);
    expect(normalizeTabs([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// migrateApp
// ---------------------------------------------------------------------------
describe('migrateApp', () => {
  test('converts single-URL legacy app to tab', () => {
    const app = migrateApp({ id: '1', name: 'Test', url: 'example.com' });
    expect(app.tabs).toHaveLength(1);
    expect(app.tabs[0].url).toBe('https://example.com');
  });

  test('moves legacy app-level notifications to tab settings', () => {
    const app = migrateApp({
      id: '1', name: 'Test', url: 'example.com',
      settings: { notifications: false },
    });
    expect(app.tabs[0].settings.notifications).toBe(false);
  });

  test('normalizes app settings to booleans', () => {
    const app = migrateApp({ id: '1', name: 'Test', url: 'example.com', settings: {} });
    expect(app.settings).toEqual({ minimizeToTray: false, launchOnStartup: false });
  });

  test('creates placeholder tab when all tabs have empty URLs', () => {
    const app = migrateApp({ id: '1', name: 'Test', tabs: [{ url: '' }] });
    expect(app.tabs).toHaveLength(1);
    expect(app.tabs[0].url).toBe('');
    expect(app.tabs[0].settings).toEqual(DEFAULT_TAB_SETTINGS);
  });

  test('preserves valid tabs', () => {
    const app = migrateApp({
      id: '1', name: 'Test',
      tabs: [{ id: 't1', name: 'Tab 1', url: 'https://example.com', settings: {} }],
    });
    expect(app.tabs).toHaveLength(1);
    expect(app.tabs[0].id).toBe('t1');
  });
});

// ---------------------------------------------------------------------------
// partitionFor
// ---------------------------------------------------------------------------
describe('partitionFor', () => {
  test('returns persist: prefix when persistSession is true', () => {
    expect(partitionFor({ id: 'abc', settings: { persistSession: true } }))
      .toBe('persist:tab-abc');
  });

  test('returns no prefix when persistSession is false', () => {
    expect(partitionFor({ id: 'abc', settings: { persistSession: false } }))
      .toBe('tab-abc');
  });

  test('treats undefined persistSession as true (default)', () => {
    expect(partitionFor({ id: 'abc', settings: {} }))
      .toBe('persist:tab-abc');
  });
});

// ---------------------------------------------------------------------------
// isAuthUrl
// ---------------------------------------------------------------------------
describe('isAuthUrl', () => {
  test('recognizes known auth hosts', () => {
    expect(isAuthUrl('https://login.microsoftonline.com/tenant')).toBe(true);
    expect(isAuthUrl('https://accounts.google.com/signin')).toBe(true);
  });

  test('recognizes subdomains of auth hosts', () => {
    expect(isAuthUrl('https://foo.okta.com/login')).toBe(true);
    expect(isAuthUrl('https://sub.login.live.com')).toBe(true);
  });

  test('rejects non-auth URLs', () => {
    expect(isAuthUrl('https://example.com')).toBe(false);
    expect(isAuthUrl('https://google.com')).toBe(false);
  });

  test('returns false for invalid URLs', () => {
    expect(isAuthUrl('not a url')).toBe(false);
    expect(isAuthUrl('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isGoogleAuthUrl
// ---------------------------------------------------------------------------
describe('isGoogleAuthUrl', () => {
  test('recognizes Google auth hosts', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com/signin')).toBe(true);
    expect(isGoogleAuthUrl('https://accounts.youtube.com/signin')).toBe(true);
  });

  test('recognizes subdomains', () => {
    expect(isGoogleAuthUrl('https://foo.accounts.google.com/x')).toBe(true);
  });

  test('rejects non-Google auth URLs', () => {
    expect(isGoogleAuthUrl('https://google.com')).toBe(false);
    expect(isGoogleAuthUrl('https://login.microsoftonline.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cleanGoogleAuthUrl
// ---------------------------------------------------------------------------
describe('cleanGoogleAuthUrl', () => {
  test('strips uilel and ltmpl params', () => {
    const url = 'https://accounts.google.com/signin?uilel=3&ltmpl=music&continue=https://youtube.com';
    const result = cleanGoogleAuthUrl(url);
    expect(result).not.toContain('uilel');
    expect(result).not.toContain('ltmpl');
    expect(result).toContain('continue=');
  });

  test('returns input unchanged for invalid URLs', () => {
    expect(cleanGoogleAuthUrl('not a url')).toBe('not a url');
  });

  test('preserves URL with no offending params', () => {
    const url = 'https://accounts.google.com/signin?continue=https://youtube.com';
    const result = cleanGoogleAuthUrl(url);
    expect(result).toContain('continue=');
  });
});

// ---------------------------------------------------------------------------
// hasGoogleSession
// ---------------------------------------------------------------------------
describe('hasGoogleSession', () => {
  // A signed-out visit to accounts.google.com: consent/prefs cookies only.
  const signedOut = [
    { domain: '.google.com', name: 'NID' },
    { domain: '.google.com', name: 'CONSENT' },
    { domain: 'accounts.google.com', name: 'GAPS' },
  ];

  test('false before sign-in completes', () => {
    expect(hasGoogleSession(signedOut)).toBe(false);
  });

  test('true for a Gmail/Groups sign-in that never touches youtube.com', () => {
    // Regression: the check used to require a youtube.com cookie, so this —
    // a completed Google account sign-in — read as "not signed in" and the
    // flow timed out without importing anything.
    expect(hasGoogleSession([
      ...signedOut,
      { domain: '.google.com', name: 'SID' },
      { domain: '.google.com', name: '__Secure-3PSID' },
    ])).toBe(true);
  });

  test('true for a YouTube sign-in', () => {
    expect(hasGoogleSession([{ domain: '.youtube.com', name: 'LOGIN_INFO' }])).toBe(true);
  });

  test('ignores session-shaped cookies from unrelated domains', () => {
    expect(hasGoogleSession([
      { domain: '.notgoogle.com', name: 'SID' },
      { domain: 'google.com.evil.test', name: 'SAPISID' },
    ])).toBe(false);
  });

  test('handles empty, missing and malformed cookie lists', () => {
    expect(hasGoogleSession([])).toBe(false);
    expect(hasGoogleSession(null)).toBe(false);
    expect(hasGoogleSession(undefined)).toBe(false);
    expect(hasGoogleSession([null, {}, { name: 'SID' }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPostLoginUrl
// ---------------------------------------------------------------------------
describe('isPostLoginUrl', () => {
  test('false while still on a Google account domain', () => {
    expect(isPostLoginUrl('https://accounts.google.com/ServiceLogin?service=mail')).toBe(false);
    expect(isPostLoginUrl('https://accounts.google.com/signin/v2/challenge/pwd')).toBe(false);
    expect(isPostLoginUrl('https://accounts.youtube.com/accounts/SetSID')).toBe(false);
  });

  test('false for the intermediate /signin hop on the target site', () => {
    expect(isPostLoginUrl('https://www.youtube.com/signin?action_handle_signin=true')).toBe(false);
  });

  test('true once redirected to the continue target', () => {
    // Regression: these are the tabs the old youtube-only check never matched,
    // so the sign-in ran to timeout and no cookies were imported.
    expect(isPostLoginUrl('https://groups.google.com/u/1/a/example.io/g/support')).toBe(true);
    expect(isPostLoginUrl('https://mail.google.com/mail/u/1/#inbox')).toBe(true);
    expect(isPostLoginUrl('https://music.youtube.com/')).toBe(true);
    expect(isPostLoginUrl('https://myaccount.google.com/')).toBe(true);
  });

  test('false for non-http(s) and unparseable URLs', () => {
    expect(isPostLoginUrl('about:blank')).toBe(false);
    expect(isPostLoginUrl('')).toBe(false);
    expect(isPostLoginUrl(null)).toBe(false);
    expect(isPostLoginUrl('not a url')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// desktopUserAgent
// ---------------------------------------------------------------------------
describe('desktopUserAgent', () => {
  test('claims the major version of the engine it is given', () => {
    expect(desktopUserAgent('152.0.7977.78')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    );
    expect(desktopUserAgent('126.0.6478.234')).toContain('Chrome/126.0.0.0');
  });

  test('carries no Electron token or app name', () => {
    const ua = desktopUserAgent('152.0.7977.78');
    expect(ua).not.toMatch(/electron/i);
    expect(ua).not.toMatch(/web.to.desktop/i);
  });

  test('throws rather than emitting a UA with a bogus version', () => {
    expect(() => desktopUserAgent(undefined)).toThrow(/unusable Chromium version/);
    expect(() => desktopUserAgent('')).toThrow(/unusable Chromium version/);
    expect(() => desktopUserAgent('vNext')).toThrow(/unusable Chromium version/);
  });
});

// ---------------------------------------------------------------------------
// cmpVersion
// ---------------------------------------------------------------------------
describe('cmpVersion', () => {
  test('equal versions return 0', () => {
    expect(cmpVersion('1.0.0', '1.0.0')).toBe(0);
    expect(cmpVersion('2026.7.2', '2026.7.2')).toBe(0);
  });

  test('newer version returns 1', () => {
    expect(cmpVersion('2.0.0', '1.0.0')).toBe(1);
    expect(cmpVersion('2026.7.2', '2026.6.2')).toBe(1);
  });

  test('older version returns -1', () => {
    expect(cmpVersion('1.0.0', '2.0.0')).toBe(-1);
  });

  test('release outranks pre-release of same version', () => {
    expect(cmpVersion('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(cmpVersion('1.0.0-beta.1', '1.0.0')).toBe(-1);
  });

  test('strips leading v', () => {
    expect(cmpVersion('v1.0.0', '1.0.0')).toBe(0);
  });

  test('handles different segment lengths', () => {
    expect(cmpVersion('1.0', '1.0.0')).toBe(0);
    expect(cmpVersion('1.0.1', '1.0')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFileName
// ---------------------------------------------------------------------------
describe('sanitizeFileName', () => {
  test('strips illegal chars', () => {
    expect(sanitizeFileName('My:App*Name')).toBe('MyAppName');
    expect(sanitizeFileName('Test\\File/"Name"')).toBe('TestFileName');
  });

  test('defaults to "App" for empty/null input', () => {
    expect(sanitizeFileName(null)).toBe('App');
    expect(sanitizeFileName('')).toBe('App');
    expect(sanitizeFileName(undefined)).toBe('App');
  });

  test('trims whitespace', () => {
    expect(sanitizeFileName('  My App  ')).toBe('My App');
  });
});

// ---------------------------------------------------------------------------
// appIdFromArgv
// ---------------------------------------------------------------------------
describe('appIdFromArgv', () => {
  test('extracts id from --app-id=xyz', () => {
    expect(appIdFromArgv(['electron', '.', '--app-id=abc123'])).toBe('abc123');
  });

  test('returns null when no matching arg', () => {
    expect(appIdFromArgv(['electron', '.'])).toBeNull();
    expect(appIdFromArgv([])).toBeNull();
  });

  test('handles null/undefined argv', () => {
    expect(appIdFromArgv(null)).toBeNull();
    expect(appIdFromArgv(undefined)).toBeNull();
  });
});
