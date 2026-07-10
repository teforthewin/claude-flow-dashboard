import os from 'os';
import path from 'path';
import { createApiServer } from './server';

async function main(): Promise<void> {
  const port = Number(process.env.LOOMSCOPE_PORT || 7842);
  const dataDir =
    process.env.LOOMSCOPE_DATA_DIR ||
    path.join(os.homedir(), '.config', 'loomscope');
  const staticDir = process.env.LOOMSCOPE_STATIC_DIR;

  const envDefaults = {
    projectsDir: process.env.LOOMSCOPE_PROJECTS_DIR,
    teamsDir: process.env.LOOMSCOPE_TEAMS_DIR,
    opencodeDbPath: process.env.LOOMSCOPE_OPENCODE_DB,
  };
  const handle = await createApiServer({ port, dataDir, staticDir, settingsDefaults: envDefaults });

  const shutdown = async (sig: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[loomscope-api] received ${sig}, shutting down`);
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[loomscope-api] fatal:', err);
  process.exit(1);
});
