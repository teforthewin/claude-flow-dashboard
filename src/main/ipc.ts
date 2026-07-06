import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import archiver from 'archiver';
import { SessionManager, TeamMonitor } from '../core';
import { Settings } from './Settings';

async function createTeamArchive(
  manager: SessionManager,
  teamMonitor: TeamMonitor,
  teamName: string,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    const prefix = teamName;

    // 1. Team config
    const configPath = path.join(teamMonitor.TEAMS_DIR, teamName, 'config.json');
    if (fs.existsSync(configPath)) {
      archive.file(configPath, { name: `${prefix}/team-config.json` });
    }

    // 2. Inbox JSON files
    const inboxesDir = path.join(teamMonitor.TEAMS_DIR, teamName, 'inboxes');
    if (fs.existsSync(inboxesDir)) {
      const files = fs.readdirSync(inboxesDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        archive.file(path.join(inboxesDir, f), { name: `${prefix}/inboxes/${f}` });
      }
    }

    // 3. Human-readable chronological message log
    const messages = teamMonitor.getTeamMessages(teamName);
    if (messages.length) {
      const lines = messages.map(m => {
        const ts = m.timestamp ? m.timestamp.replace('T', ' ').slice(0, 19) : '?';
        const badge = m.structuredType ? ` [${m.structuredType}]` : '';
        return `[${ts}] ${m.from} → ${m.to}${badge}: ${m.label}`;
      });
      archive.append(lines.join('\n'), { name: `${prefix}/messages.txt` });
    }

    // 4. Session JSONL files linked to this team
    const leadSessionId = teamMonitor.getLeadSessionId(teamName);
    const sessionPaths = manager.getTeamFilePaths(teamName, leadSessionId);
    for (const filePath of sessionPaths) {
      archive.file(filePath, { name: `${prefix}/sessions/${path.basename(filePath)}` });
    }

    archive.finalize();
  });
}

export function registerIpcHandlers(manager: SessionManager, teamMonitor: TeamMonitor, appSettings: Settings): void {
  ipcMain.handle('settings:get', () => appSettings.get());

  ipcMain.handle('settings:set', async (e, patch: Partial<{ projectsDir: string; teamsDir: string }>) => {
    appSettings.set(patch);
    BrowserWindow.fromWebContents(e.sender)?.webContents.send('settings:changed', appSettings.get());
  });

  ipcMain.handle('settings:select-folder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths.length) return null;
    return filePaths[0];
  });

  ipcMain.handle('settings:check', () => {
    const s = appSettings.get();
    return {
      projectsDir: fs.existsSync(s.projectsDir),
      teamsDir: fs.existsSync(s.teamsDir),
    };
  });

  ipcMain.handle('settings:open-folder', async (_e, dir: string) => {
    if (!dir || !fs.existsSync(dir)) return { ok: false };
    const err = await shell.openPath(dir);
    return { ok: !err };
  });

  ipcMain.handle('teams:list', () => teamMonitor.getTeams());
  ipcMain.handle('teams:messages', (_e, teamName: string) => teamMonitor.getTeamMessages(teamName));

  ipcMain.handle('teams:archive', async (e, teamName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const date = new Date().toISOString().slice(0, 10);
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Archive Team',
      defaultPath: path.join(os.homedir(), `${teamName}-archive-${date}.zip`),
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return { cancelled: true };
    await createTeamArchive(manager, teamMonitor, teamName, filePath);
    return { path: filePath };
  });

  ipcMain.handle('sessions:list', () => manager.getSessionList());

  ipcMain.handle('sessions:get', (_event, id: string) => {
    const result = manager.getSession(id);
    if (!result) return { session_id: id, entries: [] };
    return result;
  });

  ipcMain.handle('sessions:stats', (_event, id: string) => {
    return manager.getStats(id) || {};
  });

  ipcMain.handle('sessions:delete', (_event, ids: string[]) => {
    manager.deleteSessions(ids);
  });

  ipcMain.handle('sessions:reload', async () => {
    await manager.reload();
  });

  ipcMain.handle('sessions:archive', async (event, ids: string[]) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const date = new Date().toISOString().slice(0, 10);
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Archive Sessions',
      defaultPath: path.join(os.homedir(), `claude-sessions-${date}.zip`),
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return { cancelled: true };
    await manager.archiveSessions(ids, filePath);
    return { path: filePath };
  });
}
