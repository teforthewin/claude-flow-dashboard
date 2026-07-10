# Add OpenCode session support to LoomScope

## Context

LoomScope currently visualizes **Claude Code** sessions only. It scans `~/.claude/projects/**/*.jsonl`, parses each transcript line (`LogParser.parseFile`) into a normalized `AppEntry[]` + `Stats` + `ParseResult`, holds them in `SessionManager`, and exposes them identically over Electron IPC and a REST API (`src/api/server.ts`), consumed by one Vue renderer and a CLI.

We want the **same feature set** (session list, flow/BPMN, events, tokens, live streaming) for **OpenCode** sessions, plus a clear UI indication of where each session came from.

Key discovery from inspecting this machine: **OpenCode stores its data in SQLite** (`~/.local/share/opencode/opencode.db`, ~117 MB, WAL mode), not the legacy per-file JSON. The DB is already ideal for us:

- `session(id, project_id, parent_id, slug, directory, title, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, …)` — aggregate tokens/model/subagent-tree already present.
- `message(id, session_id, time_created, data)` — `data` is JSON: `{role, parentID, agent, path:{cwd}, cost, tokens:{total,input,output,reasoning,cache:{read,write}}, modelID, providerID, time:{created,completed}, finish}`.
- `part(id, message_id, session_id, time_created, data)` — `data.type` ∈ `tool | text | reasoning | step-start | step-finish | patch | file`. `tool` parts carry `{tool, callID, state:{status, input, output}}`; `text` parts carry prompt/answer text; `step-finish` carries per-step `tokens`.

Confirmed decisions: **SQLite backend only**, **unified sidebar + source badge + filter**, **reasoning tokens as a new optional pill**.

## Design — a source-adapter seam

Everything downstream of `SessionManager` (IPC, REST, SSE, CLI, renderer) already speaks only the normalized DTOs (`SessionInfo`, `SessionSummary`, `AppEntry`, `Stats`) and is source-agnostic. So we keep those DTOs, add a single `source` discriminator, and introduce two adapters behind `SessionManager`:

- **ClaudeAdapter** — the current `~/.claude/projects` scan + `LogParser` (refactored out of `SessionManager`, behavior unchanged).
- **OpenCodeAdapter** — reads `opencode.db`, produces the *same* `AppEntry[]`/`Stats`/`ParseResult`, normalizing OpenCode's tool names + input keys into the existing Claude vocabulary so `buildCmd`, `FlowBuilder.summarizeInput`, and `BpmnBuilder` work with **zero changes**.

`SessionManager` owns one merged `Map<sessionId, SessionState>` where each `SessionState` gains `source: 'claude' | 'opencode'`. Session ids are already namespaced (`ses_…` for OpenCode vs UUIDs for Claude) so no collision.

## Step-by-step plan

### 1. Shared types (additive, non-breaking)
- `src/core/LogParser.ts`: add optional `reasoning?: number` to `TokenCounts` (default treated as 0). Update `emptyStats()` and `mergeStats()` to carry `reasoning`. Claude path leaves it 0, so no behavior change.
- `src/core/SessionManager.ts`: add `source: 'claude' | 'opencode'` to `SessionState`, `SessionInfo` (as `source`), and `SessionSummary`.
- New `src/core/SourceAdapter.ts`: interface
  ```ts
  interface SourceAdapter {
    source: 'claude' | 'opencode';
    isConfigured(): boolean;
    loadAll(): LoadedSession[];              // { sessionId, filePath|dbKey, parseResult, parentId, meta }
    loadSession(id): LoadedSession | null;
    watch(onChange: (ids: string[]) => void): () => void;  // returns disposer
  }
  ```

### 2. OpenCode SQLite adapter — the log analyzer
New `src/core/opencode/OpenCodeAdapter.ts` + `src/core/opencode/parseOpenCodeSession.ts`.

- **Dependency**: add `better-sqlite3` (sync API, matches the existing sync `parseFile` style; works in both Electron and the headless node API). Open **read-only**: `new Database(dbPath, { readonly: true, fileMustExist: true })` so we never lock/mutate OpenCode's DB and WAL is respected. (Alternative if native-rebuild friction is undesirable: Node 22 built-in `node:sqlite` — Electron 42 bundles Node 22 — but it is experimental; prefer `better-sqlite3`.) Note: `electron-vite`/`electron-builder` must rebuild the native module for Electron's ABI (add to `build` config / `postinstall`).
- **Discovery** (`loadAll`): `SELECT * FROM session` joined to `project`. Map each row → a `SessionState`-ready record: `project` = `session.directory` (fallback `project.name`), `title` = `session.title`, `parentId` = `session.parent_id`, `model` from `session.model` JSON (`{id, providerID}`), aggregate tokens straight from the `tokens_*` columns, `is_active` from `time_updated`.
- **Per-session parse** (`parseOpenCodeSession(db, sessionId)`): query messages + parts ordered by `time_created`:
  ```sql
  SELECT id, data FROM message WHERE session_id=? ORDER BY time_created;
  SELECT message_id, data FROM part WHERE session_id=? ORDER BY time_created;
  ```
  Then emit `AppEntry[]` mirroring `LogParser`'s output:
  - assistant `tool` part → one `event:'pre'` entry (`action_id = callID`, `input = state.input`) and, when `state.status==='completed'`, one `event:'post'` entry (`response = state.output`) correlated by `callID`.
  - user `text` part (on a `role:'user'` message) → `event:'prompt'`, `tool:'User'`.
  - tokens: from each assistant `message.data.tokens` (or `step-finish` parts) → `TimelineEntry` + `stats.tokens` accumulation, including `reasoning`.
  - timestamps: `message.data.time.created` (epoch ms) → ISO string (`AppEntry.ts` is ISO, like Claude).
- **Tool-name + input normalization** (the key compatibility layer) — a small table so downstream is untouched:

  | OpenCode | → Claude tool | input key remap |
  |---|---|---|
  | `read`/`edit`/`write` | `Read`/`Edit`/`Write` | `filePath` → `file_path` |
  | `bash` | `Bash` | `command`, `description` (already match) |
  | `grep`/`glob` | `Grep`/`Glob` | `pattern` (matches) |
  | `webfetch` | `WebFetch` | `url` |
  | `task` | `Agent` | `subagent_type`/`description` (matches) |
  | `skill` | `Skill` | `skill`/`args` (matches) |
  | `todowrite` | `TaskCreate` (or keep `TodoWrite`) | — |
  | `codegraph_*` / other MCP | `mcp__<server>__<tool>` | — |

  Anything unmapped passes through with its raw name (fallback branches in `buildCmd`/`summarizeInput` already handle unknowns).
- **Subagent tree**: `session.parent_id` already links OpenCode subagent sessions → set `parentId`/`childIds` exactly like Claude's `subagents/` nesting. No teams concept in OpenCode (leave `teamName` empty).

### 3. SessionManager — become multi-source
- Refactor the current `~/.claude` scan/parse logic into `ClaudeAdapter` (behavior identical), and have `SessionManager` hold `adapters: SourceAdapter[]`.
- `loadAll()` iterates configured adapters, tags each `SessionState.source`, merges into the single map.
- `getSessionList()/getSummary()/getStats()` unchanged except they now include `source` in the DTO.
- `deleteSessions`/`archiveSessions`: guard by source. **OpenCode is read-only** — deleting a Claude `.jsonl` via `fs.unlink` must NOT run against DB-backed sessions. Either disable delete/archive for `source==='opencode'` (return skipped) or make them adapter methods that OpenCode no-ops. Recommend: disable + surface in UI (badge sessions as read-only).

### 4. Live updates — watcher
- New `src/core/opencode/OpenCodeWatcher.ts` (or fold into the adapter's `watch`): chokidar on `opencode.db-wal` + `opencode.db` with `awaitWriteFinish` debounce (~300 ms). On change, re-query sessions whose `time_updated` advanced since last poll and re-derive them (full per-session re-parse — the incremental `fromLine` model does not apply to SQLite). Emit the same `session:new` / `session:entry` / `sessions:updated` events `SessionManager` already broadcasts, so IPC/SSE/renderer streaming works unchanged.
- Keep the existing `LogWatcher` for the Claude source.

### 5. Settings — configure the OpenCode source
- `src/core/Settings.ts` and `src/main/Settings.ts`: extend `AppSettings` with `opencodeDbPath: string` (default `~/.local/share/opencode/opencode.db`, honoring `OPENCODE_DATA_DIR`) and `opencodeEnabled: boolean` (default auto-true if the file exists). Env overrides in `src/api/index.ts`: `LOOMSCOPE_OPENCODE_DB`.
- `GET /api/settings/check` and `settings:check` IPC: add `opencodeDb: boolean` (fs.existsSync) so the path-warning banner covers it.

### 6. API / IPC / web-shim — mostly passthrough
- `src/api/server.ts` and `src/main/ipc.ts`: **no new endpoints needed** — `source` rides along in the existing `SessionInfo`/`SessionSummary` payloads. Optionally accept `?source=` on `GET /api/sessions` for server-side filtering (nice-to-have; renderer can filter client-side).
- `src/preload/index.ts` + `src/renderer/public/electronAPI-web-shim.js`: unchanged surface; verify new settings fields flow through `getSettings`/`checkSettings`/`setSettings`.

### 7. CLI — surface the source
- `src/cli/index.ts` `cmdSessionsList`: add a `SOURCE` column (`claude`/`opencode`). `summary`/`flow`/`stats` need no change (source is in the summary payload).

### 8. Renderer — badge, filter, reasoning pill, provenance
Mirror the existing **model-dot** pattern (the codebase's established per-session marker):
- `src/renderer/main.js` (near `formatModel`/`modelClass`, lines ~21–37): add `sourceLabel(s)` and `sourceClass(s)` helpers.
- `src/renderer/index.html`:
  - CSS: add `--claude`/`--opencode` color tokens (`:root`, ~lines 14–53) and `.source-badge--claude/--opencode` styles near `.model-dot` (~1530) or the `.feed-msg__badge` pills (~1413).
  - Sidebar rows (~1731 parent, ~1752 child) and detail title bar (~1807): add a `<span class="source-badge">` next to the model dot.
  - HUD (`.hud`, ~1819): when the active session is OpenCode, show `providerID/modelID` and the **reasoning token pill** (only when `stats.tokens.reasoning > 0`); also add a reasoning bar in the Tokens tab breakdown (~2017).
  - Sidebar filter: add a small source `<select>` (All / Claude Code / OpenCode) near the search input (~1702), bound to a new `sourceFilter` ref, applied inside `filteredProjectGroups` (main.js ~2337: `.filter(s => sourceFilter==='all' || s.source===sourceFilter)`).
  - Read-only affordance: hide/disable delete & archive actions for OpenCode-selected sessions (they're DB-backed and read-only).

## Files touched (representative)
- New: `src/core/SourceAdapter.ts`, `src/core/ClaudeAdapter.ts`, `src/core/opencode/OpenCodeAdapter.ts`, `src/core/opencode/parseOpenCodeSession.ts`, `src/core/opencode/toolMap.ts`, `src/core/opencode/OpenCodeWatcher.ts`.
- Modified: `src/core/LogParser.ts` (reasoning in `TokenCounts`/`mergeStats`/`emptyStats`), `src/core/SessionManager.ts` (multi-source + `source` DTO + read-only guards), `src/core/Settings.ts`, `src/main/Settings.ts`, `src/api/index.ts`, `src/api/server.ts` (optional `?source`, `check`), `src/main/ipc.ts` (`check`), `src/main/index.ts` (wire second watcher), `src/cli/index.ts`, `src/renderer/main.js`, `src/renderer/index.html`, `package.json` (`better-sqlite3` + native rebuild config).

## Verification (end-to-end)
1. **Unit-level parse check**: run the new `parseOpenCodeSession` against the real `~/.local/share/opencode/opencode.db` (read-only) for a known `ses_…` id; assert `AppEntry[]` has correct `pre`/`post` pairs, tool names normalized to PascalCase, tokens (incl. reasoning) matching the `session.tokens_*` columns.
2. **API**: `npm run api:start`, then `curl localhost:7842/api/sessions` → confirm both Claude and OpenCode rows, each with a `source` field; `curl …/api/sessions/<ses_id>/summary` → BPMN + tokens render; `curl …/api/sessions/<ses_id>/flow` → normalized steps.
3. **CLI**: `loomscope ls` shows the SOURCE column; `loomscope flow <ses_id>` and `summary <ses_id>` work against an OpenCode session.
4. **Electron UI** (use the `run` skill): launch the app → OpenCode sessions appear in the sidebar with the source badge; source filter narrows the list; selecting one shows flow/diagram/events/tokens with the reasoning pill; delete/archive disabled for OpenCode. Start a fresh `opencode` session in another terminal and confirm it streams in live (watcher).
5. **Regression**: confirm existing Claude Code sessions, teams, live streaming, and delete/archive are unchanged.

## Risks / notes
- **WAL read-only**: open with `readonly:true` (not `immutable`) so committed WAL data is visible; never write. Large DB (117 MB) — query per-session lazily, don't load all parts up front.
- **Native module**: `better-sqlite3` must be rebuilt for Electron's ABI and also usable by the plain-node API; wire `electron-builder`/`electron-vite` accordingly (or fall back to `node:sqlite`).
- **Cost**: OpenCode stores `cost` (0 for local/ollama models). Prefer DB `cost` when > 0, else keep LoomScope's estimated-cost logic.
- **No teams** in OpenCode — team UI simply stays empty for those sessions.
