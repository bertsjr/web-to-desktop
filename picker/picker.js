// Picker UI logic. Loads capturable sources from main, renders them by type
// (screen / window), tracks the selection, and reports the choice back.
const grid = document.getElementById('grid');
const shareBtn = document.getElementById('share');
const cancelBtn = document.getElementById('cancel');
const tabs = [...document.querySelectorAll('.tab')];

let sources = [];
let activeType = 'screen';
let selectedId = null;

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
}

function select(id, card) {
  selectedId = id;
  shareBtn.disabled = false;
  for (const el of grid.querySelectorAll('.src.selected')) el.classList.remove('selected');
  card.classList.add('selected');
}

function confirm() {
  if (selectedId) window.picker.choose(selectedId);
}

tabs.forEach((tab) => tab.addEventListener('click', () => {
  tabs.forEach((t) => t.classList.toggle('active', t === tab));
  activeType = tab.dataset.type;
  render();
}));

shareBtn.addEventListener('click', confirm);
cancelBtn.addEventListener('click', () => window.picker.cancel());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.picker.cancel(); });

window.picker.list().then((list) => {
  sources = list;
  // Default to whichever tab actually has sources.
  if (!sources.some((s) => s.type === 'screen') && sources.some((s) => s.type === 'window')) {
    activeType = 'window';
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.type === 'window'));
  }
  render();
});
