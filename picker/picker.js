// Picker UI logic. Loads capturable sources from main, renders them by type
// (screen / window), tracks the selection, and reports the choice back.
const grid = document.getElementById('grid');
const shareBtn = document.getElementById('share');
const cancelBtn = document.getElementById('cancel');
const audioBox = document.getElementById('audio');
const tabs = [...document.querySelectorAll('.tab')];

let sources = [];
let activeType = 'screen';
let selectedId = null;
let preferredSourceId = null; // last-used source, restored if still available

function render() {
  selectedId = null;
  shareBtn.disabled = true;
  grid.innerHTML = '';

  const list = sources.filter((s) => s.type === activeType);
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = activeType === 'screen' ? 'No screens found.' : 'No open windows found.';
    grid.appendChild(empty);
    return;
  }

  for (const s of list) {
    const card = document.createElement('div');
    card.className = 'src';
    card.dataset.id = s.id;

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = s.thumbnail;
    card.appendChild(thumb);

    const label = document.createElement('div');
    label.className = 'label';
    if (s.appIcon) {
      const icon = document.createElement('img');
      icon.src = s.appIcon;
      label.appendChild(icon);
    }
    const name = document.createElement('span');
    name.textContent = s.name;
    name.title = s.name;
    label.appendChild(name);
    card.appendChild(label);

    card.addEventListener('click', () => select(s.id, card));
    card.addEventListener('dblclick', () => { select(s.id, card); confirm(); });
    grid.appendChild(card);
  }

  // Restore the previously shared source if it's still in this list.
  if (preferredSourceId) {
    const prev = grid.querySelector(`.src[data-id="${CSS.escape(preferredSourceId)}"]`);
    if (prev) select(preferredSourceId, prev);
  }
}

function select(id, card) {
  selectedId = id;
  shareBtn.disabled = false;
  for (const el of grid.querySelectorAll('.src.selected')) el.classList.remove('selected');
  card.classList.add('selected');
}

function confirm() {
  if (selectedId) window.picker.choose(selectedId, audioBox.checked);
}

tabs.forEach((tab) => tab.addEventListener('click', () => {
  tabs.forEach((t) => t.classList.toggle('active', t === tab));
  activeType = tab.dataset.type;
  render();
}));

shareBtn.addEventListener('click', confirm);
cancelBtn.addEventListener('click', () => window.picker.cancel());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.picker.cancel(); });

window.picker.list().then(({ sources: list, audioRequested, prefs }) => {
  sources = list;
  prefs = prefs || {};
  preferredSourceId = prefs.sourceId || null;
  // Remember the last "share system audio" state; fall back to what the app asked for.
  audioBox.checked = typeof prefs.audio === 'boolean' ? prefs.audio : !!audioRequested;
  // Restore the last screen/window tab if it has sources, else pick one that does.
  const hasType = (t) => sources.some((s) => s.type === t);
  activeType = prefs.type && hasType(prefs.type) ? prefs.type
    : hasType('screen') ? 'screen' : 'window';
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.type === activeType));
  render();
});
