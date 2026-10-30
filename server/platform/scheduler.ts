/**
 * The hosted-mode scheduler: one interval for the whole server. Each tick
 *
 * 1. runs the ordinary club tick (`runSchedulerTick`, server/services/scheduler.ts) for every
 *    **active** club, one after another, each with its own state (cleanup once per club-local
 *    day) and its own try/catch, so one club's failure never stops the others. Suspended and
 *    archived clubs are skipped: no email goes out for them.
 * 2. then runs the platform jobs, each in its own try/catch. Built in: a daily cleanup of
 *    stale sign-up handoffs and owner-console sessions/codes. server/index.ts adds the
 *    nightly backup (./backups.ts) the same way:
 *
 *      startPlatformScheduler(platform, { jobs: [...DEFAULT_PLATFORM_JOBS, nightlyBackupJob(…)] });
 *
 * A job decides for itself whether it is due (`platform_job_runs` holds idempotency keys such
 * as `backup:2026-11-02`, see claimPlatformJob).
 */
import { todayInTz } from '../../shared/time';
import { env } from '../env';
import {
  createSchedulerState,
  runSchedulerTick,
  SCHEDULER_INTERVAL_MS,
  type SchedulerState,
  type SchedulerTickResult,
} from '../services/scheduler';
import { deleteStaleAdminAuth } from './adminAuth';
import { deleteStaleHandoffs } from './handoffs';
import type { Platform } from './index';
import { platformJobRuns } from './schema';

export interface PlatformJobContext {
  platform: Platform;
  now: Date;
}

/** A platform-level job, run once per tick after the clubs. */
export interface PlatformJob {
  name: string;
  run(context: PlatformJobContext): void | Promise<void>;
}

export interface PlatformSchedulerState {
  /** Per-club tick state, by club id. */
  clubs: Map<number, SchedulerState>;
  /** Free-form state for platform jobs, by job name. */
  jobs: Map<string, unknown>;
  /** A tick is in flight. */
  running: boolean;
}

export function createPlatformSchedulerState(): PlatformSchedulerState {
  return { clubs: new Map(), jobs: new Map(), running: false };
}

export interface PlatformTickResult {
  /** Each active club's tick result (or its error), by slug. */
  clubs: Record<string, SchedulerTickResult | { error: string }>;
  /** Platform jobs that threw, by name. */
  jobErrors: Record<string, string>;
}

/**
 * Claim a platform job run (`platform_job_runs`): true when this caller inserted `key`, false
 * when it already ran. Claim before doing the work, so it happens at most once.
 */
export function claimPlatformJob(platform: Platform, key: string, now = Date.now()): boolean {
  return (
    platform.db.insert(platformJobRuns).values({ key, ranAt: now }).onConflictDoNothing().run().changes === 1
  );
}

/**
 * Daily (UTC): delete sign-up handoffs that expired or were used over a day ago, and
 * owner-console sessions and sign-in codes that are no longer any use.
 */
export const handoffCleanupJob: PlatformJob = {
  name: 'handoff-cleanup',
  run({ platform, now }) {
    if (!claimPlatformJob(platform, `handoff-cleanup:${todayInTz('UTC', now)}`, now.getTime())) return;
    deleteStaleHandoffs(platform.db, now.getTime());
    deleteStaleAdminAuth(platform.db, now.getTime());
  },
};

export const DEFAULT_PLATFORM_JOBS: readonly PlatformJob[] = [handoffCleanupJob];

export interface PlatformTickOptions {
  now?: Date;
  state?: PlatformSchedulerState;
  jobs?: readonly PlatformJob[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One pass over every active club, then the platform jobs. Exported for tests. */
export async function runPlatformTick(platform: Platform, options: PlatformTickOptions = {}): Promise<PlatformTickResult> {
  const now = options.now ?? new Date();
  const state = options.state ?? createPlatformSchedulerState();
  const result: PlatformTickResult = { clubs: {}, jobErrors: {} };
  const active = platform.registry.listClubs({ status: 'active' });

  for (const club of active) {
    let clubState = state.clubs.get(club.id);
    if (!clubState) {
      clubState = createSchedulerState();
      state.clubs.set(club.id, clubState);
    }
    try {
      result.clubs[club.slug] = await runSchedulerTick(platform.registry.openClubDb(club), { now, state: clubState });
    } catch (err) {
      result.clubs[club.slug] = { error: errorText(err) };
      if (!env.isTest) console.error(`[scheduler] club ${club.slug} (#${club.id}) tick failed:`, err);
    }
  }
  // Forget state of clubs that are no longer active.
  const activeIds = new Set(active.map((c) => c.id));
  for (const id of state.clubs.keys()) if (!activeIds.has(id)) state.clubs.delete(id);

  for (const job of options.jobs ?? DEFAULT_PLATFORM_JOBS) {
    try {
      await job.run({ platform, now });
    } catch (err) {
      result.jobErrors[job.name] = errorText(err);
      if (!env.isTest) console.error(`[scheduler] platform job ${job.name} failed:`, err);
    }
  }
  return result;
}

export interface StartPlatformSchedulerOptions {
  intervalMs?: number;
  jobs?: readonly PlatformJob[];
}

/** Start the hosted-mode scheduler. Returns a function that stops it. */
export function startPlatformScheduler(platform: Platform, options: StartPlatformSchedulerOptions = {}): () => void {
  const state = createPlatformSchedulerState();
  let stopped = false;

  async function tick() {
    if (stopped || state.running) return;
    state.running = true;
    try {
      await runPlatformTick(platform, { state, jobs: options.jobs });
    } catch (err) {
      if (!stopped) console.error('[scheduler] tick failed:', err);
    } finally {
      state.running = false;
    }
  }

  // First pass shortly after boot (catches up on sends missed while down), then every minute.
  const first = setTimeout(() => void tick(), 1_000);
  const interval = setInterval(() => void tick(), options.intervalMs ?? SCHEDULER_INTERVAL_MS);
  first.unref();
  interval.unref();

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(interval);
  };
}
