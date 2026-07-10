// Dev launcher: runs Electron and filters ONE benign, noisy stderr line out of
// the terminal — WGC's "wgc_capture_session ProcessFrame failed ... using
// existing frame" (screen/window capture warm-up; it reuses the last good frame
// and capture works fine). Everything else — all other logs and errors — passes
// through unchanged. Dev-only; the packaged app never runs through this.
const { spawn } = require('child_process');
const readline = require('readline');
const electron = require('electron'); // resolves to the electron binary path

// Match the specific benign line only, so real errors are never hidden.
const NOISE = /wgc_capture_session\.cc.*ProcessFrame failed/;

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: ['inherit', 'inherit', 'pipe'],
});

readline.createInterface({ input: child.stderr }).on('line', (line) => {
  if (!NOISE.test(line)) process.stderr.write(line + '\n');
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
