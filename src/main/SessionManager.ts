import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import archiver from 'archiver';
import { parseFile, mergeStats, AppEntry, Stats } from './LogParser';

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
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_TEAMS_DIR = path.join(os.homedir(), '.claude', 'teams');

function getProjectName(dirName: string): string {
  return dirName.replace(/^-/, '');
}

function isActive(lastMtime: number): boolean {
  return (Date.now() / 1000 - lastMtime) < 300;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, SessionState>();

  async loadAll(): Promise<void> {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return;

    const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const projDir of projectDirs) {
      const projPath = path.join(CLAUDE_PROJECTS_DIR, projDir);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(projPath, { withFileTypes: true });
      } catch {
        continue;
      }

      // Load top-level session files first so parents exist before children link to them
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.endsWith('.jsonl')) {
          this.loadSession(path.join(projPath, entry.name));
        }
      }

      // Then load subagent files nested under <session-uuid>/subagents/
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subagentsDir = path.join(projPath, entry.name, 'subagents');
        if (!fs.existsSync(subagentsDir)) continue;
        try {
          const subFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
          for (const f of subFiles) {
            this.loadSession(path.join(subagentsDir, f));
          }
        } catch { /* ignore */ }
      }
    }

    this.linkTeamSessions();
  }

  private linkTeamSessions(): void {
    if (!fs.existsSync(CLAUDE_TEAMS_DIR)) return;
    let teamDirs: string[];
    try {
      teamDirs = fs.readdirSync(CLAUDE_TEAMS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { return; }

    for (const teamName of teamDirs) {
      const configPath = path.join(CLAUDE_TEAMS_DIR, teamName, 'config.json');
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
