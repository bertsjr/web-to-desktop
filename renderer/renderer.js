const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const fName = document.getElementById('fName');
const fIcon = document.getElementById('fIcon');
const formError = document.getElementById('formError');
const tabRows = document.getElementById('tabRows');
const sTray = document.getElementById('sTray');
const sStartup = document.getElementById('sStartup');

let editingId = null;
const unread = new Map();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function isImageUrl(s) { return /^https?:\/\//i.test(s); }

function iconMarkup(appDef) {
  if (appDef.icon && isImageUrl(appDef.icon)) return `<img src="${escapeHtml(appDef.icon)}" alt="" />`;
  if (appDef.icon) return escapeHtml(appDef.icon);
  return escapeHtml((appDef.name || '?').charAt(0).toUpperCase());
}
function summaryLine(appDef) {
  const tabs = appDef.tabs || [];
  const first = tabs[0]?.url || '';
  const extra = tabs.length > 1 ? `  +${tabs.length - 1} more` : '';
  return escapeHtml(first.replace(/^https?:\/\//, '')) + escapeHtml(extra);
}

// ---- Unread badges ----
function applyBadge(card, count) {
  const badge = card.querySelector('.badge');
  if (!badge) return;
  if (count && count !== 0) {
    badge.textContent = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
    badge.classList.toggle('dot', count < 0);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}
api.onUnread(({ id, count }) => {
  unread.set(id, count);
  const card = grid.querySelector(`.card[data-id="${id}"]`);
  if (card) applyBadge(card, count);
});

// ---- Dashboard ----
function render(apps) {
  grid.innerHTML = '';
  empty.classList.toggle('hidden', apps.length > 0);
  for (const appDef of apps) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = appDef.id;
    card.innerHTML = `
      <div class="card-icon">${iconMarkup(appDef)}<span class="badge hidden"></span></div>
      <div class="card-name">${escapeHtml(appDef.name)}</div>
      <div class="card-url">${summaryLine(appDef)}</div>
      <div class="card-actions">
        <button class="primary launch">Launch</button>
        <button class="icon-btn install" title="${appDef.installed ? 'Installed as a desktop app — click to remove' : 'Install as a desktop app'}">${appDef.installed ? '✅' : '📌'}</button>
        <button class="icon-btn edit" title="Edit">✎</button>
        <button class="icon-btn del" title="Delete">🗑</button>
      </div>
    `;
    applyBadge(card, unread.get(appDef.id) || 0);
    card.querySelector('.launch').addEventListener('click', () => api.launch(appDef.id));
    card.querySelector('.install').addEventListener('click', (e) => toggleInstall(appDef, e.currentTarget));
    card.querySelector('.edit').addEventListener('click', () => openModal(appDef));
    card.querySelector('.del').addEventListener('click', async () => {
      if (confirm(`Delete "${appDef.name}"?`)) render(await api.remove(appDef.id));
    });
    grid.appendChild(card);
  }
}

// ---- Install / remove as a standalone desktop app ----
async function toggleInstall(appDef, btn) {
  if (appDef.installed) {
    if (!confirm(`Remove the desktop & Start Menu shortcuts for "${appDef.name}"?`)) return;
    try {
      await api.uninstallShortcut(appDef.id);
    } catch (err) {
      alert(`Failed to uninstall: ${err.message}`);
    }
    render(await api.list());
    return;
  }
  const prev = btn.textContent;
  btn.textContent = '⏳';
  btn.disabled = true;
  try {
    const r = await api.installShortcut(appDef.id);
    if (!r || !r.ok) {
      btn.textContent = prev;
      btn.disabled = false;
      alert(`Could not create the desktop app for "${appDef.name}".`);
      return;
    }
  } catch (err) {
    btn.textContent = prev;
    btn.disabled = false;
    alert(`An error occurred: ${err.message}`);
    return;
  }
  render(await api.list());
}

// ---- Tab-row editor (each tab carries its own settings) ----
function addTabRow(tab = {}) {
  const s = tab.settings || {};
  const row = document.createElement('div');
  row.className = 'tab-row';
  row.innerHTML = `
    <div class="tab-row-main">
      <input class="t-name" type="text" placeholder="Tab name" autocomplete="off" />
      <input class="t-url" type="text" placeholder="example.com" autocomplete="off" />
      <button class="icon-btn t-del" title="Remove tab">✕</button>
    </div>
    <div class="tab-row-opts">
      <label class="check"><input type="checkbox" class="t-notif" /> Notifications</label>
      <label class="check"><input type="checkbox" class="t-persist" /> Keep cookies &amp; logins</label>
    </div>
  `;
  row.querySelector('.t-name').value = tab.name || '';
  row.querySelector('.t-url').value = tab.url || '';
  row.querySelector('.t-notif').checked = s.notifications !== false;
  row.querySelector('.t-persist').checked = s.persistSession !== false;
  row.querySelector('.t-del').addEventListener('click', () => {
    if (tabRows.children.length > 1) row.remove();
  });
  tabRows.appendChild(row);
}

function readTabs() {
  return [...tabRows.children].map((row) => ({
    name: row.querySelector('.t-name').value.trim(),
    url: row.querySelector('.t-url').value.trim(),
    settings: {
      notifications: row.querySelector('.t-notif').checked,
      persistSession: row.querySelector('.t-persist').checked,
    },
  })).filter((t) => t.url);
}

// ---- Modal ----
function openModal(appDef = null) {
  editingId = appDef ? appDef.id : null;
  modalTitle.textContent = appDef ? 'Edit App' : 'Add App';
  fName.value = appDef ? appDef.name : '';
  fIcon.value = appDef ? (appDef.icon || '') : '';

  tabRows.innerHTML = '';
  const tabs = appDef && appDef.tabs && appDef.tabs.length ? appDef.tabs : [{}];
  tabs.forEach((t) => addTabRow(t));

  const s = (appDef && appDef.settings) || {};
  sTray.checked = !!s.minimizeToTray;
  sStartup.checked = !!s.launchOnStartup;

  formError.classList.add('hidden');
  modal.classList.remove('hidden');
  fName.focus();
}
function closeModal() { modal.classList.add('hidden'); editingId = null; }

async function save() {
  const name = fName.value.trim();
  const tabs = readTabs();
  if (!name) return showError('Please enter a name.');
  if (tabs.length === 0) return showError('Please add at least one tab with a URL.');
  tabs.forEach((t) => { if (!t.name) t.name = hostName(t.url); });

  const data = {
    name, icon: fIcon.value.trim(), tabs,
    settings: { minimizeToTray: sTray.checked, launchOnStartup: sStartup.checked },
  };
  const apps = editingId ? await api.update({ id: editingId, ...data }) : await api.add(data);
  closeModal();
  render(apps);
}

function hostName(url) {
  try { return new URL(/^https?:/i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, ''); }
  catch { return 'Tab'; }
}
function showError(msg) { formError.textContent = msg; formError.classList.remove('hidden'); }

// ---- Wire up ----
document.getElementById('addBtn').addEventListener('click', () => openModal());
document.getElementById('emptyAddBtn').addEventListener('click', () => openModal());
document.getElementById('addTabRow').addEventListener('click', () => addTabRow());
document.getElementById('cancelBtn').addEventListener('click', closeModal);
document.getElementById('saveBtn').addEventListener('click', save);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
});

// ---- Version + updates ----
const updateStatus = document.getElementById('updateStatus');
const installBtn = document.getElementById('installUpdate');
(async () => {
  try { document.getElementById('version').textContent = 'v' + (await api.version()); } catch {}
})();

// Live update status pushed from the main process (policy enforced there).
api.onUpdateStatus((d) => {
  switch (d.status) {
    case 'downloading': updateStatus.textContent = `Downloading v${d.version}${d.rollback ? ' (rollback)' : ''}…`; break;
    case 'progress': updateStatus.textContent = `Downloading… ${d.percent}%`; break;
    case 'downloaded':
      updateStatus.textContent = `v${d.version} ready${d.rollback ? ' (rollback)' : ''}.`;
      installBtn.classList.remove('hidden');
      break;
    case 'blocked': updateStatus.textContent = `v${d.version} is not newer than v${d.current} — skipped.`; break;
    case 'current': updateStatus.textContent = 'Up to date.'; break;
    case 'error': updateStatus.textContent = 'Update error.'; break;
  }
});

document.getElementById('checkUpdates').addEventListener('click', async () => {
  updateStatus.textContent = 'Checking…';
  try {
    const r = await api.checkUpdates();
    if (r.status === 'dev') updateStatus.textContent = r.message;
    else if (r.status === 'error') updateStatus.textContent = 'Update check failed.';
    else if (r.newer) updateStatus.textContent = `Found v${r.version}…`;
    else updateStatus.textContent = 'Up to date.';
  } catch { updateStatus.textContent = 'Update check failed.'; }
});

installBtn.addEventListener('click', () => api.installUpdate());

document.getElementById('rollback').addEventListener('click', async () => {
  if (!confirm('Roll back to the version the update feed is currently serving? This installs an older build and will restart the app.')) return;
  updateStatus.textContent = 'Checking rollback…';
  try {
    const r = await api.rollback();
    if (r.status === 'dev') updateStatus.textContent = r.message;
    else if (r.status === 'error') updateStatus.textContent = 'Rollback failed.';
    else updateStatus.textContent = r.version ? `Rolling back to v${r.version}…` : 'No rollback target found.';
  } catch { updateStatus.textContent = 'Rollback failed.'; }
});

// ---- Activation gate ----
const activationOverlay = document.getElementById('activationOverlay');
const activationKey = document.getElementById('activationKey');
const activationError = document.getElementById('activationError');

document.getElementById('activateBtn').addEventListener('click', async () => {
  activationError.classList.add('hidden');
  const key = activationKey.value.trim();
  if (!key) { activationError.textContent = 'Please enter a key.'; activationError.classList.remove('hidden'); return; }
  const ok = await api.activate(key);
  if (ok) {
    activationOverlay.classList.add('hidden');
    render(await api.list());
  } else {
    activationError.textContent = 'Invalid activation key.';
    activationError.classList.remove('hidden');
  }
});
activationKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('activateBtn').click();
});

// Initial load — show activation gate or dashboard
(async () => {
  if (await api.isActivated()) {
    activationOverlay.classList.add('hidden');
    render(await api.list());
  } else {
    activationKey.focus();
  }
})();
