/**
 * The Hono app. `createApp({ db })` is used by the server (server/index.ts) and by tests
 * (server/test/helpers.ts → app.request(), no ports).
 *
 * Every route module is a `new Hono<AppEnv>()` mounted at `/api`, defining full paths
 * after the prefix (`/shows`, `/days/:date`, …). Handlers read the DB from `c.var.db`.
 */
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppEnv } from './context';
import type { Db } from './db/client';
import { HttpError } from './lib/http';
import { authRoutes } from './routes/auth';
import { comediansRoutes } from './routes/comedians';
import { dashboardRoutes } from './routes/dashboard';
import { lineupRoutes } from './routes/lineup';
import { locationsRoutes } from './routes/locations';
import { portalRoutes } from './routes/portal';
import { settingsRoutes } from './routes/settings';
import { setupRoutes } from './routes/setup';
import { showsRoutes } from './routes/shows';

export interface CreateAppOptions {
  db: Db;
  /** Serve the built SPA from this directory (production). Omit in dev/tests. */
  clientDir?: string;
  /** Log each request to the console. */
  logRequests?: boolean;
}

/** Same-host check that ignores scheme (TLS is often terminated by a proxy). */
function sameHost(origin: string, requestUrl: string): boolean {
  try {
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}

export function createApp({ db, clientDir, logRequests = false }: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  if (logRequests) app.use('/api/*', logger());

  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  app.use(
    '/api/*',
    csrf({
      origin: (origin, c) => sameHost(origin, c.req.url),
      secFetchSite: ['same-origin', 'same-site'],
    }),
  );

  app.get('/api/health', (c) => c.json({ ok: true as const }));

  // Foundation
  app.route('/api', authRoutes);
  app.route('/api', setupRoutes);
  app.route('/api', locationsRoutes);
  // Features (F1–F6)
  app.route('/api', showsRoutes);
  app.route('/api', lineupRoutes);
  app.route('/api', comediansRoutes);
  app.route('/api', portalRoutes);
  app.route('/api', dashboardRoutes);
  app.route('/api', settingsRoutes);

  app.all('/api/*', (c) => c.json({ error: 'Not found', code: 'not_found' }, 404));

  if (clientDir) {
    const indexHtml = readFileSync(path.join(clientDir, 'index.html'), 'utf8');
    app.use(
      '/assets/*',
      serveStatic({
        root: clientDir,
        onFound: (_path, c) => {
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.use('*', serveStatic({ root: clientDir }));
    // SPA fallback: any other GET renders the app shell; React Router takes it from there.
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  }

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(err.toBody(), err.status);
    if (err instanceof HTTPException) {
      // e.g. hono/csrf (403, cross-site form post) or malformed JSON bodies (400).
      const status = err.status;
      const forbidden = status === 403;
      const error = err.message || (forbidden ? 'Cross-site request blocked' : 'Request failed');
      return c.json({ error, code: forbidden ? 'forbidden' : 'http_error' }, status);
    }
    console.error(err);
    return c.json({ error: 'Something went wrong', code: 'internal_error' }, 500);
  });

  return app;
}
