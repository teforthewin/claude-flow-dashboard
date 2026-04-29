import { app } from 'electron';
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

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'settings.json');
    this.data = this.load();
  }

  private load(): AppSettings {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
    } catch {
      return { ...DEFAULTS };
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
