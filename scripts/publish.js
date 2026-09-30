// Publish script: loads GH_TOKEN from .env, then runs electron-builder.
// Usage: npm run publish
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { execSync } = require('child_process');

if (!process.env.GH_TOKEN) {
  console.error('ERROR: GH_TOKEN not found. Set it in .env or as an environment variable.');
  process.exit(1);
}

console.log('GH_TOKEN loaded. Building and publishing...');
execSync('npx electron-builder --win --publish always', {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env },
});
