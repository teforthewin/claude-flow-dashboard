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
