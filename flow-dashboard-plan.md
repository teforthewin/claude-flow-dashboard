# Real-Time Claude Code Flow Dashboard — Autonomous Implementation Plan

## Goal

Build a standalone Python web dashboard that watches Claude Code session log files and streams every agent/skill/tool event to a browser in real-time via Server-Sent Events.

This plan is **fully self-contained**. An AI agent or developer can execute it start-to-finish in an empty folder with no other context.

---

## Project Structure

Create this folder structure from scratch:

```
flow-dashboard/
├── requirements.txt          # Python deps (4 packages)
├── flow_logger.py            # Claude Code hook script — writes JSONL events
├── generate_flow_diagram.py  # Mermaid diagram builder — imported by server
├── flow_server.py            # FastAPI web server + embedded HTML dashboard
└── flow-logs/                # Created automatically at runtime — JSONL files live here
```

---

## How It Works

```
Claude Code (in any repo)
  └── PreToolUse/PostToolUse hook
        └── pipes JSON → flow_logger.py → appends line to flow-logs/<session>.jsonl

flow_server.py (running in background)
  ├── watchdog watches flow-logs/ for changes
  ├── SSE streams new events to browser
  └── serves http://localhost:7842
```

Claude Code hooks point at the absolute path of `flow_logger.py` in this project. The server and logger agree on the log directory via the `FLOW_LOG_DIR` env var (default: `./flow-logs/` relative to this project).

---

## Step 1 — Setup

```bash
mkdir flow-dashboard && cd flow-dashboard
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
mkdir flow-logs
```

---

## Step 2 — Configure Claude Code Hooks

In the Claude Code project you want to monitor, edit `.claude/settings.json` to add:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent|Skill|SendMessage|TaskCreate",
        "hooks": [
          {
            "type": "command",
            "command": "FLOW_LOG_DIR=/absolute/path/to/flow-dashboard/flow-logs python3 /absolute/path/to/flow-dashboard/flow_logger.py pre"
          }
        ]
      },
      {
        "matcher": "Read|Glob|Grep",
        "hooks": [
          {
            "type": "command",
            "command": "FLOW_LOG_DIR=/absolute/path/to/flow-dashboard/flow-logs python3 /absolute/path/to/flow-dashboard/flow_logger.py pre"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Agent|Skill|SendMessage",
        "hooks": [
          {
            "type": "command",
            "command": "FLOW_LOG_DIR=/absolute/path/to/flow-dashboard/flow-logs python3 /absolute/path/to/flow-dashboard/flow_logger.py post"
          }
        ]
      }
    ]
  }
}
```

Replace `/absolute/path/to/flow-dashboard` with the real path on disk.

---

## Step 3 — Run

```bash
# In the flow-dashboard directory, with venv active:
python3 flow_server.py

# Optional: custom port or log dir
FLOW_SERVER_PORT=8000 python3 flow_server.py
FLOW_LOG_DIR=/some/other/path python3 flow_server.py
```

Open `http://localhost:7842` in a browser. It auto-selects the most recent session and streams live events as they arrive.

---

## File 1 — `requirements.txt`

```
fastapi==0.115.12
uvicorn[standard]==0.34.0
watchdog==6.0.0
sse-starlette==2.3.5
```

---

## File 2 — `flow_logger.py`

```python
#!/usr/bin/env python3
"""
Claude Code Flow Logger — Hook script
Captures Agent, Skill, SendMessage, TaskCreate and Read(skills/prompts) tool events
and appends structured JSONL entries to <FLOW_LOG_DIR>/<session_id>.jsonl

Invoked by Claude Code hooks (PreToolUse / PostToolUse).
Reads hook payload JSON from stdin.

Usage: python3 flow_logger.py <pre|post>
Config: FLOW_LOG_DIR env var (default: ./flow-logs relative to this script)
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Tools to capture fully
FULL_CAPTURE_TOOLS = {"Agent", "Skill", "SendMessage", "TaskCreate"}

# For Read/Glob/Grep, only capture if path references skills or prompts
PATH_TOOLS = {"Read", "Glob", "Grep"}
PATH_KEYWORDS = [".claude/skills", ".github/prompts", ".github/agents", ".github/instructions"]


def _truncate(value, max_len=600):
    if isinstance(value, str) and len(value) > max_len:
        return value[:max_len] + f"…[+{len(value) - max_len} chars]"
    if isinstance(value, dict):
        return {k: _truncate(v, max_len) for k, v in value.items()}
    return value


def _should_capture(tool_name: str, tool_input: dict) -> bool:
    if tool_name in FULL_CAPTURE_TOOLS:
        return True
    if tool_name in PATH_TOOLS:
        path = (
            tool_input.get("file_path")
            or tool_input.get("path")
            or tool_input.get("pattern")
            or ""
        )
        return any(kw in path for kw in PATH_KEYWORDS)
    return False


def _summarise_input(tool_name: str, tool_input: dict) -> dict:
    """Return a concise, diagram-friendly summary of the tool input."""
    if tool_name == "Agent":
        return {
            "agent": tool_input.get("subagent_type", "general-purpose"),
            "description": tool_input.get("description", ""),
            "name": tool_input.get("name", ""),
        }
    if tool_name == "Skill":
        return {
            "skill": tool_input.get("skill", ""),
            "args": tool_input.get("args", ""),
        }
    if tool_name == "SendMessage":
        return {
            "to": tool_input.get("to", ""),
            "message": _truncate(tool_input.get("message", ""), 200),
        }
    if tool_name in PATH_TOOLS:
        return {
            "path": (
                tool_input.get("file_path")
                or tool_input.get("path")
                or tool_input.get("pattern")
                or ""
            ),
        }
    return _truncate(tool_input, 300)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("pre", "post"):
        sys.exit(0)

    event_type = sys.argv[1]

    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, Exception):
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    if not _should_capture(tool_name, tool_input):
        sys.exit(0)

    session_id = data.get("session_id", "unknown")

    # Log directory: env var > default relative to this script
    log_dir = Path(os.environ.get("FLOW_LOG_DIR", Path(__file__).parent / "flow-logs"))
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{session_id}.jsonl"

    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event_type,
        "tool": tool_name,
        "input": _summarise_input(tool_name, tool_input),
    }

    if event_type == "post":
        raw_response = data.get("tool_response", "")
        entry["response"] = _truncate(raw_response, 400)

    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    sys.exit(0)


if __name__ == "__main__":
    main()
```

---

## File 3 — `generate_flow_diagram.py`

```python
#!/usr/bin/env python3
"""
Claude Code Flow Diagram Generator
Reads a JSONL flow log and produces a Mermaid sequence diagram.

Usage:
    python3 generate_flow_diagram.py [log_file]
    python3 generate_flow_diagram.py              # auto-picks latest log
    python3 generate_flow_diagram.py --list       # list available sessions

Output: flow-logs/<session_id>.md  (or stdout with --stdout)
Config: FLOW_LOG_DIR env var (default: ./flow-logs relative to this script)
"""

import json
import os
from datetime import datetime
from pathlib import Path
import sys

LOG_DIR = Path(os.environ.get("FLOW_LOG_DIR", Path(__file__).parent / "flow-logs"))

# Maps agent subagent_type to a short display label
AGENT_LABELS = {
    "general-purpose":          "Agent:General",
    "Explore":                  "Agent:Explore",
    "Plan":                     "Agent:Plan",
    "framework-architect":      "Agent:FrameworkArchitect",
    "mobile-core-generator":    "Agent:MobileCore",
    "test-reviewer":            "Agent:TestReviewer",
    "framework-checker":        "Agent:FrameworkChecker",
    "test-code-implementer":    "Agent:TestImplementer",
    "code-verifier":            "Agent:CodeVerifier",
    "business-layer-generator": "Agent:BusinessLayer",
    "generation-pipeline":      "Agent:Pipeline",
    "test-case-generator":      "Agent:TestCaseGen",
    "scenario-designer":        "Agent:ScenarioDesigner",
    "web-core-generator":       "Agent:WebCore",
    "api-core-generator":       "Agent:APICore",
    "test-implementer":         "Agent:TestImpl",
    "claude-code-guide":        "Agent:Guide",
    "statusline-setup":         "Agent:StatusLine",
}

PARTICIPANT_ALIASES = {
    "Claude":                   "C",
    "User":                     "U",
    "Agent:General":            "AG",
    "Agent:Explore":            "AE",
    "Agent:Plan":               "AP",
    "Agent:FrameworkArchitect": "AFA",
    "Agent:MobileCore":         "AMC",
    "Agent:TestReviewer":       "ATR",
    "Agent:FrameworkChecker":   "AFC",
    "Agent:TestImplementer":    "ATI",
    "Agent:CodeVerifier":       "ACV",
    "Agent:BusinessLayer":      "ABL",
    "Agent:Pipeline":           "APL",
    "Agent:TestCaseGen":        "ATCG",
    "Agent:ScenarioDesigner":   "ASD",
    "Agent:WebCore":            "AWC",
    "Agent:APICore":            "AAC",
    "Agent:TestImpl":           "AIMPL",
    "Agent:Guide":              "AGUID",
    "Skill":                    "SK",
    "Read":                     "FS",
}


def _safe(text: str, max_len=60) -> str:
    """Sanitise text for Mermaid labels."""
    text = str(text).replace('"', "'").replace("\n", " ").strip()
    if len(text) > max_len:
        text = text[:max_len] + "…"
    return text


def _agent_label(entry: dict) -> str:
    agent_type = entry["input"].get("agent", "general-purpose")
    named = entry["input"].get("name", "")
    label = AGENT_LABELS.get(agent_type, f"Agent:{agent_type}")
    if named:
        label = f"{label}[{named}]"
    return label


def load_entries(log_file: Path) -> list[dict]:
    entries = []
    with open(log_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return entries


def collect_participants(entries: list[dict]) -> list[str]:
    """Return ordered list of participant IDs seen in the log."""
    seen = ["Claude"]
    for e in entries:
        if e["event"] != "pre":
            continue
        tool = e["tool"]
        if tool == "Agent":
            p = _agent_label(e)
            if p not in seen:
                seen.append(p)
        elif tool == "Skill":
            if "Skill" not in seen:
                seen.append("Skill")
        elif tool in ("Read", "Glob", "Grep"):
            if "Read" not in seen:
                seen.append("Read")
        elif tool == "SendMessage":
            target = e["input"].get("to", "")
            matched = next((p for p in seen if target and target.lower() in p.lower()), None)
            if not matched and target:
                seen.append(f"Agent:{target}")
    return seen


def build_diagram(entries: list[dict], session_id: str) -> str:
    participants = collect_participants(entries)

    lines = [
        "```mermaid",
        "sequenceDiagram",
        "    autonumber",
    ]

    for p in participants:
        alias = PARTICIPANT_ALIASES.get(
            p, p.replace(":", "_").replace("[", "_").replace("]", "_")
        )
        lines.append(f"    participant {alias} as {p}")

    lines.append("")

    active_agents: dict[str, str] = {}

    for e in entries:
        tool = e["tool"]
        event = e["event"]

        if tool == "Agent":
            label = _agent_label(e)
            alias = PARTICIPANT_ALIASES.get(
                label, label.replace(":", "_").replace("[", "_").replace("]", "_")
            )
            c_alias = PARTICIPANT_ALIASES.get("Claude", "C")

            if event == "pre":
                desc = _safe(e["input"].get("description", "spawn"))
                lines.append(f"    {c_alias}->>{alias}: {desc}")
                lines.append(f"    activate {alias}")
                active_agents[label] = alias

            elif event == "post":
                if label in active_agents:
                    resp = e.get("response", "")
                    summary = _safe(resp, 80) if isinstance(resp, str) else "done"
                    lines.append(f"    {alias}-->>{c_alias}: {summary}")
                    lines.append(f"    deactivate {alias}")
                    del active_agents[label]

        elif tool == "Skill":
            sk_alias = PARTICIPANT_ALIASES.get("Skill", "SK")
            c_alias = PARTICIPANT_ALIASES.get("Claude", "C")
            skill_name = e["input"].get("skill", "")
            args = e["input"].get("args", "")
            label = _safe(f"{skill_name} {args}".strip(), 50)

            if event == "pre":
                lines.append(f"    {c_alias}->>{sk_alias}: invoke {label}")
            elif event == "post":
                lines.append(f"    {sk_alias}-->>{c_alias}: content loaded")

        elif tool in ("Read", "Glob", "Grep"):
            fs_alias = PARTICIPANT_ALIASES.get("Read", "FS")
            c_alias = PARTICIPANT_ALIASES.get("Claude", "C")
            path = _safe(e["input"].get("path", ""), 50)
            if event == "pre":
                lines.append(f"    Note over {c_alias},{fs_alias}: read {path}")

        elif tool == "SendMessage":
            c_alias = PARTICIPANT_ALIASES.get("Claude", "C")
            target = e["input"].get("to", "target")
            msg = _safe(e["input"].get("message", ""), 60)
            target_alias = next(
                (PARTICIPANT_ALIASES.get(p, p) for p in participants if target.lower() in p.lower()),
                target,
            )
            if event == "pre":
                lines.append(f"    {c_alias}->>{target_alias}: msg: {msg}")

        elif tool == "TaskCreate":
            c_alias = PARTICIPANT_ALIASES.get("Claude", "C")
            if event == "pre":
                task_title = _safe(e["input"].get("title", "task"), 50)
                lines.append(f"    Note over {c_alias}: task: {task_title}")

    lines.append("```")
    return "\n".join(lines)


def build_diagram_mermaid_only(
    entries: list[dict],
    session_id: str = "",
    max_entries: int = 200,
) -> tuple[str, bool]:
    """
    Returns (mermaid_syntax_string, was_truncated).
    mermaid_syntax_string is the raw mermaid content without fenced code block markers.
    Only the last max_entries events are used when the log is large.
    """
    truncated = len(entries) > max_entries
    display_entries = entries[-max_entries:] if truncated else entries
    full_markdown = build_diagram(display_entries, session_id)

    # Strip the ```mermaid ... ``` fences
    inner = []
    inside = False
    for line in full_markdown.split("\n"):
        if line.strip() == "```mermaid":
            inside = True
            continue
        if inside and line.strip() == "```":
            inside = False
            continue
        if inside:
            inner.append(line)

    return "\n".join(inner), truncated


def generate(log_file: Path, to_stdout: bool = False):
    session_id = log_file.stem
    entries = load_entries(log_file)

    if not entries:
        print(f"No entries found in {log_file}")
        return

    ts_start = entries[0].get("ts", "")
    ts_end = entries[-1].get("ts", "")
    n_events = len(entries)

    diagram = build_diagram(entries, session_id)

    report_lines = [
        f"# Flow Diagram — Session `{session_id}`",
        "",
        f"- **Start:** {ts_start}",
        f"- **End:** {ts_end}",
        f"- **Events captured:** {n_events}",
        "",
        "## Sequence Diagram",
        "",
        diagram,
        "",
        "## Raw Event Log",
        "",
        "| # | Time | Event | Tool | Summary |",
        "|---|------|-------|------|---------|",
    ]

    for i, e in enumerate(entries, 1):
        ts = e.get("ts", "")[-15:]
        ev = e["event"]
        tool = e["tool"]
        inp = e.get("input", {})
        if tool == "Agent":
            summary = f'{inp.get("agent", "")} — {inp.get("description", "")[:50]}'
        elif tool == "Skill":
            summary = inp.get("skill", "")
        elif tool in ("Read", "Glob", "Grep"):
            summary = inp.get("path", "")
        elif tool == "SendMessage":
            summary = f'→{inp.get("to", "")} {inp.get("message", "")[:40]}'
        else:
            summary = str(inp)[:60]
        report_lines.append(f"| {i} | {ts} | {ev} | {tool} | {summary} |")

    report = "\n".join(report_lines)

    if to_stdout:
        print(report)
    else:
        out_file = log_file.with_suffix(".md")
        out_file.write_text(report, encoding="utf-8")
        print(f"Diagram written to: {out_file}")


def list_sessions():
    if not LOG_DIR.exists():
        print("No flow-logs directory found.")
        return
    logs = sorted(LOG_DIR.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not logs:
        print("No log files found.")
        return
    print(f"{'Session ID':<50} {'Modified':<25} {'Events':>8}")
    print("-" * 85)
    for log in logs:
        mtime = datetime.fromtimestamp(log.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        lines = sum(1 for _ in open(log, encoding="utf-8"))
        print(f"{log.stem:<50} {mtime:<25} {lines:>8}")


def main():
    args = sys.argv[1:]

    if "--list" in args:
        list_sessions()
        return

    to_stdout = "--stdout" in args
    args = [a for a in args if not a.startswith("--")]

    if args:
        log_file = Path(args[0])
        if not log_file.is_absolute():
            log_file = LOG_DIR / log_file
        if not log_file.suffix:
            log_file = log_file.with_suffix(".jsonl")
    else:
        if not LOG_DIR.exists():
            print("No flow-logs directory found.")
            sys.exit(1)
        logs = sorted(LOG_DIR.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not logs:
            print("No log files found.")
            sys.exit(1)
        log_file = logs[0]
        print(f"Using latest log: {log_file.name}")

    if not log_file.exists():
        print(f"File not found: {log_file}")
        sys.exit(1)

    generate(log_file, to_stdout=to_stdout)


if __name__ == "__main__":
    main()
```

---

## File 4 — `flow_server.py`

```python
#!/usr/bin/env python3
"""
Claude Code Flow Dashboard — Real-time web server
Watches <FLOW_LOG_DIR>/*.jsonl and streams events to a browser dashboard via SSE.

Usage:
    python3 flow_server.py
    FLOW_SERVER_PORT=8000 python3 flow_server.py
    FLOW_LOG_DIR=/path/to/logs python3 flow_server.py
"""

import asyncio
import json
import os
import sys
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from sse_starlette.sse import EventSourceResponse
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

# ---------------------------------------------------------------------------
# Paths and config
# ---------------------------------------------------------------------------
ROOT = Path(__file__).parent
LOG_DIR = Path(os.environ.get("FLOW_LOG_DIR", ROOT / "flow-logs"))
PORT = int(os.environ.get("FLOW_SERVER_PORT", "7842"))

# ---------------------------------------------------------------------------
# Import diagram helper
# ---------------------------------------------------------------------------
sys.path.insert(0, str(ROOT))
from generate_flow_diagram import build_diagram_mermaid_only  # noqa: E402


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------
@dataclass
class SessionState:
    session_id: str
    file_path: Path
    entries: list = field(default_factory=list)
    last_line: int = 0
    last_mtime: float = 0.0
    subscribers: list = field(default_factory=list)

    @property
    def is_active(self) -> bool:
        return (time.time() - self.last_mtime) < 300

    def first_ts(self) -> str:
        return self.entries[0]["ts"] if self.entries else ""

    def last_ts(self) -> str:
        return self.entries[-1]["ts"] if self.entries else ""


# ---------------------------------------------------------------------------
# Global shared state (initialised in lifespan)
# ---------------------------------------------------------------------------
_sessions: dict[str, SessionState] = {}
_sessions_lock: asyncio.Lock = None  # type: ignore[assignment]
_global_subscribers: list[asyncio.Queue] = []
_app_loop: asyncio.AbstractEventLoop = None  # type: ignore[assignment]
_last_change: dict[str, float] = {}


# ---------------------------------------------------------------------------
# File parsing (append-only, never re-reads from line 0)
# ---------------------------------------------------------------------------
def _parse_new_lines(session: SessionState) -> list[dict]:
    """
    Read only lines not yet processed (from session.last_line onwards).
    Appends new entries to session.entries. Updates last_line and last_mtime.
    Returns the list of newly parsed entries.
    """
    new_entries = []
    try:
        with open(session.file_path, encoding="utf-8") as f:
            lines = f.readlines()
        for i in range(session.last_line, len(lines)):
            raw = lines[i].strip()
            if not raw:
                continue
            try:
                new_entries.append(json.loads(raw))
            except json.JSONDecodeError:
                pass  # partial write — skipped safely
        session.entries.extend(new_entries)
        session.last_line = len(lines)
        session.last_mtime = session.file_path.stat().st_mtime
    except (OSError, IOError):
        pass
    return new_entries


def _load_session(path: Path) -> SessionState:
    """Cold-load a full session file (called once per file at startup)."""
    s = SessionState(session_id=path.stem, file_path=path)
    _parse_new_lines(s)
    return s


# ---------------------------------------------------------------------------
# Async file change processor (called from watchdog thread via run_coroutine_threadsafe)
# ---------------------------------------------------------------------------
async def _process_file_change(path: Path) -> None:
    is_new = path.stem not in _sessions

    async with _sessions_lock:
        if path.stem not in _sessions:
            _sessions[path.stem] = SessionState(session_id=path.stem, file_path=path)

        session = _sessions[path.stem]
        new_entries = _parse_new_lines(session)

        for entry in new_entries:
            for q in list(session.subscribers):
                try:
                    q.put_nowait(entry)
                except asyncio.QueueFull:
                    pass

    if is_new:
        msg = {"type": "session_new", "session_id": path.stem}
        for q in list(_global_subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass


# ---------------------------------------------------------------------------
# Watchdog handler
# ---------------------------------------------------------------------------
class _LogFileHandler(FileSystemEventHandler):
    DEBOUNCE = 0.05  # seconds

    def _handle(self, path_str: str) -> None:
        if not path_str.endswith(".jsonl"):
            return
        now = time.monotonic()
        if now - _last_change.get(path_str, 0) < self.DEBOUNCE:
            return
        _last_change[path_str] = now
        asyncio.run_coroutine_threadsafe(
            _process_file_change(Path(path_str)), _app_loop
        )

    def on_created(self, event):
        if not event.is_directory:
            self._handle(event.src_path)

    def on_modified(self, event):
        if not event.is_directory:
            self._handle(event.src_path)


# ---------------------------------------------------------------------------
# FastAPI app + lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _sessions_lock, _app_loop

    _sessions_lock = asyncio.Lock()
    _app_loop = asyncio.get_running_loop()

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    for jsonl_file in sorted(LOG_DIR.glob("*.jsonl")):
        s = _load_session(jsonl_file)
        _sessions[s.session_id] = s

    observer = Observer()
    observer.schedule(_LogFileHandler(), str(LOG_DIR), recursive=False)
    observer.start()

    n = len(_sessions)
    hint = " — run Claude Code with hooks active to see data" if n == 0 else ""
    print(f"\nFlow Dashboard starting…")
    print(f"  Log dir  : {LOG_DIR}")
    print(f"  Sessions : {n}{hint}")
    print(f"  URL      : http://localhost:{PORT}")
    print(f"  Stop     : Ctrl+C\n")

    yield

    observer.stop()
    observer.join()


app = FastAPI(lifespan=lifespan)


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
@app.get("/api/sessions")
async def list_sessions():
    async with _sessions_lock:
        result = [
            {
                "session_id": s.session_id,
                "event_count": len(s.entries),
                "first_ts": s.first_ts(),
                "last_ts": s.last_ts(),
                "is_active": s.is_active,
            }
            for s in _sessions.values()
        ]
    result.sort(key=lambda x: x["last_ts"], reverse=True)
    return JSONResponse(result)


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    async with _sessions_lock:
        if session_id not in _sessions:
            return JSONResponse({"error": "not found"}, status_code=404)
        data = list(_sessions[session_id].entries)
    return JSONResponse({"session_id": session_id, "entries": data})


@app.get("/api/sessions/{session_id}/diagram")
async def get_diagram(session_id: str):
    async with _sessions_lock:
        if session_id not in _sessions:
            return JSONResponse({"error": "not found"}, status_code=404)
        entries = list(_sessions[session_id].entries)

    mermaid_src, truncated = build_diagram_mermaid_only(entries, session_id, max_entries=200)
    return JSONResponse({
        "mermaid": mermaid_src,
        "truncated": truncated,
        "total": len(entries),
        "shown": min(len(entries), 200),
    })


# ---------------------------------------------------------------------------
# SSE endpoints
# ---------------------------------------------------------------------------
@app.get("/api/sessions/{session_id}/stream")
async def session_stream(session_id: str):
    async with _sessions_lock:
        if session_id not in _sessions:
            async def _not_found():
                yield {"event": "error", "data": json.dumps({"message": "session not found"})}
            return EventSourceResponse(_not_found())

        session = _sessions[session_id]
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        session.subscribers.append(q)
        existing_count = len(session.entries)

    async def _generator():
        try:
            yield {
                "event": "connected",
                "data": json.dumps({"session_id": session_id, "existing_count": existing_count}),
            }
            while True:
                try:
                    entry = await asyncio.wait_for(q.get(), timeout=25.0)
                    yield {"event": "entry", "data": json.dumps(entry)}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        except asyncio.CancelledError:
            pass
        finally:
            async with _sessions_lock:
                try:
                    session.subscribers.remove(q)
                except ValueError:
                    pass

    return EventSourceResponse(_generator())


@app.get("/api/stream/global")
async def global_stream():
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _global_subscribers.append(q)

    async def _generator():
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25.0)
                    yield {"event": msg["type"], "data": json.dumps(msg)}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        except asyncio.CancelledError:
            pass
        finally:
            try:
                _global_subscribers.remove(q)
            except ValueError:
                pass

    return EventSourceResponse(_generator())


# ---------------------------------------------------------------------------
# Dashboard HTML
# ---------------------------------------------------------------------------
HTML_PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Code Flow Monitor</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <style>
    [x-cloak] { display: none !important; }
    #mermaid-render-target svg { max-width: 100%; height: auto; }
  </style>
</head>
<body class="bg-gray-100 h-screen flex flex-col overflow-hidden"
      x-data="flowDashboard()" x-init="init()" x-cloak>

  <!-- Top bar -->
  <header class="bg-white border-b px-4 py-2 flex items-center gap-3 shrink-0 shadow-sm">
    <span class="font-bold text-gray-800 text-sm tracking-tight">Claude Code Flow Monitor</span>
    <div class="ml-auto flex items-center gap-2">
      <span class="relative flex h-2.5 w-2.5">
        <span x-show="liveConnected"
              class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
        <span :class="liveConnected ? 'bg-green-500' : 'bg-gray-300'"
              class="relative inline-flex rounded-full h-2.5 w-2.5"></span>
      </span>
      <span class="text-xs text-gray-400" x-text="liveConnected ? 'LIVE' : 'disconnected'"></span>
    </div>
  </header>

  <!-- Body -->
  <div class="flex flex-1 overflow-hidden">

    <!-- Sidebar -->
    <aside class="w-64 bg-white border-r flex flex-col shrink-0">
      <div class="px-3 py-2.5 border-b bg-gray-50">
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Sessions</p>
      </div>
      <ul class="flex-1 overflow-y-auto divide-y divide-gray-100">
        <template x-for="s in sessions" :key="s.session_id">
          <li @click="selectSession(s.session_id)"
              :class="s.session_id === activeSessionId
                ? 'bg-blue-50 border-l-2 border-blue-500'
                : 'hover:bg-gray-50 border-l-2 border-transparent cursor-pointer'"
              class="px-3 py-2.5 transition-colors">
            <div class="flex items-center gap-1.5">
              <span class="font-mono text-xs text-gray-700 truncate flex-1"
                    x-text="s.session_id.slice(0,8) + '…'"></span>
              <span x-show="s.is_active"
                    class="text-xs font-bold text-green-600 animate-pulse shrink-0">LIVE</span>
            </div>
            <div class="flex items-center gap-2 mt-0.5">
              <span class="text-xs text-gray-400" x-text="s.event_count + ' events'"></span>
              <span class="text-xs text-gray-300"
                    x-text="s.last_ts ? s.last_ts.slice(11,19) + ' UTC' : ''"></span>
            </div>
          </li>
        </template>
        <li x-show="sessions.length === 0"
            class="px-3 py-4 text-xs text-gray-400 italic">
          No sessions yet.
        </li>
      </ul>
    </aside>

    <!-- Main -->
    <main class="flex-1 flex flex-col overflow-hidden">

      <!-- Tabs -->
      <nav class="bg-white border-b px-4 flex gap-0 shrink-0">
        <button @click="tab = 'diagram'"
                :class="tab==='diagram'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'"
                class="px-4 py-2.5 text-sm font-medium transition-colors">
          Diagram
          <span x-show="diagramStale"
                class="ml-1 px-1.5 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700">
            updating…
          </span>
        </button>
        <button @click="tab = 'events'"
                :class="tab==='events'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'"
                class="px-4 py-2.5 text-sm font-medium transition-colors">
          Events
          <span class="ml-1 text-xs text-gray-400"
                x-text="'(' + entries.length + ')'"></span>
        </button>
      </nav>

      <!-- Diagram tab -->
      <div x-show="tab === 'diagram'" class="flex-1 overflow-auto p-4 bg-gray-50">
        <div x-show="diagramTruncated"
             class="mb-3 px-3 py-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-800">
          Showing last <span x-text="diagramShown"></span> of
          <span x-text="diagramTotal"></span> events
        </div>
        <div x-show="!activeSessionId" class="text-sm text-gray-400 italic p-4">
          Select a session from the sidebar.
        </div>
        <div x-show="activeSessionId && entries.length === 0"
             class="text-sm text-gray-400 italic p-4">
          No events in this session yet.
        </div>
        <div id="mermaid-render-target"
             class="bg-white rounded-lg border shadow-sm p-4 overflow-auto min-h-32"></div>
      </div>

      <!-- Events tab -->
      <div x-show="tab === 'events'" class="flex-1 overflow-auto bg-white">
        <table class="w-full text-xs border-collapse">
          <thead class="bg-gray-50 sticky top-0 shadow-sm">
            <tr>
              <th class="px-3 py-2 text-left font-medium text-gray-500 border-b w-28">Time (UTC)</th>
              <th class="px-3 py-2 text-left font-medium text-gray-500 border-b w-8">Dir</th>
              <th class="px-3 py-2 text-left font-medium text-gray-500 border-b w-28">Tool</th>
              <th class="px-3 py-2 text-left font-medium text-gray-500 border-b">Summary</th>
            </tr>
          </thead>
          <tbody>
            <template x-for="(e, i) in entries" :key="i">
              <tr :class="rowClass(e)" class="border-b transition-colors">
                <td class="px-3 py-1.5 font-mono whitespace-nowrap"
                    x-text="e.ts ? e.ts.slice(11,23) : ''"></td>
                <td class="px-3 py-1.5 text-gray-400"
                    x-text="e.event === 'pre' ? '→' : '←'"></td>
                <td class="px-3 py-1.5 font-semibold" x-text="e.tool"></td>
                <td class="px-3 py-1.5 truncate max-w-xs" x-text="summarise(e)"></td>
              </tr>
            </template>
            <tr x-show="entries.length === 0">
              <td colspan="4" class="px-3 py-4 text-gray-400 italic">No events yet.</td>
            </tr>
          </tbody>
        </table>
      </div>

    </main>
  </div>

<script>
mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });

function flowDashboard() {
  return {
    sessions: [],
    activeSessionId: null,
    entries: [],
    tab: 'diagram',
    liveConnected: false,
    diagramStale: false,
    diagramTruncated: false,
    diagramTotal: 0,
    diagramShown: 0,
    _diagramTimer: null,
    _entryES: null,
    _globalES: null,

    async init() {
      await this.loadSessions();
      this.connectGlobalStream();
      if (this.sessions.length > 0) {
        await this.selectSession(this.sessions[0].session_id);
      }
    },

    async loadSessions() {
      try {
        this.sessions = await fetch('/api/sessions').then(r => r.json());
      } catch (e) {
        console.error('loadSessions failed', e);
      }
    },

    async selectSession(sessionId) {
      if (sessionId === this.activeSessionId) return;
      this.closeEntryStream();
      this.activeSessionId = sessionId;
      this.entries = [];
      this.diagramStale = false;
      clearTimeout(this._diagramTimer);
      document.getElementById('mermaid-render-target').innerHTML = '';

      try {
        const data = await fetch(`/api/sessions/${sessionId}`).then(r => r.json());
        this.entries = data.entries || [];
      } catch (e) {
        console.error('selectSession failed', e);
      }

      await this.refreshDiagram();
      this.connectEntryStream(sessionId);
    },

    connectEntryStream(sessionId) {
      this._entryES = new EventSource(`/api/sessions/${sessionId}/stream`);

      this._entryES.addEventListener('connected', () => {
        this.liveConnected = true;
      });

      this._entryES.addEventListener('entry', (e) => {
        this.entries.push(JSON.parse(e.data));
        this.schedulesDiagramUpdate();
        // Auto-scroll events tab
        if (this.tab === 'events') {
          this.$nextTick(() => {
            const el = document.querySelector('tbody tr:last-child');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        }
      });

      this._entryES.addEventListener('ping', () => {});

      this._entryES.onerror = () => {
        this.liveConnected = false;
        this.closeEntryStream();
        setTimeout(() => {
          if (this.activeSessionId === sessionId) this.connectEntryStream(sessionId);
        }, 3000);
      };
    },

    closeEntryStream() {
      if (this._entryES) {
        this._entryES.close();
        this._entryES = null;
        this.liveConnected = false;
      }
    },

    connectGlobalStream() {
      this._globalES = new EventSource('/api/stream/global');
      this._globalES.addEventListener('session_new', () => this.loadSessions());
      this._globalES.addEventListener('ping', () => {});
    },

    schedulesDiagramUpdate() {
      this.diagramStale = true;
      clearTimeout(this._diagramTimer);
      this._diagramTimer = setTimeout(() => this.refreshDiagram(), 2000);
    },

    async refreshDiagram() {
      if (!this.activeSessionId) return;
      try {
        const data = await fetch(`/api/sessions/${this.activeSessionId}/diagram`).then(r => r.json());
        this.diagramTruncated = data.truncated;
        this.diagramTotal = data.total;
        this.diagramShown = data.shown;
        await this.renderMermaid(data.mermaid);
        this.diagramStale = false;
      } catch (e) {
        console.error('refreshDiagram failed', e);
      }
    },

    async renderMermaid(src) {
      if (!src || !src.trim()) return;
      const container = document.getElementById('mermaid-render-target');

      // Render into hidden staging node to avoid flicker
      const staging = document.createElement('div');
      staging.className = 'mermaid';
      staging.style.cssText = 'visibility:hidden;position:absolute;top:-9999px;left:-9999px';
      staging.textContent = src;
      document.body.appendChild(staging);

      try {
        await mermaid.run({ nodes: [staging] });
        requestAnimationFrame(() => {
          container.innerHTML = staging.innerHTML;
          staging.remove();
        });
      } catch (err) {
        console.error('Mermaid render error', err);
        staging.remove();
      }
    },

    rowClass(e) {
      if (e.tool === 'Agent' && e.event === 'pre')  return 'bg-blue-50 text-blue-900 font-semibold';
      if (e.tool === 'Agent' && e.event === 'post') return 'bg-blue-100 text-blue-700';
      if (e.tool === 'Skill')                        return 'bg-purple-50 text-purple-800';
      if (e.tool === 'SendMessage')                  return 'bg-amber-50 text-amber-800';
      if (e.tool === 'TaskCreate')                   return 'bg-green-50 text-green-800';
      if (['Read','Glob','Grep'].includes(e.tool))   return 'bg-gray-50 text-gray-400';
      return 'bg-white text-gray-700';
    },

    summarise(e) {
      const i = e.input || {};
      switch (e.tool) {
        case 'Agent':       return `[${i.agent||'?'}] ${i.description||''}`;
        case 'Skill':       return `${i.skill||''}${i.args ? ' '+i.args : ''}`;
        case 'SendMessage': return `→ ${i.to||''}: ${(i.message||'').slice(0,80)}`;
        case 'TaskCreate':  return i.title || JSON.stringify(i).slice(0,80);
        case 'Read': case 'Glob': case 'Grep':
          return (i.path||i.file_path||i.pattern||'').split('/').slice(-3).join('/');
        default: return JSON.stringify(i).slice(0,100);
      }
    },
  };
}
</script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return HTMLResponse(HTML_PAGE)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    log_config = uvicorn.config.LOGGING_CONFIG
    log_config["loggers"]["uvicorn.access"]["level"] = "WARNING"

    try:
        uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning", log_config=log_config)
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"\nERROR: Port {PORT} is already in use.")
            print(f"Set FLOW_SERVER_PORT=<other> to use a different port.\n")
            sys.exit(1)
        raise


if __name__ == "__main__":
    main()
```

---

## Verification

After creating all 4 files and installing deps, verify the server starts:

```bash
python3 flow_server.py
```

Expected output:
```
Flow Dashboard starting…
  Log dir  : /path/to/flow-dashboard/flow-logs
  Sessions : 0 — run Claude Code with hooks active to see data
  URL      : http://localhost:7842
  Stop     : Ctrl+C
```

Inject a test event manually to verify the full pipeline:

```bash
mkdir -p flow-logs
echo '{"ts":"2026-04-04T10:00:00+00:00","event":"pre","tool":"Agent","input":{"agent":"Explore","description":"Test event","name":""}}' \
  >> flow-logs/test-session-abc123.jsonl
```

The browser at `http://localhost:7842` should show `test-sessi…` in the sidebar and one blue row in the Events tab within ~1 second. Switching to the Diagram tab should render a Mermaid sequence diagram 2 seconds after the last event.
