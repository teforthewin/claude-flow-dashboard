import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import {
  SessionManager,
  LogWatcher,
  TeamMonitor,
  Settings,
  buildFlow,
} from '../core';

export interface ApiServerOptions {
  port: number;
  dataDir: string;
  staticDir?: string;
  settingsDefaults?: { projectsDir?: string; teamsDir?: string };
}

export interface ApiServerHandle {
  app: express.Express;
  manager: SessionManager;
  watcher: LogWatcher;
  teams: TeamMonitor;
  settings: Settings;
  close: () => Promise<void>;
}

export async function createApiServer(opts: ApiServerOptions): Promise<ApiServerHandle> {
  const defaults: Partial<{ projectsDir: string; teamsDir: string }> = {};
  if (opts.settingsDefaults?.projectsDir) defaults.projectsDir = opts.settingsDefaults.projectsDir;
  if (opts.settingsDefaults?.teamsDir) defaults.teamsDir = opts.settingsDefaults.teamsDir;
  const settings = new Settings(opts.dataDir, defaults);
  const cfg = settings.get();

  const manager = new SessionManager(cfg.projectsDir, cfg.teamsDir);
  await manager.loadAll();
  const watcher = new LogWatcher(manager, cfg.projectsDir);
  watcher.start();
  const teams = new TeamMonitor(cfg.teamsDir);
  await teams.loadAll();
  teams.start();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '4mb' }));

  // ----- Sessions -----
  app.get('/api/sessions', (_req, res) => res.json(manager.getSessionList()));

  app.get('/api/sessions/:id', (req, res) => {
    const s = manager.getSession(req.params.id);
    res.json(s ?? { session_id: req.params.id, entries: [] });
  });

  app.get('/api/sessions/:id/stats', (req, res) => {
    res.json(manager.getStats(req.params.id) ?? {});
  });

  app.get('/api/sessions/:id/flow', (req, res) => {
    const s = manager.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'session not found' });
    res.json({ session_id: s.session_id, steps: buildFlow(s.entries) });
  });

  app.post('/api/sessions/delete', (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    manager.deleteSessions(ids);
    res.json({ deleted: ids.length });
  });

  app.post('/api/sessions/reload', async (_req, res) => {
    await manager.reload();
    res.json({ ok: true });
  });

  // ----- Teams -----
  app.get('/api/teams', (_req, res) => res.json(teams.getTeams()));
  app.get('/api/teams/:name/messages', (req, res) =>
    res.json(teams.getTeamMessages(req.params.name)),
  );

  // ----- Settings -----
  app.get('/api/settings', (_req, res) => res.json(settings.get()));
  app.put('/api/settings', (req, res) => {
    settings.set(req.body ?? {});
    res.json(settings.get());
  });
  app.get('/api/settings/check', (_req, res) => {
    const s = settings.get();
    res.json({
      projectsDir: fs.existsSync(s.projectsDir),
      teamsDir: fs.existsSync(s.teamsDir),
    });
  });

  // ----- SSE event stream -----
  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const onSessionNew = () => send('sessions:updated', {});
    const onSessionEntry = (sessionId: string, entry: unknown) =>
      send('sessions:entry', { sessionId, entry });
    const onTeamsUpdated = () => send('teams:updated', {});
    const onTeamRevoked = (name: string) => send('teams:revoked', { name });

    manager.on('session:new', onSessionNew);
    manager.on('session:entry', onSessionEntry);
    teams.on('teams:updated', onTeamsUpdated);
    teams.on('team:revoked', onTeamRevoked);

    const ping = setInterval(() => res.write(': ping\n\n'), 30_000);

    req.on('close', () => {
      clearInterval(ping);
      manager.off('session:new', onSessionNew);
      manager.off('session:entry', onSessionEntry);
      teams.off('teams:updated', onTeamsUpdated);
      teams.off('team:revoked', onTeamRevoked);
    });
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: process.env.npm_package_version ?? 'dev' }));

  // ----- Static UI (optional) -----
  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(opts.staticDir!, 'index.html'));
    });
  }

  const server = app.listen(opts.port);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  // eslint-disable-next-line no-console
  console.log(`[loomscope-api] listening on :${opts.port}`);

  return {
    app,
    manager,
    watcher,
    teams,
    settings,
    close: async () => {
      watcher.stop();
      teams.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
