# LoomScope — Deployment Guide

This document covers how to build, package, and distribute LoomScope as an
Electron desktop app on **macOS**, **Windows**, and **Linux** — both as
installers and as fully portable bundles.

---

## 1. Prerequisites

| Tool       | Version            | Notes                                        |
| ---------- | ------------------ | -------------------------------------------- |
| Node.js    | ≥ 18 LTS           | 20.x recommended                             |
| npm        | ≥ 9                | Ships with Node                              |
| Git        | any recent         | Required for `electron-builder` metadata     |
| Python 3   | only on Linux/Win  | Needed by some native-module rebuilds        |

Platform-specific build tooling:

- **macOS** — Xcode Command Line Tools (`xcode-select --install`).
- **Windows** — Visual Studio Build Tools 2019/2022 ("Desktop development with C++").
- **Linux** — `dpkg`, `fakeroot`, `rpm` (for `.deb` / `.rpm`); `libarchive-tools` for AppImage signing.

Cross-compilation caveats: electron-builder can build Windows artifacts from
macOS/Linux but **cannot reliably build macOS artifacts from Windows/Linux**
(code-signing limitations). Build mac artifacts on a Mac.

---

## 2. Install dependencies

```bash
npm ci
```

`npm ci` is preferred over `npm install` in CI/release contexts — it honors
`package-lock.json` exactly and is reproducible.

---

## 3. Local development

```bash
npm run dev
```

This runs `electron-vite dev` after renaming the Electron binary (see
`scripts/dev-rename-electron.js`). The renderer hot-reloads on save.

---

## 4. Production build (no packaging)

```bash
npm run build
```

Outputs compiled main/preload/renderer bundles to `out/`. This is the input
to every packaging command below.

---

## 5. Packaging

All packaging targets call `electron-builder` with `out/` as input and emit
artifacts to `dist/`.

### 5.1 Build everything for the current OS

```bash
npm run dist
```

### 5.2 Build for a specific OS

```bash
npm run dist:mac      # macOS    → .dmg + .zip   (arm64, x64)
npm run dist:win      # Windows  → .exe NSIS + .exe portable (x64, arm64)
npm run dist:linux    # Linux    → .AppImage + .deb (x64, arm64)
```

### 5.3 Build all three OSes at once

```bash
npm run dist:all
```

Run on macOS for best results (it can produce Win + Linux artifacts; the
reverse is not true for macOS).

### 5.4 Portable-only builds

Portable bundles run **without installation** — no admin rights, no
registry/AppData writes, no system-wide effects.

```bash
npm run dist:portable          # all OSes (portable artifacts only)
npm run dist:portable:mac      # macOS    → .zip
npm run dist:portable:win      # Windows  → portable .exe
npm run dist:portable:linux    # Linux    → .AppImage
```

| OS      | Portable artifact                                     | How users run it                         |
| ------- | ----------------------------------------------------- | ---------------------------------------- |
| macOS   | `LoomScope-<version>-mac-<arch>.zip`                  | Unzip, double-click `LoomScope.app`      |
| Windows | `LoomScope-<version>-portable-<arch>.exe`             | Double-click — single-file, no install   |
| Linux   | `LoomScope-<version>-portable-<arch>.AppImage`        | `chmod +x` once, then double-click       |

---

## 6. Output layout

After a full build, `dist/` looks like:

```
dist/
├── LoomScope-1.0.3-mac-arm64.dmg
├── LoomScope-1.0.3-mac-arm64.zip
├── LoomScope-1.0.3-mac-x64.dmg
├── LoomScope-1.0.3-mac-x64.zip
├── LoomScope-1.0.3-portable-x64.exe
├── LoomScope-1.0.3-portable-arm64.exe
├── LoomScope Setup 1.0.3.exe          (NSIS installer)
├── LoomScope-1.0.3-portable-x64.AppImage
├── LoomScope-1.0.3-portable-arm64.AppImage
├── loomscope_1.0.3_amd64.deb
├── loomscope_1.0.3_arm64.deb
└── latest-*.yml                       (auto-update manifests)
```

---

## 7. Versioning

When releasing a new version:

1. Bump `version` in `package.json`.
2. Commit with message `release: vX.Y.Z`.
3. Tag: `git tag vX.Y.Z && git push --tags`.
4. Build & publish (see §8).

Use [semver](https://semver.org/): patch for fixes, minor for features,
major for breaking changes.

---

## 8. Publishing

The `publish` block in `package.json` targets GitHub Releases
(`easyparkgroup/claude-flow-dashboard`). To publish:

```bash
GH_TOKEN=<personal-access-token> npm run dist:all -- --publish always
```

Tokens need `repo` scope. `electron-builder` will:

1. Build all artifacts.
2. Upload them to a draft GitHub Release for the current tag.
3. Generate `latest.yml` / `latest-mac.yml` / `latest-linux.yml` for
   future auto-update support.

Mark the GitHub Release as **published** (not draft) when ready.

---

## 9. Code signing & notarization (optional but recommended)

Unsigned builds run, but trigger Gatekeeper / SmartScreen warnings.

### macOS

Set these env vars before `dist:mac`:

```
CSC_LINK=<base64 .p12 or file path>
CSC_KEY_PASSWORD=<password>
APPLE_ID=<apple id>
APPLE_APP_SPECIFIC_PASSWORD=<app-specific password>
APPLE_TEAM_ID=<team id>
```

electron-builder will sign and notarize automatically.

### Windows

```
CSC_LINK=<base64 .pfx or file path>
CSC_KEY_PASSWORD=<password>
```

### Linux

No signing required for AppImage/deb.

---

## 10. CI/CD

A minimal GitHub Actions matrix (for reference — add as
`.github/workflows/release.yml`):

```yaml
name: release
on:
  push:
    tags: ['v*']
jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run dist -- --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

---

## 11. Troubleshooting

| Symptom                                             | Fix                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Cannot find module 'electron'`                     | Run `npm ci` again; check `postinstall` script ran.                            |
| macOS: "App is damaged and can't be opened"         | App is unsigned. `xattr -cr /Applications/LoomScope.app` clears the quarantine.|
| Windows SmartScreen blocks the portable `.exe`      | Click "More info" → "Run anyway", or sign the binary (see §9).                 |
| Linux AppImage won't launch                         | `chmod +x LoomScope-*.AppImage`; install `libfuse2` on newer distros.          |
| `electron-builder` fails on native modules          | Delete `node_modules` + `package-lock.json`, then `npm install`.               |
| Build hangs on `Downloading Electron`               | Set `ELECTRON_MIRROR` to a closer mirror, or pre-cache `~/.cache/electron`.    |

---

## 12. Quick reference

```bash
# Dev
npm run dev

# Build (no packaging)
npm run build

# Portable artifacts (no installer)
npm run dist:portable

# Per-OS portable
npm run dist:portable:mac
npm run dist:portable:win
npm run dist:portable:linux

# Full installers + portables
npm run dist:all

# Publish to GitHub Releases
GH_TOKEN=*** npm run dist:all -- --publish always
```
