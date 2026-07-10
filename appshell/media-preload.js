// Preload injected only into media-enabled webviews (e.g. YouTube Music).
// Bridges the appshell host to the site's player: executes transport commands
// received as `media:command` and reports playback state via `media:state`,
// so the taskbar thumbbar buttons and hardware media keys can drive playback.
const { ipcRenderer } = require('electron');

// --- Site adapters ---------------------------------------------------------
// Each adapter drives one site. Add new sites here (Spotify, Deezer, …) —
// `match` tests the page hostname; the rest click the site's own controls.
const ADAPTERS = [
  {
    name: 'youtube-music',
    match: (h) => /(^|\.)music\.youtube\.com$/i.test(h),
    playPause: () => click('#play-pause-button, tp-yt-paper-icon-button.play-pause-button'),
    next: () => click('.next-button, tp-yt-paper-icon-button.next-button'),
    prev: () => click('.previous-button, tp-yt-paper-icon-button.previous-button'),
    isPlaying() {
      const v = document.querySelector('video');
      return !!(v && !v.paused && !v.ended && v.readyState > 2);
    },
    meta() {
      const bar = document.querySelector('ytmusic-player-bar');
      return {
        title: text(bar, '.title'),
        artist: text(bar, '.byline'),
      };
    },
  },
];

function click(sel) {
  const el = document.querySelector(sel);
  if (el) { el.click(); return true; }
  return false;
}
function text(root, sel) {
  try { return (root || document).querySelector(sel)?.textContent?.trim() || ''; }
  catch { return ''; }
}
function mediaEl() { return document.querySelector('video, audio'); }

const adapter =
  ADAPTERS.find((a) => { try { return a.match(location.hostname); } catch { return false; } }) || null;

// --- Command execution -----------------------------------------------------
function run(cmd) {
  try {
    if (adapter) {
      if (cmd === 'playpause') return adapter.playPause();
      if (cmd === 'next') return adapter.next();
      if (cmd === 'prev') return adapter.prev();
      return;
    }
    // Generic fallback: toggle the media element directly (play/pause only).
    const m = mediaEl();
    if (m && cmd === 'playpause') { m.paused ? m.play() : m.pause(); }
  } catch { /* selectors can go stale between site updates; ignore */ }
}
ipcRenderer.on('media:command', (_e, cmd) => run(cmd));

// --- State reporting -------------------------------------------------------
let last = '';
function report() {
  let playing = false, title = '', artist = '';
  try {
    if (adapter) {
      playing = adapter.isPlaying();
      ({ title, artist } = adapter.meta());
    } else {
      const m = mediaEl();
      playing = !!(m && !m.paused && !m.ended);
    }
    // MediaSession metadata is the most reliable title/artist when present.
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    if (md) { title = md.title || title; artist = md.artist || artist; }
  } catch { /* ignore */ }
  const enabled = !!(adapter || mediaEl());
  const snap = JSON.stringify({ playing, title, artist, enabled });
  if (snap !== last) {
    last = snap;
    ipcRenderer.sendToHost('media:state', { playing, title, artist, enabled });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  // Poll (covers sites that mutate state without firing bubbling events) plus
  // capture play/pause events for immediate updates.
  setInterval(report, 1000);
  document.addEventListener('play', report, true);
  document.addEventListener('pause', report, true);
  report();
});
