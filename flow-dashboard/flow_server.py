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
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from sse_starlette.sse import EventSourceResponse
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

# ---------------------------------------------------------------------------
# Paths and config
# ---------------------------------------------------------------------------
ROOT = Path(__file__).parent
LOG_DIR = Path(os.environ.get("FLOW_LOG_DIR", Path.home() / ".claude" / "flow-logs"))
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
    project: str = ""
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


def _project_from_path(file_path: Path) -> str:
    """Derive the project name from the JSONL file's parent directory."""
    parent = file_path.parent.name
    # If the file is directly in LOG_DIR (no project subfolder), return empty
    if file_path.parent == LOG_DIR:
        return ""
    return parent


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


def _session_key(path: Path) -> str:
    """Composite key: project/session_id (unique across projects)."""
    project = _project_from_path(path)
    return f"{project}/{path.stem}" if project else path.stem


def _load_session(path: Path) -> SessionState:
    """Cold-load a full session file (called once per file at startup)."""
    key = _session_key(path)
    s = SessionState(session_id=key, file_path=path, project=_project_from_path(path))
    _parse_new_lines(s)
    return s


# ---------------------------------------------------------------------------
# Async file change processor (called from watchdog thread via run_coroutine_threadsafe)
# ---------------------------------------------------------------------------
async def _process_file_change(path: Path) -> None:
    key = _session_key(path)
    is_new = key not in _sessions

    async with _sessions_lock:
        if key not in _sessions:
            _sessions[key] = SessionState(
                session_id=key, file_path=path,
                project=_project_from_path(path),
            )

        session = _sessions[key]
        new_entries = _parse_new_lines(session)

        for entry in new_entries:
            for q in list(session.subscribers):
                try:
                    q.put_nowait(entry)
                except asyncio.QueueFull:
                    pass

    if is_new:
        msg = {"type": "session_new", "session_id": key}
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
    for jsonl_file in sorted(LOG_DIR.glob("**/*.jsonl")):
        s = _load_session(jsonl_file)
        _sessions[s.session_id] = s

    observer = Observer()
    observer.schedule(_LogFileHandler(), str(LOG_DIR), recursive=True)
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
# Claude session stats (reads native ~/.claude session JSONL)
# ---------------------------------------------------------------------------
def _read_claude_session_stats(session_id: str) -> dict:
    """
    Read token usage, all-tool breakdown, and child sessions from Claude's
    own session JSONL at ~/.claude/projects/**/<session_id>.jsonl.
    Returns {} when no matching file is found.
    """
    # session_id may be composite "project/uuid" — extract the raw UUID
    raw_id = session_id.rsplit("/", 1)[-1] if "/" in session_id else session_id

    claude_home = Path.home() / ".claude" / "projects"
    if not claude_home.exists():
        return {}

    session_file: Path | None = None
    for project_dir in claude_home.iterdir():
        if not project_dir.is_dir():
            continue
        candidate = project_dir / f"{raw_id}.jsonl"
        if candidate.exists():
            session_file = candidate
            break

    if not session_file:
        return {}

    tokens: dict[str, int] = {"input": 0, "output": 0, "cache_read": 0, "cache_create": 0}
    tools: dict[str, int] = {}
    timeline: list[dict] = []

    try:
        with open(session_file, encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    entry = json.loads(raw)
                except Exception:
                    continue
                msg = entry.get("message", {})
                if not isinstance(msg, dict):
                    continue
                usage = msg.get("usage", {})
                inp    = usage.get("input_tokens", 0)
                out    = usage.get("output_tokens", 0)
                cr     = usage.get("cache_read_input_tokens", 0)
                cc     = usage.get("cache_creation_input_tokens", 0)
                tokens["input"]        += inp
                tokens["output"]       += out
                tokens["cache_read"]   += cr
                tokens["cache_create"] += cc
                content = msg.get("content", [])
                tool_names_in_msg: list[str] = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        name = block.get("name", "unknown")
                        tools[name] = tools.get(name, 0) + 1
                        tool_names_in_msg.append(name)
                # Collect per-message timeline (only when tokens were consumed)
                if msg.get("role") == "assistant" and (inp or out or cr or cc):
                    timeline.append({
                        "ts":          entry.get("timestamp", ""),
                        "input":       inp,
                        "output":      out,
                        "cache_read":  cr,
                        "cache_create": cc,
                        "tools":       tool_names_in_msg,
                    })
    except Exception:
        return {}

    # Child sessions (subagents spawned during this session)
    children: list[dict] = []
    subagents_dir = session_file.parent / "subagents"
    if subagents_dir.exists():
        for meta_path in sorted(subagents_dir.glob("*.meta.json")):
            try:
                with open(meta_path, encoding="utf-8") as f:
                    meta = json.load(f)
                children.append({
                    "agent_id":   meta_path.stem,
                    "agent_type": meta.get("agentType", ""),
                    "description": meta.get("description", ""),
                })
            except Exception:
                pass

    return {"tokens": tokens, "tools": tools, "child_sessions": children, "timeline": timeline}


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
@app.get("/api/sessions")
async def list_sessions():
    async with _sessions_lock:
        result = [
            {
                "session_id": s.session_id,
                "project": s.project,
                "event_count": len(s.entries),
                "first_ts": s.first_ts(),
                "last_ts": s.last_ts(),
                "is_active": s.is_active,
            }
            for s in _sessions.values()
        ]
    result.sort(key=lambda x: x["last_ts"], reverse=True)
    return JSONResponse(result)


@app.get("/api/sessions/{session_id:path}/diagram")
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


@app.get("/api/sessions/{session_id:path}/stats")
async def get_session_stats(session_id: str):
    async with _sessions_lock:
        if session_id not in _sessions:
            return JSONResponse({"error": "not found"}, status_code=404)
    loop = asyncio.get_event_loop()
    stats = await loop.run_in_executor(None, _read_claude_session_stats, session_id)
    return JSONResponse(stats)


# ---------------------------------------------------------------------------
# SSE endpoints
# ---------------------------------------------------------------------------
@app.get("/api/sessions/{session_id:path}/stream")
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
            # Send connected event so the browser refreshes sessions on (re)connect
            yield {"event": "connected", "data": json.dumps({"sessions": len(_sessions)})}
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


@app.delete("/api/sessions/{session_id:path}")
async def delete_session(session_id: str):
    async with _sessions_lock:
        if session_id not in _sessions:
            return JSONResponse({"error": "not found"}, status_code=404)
        session = _sessions.pop(session_id)
    try:
        session.file_path.unlink(missing_ok=True)
    except OSError:
        pass
    return JSONResponse({"deleted": session_id})


@app.post("/api/sessions/delete-batch")
async def delete_sessions_batch(request: Request):
    body = await request.json()
    ids = body.get("session_ids", [])
    deleted = []
    async with _sessions_lock:
        for sid in ids:
            if sid in _sessions:
                session = _sessions.pop(sid)
                try:
                    session.file_path.unlink(missing_ok=True)
                except OSError:
                    pass
                deleted.append(sid)
    return JSONResponse({"deleted": deleted})


# NOTE: this catch-all :path route MUST be after /diagram, /stats, /stream, /delete-batch
@app.get("/api/sessions/{session_id:path}")
async def get_session(session_id: str):
    async with _sessions_lock:
        if session_id not in _sessions:
            return JSONResponse({"error": "not found"}, status_code=404)
        data = list(_sessions[session_id].entries)
    return JSONResponse({"session_id": session_id, "entries": data})


# ---------------------------------------------------------------------------
# Dashboard — serves static/index.html (unified Vue 3 UI)
# ---------------------------------------------------------------------------
STATIC_DIR = ROOT / "static"


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return FileResponse(STATIC_DIR / "index.html")


# Backwards-compat: /cyber now redirects to /
@app.get("/cyber", response_class=HTMLResponse)
async def cyber_redirect():
    return FileResponse(STATIC_DIR / "index.html")


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
