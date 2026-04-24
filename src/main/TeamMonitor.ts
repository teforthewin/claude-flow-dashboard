import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import chokidar, { FSWatcher } from 'chokidar';

export interface TeamMessage {
  from: string;
  to: string;
  timestamp: string;
  color: string;
  read: boolean;
  isStructured: boolean;
  structuredType: string | null;
  label: string;
  payload: Record<string, unknown> | null;
  text: string;
}

export interface TeamMember {
  agentId: string;
  name: string;
  color: string;
  isActive: boolean;
  model: string;
  unreadCount: number;
}

export interface TeamInfo {
  name: string;
  description: string;
  leadAgentId: string;
  leadSessionId: string;
  isActive: boolean;
  members: TeamMember[];
  messageCount: number;
  lastActivityTs: string | null;
}

interface RawMessage {
  from: string;
  text: string;
  summary?: string;
  timestamp: string;
  color?: string;
  read?: boolean;
}

interface TeamConfig {
  description?: string;
  leadAgentId?: string;
  leadSessionId?: string;
  status?: string;
  active?: boolean;
  revokedAt?: string | number;
  disbanded?: boolean;
  members?: Array<{
    agentId: string;
    name?: string;
    color?: string;
    isActive?: boolean;
    model?: string;
  }>;
}

interface TeamState {
  name: string;
  config: TeamConfig;
  inboxes: Map<string, TeamMessage[]>;
}

const COLOR_MAP: Record<string, string> = {
  blue: '#2563eb', green: '#16a34a', yellow: '#ca8a04', purple: '#7c3aed',
  orange: '#d97706', pink: '#db2777', cyan: '#0891b2', red: '#dc2626',
};

function colorToCss(color: string | undefined): string {
  return COLOR_MAP[color || ''] || '#94a3b8';
}

function labelForType(msg: Record<string, unknown>): string {
  const type = String(msg.type || '');
  switch (type) {
    case 'idle_notification': return `Idle: ${msg.idleReason || msg.reason || ''}`;
    case 'permission_request': return `Permission: ${msg.tool_name || ''} — ${msg.description || ''}`;
    case 'permission_response': return `Permission ${msg.approved ? 'granted' : 'denied'}`;
    case 'task_assignment': return `Task #${msg.taskId || ''}: ${msg.subject || msg.title || ''}`;
    case 'shutdown_request': return `Shutdown: ${msg.reason || ''}`;
    default: return type;
  }
}

function normaliseMessage(raw: RawMessage, toAgent: string, colorMap: Map<string, string>): TeamMessage {
  const color = colorToCss(raw.color || colorMap.get(raw.from));
  let isStructured = false;
  let structuredType: string | null = null;
  let label = '';
  let payload: Record<string, unknown> | null = null;

  try {
    const parsed = JSON.parse(raw.text);
    if (parsed && typeof parsed === 'object' && parsed.type) {
      isStructured = true;
      structuredType = String(parsed.type);
      label = labelForType(parsed);
      payload = parsed as Record<string, unknown>;
    }
  } catch { /* plain text message */ }

  if (!isStructured) {
    label = raw.summary || (raw.text || '').slice(0, 120);
  }

  return {
    from: raw.from || '',
    to: toAgent,
    timestamp: raw.timestamp || '',
    color,
    read: raw.read ?? true,
    isStructured,
    structuredType,
    label,
    payload,
    text: raw.text || '',
  };
}

export class TeamMonitor extends EventEmitter {
  private teams = new Map<string, TeamState>();
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly DEBOUNCE_MS = 100;
  private readonly ACTIVE_WINDOW_MS = 30 * 60 * 1000;
  readonly TEAMS_DIR = path.join(os.homedir(), '.claude', 'teams');

  private isRevoked(config: TeamConfig): boolean {
    if (config.status && config.status !== 'active') return true;
    if (config.disbanded === true) return true;
    if (config.revokedAt) return true;
    if (config.active === false) return true;
    return false;
  }

  async loadAll(): Promise<void> {
    if (!fs.existsSync(this.TEAMS_DIR)) return;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.TEAMS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { return; }

    for (const name of dirs) {
      this.loadTeam(name);
    }
    this.emit('teams:updated');
  }

  loadTeam(name: string): void {
    const teamDir = path.join(this.TEAMS_DIR, name);
    const configPath = path.join(teamDir, 'config.json');
    let config: TeamConfig = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* keep empty config */ }

    const prevState = this.teams.get(name);
    const wasRevoked = prevState ? this.isRevoked(prevState.config) : false;
    const nowRevoked = this.isRevoked(config);

    const state: TeamState = { name, config, inboxes: new Map() };
    this.teams.set(name, state);

    // Emit revocation only on transition (not on initial load if already revoked)
    if (!wasRevoked && nowRevoked && prevState !== undefined) {
      this.emit('team:revoked', name);
    }

    const inboxesDir = path.join(teamDir, 'inboxes');
    if (!fs.existsSync(inboxesDir)) return;
    let files: string[];
    try {
      files = fs.readdirSync(inboxesDir).filter(f => f.endsWith('.json'));
    } catch { return; }

    const colorMap = this.buildColorMap(config);
    for (const f of files) {
      const agentName = path.basename(f, '.json');
      this.parseInboxFile(name, agentName, path.join(inboxesDir, f), colorMap);
    }
  }

  private buildColorMap(config: TeamConfig): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of config.members || []) {
      if (m.name && m.color) map.set(m.name, m.color);
      if (m.agentId && m.color) map.set(m.agentId, m.color);
    }
    return map;
  }

  private parseInboxFile(teamName: string, agentName: string, filePath: string, colorMap: Map<string, string>): void {
    const state = this.teams.get(teamName);
    if (!state) return;
    let rawMessages: RawMessage[] = [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      rawMessages = Array.isArray(parsed) ? parsed : [];
    } catch { return; }

    state.inboxes.set(agentName, rawMessages.map(r => normaliseMessage(r, agentName, colorMap)));
  }

  private isTeamActive(state: TeamState): boolean {
    if (state.config.members?.some(m => m.isActive)) return true;
    const now = Date.now();
    for (const messages of state.inboxes.values()) {
      if (messages.some(m => m.timestamp && now - new Date(m.timestamp).getTime() < this.ACTIVE_WINDOW_MS)) return true;
    }
    return false;
  }

  getTeams(): TeamInfo[] {
    const result: TeamInfo[] = [];
    for (const state of this.teams.values()) {
      const allMessages = [...state.inboxes.values()].flat();
      const lastActivityTs = allMessages.reduce<string | null>((best, m) => {
        if (!m.timestamp) return best;
        return (!best || m.timestamp > best) ? m.timestamp : best;
      }, null);

      const members: TeamMember[] = (state.config.members || []).map(m => {
        const inbox = state.inboxes.get(m.agentId || '') || state.inboxes.get(m.name || '') || [];
        const unreadCount = inbox.filter(msg => !msg.read).length;
        return {
          agentId: m.agentId || '',
          name: m.name || m.agentId || '',
          color: colorToCss(m.color),
          isActive: m.isActive ?? false,
          model: m.model || '',
          unreadCount,
        };
      });

      result.push({
        name: state.name,
        description: String(state.config.description || ''),
        leadAgentId: String(state.config.leadAgentId || ''),
        leadSessionId: String(state.config.leadSessionId || ''),
        isActive: this.isTeamActive(state),
        members,
        messageCount: allMessages.length,
        lastActivityTs,
      });
    }
    return result.sort((a, b) => {
      if (a.lastActivityTs && b.lastActivityTs) return b.lastActivityTs.localeCompare(a.lastActivityTs);
      if (a.lastActivityTs) return -1;
      if (b.lastActivityTs) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  getLeadSessionId(teamName: string): string | null {
    return this.teams.get(teamName)?.config.leadSessionId || null;
  }

  getTeamMessages(teamName: string): TeamMessage[] {
    const state = this.teams.get(teamName);
    if (!state) return [];
    const all = [...state.inboxes.values()].flat();
    return all.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  }

  start(): void {
    if (!fs.existsSync(this.TEAMS_DIR)) return;
    this.watcher = chokidar.watch([
      this.TEAMS_DIR,                                     // watch team dirs for add/unlinkDir
      `${this.TEAMS_DIR}/*/config.json`,
      `${this.TEAMS_DIR}/*/inboxes/*.json`,
    ], {
      persistent: true,
      ignoreInitial: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    this.watcher.on('add', (filePath: string) => {
      if (path.basename(filePath) === 'config.json') {
        const teamName = path.basename(path.dirname(filePath));
        this.loadTeam(teamName);
        this.emit('teams:updated');
      } else {
        this.handleInboxChange(filePath);
      }
    });

    this.watcher.on('unlink', (filePath: string) => {
      if (path.basename(filePath) === 'config.json') {
        const teamName = path.basename(path.dirname(filePath));
        if (this.teams.has(teamName)) {
          this.emit('team:revoked', teamName);
          this.teams.delete(teamName);
          this.emit('teams:updated');
        }
      }
    });

    // Fired on macOS when the entire team directory is deleted (FSEvents does
    // not emit individual 'unlink' events for files inside a removed directory).
    this.watcher.on('unlinkDir', (dirPath: string) => {
      const rel = path.relative(this.TEAMS_DIR, dirPath);
      const parts = rel.split(path.sep).filter(Boolean);
      if (parts.length === 1) {
        const teamName = parts[0];
        if (this.teams.has(teamName)) {
          this.emit('team:revoked', teamName);
          this.teams.delete(teamName);
          this.emit('teams:updated');
        }
      }
    });

    this.watcher.on('change', (filePath: string) => {
      if (path.basename(filePath) === 'config.json') {
        this.debounce(filePath, () => {
          const teamName = path.basename(path.dirname(filePath));
          this.loadTeam(teamName);
          this.emit('teams:updated');
        });
      } else {
        this.debounce(filePath, () => this.handleInboxChange(filePath));
      }
    });
  }

  private handleInboxChange(filePath: string): void {
    const agentName = path.basename(filePath, '.json');
    const teamName = path.basename(path.dirname(path.dirname(filePath)));
    const state = this.teams.get(teamName);
    if (!state) {
      this.loadTeam(teamName);
    } else {
      const colorMap = this.buildColorMap(state.config);
      this.parseInboxFile(teamName, agentName, filePath, colorMap);
    }
    this.emit('teams:updated');
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, this.DEBOUNCE_MS);
    this.debounceTimers.set(key, timer);
  }

  stop(): void {
    this.watcher?.close();
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }
}
