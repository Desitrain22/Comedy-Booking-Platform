/**
 * Server entry: open + migrate the database(s), start HTTP and the scheduler.
 * Dev: `npm run dev` (tsx watch). Production: `npm start` (bundled by tsup, serves dist/client).
 *
 * Two modes (server/env.ts):
 * - Single club (no PLATFORM_URL): `$DATA_DIR/club.db`, the app as it has always been.
 * - Hosted (PLATFORM_URL set): `$DATA_DIR/platform.db` + `$DATA_DIR/clubs/<id>.db`, one club
 *   per subdomain (server/platform).
 */
import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { closeDb, createDb } from './db/client';
import { env, type HostedEnv } from './env';
import { getSettings } from './lib/settings';
import { createPlatform } from './platform';
import { clubUrl } from './platform/hosts';
import { nightlyBackupJob } from './platform/backups';
import { DEFAULT_PLATFORM_JOBS, startPlatformScheduler } from './platform/scheduler';
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

interface Running {
  fetch: Parameters<typeof serve>[0]['fetch'];
  /** Logged once the server listens. */
  describe(port: number): string[];
  stopScheduler: () => void;
  close(): void;
}

function startSingle(): Running {
  const db = createDb(env.dbFile);
  const app = createApp({ db, clientDir: resolveClientDir(), logRequests: !env.isProduction });
  return {
    fetch: app.fetch,
    describe: (port) => {
      const lines = [
        `[server] Comedy Booking API listening on http://localhost:${port} (single club)`,
        `[server] Database: ${env.dbFile}`,
      ];
      if (!getSettings(db).setupComplete) lines.push('[server] First run: open the app to complete setup.');
      return lines;
    },
    stopScheduler: startScheduler(db),
    close: () => closeDb(db),
  };
}

function startHosted(hosted: HostedEnv): Running {
  if (env.isProduction && !env.appSecret) {
    console.error(
      '[server] Hosted mode (PLATFORM_URL) needs APP_SECRET in production: it encrypts mailbox passwords at rest.\n' +
        '         Generate one with `openssl rand -base64 32` and set it as a secret, then restart.',
    );
    process.exit(1);
  }
  if (!hosted.adminEmails.length) {
    console.warn(
      '[server] PLATFORM_ADMIN_EMAILS is empty: nobody is told about new sign-ups and nobody can use the owner console.',
    );
  }
  const platform = createPlatform({
    hosted,
    platformDbFile: env.platformDbFile,
    clubsDir: env.clubsDir,
    smtp: env.smtp,
  });
  const app = createApp({ platform, clientDir: resolveClientDir(), logRequests: !env.isProduction });
  return {
    fetch: app.fetch,
    describe: (port) => {
      const clubs = platform.registry.listClubs();
      const active = clubs.filter((c) => c.status === 'active').length;
      return [
        `[server] Comedy Booking API listening on http://localhost:${port} (hosted mode: ${hosted.platformName})`,
        `[server] Platform site: ${hosted.platformUrl}   Clubs: ${clubUrl(hosted, '<slug>')}`,
        `[server] Data: ${env.platformDbFile}, ${env.clubsDir}/<id>.db (${clubs.length} clubs, ${active} active)`,
        `[server] Nightly backups (03:30 UTC, 14 days): ${env.backupsDir}`,
        `[server] Sign-ups ${hosted.signupsOpen ? 'open' : 'closed'}; platform email ${
          env.smtp ? `via ${env.smtp.host}` : 'to the outbox (console + platform_email_log)'
        }`,
      ];
    },
    stopScheduler: startPlatformScheduler(platform, {
      jobs: [...DEFAULT_PLATFORM_JOBS, nightlyBackupJob({ backupsDir: env.backupsDir })],
    }),
    close: () => platform.close(),
  };
}

const running = env.hosted ? startHosted(env.hosted) : startSingle();

const server = serve({ fetch: running.fetch, port: env.port }, (info) => {
  for (const line of running.describe(info.port)) console.log(line);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down…`);
  running.stopScheduler();
  server.close(() => {
    running.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
