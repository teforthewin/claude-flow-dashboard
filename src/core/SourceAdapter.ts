import type { AppEntry, Stats } from './LogParser';

export type SessionSource = 'claude' | 'opencode';

export interface LoadedSession {
  sessionId: string;
  source: SessionSource;
  project: string;
  entries: AppEntry[];
  stats: Stats;
  lastCursor: number;
  lastMtime: number;
  parentId: string | null;
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
  origin: string;
}

export interface SourceAdapter {
  readonly source: SessionSource;
  isConfigured(): boolean;
  loadAll(): LoadedSession[] | Promise<LoadedSession[]>;
  reload(sessionId: string, cursor: number): LoadedSession | null;
  watch(onChange: (sessionId: string) => void): () => void;
  stop(): void;
}
