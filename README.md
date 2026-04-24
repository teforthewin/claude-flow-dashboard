# Claude Flow Dashboard

A desktop app for monitoring Claude Code agent sessions in real-time. Reads native Claude Code logs directly — no hooks, no server, no configuration.

## How it works

Claude Code writes session logs to `~/.claude/projects/` as JSONL files. The app watches these files with chokidar, parses every tool invocation and token usage, and renders them in a live UI.

```
~/.claude/projects/<project>/<session>.jsonl   ← Claude Code writes here
~/.claude/teams/<team>/                        ← Multi-agent team state
        ↓ chokidar file watcher
   Electron main process (TypeScript)
        ↓ IPC
   Renderer (Vue 3)
```

## Features

- **Flow Tree** — collapsible tree of every tool call, agent spawn, and prompt in a session
- **Events** — filterable flat log of all events with token counts
- **Process** — visual flow diagram of the session execution
- **Tokens** — token consumption breakdown by type (input/output/cache) and activity category, with estimated cost
- **Teams** — real-time multi-agent team monitoring: per-agent message inboxes, live activity feed
- Team revocation detection with one-click archive to zip
- Session and team archive export (zip containing JSONL + message logs)

## Install & run

```bash
npm install
npm run dev
```

## Build

```bash
npm run dist:mac     # macOS — .dmg + .zip (arm64 & x64)
npm run dist:win     # Windows — NSIS installer + portable .exe (x64)
npm run dist:linux   # Linux — .AppImage + .deb (x64)
npm run dist:all     # All platforms
```

Output lands in `dist/`.

> Building for Windows from macOS requires Wine or a CI runner. Linux builds work via Docker if it's running.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `t` | Flow Tree tab |
| `p` | Process tab |
| `e` | Events tab |
| `k` | Tokens tab |
| `m` | Teams tab |
| `j / k` | Navigate sessions |
| `/` | Search sessions |
| `esc` | Collapse tree |
