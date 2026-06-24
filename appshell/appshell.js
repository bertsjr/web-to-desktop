const params = new URLSearchParams(location.search);
const APP_ID = params.get('id');
const SOLO_ID = params.get('tab');          // set in detached windows
const DETACHED = params.get('detached') === '1';

const tabstrip = document.getElementById('tabstrip');
const views = document.getElementById('views');
const divider = document.getElementById('divider');
const dragGuard = document.getElementById('dragGuard');
const ctxMenu = document.getElementById('ctxMenu');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');
const unsplitBtn = document.getElementById('unsplitBtn');

const state = {
  appName: '',
  appSettings: {},
  tabs: [],                 // full ordered list (objects with settings + _partition)
  activeId: null,
  layout: { orientation: 'single', panes: [], ratio: 0.5 },
  counts: new Map(),        // tabId -> unread
  webviews: new Map(),      // tabId -> <webview>
  detached: new Set(),      // tabs detached into their own window
  dragId: null,
};

// ---- Boot ----
(async function init() {
  const data = await api.get(APP_ID);
  if (!data) { document.body.innerHTML = '<p style="padding:20px">App not found.</p>'; return; }
  state.appName = data.name;
  state.appSettings = data.settings;
  state.tabs = DETACHED ? data.tabs.filter((t) => t.id === SOLO_ID) : data.tabs;
  document.title = DETACHED ? (state.tabs[0]?.name || data.name) : data.name;

  if (DETACHED) tabstrip.style.display = 'none';

  state.tabs.forEach((tab) => buildTab(tab));
  if (state.tabs[0]) activateTab(state.tabs[0].id);
})();

// ---- Build a tab (button + webview) ----
function buildTab(tab, insertIndex = null) {
  const btn = document.createElement('div');
  btn.className = 'tab';
  btn.dataset.tabId = tab.id;
  btn.draggable = !DETACHED;
  btn.innerHTML = `<span class="label"></span><span class="count hidden"></span>`;
  btn.querySelector('.label').textContent = tab.name;
  btn.addEventListener('click', () => activateTab(tab.id));
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

  const wv = document.createElement('webview');
  wv.style.position = 'absolute';
  wv.setAttribute('partition', tab._partition);
  wv.setAttribute('src', tab.url || 'about:blank');
  wv.dataset.tabId = tab.id;
  wv.addEventListener('page-title-updated', (e) => onTitle(tab.id, e.title));
  wv.addEventListener('did-stop-loading', () => { if (isFocusPane(tab.id)) updateNav(); });
  wv.addEventListener('did-navigate-in-page', () => { if (isFocusPane(tab.id)) updateNav(); });
  views.appendChild(wv);
  state.webviews.set(tab.id, wv);
}

function getTab(id) { return state.tabs.find((t) => t.id === id); }
function tabBtn(id) { return [...tabstrip.children].find((el) => el.dataset.tabId === id); }
function visibleTabs() { return state.tabs.filter((t) => !state.detached.has(t.id)); }
function isFocusPane(id) { return state.layout.panes[0] === id || id === state.activeId; }

// ---- Layout (single / split) ----
function activateTab(id) {
  state.activeId = id;
  state.layout = { orientation: 'single', panes: [id], ratio: 0.5 };
  applyLayout();
}

function firstOther(excludeId) {
  return visibleTabs().find((t) => t.id !== excludeId)?.id || null;
}

function splitWith(targetId, orientation) {
  let left = state.activeId;
  if (!left || left === targetId) left = firstOther(targetId);
  if (!left) return; // need two distinct visible tabs
  state.activeId = targetId;
  state.layout = { orientation, panes: [left, targetId], ratio: 0.5 };
  applyLayout();
}

function unsplit() { activateTab(state.activeId || visibleTabs()[0]?.id); }

function applyLayout() {
  const L = state.layout;
  for (const wv of state.webviews.values()) wv.style.display = 'none';
  divider.classList.add('hidden');
  unsplitBtn.classList.add('hidden');

  const place = (wv, left, top, w, h) => {
    if (!wv) return;
    wv.style.left = left; wv.style.top = top; wv.style.width = w; wv.style.height = h;
    wv.style.display = 'block';
  };

  if (L.panes.length < 2) {
    place(state.webviews.get(L.panes[0] || state.activeId), '0', '0', '100%', '100%');
  } else {
    const [a, b] = L.panes;
    const r = Math.round(L.ratio * 100);
    if (L.orientation === 'vertical') {
      place(state.webviews.get(a), '0', '0', `${r}%`, '100%');
      place(state.webviews.get(b), `${r}%`, '0', `${100 - r}%`, '100%');
      divider.className = 'divider vertical';
      divider.style.left = `${r}%`; divider.style.top = '0';
      divider.style.height = '100%'; divider.style.width = '6px';
    } else {
      place(state.webviews.get(a), '0', '0', '100%', `${r}%`);
      place(state.webviews.get(b), '0', `${r}%`, '100%', `${100 - r}%`);
      divider.className = 'divider horizontal';
      divider.style.top = `${r}%`; divider.style.left = '0';
      divider.style.width = '100%'; divider.style.height = '6px';
    }
    divider.classList.remove('hidden');
    unsplitBtn.classList.remove('hidden');
  }

  for (const el of tabstrip.children) {
    el.classList.toggle('active', L.panes.includes(el.dataset.tabId));
  }
  updateNav();
}

// ---- Divider resize ----
divider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  dragGuard.classList.remove('hidden');
  dragGuard.style.cursor = state.layout.orientation === 'vertical' ? 'col-resize' : 'row-resize';
  const rect = views.getBoundingClientRect();
  const move = (ev) => {
    let ratio = state.layout.orientation === 'vertical'
      ? (ev.clientX - rect.left) / rect.width
      : (ev.clientY - rect.top) / rect.height;
    state.layout.ratio = Math.min(0.85, Math.max(0.15, ratio));
    applyLayout();
  };
  const up = () => {
    dragGuard.classList.add('hidden');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ---- Tab drag reorder ----
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

// ---- Context menu ----
function openCtxMenu(e, tabId) {
  const split = state.layout.panes.length >= 2;
  const items = [
    { label: 'Move to new window', act: () => api.detach(APP_ID, tabId) },
    { label: 'Split right (side by side)', act: () => splitWith(tabId, 'vertical') },
    { label: 'Split down (stacked)', act: () => splitWith(tabId, 'horizontal') },
  ];
  if (split) items.push({ label: 'Unsplit', act: unsplit });

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
  tabBtn(tabId)?.remove();
  state.webviews.get(tabId)?.remove();
  state.webviews.delete(tabId);
  if (state.layout.panes.includes(tabId) || state.activeId === tabId) {
    const next = visibleTabs()[0];
    if (next) activateTab(next.id); else applyLayout();
  }
  recomputeUnread();
});

api.onTabReturned(({ tabId }) => {
  state.detached.delete(tabId);
  const tab = getTab(tabId);
  if (!tab) return;
  // Insert at its original position among currently visible tabs.
  const visBefore = state.tabs.filter((t, i) =>
    !state.detached.has(t.id) && i < state.tabs.indexOf(tab)).length;
  buildTab(tab, visBefore);
  activateTab(tabId);
});

// ---- Navigation ----
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
unsplitBtn.addEventListener('click', unsplit);
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
const sTray = document.getElementById('sTray');
const sStartup = document.getElementById('sStartup');
let drawerTabId = null;

function openSettings() {
  drawerTabId = state.activeId;
  const tab = getTab(drawerTabId);
  document.getElementById('settingsTitle').textContent = `${state.appName} — Settings`;
  document.getElementById('tabSettingsLabel').textContent = tab ? `Tab: ${tab.name}` : 'This tab';
  if (tab) {
    sNotifications.checked = tab.settings.notifications !== false;
    sPersist.checked = tab.settings.persistSession !== false;
  }
  sTray.checked = !!state.appSettings.minimizeToTray;
  sStartup.checked = !!state.appSettings.launchOnStartup;
  settings.classList.remove('hidden');
}
document.getElementById('settingsBtn').addEventListener('click', openSettings);
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
