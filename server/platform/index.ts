/**
 * Hosted mode in one handle: the platform database, the club registry, the platform mailer
 * and the platform-level rate limits. `server/index.ts` makes one and passes it to
 * `createApp({ platform })` and `startPlatformScheduler(platform)`; tests make one with
 * `makeHostedTestApp()` (server/test/hosted.ts).
 *
 *   const platform = createPlatform({
 *     hosted: env.hosted, platformDbFile: env.platformDbFile, clubsDir: env.clubsDir, smtp: env.smtp,
 *   });
 *   platform.registry.getClubBySlug('broadway');
 *   platform.close();
 */
import type { HostedEnv, SmtpEnv } from '../env';
import type { RateLimitConfig } from '../lib/rateLimit';
import { closePlatformDb, createPlatformDb, type PlatformDb } from './db';
import { PlatformRateLimiter, type PlatformRateLimitConfig } from './limits';
import { createPlatformMailer, type PlatformMailer, type PlatformTransportFactory } from './mailer';
import { ClubRegistry } from './registry';

export interface Platform {
  hosted: HostedEnv;
  /** platform.db */
  db: PlatformDb;
  registry: ClubRegistry;
  mailer: PlatformMailer;
  /** Sign-up and find-my-club limits (per server, not per club). */
  limiter: PlatformRateLimiter;
  /** Close every club database and platform.db. */
  close(): void;
}

export interface CreatePlatformOptions {
  hosted: HostedEnv;
  /** `$DATA_DIR/platform.db` (':memory:' works for tests). */
  platformDbFile: string;
  /** `$DATA_DIR/clubs` */
  clubsDir: string;
  /** Platform SMTP (`env.smtp`); null/omitted → outbox. */
  smtp?: SmtpEnv | null;
  /** Tests: how the platform mailer's SMTP transport is made. */
  transportFactory?: PlatformTransportFactory;
  /** Don't print outbox emails (default: printed unless running tests). */
  quietOutbox?: boolean;
  /** Each club database's sign-in limits (default: as in a single-club app). */
  clubRateLimits?: Partial<RateLimitConfig>;
  /** Sign-up / find-my-club limits (default: PLATFORM_RATE_LIMITS, ×10 on a dev server). */
  platformRateLimits?: Partial<PlatformRateLimitConfig>;
}

export function createPlatform(options: CreatePlatformOptions): Platform {
  const db = createPlatformDb(options.platformDbFile);
  const registry = new ClubRegistry({
    db,
    hosted: options.hosted,
    clubsDir: options.clubsDir,
    clubRateLimits: options.clubRateLimits,
  });
  const mailer = createPlatformMailer({
    db,
    hosted: options.hosted,
    smtp: options.smtp ?? null,
    transportFactory: options.transportFactory,
    quiet: options.quietOutbox,
  });
  let closed = false;
  return {
    hosted: options.hosted,
    db,
    registry,
    mailer,
    limiter: new PlatformRateLimiter(options.platformRateLimits),
    close() {
      if (closed) return;
      closed = true;
      registry.closeAll();
      closePlatformDb(db);
    },
  };
}

export { ClubRegistry, SlugTakenError, type ListClubsFilter, type NewClubInput } from './registry';
export { clubHost, clubUrl, matchHost, type HostMatch } from './hosts';
export type { PlatformMailer, PlatformEmail, PlatformSendResult } from './mailer';
