import chokidar, { FSWatcher } from 'chokidar';
import path from 'path';
import os from 'os';
import { SessionManager } from './SessionManager';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEBOUNCE_MS = 50;

export class LogWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private manager: SessionManager) {}

  start(): void {
    this.watcher = chokidar.watch(`${CLAUDE_PROJECTS_DIR}/**/*.jsonl`, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    this.watcher.on('add', (filePath) => {
      this.manager.loadSession(filePath);
    });

    this.watcher.on('change', (filePath) => {
      const existing = this.debounceTimers.get(filePath);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this.manager.processNewLines(filePath);
      }, DEBOUNCE_MS);
      this.debounceTimers.set(filePath, timer);
    });
  }

  stop(): void {
    this.watcher?.close();
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }
}
