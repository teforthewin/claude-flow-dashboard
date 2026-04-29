import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getSessions: () => ipcRenderer.invoke('sessions:list'),

  getSession: (id: string) => ipcRenderer.invoke('sessions:get', id),

  getStats: (id: string) => ipcRenderer.invoke('sessions:stats', id),

  deleteSessions: (ids: string[]) => ipcRenderer.invoke('sessions:delete', ids),

  onSessionEntry: (callback: (data: { sessionId: string; entry: unknown }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { sessionId: string; entry: unknown }) => {
      callback(data);
    };
    ipcRenderer.on('sessions:entry', handler);
    return () => ipcRenderer.removeListener('sessions:entry', handler);
  },

  onGlobalUpdate: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('sessions:updated', handler);
    return () => ipcRenderer.removeListener('sessions:updated', handler);
  },

  archiveSessions: (ids: string[]) => ipcRenderer.invoke('sessions:archive', ids),

  reloadSessions: () => ipcRenderer.invoke('sessions:reload'),

  getTeams: () => ipcRenderer.invoke('teams:list'),

  getTeamMessages: (teamName: string) => ipcRenderer.invoke('teams:messages', teamName),

  onTeamsUpdate: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('teams:updated', handler);
    return () => ipcRenderer.removeListener('teams:updated', handler);
  },

  onTeamRevoked: (callback: (teamName: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, teamName: string) => callback(teamName);
    ipcRenderer.on('teams:revoked', handler);
    return () => ipcRenderer.removeListener('teams:revoked', handler);
  },

  archiveTeam: (teamName: string) => ipcRenderer.invoke('teams:archive', teamName),

  getSettings: () => ipcRenderer.invoke('settings:get'),

  checkSettings: () => ipcRenderer.invoke('settings:check'),

  setSettings: (patch: Record<string, string>) => ipcRenderer.invoke('settings:set', patch),

  selectFolder: () => ipcRenderer.invoke('settings:select-folder'),

  onSettingsChanged: (callback: (settings: Record<string, string>) => void) => {
    const handler = (_: Electron.IpcRendererEvent, settings: Record<string, string>) => callback(settings);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },
});
