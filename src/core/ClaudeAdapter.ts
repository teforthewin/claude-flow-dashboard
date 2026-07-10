import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFile, mergeStats } from './LogParser';
import { LogWatcher } from './LogWatcher';
import type { SourceAdapter, LoadedSession } from './SourceAdapter';

function getProjectName(dirName: string): string {
  return dirName.replace(/^-/, '');
}

// Truncates long free-form text (e.g. a sub-agent's task description) while keeping both
// ends visible, so sessions that share a long common prefix (e.g. the same temp directory
// path) still read as distinct rows in the sidebar instead of all showing the same clipped start.
function middleEllipsis(text: string, max = 90): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 1) / 2);
  return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`;
}

export class ClaudeAdapter implements SourceAdapter {
  readonly source = 'claude' as const;
  private states = new Map<string, LoadedSession>();
  private sessionFilePaths = new Map<string, string>();
  private watcher: LogWatcher | null = null;

  constructor(
    private projectsDir = path.join(os.homedir(), '.claude', 'projects'),
    private teamsDir = path.join(os.homedir(), '.claude', 'teams'),
  ) {}

  isConfigured(): boolean {
    return fs.existsSync(this.projectsDir);
  }

  loadAll(): LoadedSession[] {
    this.states.clear();
    this.sessionFilePaths.clear();
    if (!this.isConfigured()) return [];

    const projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const projDir of projectDirs) {
      const projPath = path.join(this.projectsDir, projDir);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(projPath, { withFileTypes: true });
      } catch {
        continue;
      }

      // Load top-level session files first so parents exist before children link to them
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.flow.jsonl')) {
          this.loadSession(path.join(projPath, entry.name));
        }
      }

      // Then load subagent files nested under <session-uuid>/subagents/
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subagentsDir = path.join(projPath, entry.name, 'subagents');
        if (!fs.existsSync(subagentsDir)) continue;
        try {
          const subFiles = fs.readdirSync(subagentsDir)
            .filter(f => f.endsWith('.jsonl') && !f.endsWith('.flow.jsonl'));
          for (const f of subFiles) {
            this.loadSession(path.join(subagentsDir, f));
          }
        } catch { /* ignore */ }
      }
    }

    this.linkTeamSessions();
    return [...this.states.values()];
  }

  private linkTeamSessions(): void {
    if (!fs.existsSync(this.teamsDir)) return;
    let teamDirs: string[];
    try {
      teamDirs = fs.readdirSync(this.teamsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { return; }

    for (const teamName of teamDirs) {
      const configPath = path.join(this.teamsDir, teamName, 'config.json');
      let leadSessionId: string;
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        leadSessionId = config.leadSessionId;
      } catch { continue; }

      if (!leadSessionId || !this.states.has(leadSessionId)) continue;

      for (const [sessionId, state] of this.states) {
        if (sessionId === leadSessionId) continue;
        if (state.teamName !== teamName || !state.agentName) continue;
        if (!state.parentId) state.parentId = leadSessionId;
        if (!state.agentDescription) state.agentDescription = state.agentName;
      }
    }
  }

  loadSession(filePath: string): void {
    if (filePath.endsWith('.flow.jsonl')) return;
    const sessionId = path.basename(filePath, '.jsonl');
    if (this.states.has(sessionId)) return;

    const dirName = path.basename(path.dirname(filePath));
    let projectDir: string;
    let parentId: string | null = null;
    let agentDescription = '';

    if (dirName === 'subagents') {
      // path: <projects>/<project-dir>/<parent-uuid>/subagents/<agent-id>.jsonl
      const parentUuidPath = path.dirname(path.dirname(filePath));
      parentId = path.basename(parentUuidPath);
      projectDir = path.basename(path.dirname(parentUuidPath));

      const metaPath = filePath.replace('.jsonl', '.meta.json');
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        agentDescription = meta.description || meta.agentType || '';
      } catch { /* ignore */ }
    } else {
      projectDir = dirName;
    }

    const fallbackProject = getProjectName(projectDir);

    let mtime = 0;
    try {
      mtime = fs.statSync(filePath).mtimeMs / 1000;
    } catch { /* ignore */ }

    const result = parseFile(filePath, 0);
    // cwd is the real, unambiguous filesystem path recorded on every transcript line.
    // The on-disk project directory name only approximates it (Claude Code replaces both
    // '/' and '.' with '-' when encoding the path), which is ambiguous to reverse once the
    // real path itself contains hyphens (e.g. "agent-flow-front", "AI-benchmark").
    const project = (result.cwd ? result.cwd.replace(/^\//, '') : '') || fallbackProject;
    const firstPrompt = result.entries.find(e => e.event === 'prompt' && e.tool === 'User');
    const baseTitle = firstPrompt?.cmd || result.teamTask || result.agentSetting || middleEllipsis(agentDescription);
    const title = result.agentName && baseTitle
      ? `[${result.agentName}] ${baseTitle}`
      : result.agentName || baseTitle;

    const state: LoadedSession = {
      sessionId,
      source: 'claude',
      project,
      entries: result.entries,
      stats: result.stats,
      lastCursor: result.lastLine,
      lastMtime: mtime,
      parentId,
      agentDescription,
      title,
      teamName: result.teamName,
      agentName: result.agentName,
      attributionSkill: result.attributionSkill,
      attributionAgent: result.attributionAgent,
      attributionPlugin: result.attributionPlugin,
      model: result.model,
      modelCounts: result.modelCounts,
      readOnly: false,
      origin: filePath,
    };
    this.states.set(sessionId, state);
    this.sessionFilePaths.set(sessionId, filePath);
  }

  processNewLines(filePath: string): void {
    const sessionId = path.basename(filePath, '.jsonl');

    if (!this.states.has(sessionId)) {
      this.loadSession(filePath);
      return;
    }

    const state = this.states.get(sessionId)!;
    const result = parseFile(filePath, state.lastCursor);

    if (!result.entries.length) return;

    state.entries = [...state.entries, ...result.entries];
    state.stats = mergeStats(state.stats, result.stats);
    state.lastCursor = result.lastLine;
    if (!state.attributionSkill && result.attributionSkill) state.attributionSkill = result.attributionSkill;
    if (!state.attributionAgent && result.attributionAgent) state.attributionAgent = result.attributionAgent;
    if (!state.attributionPlugin && result.attributionPlugin) state.attributionPlugin = result.attributionPlugin;
    if (result.modelCounts) {
      for (const [m, c] of Object.entries(result.modelCounts)) {
        state.modelCounts[m] = (state.modelCounts[m] || 0) + c;
      }
      let bestModel = state.model, bestCount = state.modelCounts[bestModel] || 0;
      for (const [m, c] of Object.entries(state.modelCounts)) {
        if (c > bestCount) { bestModel = m; bestCount = c; }
      }
      state.model = bestModel;
    }
    if (!state.title) {
      const firstPrompt = state.entries.find(e => e.event === 'prompt' && e.tool === 'User');
      state.title = firstPrompt?.cmd || result.agentSetting || result.agentName || '';
    }

    try {
      state.lastMtime = fs.statSync(filePath).mtimeMs / 1000;
    } catch { /* ignore */ }
  }

  reload(sessionId: string, cursor: number): LoadedSession | null {
    const filePath = this.sessionFilePaths.get(sessionId);
    if (!filePath) return null;
    if (cursor === 0) {
      this.states.delete(sessionId);
      this.loadSession(filePath);
    } else {
      this.processNewLines(filePath);
    }
    return this.states.get(sessionId) ?? null;
  }

  watch(onChange: (sessionId: string) => void): () => void {
    this.watcher = new LogWatcher(
      {
        loadSession: (filePath: string) => {
          this.loadSession(filePath);
          onChange(path.basename(filePath, '.jsonl'));
        },
        processNewLines: (filePath: string) => {
          this.processNewLines(filePath);
          onChange(path.basename(filePath, '.jsonl'));
        },
      },
      this.projectsDir,
    );
    this.watcher.start();
    return () => {
      this.watcher?.stop();
      this.watcher = null;
    };
  }

  stop(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  getFilePath(sessionId: string): string | undefined {
    return this.sessionFilePaths.get(sessionId);
  }
}
