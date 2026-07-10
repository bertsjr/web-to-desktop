const params = new URLSearchParams(location.search);
const APP_ID = params.get('id');
const SOLO_ID = params.get('tab');          // set in detached windows
const DETACHED = params.get('detached') === '1';

const tabstrip = document.getElementById('tabstrip');
const views = document.getElementById('views');
const dragGuard = document.getElementById('dragGuard');
const ctxMenu = document.getElementById('ctxMenu');
const chips = document.getElementById('chips');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');

const GROUP = '__group__';

const state = {
  appName: '',
  appSettings: {},
  tabs: [],                 // full ordered list (objects with settings + _partition)
  activeId: null,           // focused webview (for the top toolbar / Ctrl+R)
  group: [],                // tabIds forming the split (length >= 2) or []
  groupSizes: [],           // fractions for the group panes (sum 1)
  orientation: 'vertical',  // 'vertical' = side by side, 'horizontal' = stacked
  expanded: null,           // a tabId (single fills app) or GROUP (split fills app)
  counts: new Map(),        // tabId -> unread
  webviews: new Map(),      // tabId -> <webview>
  hosts: new Map(),         // tabId -> pane wrapper element
  detached: new Set(),      // tabs detached into their own window
  mediaTabId: null,         // tab whose player drives the taskbar / media keys
  mediaPreloadPath: '',     // file:// URL of the media webview preload (from main)
  dragId: null,
  appIcon: '',              // configured icon (emoji/letter or image URL)
  iconSet: false,           // a favicon was already used as the window icon
};

// ---- Boot ----
(async function init() {
  const data = await api.get(APP_ID);
  if (!data) { document.body.innerHTML = '<p style="padding:20px">App not found.</p>'; return; }
  state.appName = data.name;
  state.appSettings = data.settings;
  state.appIcon = data.icon || '';
  state.mediaPreloadPath = data.mediaPreloadPath || '';
  state.tabs = DETACHED ? data.tabs.filter((t) => t.id === SOLO_ID) : data.tabs;
  document.title = DETACHED ? (state.tabs[0]?.name || data.name) : data.name;

  if (DETACHED) tabstrip.style.display = 'none';

  state.tabs.forEach((tab) => buildTab(tab));
  if (state.tabs[0]) { state.expanded = state.tabs[0].id; state.activeId = state.tabs[0].id; }
  applyLayout();
  resolveIcon();

  // Route taskbar/media-key commands to the active media tab's player.
  api.onMediaCommand((cmd) => {
    const wv = state.webviews.get(state.mediaTabId)
      || [...state.webviews.keys()].map((id) => state.webviews.get(id))
        .find((v) => v && v.getAttribute('preload'));
    try { if (wv) wv.send('media:command', cmd); } catch {}
  });

  // Re-flow whenever the window/view area resizes.
  new ResizeObserver(() => applyLayout()).observe(views);
})();

// ---- Build a tab (strip button + pane host with header + webview) ----
function buildTab(tab, insertIndex = null) {
  const btn = document.createElement('div');
  btn.className = 'tab';
  btn.dataset.tabId = tab.id;
  btn.draggable = !DETACHED;
  btn.innerHTML = `<span class="label"></span><span class="count hidden"></span>`;
  btn.querySelector('.label').textContent = tab.name;
  btn.addEventListener('click', () => onTabClick(tab.id));
  if (!DETACHED) {
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtxMenu(e, tab.id); });
    btn.addEventListener('dragstart', (e) => { state.dragId = tab.id; e.dataTransfer.effectAllowed = 'move'; });
    btn.addEventListener('dragover', (e) => onTabDragOver(e, btn));
    btn.addEventListener('dragend', persistOrder);
  }
  if (insertIndex != null && tabstrip.children[insertIndex]) {
    tabstrip.insertBefore(btn, tabstrip.children[insertIndex]);
  } else {
    tabstrip.appendChild(btn);
  }

  // Pane host: a sized wrapper holding the header + webview. The webview fills
  // it via CSS (inset:0). The host is never reparented, so it never reloads.
  const host = document.createElement('div');
  host.className = 'pane-host';
  host.dataset.tabId = tab.id;
  host.style.display = 'none';

  const wv = document.createElement('webview');
  wv.setAttribute('partition', tab._partition);
  wv.setAttribute('allowpopups', '');
  // Media tabs (explicit setting or a known music site) get the media preload
  // so the taskbar thumbbar + media keys can drive playback. Set before src.
  if (isMediaTab(tab) && state.mediaPreloadPath) {
    wv.setAttribute('preload', state.mediaPreloadPath);
    wv.addEventListener('ipc-message', (e) => {
      if (e.channel !== 'media:state') return;
      const s = e.args[0];
      if (s && s.enabled) state.mediaTabId = tab.id;
      api.mediaState(s);
    });
  }
  wv.setAttribute('src', tab.url || 'about:blank');
  wv.dataset.tabId = tab.id;
  wv.addEventListener('page-title-updated', (e) => onTitle(tab.id, e.title));
  wv.addEventListener('page-favicon-updated', (e) => onFavicon(e.favicons));
  wv.addEventListener('did-stop-loading', () => { if (tab.id === state.activeId) updateNav(); updatePaneNav(tab.id); });
  wv.addEventListener('did-navigate-in-page', () => { if (tab.id === state.activeId) updateNav(); updatePaneNav(tab.id); });

  const head = document.createElement('div');
  head.className = 'pane-head';
  head.innerHTML = `
    <span class="ph-name"></span>
    <div class="ph-actions">
      <button class="ph-btn ph-back" title="Back">‹</button>
      <button class="ph-btn ph-fwd" title="Forward">›</button>
      <button class="ph-btn ph-reload" title="Reload">⟳</button>
      <button class="ph-btn ph-settings" title="Settings">⚙</button>
      <button class="ph-btn ph-close" title="Close pane">×</button>
    </div>`;
  head.querySelector('.ph-name').textContent = tab.name;
  head.addEventListener('mousedown', (e) => { if (!e.target.closest('button')) { state.activeId = tab.id; updateNav(); } });
  head.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtxMenu(e, tab.id); });
  head.querySelector('.ph-back').addEventListener('click', (e) => { e.stopPropagation(); wv.goBack(); });
  head.querySelector('.ph-fwd').addEventListener('click', (e) => { e.stopPropagation(); wv.goForward(); });
  head.querySelector('.ph-reload').addEventListener('click', (e) => { e.stopPropagation(); wv.reload(); });
  head.querySelector('.ph-settings').addEventListener('click', (e) => { e.stopPropagation(); openSettings(tab.id); });
  head.querySelector('.ph-close').addEventListener('click', (e) => { e.stopPropagation(); removeFromGroup(tab.id); });

  host.appendChild(head);
  host.appendChild(wv);
  views.appendChild(host);
  state.webviews.set(tab.id, wv);
  state.hosts.set(tab.id, host);
}

function updatePaneNav(id) {
  const host = state.hosts.get(id);
  const wv = state.webviews.get(id);
  if (!host || !wv) return;
  const b = host.querySelector('.ph-back');
  const f = host.querySelector('.ph-fwd');
  if (!b || !f) return;
  try { b.disabled = !wv.canGoBack(); f.disabled = !wv.canGoForward(); } catch {}
}

// ---- Window / taskbar / tray icon ----
function resolveIcon() {
  const icon = state.appIcon;
  if (icon && /^https?:\/\//i.test(icon)) { api.setIconUrl(APP_ID, icon); return; }
  if (icon) { const d = glyphToDataUrl(icon); if (d) api.setIconData(APP_ID, d); return; }
  // No configured icon: a tab's favicon will be used (see onFavicon).
}

// A site favicon is used only when no icon is configured.
async function onFavicon(favicons) {
  if (state.appIcon || state.iconSet || !favicons || !favicons.length) return;
  const url = favicons[favicons.length - 1];
  try {
    if (await api.setIconUrl(APP_ID, url)) {
      state.iconSet = true;
    }
  } catch {}
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Render an emoji or letter onto a rounded blue tile -> PNG data URL.
function glyphToDataUrl(text) {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#5b8cff';
  roundRect(x, 1, 1, S - 2, S - 2, 14);
  x.fill();
  const ch = [...text][0] || '?';
  const emoji = /\p{Extended_Pictographic}/u.test(ch);
  x.fillStyle = '#ffffff';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `${emoji ? '' : 'bold '}${emoji ? 40 : 36}px "Segoe UI Emoji","Segoe UI",system-ui,sans-serif`;
  x.fillText(ch, S / 2, S / 2 + 2);
  try { return c.toDataURL('image/png'); } catch { return null; }
}

// A tab is media-capable if explicitly enabled or it's a known music site.
function isMediaTab(tab) {
  if (tab.settings && tab.settings.mediaControls) return true;
  return /(^|\/\/|\.)music\.youtube\.com(\/|$)/i.test(tab.url || '');
}

function getTab(id) { return state.tabs.find((t) => t.id === id); }
function tabBtn(id) { return [...tabstrip.children].find((el) => el.dataset.tabId === id); }
function visibleTabs() { return state.tabs.filter((t) => !state.detached.has(t.id)); }
function firstOther(excludeId) { return visibleTabs().find((t) => t.id !== excludeId)?.id || null; }
function hasSplit() { return state.group.length >= 2; }
function inGroup(id) { return state.group.includes(id); }

// ---- View model: one item expanded (a single tab, or the split group) ----
function onTabClick(id) {
  // Top strip is only visible when not split; selecting shows that tab.
  state.expanded = id;
  state.activeId = id;
  applyLayout();
}

function startSplit(targetId, orientation) {
  let base = (state.expanded && state.expanded !== GROUP && state.expanded !== targetId)
    ? state.expanded : firstOther(targetId);
  if (!base || base === targetId) base = firstOther(targetId);
  if (!base) return; // need two distinct visible tabs
  state.group = [base, targetId];
  state.groupSizes = [0.5, 0.5];
  state.orientation = orientation;
  state.expanded = GROUP;
  state.activeId = targetId;
  applyLayout();
}

function addToGroup(id) {
  if (inGroup(id) || state.detached.has(id)) return;
  state.group.push(id);
  state.groupSizes = state.group.map(() => 1 / state.group.length);
  state.expanded = GROUP;
  state.activeId = id;
  applyLayout();
}

function removeFromGroup(id) {
  state.group = state.group.filter((p) => p !== id);
  if (state.group.length < 2) {
    const keep = state.group[0] || firstOther(id) || visibleTabs()[0]?.id || null;
    state.group = [];
    state.groupSizes = [];
    state.expanded = keep;
    state.activeId = keep;
  } else {
    state.groupSizes = state.group.map(() => 1 / state.group.length);
    if (state.activeId === id) state.activeId = state.group[0];
    state.expanded = GROUP;
  }
  applyLayout();
}

function dissolveSplit() {
  const keep = (state.activeId && inGroup(state.activeId)) ? state.activeId
    : (state.group[0] || visibleTabs()[0]?.id || null);
  state.group = [];
  state.groupSizes = [];
  state.expanded = keep;
  state.activeId = keep;
  applyLayout();
}

function expandItem(item) {
  state.expanded = item;            // a tabId or GROUP
  if (item !== GROUP) state.activeId = item;
  else if (!inGroup(state.activeId)) state.activeId = state.group[0];
  applyLayout();
}

// ---- Render ----
function setRect(el, left, top, w, h) {
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.width = `${Math.round(w)}px`;
  el.style.height = `${Math.round(h)}px`;
  el.style.display = 'block';
}

function applyLayout() {
  for (const host of state.hosts.values()) {
    host.style.display = 'none';
    host.classList.remove('with-head', 'is-active', 'solo');
  }
  views.querySelectorAll('.divider').forEach((d) => d.remove());

  const split = hasSplit() && !DETACHED;
  // Validate expanded
  if (split) {
    if (state.expanded !== GROUP && (!getTab(state.expanded) || inGroup(state.expanded) || state.detached.has(state.expanded))) {
      state.expanded = GROUP;
    }
  } else if (!getTab(state.expanded) || state.detached.has(state.expanded)) {
    state.expanded = visibleTabs()[0]?.id || null;
  }

  renderChips(split);
  document.body.classList.toggle('split', split);
  document.body.classList.toggle('has-chips', split && chips.children.length > 0);

  const rect = views.getBoundingClientRect();
  const W = Math.max(1, rect.width);
  const H = Math.max(1, rect.height);

  if (split && state.expanded === GROUP) {
    renderGroup(W, H);
  } else {
    // A single tab fills the whole view area.
    const id = (state.expanded && state.expanded !== GROUP) ? state.expanded : visibleTabs()[0]?.id;
    const host = state.hosts.get(id);
    if (host) {
      setRect(host, 0, 0, W, H);
      if (split) { host.classList.add('with-head', 'solo', 'is-active'); } // give it a header (toolbar is hidden in split)
    }
    state.activeId = id;
  }

  for (const el of tabstrip.children) {
    el.classList.toggle('active', el.dataset.tabId === state.activeId);
  }
  updateNav();
}

function renderGroup(W, H) {
  const panes = state.group;
  const vertical = state.orientation === 'vertical';
  const sizes = (state.groupSizes.length === panes.length) ? state.groupSizes : panes.map(() => 1 / panes.length);

  let off = 0;
  panes.forEach((id, i) => {
    const host = state.hosts.get(id);
    const frac = sizes[i];
    if (host) {
      if (vertical) setRect(host, off * W, 0, frac * W, H);
      else setRect(host, 0, off * H, W, frac * H);
      host.classList.add('with-head');
      host.classList.toggle('is-active', id === state.activeId);
      updatePaneNav(id);
    }
    off += frac;
    if (i < panes.length - 1) {
      const d = document.createElement('div');
      d.className = 'divider ' + (vertical ? 'vertical' : 'horizontal');
      if (vertical) { d.style.left = `${off * W}px`; d.style.top = '0'; d.style.width = '6px'; d.style.height = `${H}px`; }
      else { d.style.top = `${off * H}px`; d.style.left = '0'; d.style.height = '6px'; d.style.width = `${W}px`; }
      d.addEventListener('mousedown', (e) => startResize(e, i));
      views.appendChild(d);
    }
  });
}

// Collapsed items: every non-group tab plus the group, except whatever's expanded.
function renderChips(split) {
  chips.innerHTML = '';
  if (!split) return;

  const items = [];
  for (const t of visibleTabs()) if (!inGroup(t.id)) items.push({ kind: 'tab', id: t.id, name: t.name });
  items.push({ kind: 'group' });

  for (const it of items) {
    const isExpanded = (it.kind === 'group') ? state.expanded === GROUP : state.expanded === it.id;
    if (isExpanded) continue;
    const chip = document.createElement('button');
    chip.className = 'chip';
    if (it.kind === 'group') {
      chip.classList.add('chip-group');
      chip.textContent = '⊞ ' + state.group.map((id) => getTab(id)?.name || '').join(' | ');
      chip.addEventListener('click', () => expandItem(GROUP));
    } else {
      chip.textContent = it.name;
      chip.addEventListener('click', () => expandItem(it.id));
    }
    chips.appendChild(chip);
  }
}

// ---- Divider resize ----
function startResize(e, i) {
  e.preventDefault();
  const vertical = state.orientation === 'vertical';
  dragGuard.classList.remove('hidden');
  dragGuard.style.cursor = vertical ? 'col-resize' : 'row-resize';
  const rect = views.getBoundingClientRect();
  const dim = vertical ? rect.width : rect.height;
  const start = vertical ? e.clientX : e.clientY;
  const s0 = [...state.groupSizes];
  const pairSum = s0[i] + s0[i + 1];
  const move = (ev) => {
    const cur = vertical ? ev.clientX : ev.clientY;
    const delta = (cur - start) / dim;
    const si = Math.min(pairSum - 0.1, Math.max(0.1, s0[i] + delta));
    state.groupSizes[i] = si;
    state.groupSizes[i + 1] = pairSum - si;
    applyLayout();
  };
  const up = () => {
    dragGuard.classList.add('hidden');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// ---- Tab drag reorder (within the strip) ----
function onTabDragOver(e, overBtn) {
  e.preventDefault();
  if (!state.dragId || overBtn.dataset.tabId === state.dragId) return;
  const dragEl = tabBtn(state.dragId);
  const rect = overBtn.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  tabstrip.insertBefore(dragEl, after ? overBtn.nextSibling : overBtn);
}

function persistOrder() {
  if (!state.dragId) return;
  state.dragId = null;
  const order = [...tabstrip.children].map((el) => el.dataset.tabId);
  state.tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  api.setTabsOrder(APP_ID, order);
}

// ---- Context menu (from a strip tab or a pane header) ----
function openCtxMenu(e, tabId) {
  const items = [{ label: 'Move to new window', act: () => api.detach(APP_ID, tabId) }];

  if (!hasSplit()) {
    items.push({ label: 'Split right (side by side)', act: () => startSplit(tabId, 'vertical') });
    items.push({ label: 'Split down (stacked)', act: () => startSplit(tabId, 'horizontal') });
  } else {
    for (const t of visibleTabs()) {
      if (!inGroup(t.id)) items.push({ label: `Add “${t.name}” to split`, act: () => addToGroup(t.id) });
    }
    items.push({
      label: state.orientation === 'vertical' ? 'Switch to stacked' : 'Switch to side by side',
      act: () => { state.orientation = state.orientation === 'vertical' ? 'horizontal' : 'vertical'; applyLayout(); },
    });
    if (inGroup(tabId)) items.push({ label: 'Remove this pane', act: () => removeFromGroup(tabId) });
    items.push({ label: 'Close split view', act: dissolveSplit });
  }

  ctxMenu.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'ctx-item';
    row.textContent = it.label;
    row.addEventListener('click', () => { it.act(); hideCtxMenu(); });
    ctxMenu.appendChild(row);
  }
  ctxMenu.style.left = `${e.clientX}px`;
  ctxMenu.style.top = `${e.clientY}px`;
  ctxMenu.classList.remove('hidden');
}
function hideCtxMenu() { ctxMenu.classList.add('hidden'); }
window.addEventListener('click', hideCtxMenu);
window.addEventListener('blur', hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

// ---- Detach / return ----
api.onTabDetached(({ tabId }) => {
  state.detached.add(tabId);
  if (inGroup(tabId)) {
    removeFromGroup(tabId);
  } else if (state.expanded === tabId) {
    state.expanded = firstOther(tabId);
    state.activeId = state.expanded;
  }
  tabBtn(tabId)?.remove();
  state.hosts.get(tabId)?.remove();
  state.hosts.delete(tabId);
  state.webviews.delete(tabId);
  applyLayout();
  recomputeUnread();
});

api.onTabReturned(({ tabId }) => {
  state.detached.delete(tabId);
  const tab = getTab(tabId);
  if (!tab) return;
  const visBefore = state.tabs.filter((t, i) =>
    !state.detached.has(t.id) && i < state.tabs.indexOf(tab)).length;
  buildTab(tab, visBefore);
  state.expanded = tabId;
  state.activeId = tabId;
  applyLayout();
});

// ---- Navigation (top toolbar — only visible when not split) ----
function activeWv() { return state.webviews.get(state.activeId); }
function updateNav() {
  const wv = activeWv();
  try {
    backBtn.disabled = !wv || !wv.canGoBack();
    forwardBtn.disabled = !wv || !wv.canGoForward();
  } catch { backBtn.disabled = forwardBtn.disabled = true; }
}
backBtn.addEventListener('click', () => activeWv()?.goBack());
forwardBtn.addEventListener('click', () => activeWv()?.goForward());
reloadBtn.addEventListener('click', () => activeWv()?.reload());
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey && e.key.toLowerCase() === 'r') || e.key === 'F5') { e.preventDefault(); activeWv()?.reload(); }
});

// ---- Unread ----
function onTitle(tabId, title) {
  const count = parseUnread(title);
  state.counts.set(tabId, count);
  const badge = tabBtn(tabId)?.querySelector('.count');
  if (badge) {
    if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.classList.remove('hidden'); }
    else if (count < 0) { badge.textContent = ''; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }
  recomputeUnread();
}
function recomputeUnread() {
  let total = 0, unknown = false;
  for (const [id, c] of state.counts) {
    if (state.detached.has(id)) continue;
    if (c > 0) total += c; else if (c < 0) unknown = true;
  }
  api.unread(APP_ID, total > 0 ? total : (unknown ? -1 : 0));
}
function parseUnread(title) {
  if (!title) return 0;
  const m = title.match(/[([{]\s*(\d+)\s*[)\]}]/) || title.match(/(\d+)\s+new/i);
  if (m) return parseInt(m[1], 10) || 0;
  if (/^\s*[•*∙]/.test(title)) return -1;
  return 0;
}

// ---- Settings drawer ----
const settings = document.getElementById('settings');
const sNotifications = document.getElementById('sNotifications');
const sPersist = document.getElementById('sPersist');
const sMedia = document.getElementById('sMedia');
const sTray = document.getElementById('sTray');
const sStartup = document.getElementById('sStartup');
let drawerTabId = null;

function openSettings(id) {
  drawerTabId = id || state.activeId;
  const tab = getTab(drawerTabId);
  document.getElementById('settingsTitle').textContent = `${state.appName} — Settings`;
  document.getElementById('tabSettingsLabel').textContent = tab ? `Tab: ${tab.name}` : 'This tab';
  if (tab) {
    sNotifications.checked = tab.settings.notifications !== false;
    sPersist.checked = tab.settings.persistSession !== false;
    sMedia.checked = !!tab.settings.mediaControls;
  }
  sTray.checked = !!state.appSettings.minimizeToTray;
  sStartup.checked = !!state.appSettings.launchOnStartup;
  settings.classList.remove('hidden');
}
document.getElementById('settingsBtn').addEventListener('click', () => openSettings());
document.getElementById('closeSettings').addEventListener('click', () => settings.classList.add('hidden'));
settings.addEventListener('click', (e) => { if (e.target === settings) settings.classList.add('hidden'); });

sNotifications.addEventListener('change', () => {
  const t = getTab(drawerTabId); if (t) t.settings.notifications = sNotifications.checked;
  api.setTabSettings(APP_ID, drawerTabId, { notifications: sNotifications.checked });
});
sPersist.addEventListener('change', () => {
  const t = getTab(drawerTabId); if (t) t.settings.persistSession = sPersist.checked;
  api.setTabSettings(APP_ID, drawerTabId, { persistSession: sPersist.checked });
});
sMedia.addEventListener('change', () => {
  const t = getTab(drawerTabId); if (t) t.settings.mediaControls = sMedia.checked;
  api.setTabSettings(APP_ID, drawerTabId, { mediaControls: sMedia.checked });
});
sTray.addEventListener('change', () => {
  state.appSettings.minimizeToTray = sTray.checked;
  api.setAppSettings(APP_ID, { minimizeToTray: sTray.checked });
});
sStartup.addEventListener('change', () => {
  state.appSettings.launchOnStartup = sStartup.checked;
  api.setAppSettings(APP_ID, { launchOnStartup: sStartup.checked });
});

document.getElementById('clearCache').addEventListener('click', async (e) => {
  e.target.textContent = 'Clearing…';
  await api.clearCache(APP_ID, drawerTabId);
  e.target.textContent = 'Cache cleared';
  setTimeout(() => (e.target.textContent = 'Clear cache'), 1500);
});
document.getElementById('clearData').addEventListener('click', async (e) => {
  if (!confirm('Clear cookies and site data for this tab? You will be signed out of it.')) return;
  e.target.textContent = 'Clearing…';
  await api.clearData(APP_ID, drawerTabId);
  state.webviews.get(drawerTabId)?.reload();
  e.target.textContent = 'Cleared';
  setTimeout(() => (e.target.textContent = 'Clear cookies & data'), 1500);
});
document.getElementById('exitBtn').addEventListener('click', () => api.exit(APP_ID));

// ---- Open launcher / check for updates / version ----
document.getElementById('openLauncherBtn').addEventListener('click', () => api.openManager());

const updateStatus = document.getElementById('updateStatus');
(async () => {
  try { document.getElementById('appVersion').textContent = 'v' + (await api.version()); } catch {}
})();
document.getElementById('checkUpdatesBtn').addEventListener('click', async () => {
  updateStatus.textContent = '— Checking…';
  try {
    const r = await api.checkUpdates();
    if (r.status === 'dev') updateStatus.textContent = '— ' + r.message;
    else if (r.status === 'error') updateStatus.textContent = '— Update check failed.';
    else updateStatus.textContent = r.version ? `— Latest: v${r.version}` : '— Up to date.';
  } catch { updateStatus.textContent = '— Update check failed.'; }
});
