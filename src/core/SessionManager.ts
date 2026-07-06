import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import archiver from 'archiver';
import { parseFile, mergeStats, AppEntry, Stats, TokenCounts } from './LogParser';
import { buildBpmnPhases, BpmnProcess } from './BpmnBuilder';

export interface SessionState {
  sessionId: string;
  project: string;
  filePath: string;
  entries: AppEntry[];
  stats: Stats;
  lastLine: number;
  lastMtime: number;
  parentId: string | null;
  childIds: string[];
  agentDescription: string;
  title: string;
  teamName: string;
  agentName: string;
  attributionSkill: string;
  attributionAgent: string;
  attributionPlugin: string;
  model: string;
  modelCounts: Record<string, number>;
}

export interface SessionInfo {
  session_id: string;
  project: string;
  event_count: number;
  first_ts: string;
  last_ts: string;
  is_active: boolean;
  parent_id: string | null;
  child_ids: string[];
  agent_description: string;
  title: string;
  team_name: string;
  agent_name: string;
  attribution_skill: string;
  attribution_agent: string;
  attribution_plugin: string;
  model: string;
  model_counts: Record<string, number>;
}

export interface SessionSummary {
  session_id: string;
  project: string;
  title: string;
  model: string;
  model_counts: Record<string, number>;
  start_ts: string;
  stop_ts: string;
  duration_ms: number;
  duration_human: string;
  tokens: TokenCounts;
  tools: Record<string, number>;
  bpmn: BpmnProcess;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function getProjectName(dirName: string): string {
  return dirName.replace(/^-/, '');
}

function isActive(lastMtime: number): boolean {
  return (Date.now() / 1000 - lastMtime) < 300;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, SessionState>();

  constructor(
    private projectsDir = path.join(os.homedir(), '.claude', 'projects'),
    private teamsDir = path.join(os.homedir(), '.claude', 'teams'),
  ) {
    super();
  }

  async loadAll(): Promise<void> {
    if (!fs.existsSync(this.projectsDir)) return;

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

      if (!leadSessionId || !this.sessions.has(leadSessionId)) continue;
      const leadState = this.sessions.get(leadSessionId)!;

      for (const [sessionId, state] of this.sessions) {
        if (sessionId === leadSessionId) continue;
        if (state.teamName !== teamName || !state.agentName) continue;
        if (!state.parentId) state.parentId = leadSessionId;
        if (!state.agentDescription) state.agentDescription = state.agentName;
        if (!leadState.childIds.includes(sessionId)) {
          leadState.childIds.push(sessionId);
        }
      }
    }
  }

  loadSession(filePath: string): void {
    if (filePath.endsWith('.flow.jsonl')) return;
    const sessionId = path.basename(filePath, '.jsonl');
    if (this.sessions.has(sessionId)) return;

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

    const project = getProjectName(projectDir);

    let mtime = 0;
    try {
      mtime = fs.statSync(filePath).mtimeMs / 1000;
    } catch { /* ignore */ }

    const result = parseFile(filePath, 0);
    const firstPrompt = result.entries.find(e => e.event === 'prompt' && e.tool === 'User');
    const baseTitle = firstPrompt?.cmd || result.teamTask || result.agentSetting || agentDescription;
    const title = result.agentName && baseTitle
      ? `[${result.agentName}] ${baseTitle}`
      : result.agentName || baseTitle;
    const state: SessionState = {
      sessionId,
      project,
      filePath,
      entries: result.entries,
      stats: result.stats,
      lastLine: result.lastLine,
      lastMtime: mtime,
      parentId,
      childIds: [],
      agentDescription,
      title,
      teamName: result.teamName,
      agentName: result.agentName,
      attributionSkill: result.attributionSkill,
      attributionAgent: result.attributionAgent,
      attributionPlugin: result.attributionPlugin,
      model: result.model,
      modelCounts: result.modelCounts,
    };
    this.sessions.set(sessionId, state);

    if (parentId) {
      const parentState = this.sessions.get(parentId);
      if (parentState && !parentState.childIds.includes(sessionId)) {
        parentState.childIds.push(sessionId);
      }
    }

    this.emit('session:new', sessionId);
  }

  processNewLines(filePath: string): void {
    const sessionId = path.basename(filePath, '.jsonl');

    if (!this.sessions.has(sessionId)) {
      this.loadSession(filePath);
      return;
    }

    const state = this.sessions.get(sessionId)!;
    const result = parseFile(filePath, state.lastLine);

    if (!result.entries.length) return;

    state.entries = [...state.entries, ...result.entries];
    state.stats = mergeStats(state.stats, result.stats);
    state.lastLine = result.lastLine;
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

    for (const entry of result.entries) {
      this.emit('session:entry', sessionId, entry);
    }
  }

  getSessionList(): SessionInfo[] {
    const list: SessionInfo[] = [];
    for (const state of this.sessions.values()) {
      list.push({
        session_id: state.sessionId,
        project: state.project,
        event_count: state.entries.length,
        first_ts: state.entries.find(e => e.ts)?.ts || '',
        last_ts: [...state.entries].reverse().find(e => e.ts)?.ts || '',
        is_active: isActive(state.lastMtime),
        parent_id: state.parentId,
        child_ids: [...state.childIds],
        agent_description: state.agentDescription,
        title: state.title,
        team_name: state.teamName,
        agent_name: state.agentName,
        attribution_skill: state.attributionSkill,
        attribution_agent: state.attributionAgent,
        attribution_plugin: state.attributionPlugin,
        model: state.model,
        model_counts: state.modelCounts,
      });
    }
    return list.sort((a, b) => b.last_ts.localeCompare(a.last_ts));
  }

  async reload(): Promise<void> {
    this.sessions.clear();
    await this.loadAll();
    this.emit('sessions:updated');
  }

  getSession(sessionId: string): { session_id: string; entries: AppEntry[] } | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return { session_id: sessionId, entries: state.entries };
  }

  getTeamFilePaths(teamName: string, leadSessionId?: string | null): string[] {
    const paths: string[] = [];
    for (const state of this.sessions.values()) {
      if (state.teamName === teamName || (leadSessionId && state.sessionId === leadSessionId)) {
        paths.push(state.filePath);
      }
    }
    return paths;
  }

  getStats(sessionId: string): Stats | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return state.stats;
  }

  getSummary(sessionId: string): SessionSummary | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const startTs = state.entries.find(e => e.ts)?.ts || '';
    const stopTs = [...state.entries].reverse().find(e => e.ts)?.ts || '';
    const durationMs = startTs && stopTs
      ? Math.max(0, new Date(stopTs).getTime() - new Date(startTs).getTime())
      : 0;
    return {
      session_id: state.sessionId,
      project: state.project,
      title: state.title,
      model: state.model,
      model_counts: state.modelCounts,
      start_ts: startTs,
      stop_ts: stopTs,
      duration_ms: durationMs,
      duration_human: formatDuration(durationMs),
      tokens: state.stats.tokens,
      tools: state.stats.tools,
      bpmn: buildBpmnPhases(state.entries, state.title || state.sessionId),
    };
  }

  deleteSessions(ids: string[]): void {
    for (const id of ids) {
      const state = this.sessions.get(id);
      if (!state) continue;
      if (state.parentId) {
        const parent = this.sessions.get(state.parentId);
        if (parent) parent.childIds = parent.childIds.filter(c => c !== id);
      }
      for (const childId of state.childIds) {
        const child = this.sessions.get(childId);
        if (child) child.parentId = null;
      }
      this.sessions.delete(id);
      try {
        fs.unlinkSync(state.filePath);
      } catch { /* ignore if already gone */ }
    }
  }

  archiveSessions(ids: string[], outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        for (const id of ids) {
          const state = this.sessions.get(id);
          if (!state) continue;
          if (state.parentId) {
            const parent = this.sessions.get(state.parentId);
            if (parent) parent.childIds = parent.childIds.filter(c => c !== id);
          }
          for (const childId of state.childIds) {
            const child = this.sessions.get(childId);
            if (child) child.parentId = null;
          }
          this.sessions.delete(id);
          try { fs.unlinkSync(state.filePath); } catch { /* ignore */ }
        }
        resolve();
      });

      archive.on('error', reject);
      archive.pipe(output);

      for (const id of ids) {
        const state = this.sessions.get(id);
        if (!state) continue;
        const projectDir = path.basename(path.dirname(state.filePath));
        archive.file(state.filePath, { name: `${projectDir}/${path.basename(state.filePath)}` });
      }

      archive.finalize();
    });
  }
}
