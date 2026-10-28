/**
 * Server entry: open + migrate the database, start HTTP and the scheduler.
 * Dev: `npm run dev` (tsx watch). Production: `npm start` (bundled by tsup, serves dist/client).
 */
import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { closeDb, createDb } from './db/client';
import { env } from './env';
import { getSettings } from './lib/settings';
import { startScheduler } from './services/scheduler';

/** In the bundle (dist/server/index.js) the built client sits at dist/client. */
function resolveClientDir(): string | undefined {
  if (process.env.NODE_ENV !== 'production') return undefined;
  const dir = process.env.CLIENT_DIR
    ? path.resolve(process.env.CLIENT_DIR)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
  if (existsSync(path.join(dir, 'index.html'))) return dir;
  console.warn(`[server] Built client not found at ${dir}; serving the API only.`);
  return undefined;
}

const db = createDb(env.dbFile);
const app = createApp({ db, clientDir: resolveClientDir(), logRequests: !env.isProduction });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  const settings = getSettings(db);
  console.log(`[server] Comedy Booking API listening on http://localhost:${info.port}`);
  console.log(`[server] Database: ${env.dbFile}`);
  if (!settings.setupComplete) console.log('[server] First run: open the app to complete setup.');
});

const stopScheduler = startScheduler(db);

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down…`);
  stopScheduler();
  server.close(() => {
    closeDb(db);
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
