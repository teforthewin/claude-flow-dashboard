import { app, BrowserWindow, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { SessionManager } from './SessionManager';
import { LogWatcher } from './LogWatcher';
import { TeamMonitor } from './TeamMonitor';
import { Settings } from './Settings';
import { registerIpcHandlers } from './ipc';

app.setName('LoomScope');

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager;
let logWatcher: LogWatcher;
let teamMonitor: TeamMonitor;
let settings: Settings;
let managerListeners: (() => void) | null = null;

function resolveIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, '../../build/icon.png'),
    path.join(process.resourcesPath || '', 'icon.png'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  console.warn('[LoomScope] icon not found in any of:', candidates);
  return undefined;
}

function createWindow(): void {
  const iconPath = resolveIconPath();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'LoomScope',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  if (iconPath && process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(nativeImage.createFromPath(iconPath)); } catch {}
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function startManagers(): Promise<void> {
  const cfg = settings.get();

  sessionManager = new SessionManager(cfg.projectsDir, cfg.teamsDir);
  await sessionManager.loadAll();

  logWatcher = new LogWatcher(sessionManager, cfg.projectsDir);
  logWatcher.start();

  teamMonitor = new TeamMonitor(cfg.teamsDir);
  await teamMonitor.loadAll();
  teamMonitor.start();

  registerIpcHandlers(sessionManager, teamMonitor, settings);

  const onSessionNew = () => {
    mainWindow?.webContents.send('sessions:updated');
  };
  const onSessionEntry = (sessionId: string, entry: unknown) => {
    mainWindow?.webContents.send('sessions:entry', { sessionId, entry });
    mainWindow?.webContents.send('sessions:updated');
  };
  const onTeamsUpdated = () => {
    mainWindow?.webContents.send('teams:updated');
  };
  const onTeamRevoked = (teamName: string) => {
    mainWindow?.webContents.send('teams:revoked', teamName);
  };

  sessionManager.on('session:new', onSessionNew);
  sessionManager.on('session:entry', onSessionEntry);
  teamMonitor.on('teams:updated', onTeamsUpdated);
  teamMonitor.on('team:revoked', onTeamRevoked);

  managerListeners = () => {
    sessionManager.off('session:new', onSessionNew);
    sessionManager.off('session:entry', onSessionEntry);
    teamMonitor.off('teams:updated', onTeamsUpdated);
    teamMonitor.off('team:revoked', onTeamRevoked);
  };
}

app.whenReady().then(async () => {
  settings = new Settings();
  await startManagers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  managerListeners?.();
  managerListeners = null;
  logWatcher?.stop();
  teamMonitor?.stop();
  if (process.platform !== 'darwin') app.quit();
});
