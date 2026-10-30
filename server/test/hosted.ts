/**
 * Test toolkit for hosted mode (vitest, no ports). Requests are absolute URLs: the host picks
 * the site, exactly as in production.
 *
 *   const h = makeHostedTestApp();                                  // platform at localhost:3000
 *   const { club, db } = h.createClub({ slug: 'broadway' });        // registered + set up
 *   const { headers } = h.loginAsBooker('broadway');
 *   const res = await h.request(h.clubUrl('broadway', '/api/shows'), { headers });
 *   await h.request(h.platformUrl('/api/platform/signup'), { method: 'POST', json: { … } });
 *   h.platformEmails('signup_notice');                              // platform_email_log rows
 *   h.close();
 */
import { desc } from 'drizzle-orm';
import type { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app';
import { createSession, SESSION_COOKIES } from '../auth/sessions';
import type { AppEnv } from '../context';
import type { Db } from '../db/client';
import type { User } from '../db/schema';
import type { HostedEnv } from '../env';
import type { RateLimitConfig } from '../lib/rateLimit';
import { createPlatform, type Platform } from '../platform';
import type { PlatformRateLimitConfig } from '../platform/limits';
import type { PlatformTransportFactory } from '../platform/mailer';
import { platformEmailLog, type Club, type ClubStatus, type PlatformEmailKind, type PlatformEmailLogEntry } from '../platform/schema';
import { applyClubSetup } from '../services/setup';
import { createUser, testPasswordHash, type AuthHeaders, type TestRequestInit } from './helpers';

/** The hosted settings tests run with (override any of them per test app). */
export const TEST_HOSTED: HostedEnv = {
  platformUrl: 'http://localhost:3000',
  platformHost: 'localhost:3000',
  protocol: 'http:',
  platformName: 'Comedy Booking',
  adminEmails: ['owner@platform.test'],
  supportEmail: 'help@platform.test',
  signupsOpen: true,
  dailyEmailCap: 2000,
};

export interface MakeHostedTestAppOptions {
  hosted?: Partial<HostedEnv>;
  /** Platform SMTP; omit for the outbox. */
  smtp?: Parameters<typeof createPlatform>[0]['smtp'];
  transportFactory?: PlatformTransportFactory;
  platformRateLimits?: Partial<PlatformRateLimitConfig>;
  clubRateLimits?: Partial<RateLimitConfig>;
}

export interface CreateTestClubOptions {
  slug?: string;
  name?: string;
  status?: ClubStatus;
  timezone?: string;
  admin?: { name?: string; email?: string };
}

export interface HostedTestApp {
  app: Hono<AppEnv>;
  platform: Platform;
  hosted: HostedEnv;
  dataDir: string;
  /** `http://<slug>.localhost:3000<pathname>` */
  clubUrl(slug: string, pathname?: string): string;
  /** `http://localhost:3000<pathname>` */
  platformUrl(pathname?: string): string;
  /** `app.request` with JSON conveniences. `url` must be absolute: its host picks the site. */
  request(url: string, init?: TestRequestInit): Promise<Response>;
  /** Register a club and set it up directly (no HTTP): settings, one location, its admin. */
  createClub(options?: CreateTestClubOptions): { club: Club; db: Db; admin: User };
  /** A booker with a live session in that club (admin unless `role` says otherwise). */
  loginAsBooker(
    slug: string,
    options?: { role?: 'admin' | 'booker'; email?: string },
  ): { user: User; headers: AuthHeaders; cookie: string };
  /** platform_email_log rows, newest first (optionally only one kind). */
  platformEmails(kind?: PlatformEmailKind): PlatformEmailLogEntry[];
  close(): void;
}

const dirs: string[] = [];
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let clubSeq = 0;

export function makeHostedTestApp(options: MakeHostedTestAppOptions = {}): HostedTestApp {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cbp-hosted-'));
  dirs.push(dataDir);
  const hosted: HostedEnv = { ...TEST_HOSTED, ...options.hosted };
  const platform = createPlatform({
    hosted,
    platformDbFile: path.join(dataDir, 'platform.db'),
    clubsDir: path.join(dataDir, 'clubs'),
    smtp: options.smtp ?? null,
    transportFactory: options.transportFactory,
    quietOutbox: true,
    platformRateLimits: options.platformRateLimits,
    clubRateLimits: options.clubRateLimits,
  });
  const app = createApp({ platform });

  const clubUrl = (slug: string, pathname = '') => `${hosted.protocol}//${slug}.${hosted.platformHost}${pathname}`;
  const platformUrl = (pathname = '') => `${hosted.platformUrl}${pathname}`;

  function dbFor(slug: string): Db {
    const club = platform.registry.getClubBySlug(slug);
    if (!club) throw new Error(`No club ${slug}`);
    return platform.registry.openClubDb(club);
  }

  return {
    app,
    platform,
    hosted,
    dataDir,
    clubUrl,
    platformUrl,
    request: async (url, init = {}) => {
      const { json, headers, body, ...rest } = init;
      const h = new Headers(headers);
      let payload = body;
      if (json !== undefined) {
        h.set('content-type', 'application/json');
        payload = JSON.stringify(json);
      } else if (!h.has('content-type') && rest.method && !['GET', 'HEAD'].includes(rest.method.toUpperCase())) {
        h.set('content-type', 'application/json');
      }
      return app.request(new Request(url, { ...rest, headers: h, body: payload }));
    },
    createClub: (opts = {}) => {
      const n = ++clubSeq;
      const slug = opts.slug ?? `club-${n}`;
      const name = opts.name ?? `Club ${n}`;
      const adminName = opts.admin?.name ?? `Owner ${n}`;
      const adminEmail = opts.admin?.email ?? `owner${n}@club.test`;
      const { club, db, result: admin } = platform.registry.createClub(
        { slug, name, ownerName: adminName, ownerEmail: adminEmail },
        (clubDb) =>
          applyClubSetup(clubDb, {
            clubName: name,
            timezone: opts.timezone ?? 'America/New_York',
            appUrl: clubUrl(slug),
            location: { name: 'Main Room' },
            admin: { name: adminName, email: adminEmail, passwordHash: testPasswordHash() },
          }),
      );
      const row = opts.status && opts.status !== 'active' ? platform.registry.setClubStatus(club.id, opts.status)! : club;
      return { club: row, db, admin };
    },
    loginAsBooker: (slug, opts = {}) => {
      const db = dbFor(slug);
      const user = createUser(db, { role: opts.role ?? 'admin', email: opts.email });
      const { token } = createSession(db, 'booker', user.id);
      const cookie = `${SESSION_COOKIES.booker}=${token}`;
      return { user, headers: { cookie }, cookie };
    },
    platformEmails: (kind) => {
      const rows = platform.db.select().from(platformEmailLog).orderBy(desc(platformEmailLog.id)).all();
      return kind ? rows.filter((r) => r.kind === kind) : rows;
    },
    close: () => platform.close(),
  };
}
