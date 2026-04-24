import { app, BrowserWindow } from 'electron';
import path from 'path';
import { SessionManager } from './SessionManager';
import { LogWatcher } from './LogWatcher';
import { TeamMonitor } from './TeamMonitor';
import { registerIpcHandlers } from './ipc';

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager;
let logWatcher: LogWatcher;
let teamMonitor: TeamMonitor;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Claude Flow Dashboard',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  sessionManager = new SessionManager();
  await sessionManager.loadAll();

  logWatcher = new LogWatcher(sessionManager);
  logWatcher.start();

  teamMonitor = new TeamMonitor();
  await teamMonitor.loadAll();
  teamMonitor.start();

  registerIpcHandlers(sessionManager, teamMonitor);

  sessionManager.on('session:new', () => {
    mainWindow?.webContents.send('sessions:updated');
  });

  sessionManager.on('session:entry', (sessionId: string, entry: unknown) => {
    mainWindow?.webContents.send('sessions:entry', { sessionId, entry });
    mainWindow?.webContents.send('sessions:updated');
  });

  teamMonitor.on('teams:updated', () => {
    mainWindow?.webContents.send('teams:updated');
  });

  teamMonitor.on('team:revoked', (teamName: string) => {
    mainWindow?.webContents.send('teams:revoked', teamName);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  logWatcher?.stop();
  teamMonitor?.stop();
  if (process.platform !== 'darwin') app.quit();
});
