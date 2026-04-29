# LoomScope

A desktop app that turns your Claude Code session logs into a live, navigable view of what your agents are actually doing — every prompt, every tool call, every sub-agent, every token. No hooks, no server, no instrumentation: it reads the JSONL files Claude Code already writes.

## How it works

Claude Code writes one JSONL line per event to `~/.claude/projects/<project>/<session-uuid>.jsonl`. Sub-agents launched via the `Agent` tool get their own log under `<session>/subagents/<agent-id>.jsonl` plus a `.meta.json` with the agent type and description. Teams (the multi-agent coordination feature) leave state in `~/.claude/teams/<team>/`.

LoomScope watches both directories with `chokidar`, parses each new line incrementally in the Electron main process, and pushes updates to the Vue renderer over IPC.

```
~/.claude/projects/<project>/<session>.jsonl              ← parent sessions
~/.claude/projects/<project>/<session>/subagents/*.jsonl  ← sub-agent sessions
~/.claude/teams/<team>/                                   ← team state + messages
        │
        ▼  chokidar (debounced, awaitWriteFinish)
   Electron main (TypeScript)
   ├── LogParser    — JSONL → typed entries (prompt | pre | post | command)
   ├── SessionManager — links subagents → parent, teams → lead
   ├── LogWatcher   — incremental parse on change
   └── TeamMonitor  — watches teams dir, detects revocations
        │
        ▼  IPC
   Renderer (Vue 3, single-file `index.html` + `main.js`)
```

The parser is incremental — once a session is loaded, only new lines are parsed on each file change, so a session with thousands of entries stays cheap to update.

## What you can do with it

### Sidebar — sessions & teams

- Sessions are grouped by project and sorted by recency. Live sessions get a `●` dot.
- Sub-agent sessions are nested under their parent (click the parent to expand).
- Search by project, session id, or date with `/`.
- Each session shows: title (first user prompt or agent role), tool count, token totals, duration.

### Flow tab (`p`)

The main view. Renders a session as a numbered, BPMN-style lane:

- **Solo steps** — User prompts, slash commands, skill listings (boundary events).
- **Sequential steps** — runs of consecutive tool calls (Read/Edit/Bash/...) collapsed into one block with aggregated stats; click to expand.
- **Sub-agent steps** — each `Agent` tool call becomes an orchestration step; expanding it inlines the sub-agent's own flow recursively.
- **Parallel steps** — when multiple `Agent` calls fire close together, they're rendered as a parallel gateway with one column per agent.
- Live agents show a `● LIVE` badge until their tool result arrives.
- Click any sub-agent to navigate into its session.

### Diagram tab (`d`)

A Mermaid flowchart of the same data, with rich hover tooltips (full prompt / response, timing, token cost). Sub-agents appear as nested subgraphs up to a configurable depth; click a node to open that sub-session.

### Events tab (`e`)

Flat, filterable event log:
- Filter by event direction (prompt / pre / post / command).
- Filter by tool (Bash, Read, Agent, Skill, …).
- Free-text search.
- Auto-scroll toggle for live tailing.

### Teams tab (`m`)

For sessions running under a team:
- One row per team member with current status, last message, total tokens.
- Inbox view: every `SendMessage` between agents.
- Live activity feed across the whole team.
- Revocation detection — when a team is dissolved, you get a one-click "Archive to zip" prompt.

### Tokens tab (`k`)

Per-session token breakdown:
- Input / output / cache-read / cache-create totals.
- Estimated cost in USD (using current Sonnet/Opus/Haiku rates).
- Activity bucketing (which tools consumed which tokens).
- Timeline of token consumption over the session.

### Raw Log toggle

A button in the tab bar exposes the underlying JSONL — pretty-printed or compact — for any open session. Useful when something looks off in the parsed view.

### HUD (top of the session pane)

Always visible: token totals, estimated cost, top tools used, session duration, parent-session jump button (when viewing a sub-agent).

### Archive export

Right-click any session or team in the sidebar → "Export archive". Produces a `.zip` containing the parent JSONL, all sub-agent JSONLs, team message logs, and a manifest. Useful for sharing reproductions or post-mortems.

## Install & run (development)

```bash
npm install
npm run dev
```

The app picks up `~/.claude/projects/` and `~/.claude/teams/` automatically. Override paths via Settings (gear icon) if Claude Code uses a non-default location.

## Build distributables

```bash
npm run dist:mac     # macOS — .dmg + .zip (arm64 & x64)
npm run dist:win     # Windows — NSIS installer + portable .exe (x64)
npm run dist:linux   # Linux — .AppImage + .deb (x64)
npm run dist:all     # all platforms
```

Output lands in `dist/`. Cross-building Windows from macOS needs Wine or a CI runner; Linux works under Docker.

## Keyboard shortcuts

| Key       | Action                       |
|-----------|------------------------------|
| `p`       | Flow tab                     |
| `d`       | Diagram tab                  |
| `e`       | Events tab                   |
| `k`       | Tokens tab                   |
| `m`       | Teams tab                    |
| `j` / `↓` | Next session in sidebar      |
| `k` / `↑` | Previous session in sidebar  |
| `/`       | Focus session search         |
| `Esc`     | Blur input / collapse        |

## Quick start (user manual)

1. **Install & launch.** `npm install && npm run dev`. The window opens with your sessions in the sidebar.
2. **Pick a session.** Click any session — or press `j`/`k` to walk the list. Live sessions sort to the top with a `●` dot.
3. **See what happened.** Land on the **Flow** tab (`p`). Read top-to-bottom: each step is numbered. Click a step to expand sequential blocks or dive into a sub-agent.
4. **Need a bird's-eye?** Press `d` for the Mermaid diagram. Hover any node for full context; click a sub-agent node to jump into its session.
5. **Hunting a specific event?** Press `e`, filter by tool or text, toggle direction filters. The action_id of a `post` event matches its `pre` — useful for tracing tool calls in the raw log.
6. **Watching cost.** Press `k` for the token breakdown — totals, per-tool consumption, estimated cost.
7. **Multi-agent run.** If the session is a team lead, press `m` to see all members, their inboxes, and live activity. When the team is dissolved, you'll get an archive prompt.
8. **Need the raw data?** Toggle "Raw Log" in the tab bar to read the original JSONL alongside the parsed view.
9. **Sharing a session.** Right-click in the sidebar → "Export archive" produces a self-contained zip.

## Troubleshooting

- **Session doesn't show up.** Check that Claude Code is actually writing to `~/.claude/projects/`. The watcher only picks up `.jsonl` files (the legacy `.flow.jsonl` format is ignored).
- **Sub-agent step shows "No nested operations".** The sub-agent has been launched but hasn't logged any tool call yet — it'll fill in live as the agent runs.
- **App icon missing in Dock.** Ensure `build/icon.png` exists; LoomScope warns to the console if it can't resolve an icon path.
- **Two copies of the same session.** Was an issue with legacy `.flow.jsonl` ghosts; fixed in the watcher (and in `SessionManager.loadSession`).

## Project layout

```
src/
├── main/                  Electron main (Node)
│   ├── index.ts           App lifecycle, window, listener cleanup
│   ├── ipc.ts             IPC channel handlers
│   ├── LogParser.ts       JSONL → typed AppEntry[]
│   ├── LogWatcher.ts      chokidar driver, debounced parse
│   ├── SessionManager.ts  Session graph, parent/child links
│   ├── TeamMonitor.ts     Team state + revocation detection
│   └── Settings.ts        Persisted user settings
├── preload/index.ts       contextBridge API exposed to renderer
└── renderer/
    ├── index.html         Single-file Vue template
    └── main.js            App, components, tree/step grouping, Mermaid emitter
```
