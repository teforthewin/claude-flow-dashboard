import chokidar, { FSWatcher } from 'chokidar';
import type Database from 'better-sqlite3';

const DEBOUNCE_MS = 300;

// SQLite has no per-row change-notification, so unlike LogWatcher (which reacts to
// jsonl line growth) this diffs session.time_updated against a last-seen watermark
// on every debounced db/db-wal write and reports advanced sessions.
export class OpenCodeWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSeen = new Map<string, number>();

  constructor(
    private dbPath: string,
    private getDb: () => Database.Database,
    private onChange: (sessionId: string) => void,
  ) {}

  start(): void {
    try {
      const rows = this.getDb().prepare('SELECT id, time_updated FROM session').all() as Array<{
        id: string;
        time_updated: number;
      }>;
      for (const r of rows) this.lastSeen.set(r.id, r.time_updated);
    } catch { /* ignore */ }

    this.watcher = chokidar.watch([this.dbPath, `${this.dbPath}-wal`], {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher.on('add', () => this.scheduleScan());
    this.watcher.on('change', () => this.scheduleScan());
  }

  private scheduleScan(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scan();
    }, DEBOUNCE_MS);
  }

  private scan(): void {
    let rows: Array<{ id: string; time_updated: number }>;
    try {
      rows = this.getDb().prepare('SELECT id, time_updated FROM session').all() as Array<{
        id: string;
        time_updated: number;
      }>;
    } catch {
      return;
    }
    for (const row of rows) {
      const prev = this.lastSeen.get(row.id);
      if (prev === undefined || row.time_updated > prev) {
        this.lastSeen.set(row.id, row.time_updated);
        this.onChange(row.id);
      }
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
