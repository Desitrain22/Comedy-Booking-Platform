/**
 * The Hono app, in one of two modes:
 *
 * - **Single club** (the self-hosted install): `createApp({ db })`. Every request uses `db`.
 * - **Hosted** (`PLATFORM_URL` set): `createApp({ platform })`. The request's host picks the
 *   site (server/platform/tenancy.ts): `<domain>` serves the platform API, `<slug>.<domain>`
 *   that club's database and every route below.
 *
 * Used by the server (server/index.ts) and by tests (server/test/helpers.ts and
 * server/test/hosted.ts → app.request(), no ports).
 *
 * Every route module is a `new Hono<AppEnv>()` mounted at `/api`, defining full paths
 * after the prefix (`/shows`, `/days/:date`, …). Handlers read the DB from `c.var.db`.
 */
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { HostContext } from '../shared/api/platform';
import { timingDummyHash } from './auth/password';
import type { AppEnv } from './context';
import type { Db } from './db/client';
import { HttpError } from './lib/http';
import { RateLimiter, setRateLimiter, type RateLimitConfig } from './lib/rateLimit';
import { resolveRateLimits } from './lib/rateLimitConfig';
import type { Platform } from './platform';
import { platformRoutes } from './platform/routes';
import { hostedTenancy } from './platform/tenancy';
import { authRoutes } from './routes/auth';
import { BULK_ADD_PATH, comediansRoutes } from './routes/comedians';
import { dashboardRoutes } from './routes/dashboard';
import { lineupRoutes } from './routes/lineup';
import { locationsRoutes } from './routes/locations';
import { onboardingRoutes } from './routes/onboarding';
import { portalRoutes } from './routes/portal';
import { settingsRoutes } from './routes/settings';
import { setupRoutes } from './routes/setup';
import { showsRoutes } from './routes/shows';

interface CommonAppOptions {
  /** Serve the built SPA from this directory (production). Omit in dev/tests. */
  clientDir?: string;
  /** Log each request to the console. */
  logRequests?: boolean;
}

/** The self-hosted single club: one database for every request. */
export interface SingleAppOptions extends CommonAppOptions {
  db: Db;
  platform?: undefined;
  /**
   * Sign-in rate limits (server/lib/rateLimit.ts). Default: the production limits, ×10 under
   * `npm run dev` so repeated e2e runs against one dev server never trip them.
   */
  rateLimits?: Partial<RateLimitConfig>;
}

/**
 * Hosted mode: many clubs, picked by host name. Each club database's sign-in limits are set
 * by the platform (`createPlatform({ clubRateLimits })`).
 */
export interface HostedAppOptions extends CommonAppOptions {
  platform: Platform;
  db?: undefined;
}

export type CreateAppOptions = SingleAppOptions | HostedAppOptions;

/** Largest request body the API accepts (bulk-adding 500 comedians is well under this). */
export const API_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Content-Security-Policy for the app shell (production serves it; in dev Vite does).
 * - Scripts: only our own bundle (no inline scripts, no eval).
 * - Styles: our CSS plus inline styles (React style props, toasts, and the sandboxed email
 *   previews, whose srcdoc documents inherit this policy, all use them).
 * - Images: anywhere (comedian headshots are links to any site), plus data:/blob:.
 * - Never framed by another site (frame-ancestors 'none'; X-Frame-Options DENY for old browsers).
 */
export const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ['*', 'data:', 'blob:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  frameSrc: ["'self'"],
  workerSrc: ["'self'"],
  manifestSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

/**
 * Writes must be JSON: form and text/plain posts (what a cross-site page can send without a
 * CORS preflight) never reach a handler, where a JSON validator would read them as `{}`.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function isJsonContentType(value: string): boolean {
  const type = value.split(';')[0]!.trim().toLowerCase();
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'));
}

/** Same-host check that ignores scheme (TLS is often terminated by a proxy). */
function sameHost(origin: string, requestUrl: string): boolean {
  try {
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { clientDir, logRequests = false } = options;
  const platform = options.platform ?? null;
  const app = new Hono<AppEnv>();
  if (options.db) setRateLimiter(options.db, new RateLimiter(resolveRateLimits(options.rateLimits)));
  // Hash the sign-in timing decoy now (with the configured bcrypt cost), not on the first login.
  void timingDummyHash();

  if (logRequests) app.use('/api/*', logger());

  if (options.db) {
    const db = options.db;
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
  }

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: CONTENT_SECURITY_POLICY,
      xFrameOptions: 'DENY',
      // Emailed links carry their token in the path (/portal/confirm/<token>): never send
      // it to another site (headshots, provider help links).
      referrerPolicy: 'no-referrer',
      // Browsers ignore this over plain http; on https it pins the club's host to https.
      strictTransportSecurity: 'max-age=15552000',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
    }),
  );

  const apiBodyLimit = bodyLimit({
    maxSize: API_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: 'That request is too large', code: 'payload_too_large' }, 413),
  });
  // CSV import (up to 1,000 comedians) applies its own, larger limit: server/routes/comedians.ts.
  app.use('/api/*', (c, next) => (c.req.path === BULK_ADD_PATH ? next() : apiBodyLimit(c, next)));

  app.use(
    '/api/*',
    csrf({
      origin: (origin, c) => sameHost(origin, c.req.url),
      // Same origin only: a sibling subdomain ("same-site") is another site for us.
      secFetchSite: 'same-origin',
    }),
  );

  app.use('/api/*', async (c, next) => {
    const type = c.req.header('content-type');
    if (MUTATING_METHODS.has(c.req.method) && type && !isJsonContentType(type)) {
      return c.json({ error: 'Send JSON (Content-Type: application/json)', code: 'unsupported_media_type' }, 415);
    }
    await next();
  });

  // Hosted mode: which club (or the platform) this host is; sets c.var.db for a club, and
  // answers /api/host itself.
  if (platform) app.use('/api/*', hostedTenancy(platform));

  app.get('/api/health', (c) => c.json({ ok: true as const }));
  app.get('/api/host', (c) => c.json({ mode: 'single' } satisfies HostContext));

  // Hosted mode, platform host only (the tenancy middleware keeps club hosts out): sign-up
  // and find my club. The owner console (hosted MVP PR 3) mounts its routes here too.
  if (platform) app.route('/api', platformRoutes(platform));

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
  app.route('/api', onboardingRoutes);

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
