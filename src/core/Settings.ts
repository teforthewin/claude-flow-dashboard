import fs from 'fs';
import path from 'path';
import os from 'os';

export interface AppSettings {
  projectsDir: string;
  teamsDir: string;
}

const DEFAULTS: AppSettings = {
  projectsDir: path.join(os.homedir(), '.claude', 'projects'),
  teamsDir: path.join(os.homedir(), '.claude', 'teams'),
};

export class Settings {
  private filePath: string;
  private data: AppSettings;

  constructor(dataDir: string, defaults: Partial<AppSettings> = {}) {
    this.filePath = path.join(dataDir, 'settings.json');
    this.data = this.load(defaults);
  }

  private load(defaults: Partial<AppSettings>): AppSettings {
    const base = { ...DEFAULTS, ...defaults };
    try {
      return { ...base, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
    } catch {
      return base;
    }
  }

  get(): AppSettings {
    return { ...this.data };
  }

  set(patch: Partial<AppSettings>): void {
    this.data = { ...this.data, ...patch };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
