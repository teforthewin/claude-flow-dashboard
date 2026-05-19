#!/usr/bin/env node
/**
 * Patches the dev Electron binary's Info.plist so the macOS Dock tooltip
 * reads "LoomScope" instead of "Electron". No-op on non-macOS or when the
 * plist is already patched. Runs before `electron-vite dev`.
 *
 * Packaged builds use electron-builder's own plist — this script is dev-only.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const electronRoot = path.resolve(__dirname, '..', 'node_modules/electron');
const electronDist = path.join(electronRoot, 'dist');

// Some npm install paths (especially major-version bumps) skip Electron's
// own postinstall, leaving node_modules/electron without its binary.
// Re-run the upstream installer when the dist is missing so `npm run dev`
// works straight after a fresh install.
if (fs.existsSync(electronRoot) && !fs.existsSync(electronDist)) {
  console.log('[dev-rename] Electron dist missing — running electron install.js');
  const r = spawnSync(process.execPath, [path.join(electronRoot, 'install.js')], {
    stdio: 'inherit',
    cwd: electronRoot,
  });
  if (r.status !== 0) {
    console.warn('[dev-rename] Electron install.js exited with', r.status);
  }
}

if (process.platform !== 'darwin') process.exit(0);

const APP_NAME = 'LoomScope';
const APP_ID = 'com.loomscope.dev';
const APP_DIR = path.join(electronDist, 'Electron.app');
const plistPath = path.join(APP_DIR, 'Contents/Info.plist');

if (!fs.existsSync(plistPath)) {
  console.warn('[dev-rename] Electron app not found at', plistPath);
  process.exit(0);
}

const PB = '/usr/libexec/PlistBuddy';
function get(key) {
  const r = spawnSync(PB, ['-c', `Print :${key}`, plistPath], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function set(key, value) {
  const exists = get(key) !== null;
  const cmd = exists ? `Set :${key} ${value}` : `Add :${key} string ${value}`;
  spawnSync(PB, ['-c', cmd, plistPath]);
}

const beforeName = get('CFBundleName');
const beforeId = get('CFBundleIdentifier');
const beforeDisp = get('CFBundleDisplayName');

const allOk = beforeName === APP_NAME && beforeId === APP_ID && beforeDisp === APP_NAME;
if (allOk) process.exit(0);

set('CFBundleName', APP_NAME);
set('CFBundleDisplayName', APP_NAME);
set('CFBundleIdentifier', APP_ID);

// Force Launch Services to re-read the bundle so the menu-bar/Dock pick up
// the new name instead of returning the cached "Electron" entry.
const LSREG = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
if (fs.existsSync(LSREG)) {
  spawnSync(LSREG, ['-f', APP_DIR], { stdio: 'ignore' });
}

// Refresh the Dock so the icon tooltip + menu-bar pick up the new name.
spawnSync('killall', ['Dock'], { stdio: 'ignore' });

console.log(`[dev-rename] Electron bundle patched → ${APP_NAME} (${APP_ID})`);
console.log('[dev-rename] If a previous Electron is still running, quit it (cmd+Q) before starting dev.');
