import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { AppEntry, Stats, TokenCounts } from './LogParser';
import { buildBpmnPhases, BpmnProcess } from './BpmnBuilder';
import type { SourceAdapter, SessionSource, LoadedSession } from './SourceAdapter';

export interface SessionState {
  sessionId: string;
  source: SessionSource;
  project: string;
  origin: string;
  entries: AppEntry[];
  stats: Stats;
  lastCursor: number;
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
  readOnly: boolean;
}

export interface SessionInfo {
  session_id: string;
  source: SessionSource;
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
  read_only: boolean;
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

function isActive(lastMtime: number): boolean {
  return (Date.now() / 1000 - lastMtime) < 300;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, SessionState>();
  private disposers: Array<() => void> = [];

  constructor(private adapters: SourceAdapter[]) {
    super();
  }

  private ingest(loaded: LoadedSession): void {
    this.sessions.set(loaded.sessionId, {
      sessionId: loaded.sessionId,
      source: loaded.source,
      project: loaded.project,
      origin: loaded.origin,
      entries: loaded.entries,
      stats: loaded.stats,
      lastCursor: loaded.lastCursor,
      lastMtime: loaded.lastMtime,
      parentId: loaded.parentId,
      childIds: this.sessions.get(loaded.sessionId)?.childIds ?? [],
      agentDescription: loaded.agentDescription,
      title: loaded.title,
      teamName: loaded.teamName,
      agentName: loaded.agentName,
      attributionSkill: loaded.attributionSkill,
      attributionAgent: loaded.attributionAgent,
      attributionPlugin: loaded.attributionPlugin,
      model: loaded.model,
      modelCounts: loaded.modelCounts,
      readOnly: loaded.readOnly,
    });
  }

  private recomputeChildIds(): void {
    for (const s of this.sessions.values()) s.childIds = [];
    for (const s of this.sessions.values()) {
      if (s.parentId && this.sessions.has(s.parentId)) {
        this.sessions.get(s.parentId)!.childIds.push(s.sessionId);
      }
    }
  }

  private onAdapterChange(adapter: SourceAdapter, sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    const isNew = !existing;
    const loaded = adapter.reload(sessionId, isNew ? 0 : existing.lastCursor);
    if (!loaded) return;
    const prevCount = existing?.entries.length ?? 0;
    this.ingest(loaded);
    this.recomputeChildIds();
    if (isNew) {
      this.emit('session:new', sessionId);
    } else {
      const newEntries = loaded.entries.slice(prevCount);
      for (const entry of newEntries) this.emit('session:entry', sessionId, entry);
    }
  }

  async loadAll(): Promise<void> {
    this.sessions.clear();
    for (const adapter of this.adapters) {
      if (!adapter.isConfigured()) continue;
      const loaded = await adapter.loadAll();
      for (const l of loaded) this.ingest(l);
    }
    this.recomputeChildIds();
  }

  startWatchers(): void {
    for (const adapter of this.adapters) {
      if (!adapter.isConfigured()) continue;
      const dispose = adapter.watch((sessionId) => this.onAdapterChange(adapter, sessionId));
      this.disposers.push(dispose);
    }
  }

  stopWatchers(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    for (const adapter of this.adapters) adapter.stop();
  }

  async reload(): Promise<void> {
    await this.loadAll();
    this.emit('sessions:updated');
  }

  getSessionList(): SessionInfo[] {
    const list: SessionInfo[] = [];
    for (const state of this.sessions.values()) {
      list.push({
        session_id: state.sessionId,
        source: state.source,
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
        read_only: state.readOnly,
      });
    }
    return list.sort((a, b) => b.last_ts.localeCompare(a.last_ts));
  }

  getSession(sessionId: string): { session_id: string; entries: AppEntry[] } | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return { session_id: sessionId, entries: state.entries };
  }

  getTeamFilePaths(teamName: string, leadSessionId?: string | null): string[] {
    const paths: string[] = [];
    for (const state of this.sessions.values()) {
      if (state.readOnly) continue;
      if (state.teamName === teamName || (leadSessionId && state.sessionId === leadSessionId)) {
        paths.push(state.origin);
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
      if (!state || state.readOnly) continue;
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
        fs.unlinkSync(state.origin);
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
          if (!state || state.readOnly) continue;
          if (state.parentId) {
            const parent = this.sessions.get(state.parentId);
            if (parent) parent.childIds = parent.childIds.filter(c => c !== id);
          }
          for (const childId of state.childIds) {
            const child = this.sessions.get(childId);
            if (child) child.parentId = null;
          }
          this.sessions.delete(id);
          try { fs.unlinkSync(state.origin); } catch { /* ignore */ }
        }
        resolve();
      });

      archive.on('error', reject);
      archive.pipe(output);

      const archivable = ids
        .map(id => this.sessions.get(id))
        .filter((s): s is SessionState => !!s && !s.readOnly);

      for (const state of archivable) {
        const projectDir = path.basename(path.dirname(state.origin));
        archive.file(state.origin, { name: `${projectDir}/${path.basename(state.origin)}` });
      }

      archive.finalize();
    });
  }
}
