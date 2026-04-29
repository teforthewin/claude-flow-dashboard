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

if (process.platform !== 'darwin') process.exit(0);

const APP_NAME = 'LoomScope';
const plistPath = path.resolve(__dirname, '..', 'node_modules/electron/dist/Electron.app/Contents/Info.plist');

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

const before = get('CFBundleName');
if (before === APP_NAME) {
  process.exit(0);
}
set('CFBundleName', APP_NAME);
set('CFBundleDisplayName', APP_NAME);
console.log(`[dev-rename] patched Electron Info.plist: CFBundleName ${before || '(unset)'} → ${APP_NAME}`);
