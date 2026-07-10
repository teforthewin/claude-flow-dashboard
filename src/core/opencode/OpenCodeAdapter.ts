import fs from 'fs';
import Database from 'better-sqlite3';
import type { SourceAdapter, LoadedSession } from '../SourceAdapter';
import { parseOpenCodeSession } from './parseOpenCodeSession';
import { OpenCodeWatcher } from './OpenCodeWatcher';

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  model: string | null;
  time_created: number;
  time_updated: number;
}

const SESSION_COLUMNS = 'id, parent_id, directory, title, model, time_created, time_updated';

function extractModelId(raw: string | null): string {
  if (!raw) return '';
  try {
    const m = JSON.parse(raw);
    return m?.id || '';
  } catch {
    return '';
  }
}

export class OpenCodeAdapter implements SourceAdapter {
  readonly source = 'opencode' as const;
  private db: Database.Database | null = null;
  private watcher: OpenCodeWatcher | null = null;

  constructor(private dbPath: string, private enabled: boolean) {}

  isConfigured(): boolean {
    return this.enabled && fs.existsSync(this.dbPath);
  }

  // Read-only, never writes — respects an opencode process holding the DB open with WAL.
  private getDb(): Database.Database {
    if (!this.db) {
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    }
    return this.db;
  }

  private loadOne(row: SessionRow): LoadedSession {
    const parsed = parseOpenCodeSession(this.getDb(), row.id);
    return {
      sessionId: row.id,
      source: 'opencode',
      project: (row.directory || '').replace(/^\//, ''),
      entries: parsed.entries,
      stats: parsed.stats,
      lastCursor: row.time_updated,
      lastMtime: row.time_updated / 1000,
      parentId: row.parent_id,
      agentDescription: '',
      title: row.title || '',
      teamName: '',
      agentName: '',
      attributionSkill: '',
      attributionAgent: '',
      attributionPlugin: '',
      model: parsed.model || extractModelId(row.model),
      modelCounts: parsed.modelCounts,
      readOnly: true,
      origin: `${this.dbPath}#${row.id}`,
    };
  }

  loadAll(): LoadedSession[] {
    if (!this.isConfigured()) return [];
    const rows = this.getDb().prepare(`SELECT ${SESSION_COLUMNS} FROM session`).all() as SessionRow[];
    return rows.map((row) => this.loadOne(row));
  }

  reload(sessionId: string): LoadedSession | null {
    if (!this.isConfigured()) return null;
    const row = this.getDb()
      .prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return this.loadOne(row);
  }

  watch(onChange: (sessionId: string) => void): () => void {
    if (!this.isConfigured()) return () => {};
    this.watcher = new OpenCodeWatcher(this.dbPath, () => this.getDb(), onChange);
    this.watcher.start();
    return () => {
      this.watcher?.stop();
      this.watcher = null;
    };
  }

  stop(): void {
    this.watcher?.stop();
    this.watcher = null;
    this.db?.close();
    this.db = null;
  }
}
