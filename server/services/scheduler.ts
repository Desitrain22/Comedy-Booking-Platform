/**
 * Background scheduler (spec §6 F5). `startScheduler(db)` runs `runSchedulerTick` every
 * 60s on an unref'd interval (it never keeps the process alive):
 *
 * - **Weekly confirmations**: when confirmationsEnabled, the club-local weekday is
 *   confirmationDay and the local time has reached confirmationTimeMin, the target week
 *   is the Monday on/after today. If no `job_runs` row `confirmations:<weekStart>` exists,
 *   claim it and send. The claim happens before sending, so a week is sent at most once
 *   even with overlapping ticks or several processes. The send uses `onlyUnsent` so
 *   comedians already emailed for that week (e.g. by "Send confirmations now") aren't
 *   emailed twice.
 * - **Daily cleanup** of expired sessions, stale login codes and expired tokens: on the
 *   first tick and whenever the club-local date changes.
 */
import { eq } from 'drizzle-orm';
import type { NextConfirmationSend } from '../../shared/api/dashboard';
import { addDays, nowMinutesInTz, todayInTz, weekdayOf, zonedTimeToUtc } from '../../shared/time';
import { deleteStaleLoginCodes } from '../auth/codes';
import { deleteExpiredSessions } from '../auth/sessions';
import { deleteExpiredTokens } from '../auth/tokens';
import type { Db, DbOrTx } from '../db/client';
import { jobRuns, type Settings } from '../db/schema';
import { env } from '../env';
import { getSettings } from '../lib/settings';
import { sendConfirmationsForWeek, type SendConfirmationsResult } from './confirmations';

export const SCHEDULER_INTERVAL_MS = 60_000;

/** `job_runs` key for a week's automatic confirmations. */
export function confirmationsJobKey(weekStart: string): string {
  return `confirmations:${weekStart}`;
}

/** The Monday on or after `date`. */
export function mondayOnOrAfter(date: string): string {
  return addDays(date, (8 - weekdayOf(date)) % 7);
}

function hasRun(db: DbOrTx, key: string): boolean {
  return db.select({ key: jobRuns.key }).from(jobRuns).where(eq(jobRuns.key, key)).get() !== undefined;
}

/**
 * The week whose confirmations are due at `now` (club time), ignoring whether they were
 * already sent: null unless enabled, on the configured weekday, at/after the time.
 */
export function dueConfirmationWeek(settings: Settings, now: Date): string | null {
  if (!settings.confirmationsEnabled) return null;
  const today = todayInTz(settings.timezone, now);
  if (weekdayOf(today) !== settings.confirmationDay) return null;
  if (nowMinutesInTz(settings.timezone, now) < settings.confirmationTimeMin) return null;
  return mondayOnOrAfter(today);
}

/**
 * When the next automatic send happens (club-local date + time), skipping weeks that
 * were already sent. Null when automatic sends are off. A send that is due but hasn't
 * fired yet (it will within a minute) is returned as-is.
 */
export function nextConfirmationSend(db: DbOrTx, now: Date = new Date()): NextConfirmationSend | null {
  const s = getSettings(db);
  if (!s.confirmationsEnabled) return null;
  const today = todayInTz(s.timezone, now);
  const nowMin = nowMinutesInTz(s.timezone, now);
  for (let i = 0; i <= 7; i++) {
    const date = addDays(today, i);
    if (weekdayOf(date) !== s.confirmationDay) continue;
    const weekStart = mondayOnOrAfter(date);
    if (hasRun(db, confirmationsJobKey(weekStart))) continue;
    // Today, earlier than now, and not run: due (fires on the next tick).
    if (i === 0 && nowMin >= s.confirmationTimeMin) {
      return { date, startMin: s.confirmationTimeMin, at: now.getTime(), weekStart };
    }
    return { date, startMin: s.confirmationTimeMin, at: zonedTimeToUtc(date, s.confirmationTimeMin, s.timezone), weekStart };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface SchedulerState {
  /** Club-local date of the last cleanup run. */
  lastCleanupDate: string | null;
  /** A tick is in flight (sending can outlast the interval). */
  running: boolean;
}

export function createSchedulerState(): SchedulerState {
  return { lastCleanupDate: null, running: false };
}

export interface CleanupResult {
  sessions: number;
  loginCodes: number;
  tokens: number;
}

export interface SchedulerTickResult {
  /** Set when this tick sent a week's confirmations. */
  confirmations: (SendConfirmationsResult & { weekStart: string }) | null;
  /** Set when this tick ran the daily cleanup. */
  cleanup: CleanupResult | null;
}

export interface SchedulerTickOptions {
  /** Clock override for tests. */
  now?: Date;
  /** Carry state between ticks (cleanup once per club-local day). */
  state?: SchedulerState;
}

export function runCleanup(db: DbOrTx, now = Date.now()): CleanupResult {
  return {
    sessions: deleteExpiredSessions(db, now),
    loginCodes: deleteStaleLoginCodes(db, now),
    tokens: deleteExpiredTokens(db, now),
  };
}

/** One scheduler pass. Exported for tests; `startScheduler` calls it every minute. */
export async function runSchedulerTick(db: Db, options: SchedulerTickOptions = {}): Promise<SchedulerTickResult> {
  const now = options.now ?? new Date();
  const state = options.state ?? createSchedulerState();
  const settings = getSettings(db);
  const result: SchedulerTickResult = { confirmations: null, cleanup: null };

  const today = todayInTz(settings.timezone, now);
  if (state.lastCleanupDate !== today) {
    state.lastCleanupDate = today;
    result.cleanup = runCleanup(db, now.getTime());
  }

  const weekStart = settings.setupComplete ? dueConfirmationWeek(settings, now) : null;
  if (weekStart) {
    const claimed =
      db
        .insert(jobRuns)
        .values({ key: confirmationsJobKey(weekStart), ranAt: now.getTime() })
        .onConflictDoNothing()
        .run().changes === 1;
    if (claimed) {
      const sent = await sendConfirmationsForWeek(db, weekStart, { onlyUnsent: true, now });
      result.confirmations = { weekStart, ...sent };
      if (!env.isTest) {
        console.log(
          `[scheduler] Weekly confirmations for the week of ${weekStart}: ${sent.sent} emailed, ${sent.failed} failed.`,
        );
      }
    }
  }
  return result;
}

/** Start background jobs. Returns a function that stops them. */
export function startScheduler(db: Db, options: { intervalMs?: number } = {}): () => void {
  const state = createSchedulerState();
  let stopped = false;

  async function tick() {
    if (stopped || state.running) return;
    state.running = true;
    try {
      await runSchedulerTick(db, { state });
    } catch (err) {
      if (!stopped) console.error('[scheduler] tick failed:', err);
    } finally {
      state.running = false;
    }
  }

  // First pass shortly after boot (so a send that came due while the server was down
  // goes out), then every minute.
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
