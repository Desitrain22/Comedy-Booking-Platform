/**
 * Background scheduler (spec §6 F5). `startScheduler(db)` runs `runSchedulerTick` every
 * 60s on an unref'd interval (it never keeps the process alive):
 *
 * - **Weekly confirmations**: when confirmationsEnabled, the most recent configured send
 *   (confirmationDay at confirmationTimeMin, club time) targets the Monday on/after that
 *   day. If that week hasn't ended and no `job_runs` row `confirmations:<weekStart>`
 *   exists, claim it and send — so a send missed while the server was down goes out as
 *   soon as it's back (later that week), not never. The claim happens before sending, so a
 *   week is sent at most once even with overlapping ticks or several processes. The send
 *   uses `onlyUnsent` so comedians already emailed for that week (e.g. by "Send
 *   confirmations now") aren't emailed twice.
 * - **Daily catch-up** (when confirmationsEnabled and catchUpEnabled): every day at
 *   confirmationTimeMin, claim `catch-up:<club date>` and email the comedians with spots
 *   in the current Mon–Sun week (today on) that are unconfirmed, not declined and were
 *   never emailed — bookings made after the week's confirmations went out. Runs after the
 *   weekly send in the same tick and skips the week that send just covered, and both use
 *   `onlyUnsent`, so nobody is emailed twice for the same spots.
 * - **Daily cleanup** of expired sessions, stale login codes and expired tokens: on the
 *   first tick and whenever the club-local date changes.
 */
import { eq } from 'drizzle-orm';
import type { NextConfirmationSend } from '../../shared/api/dashboard';
import { addDays, nowMinutesInTz, todayInTz, weekdayOf, weekStartOf, zonedTimeToUtc } from '../../shared/time';
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

/**
 * `job_runs` key for a day's catch-up send (club-local calendar `date`): this week's
 * not-yet-emailed bookings, emailed daily at confirmationTimeMin when catchUpEnabled.
 */
export function catchUpJobKey(date: string): string {
  return `catch-up:${date}`;
}

/** The Monday on or after `date`. */
export function mondayOnOrAfter(date: string): string {
  return addDays(date, (8 - weekdayOf(date)) % 7);
}

function hasRun(db: DbOrTx, key: string): boolean {
  return db.select({ key: jobRuns.key }).from(jobRuns).where(eq(jobRuns.key, key)).get() !== undefined;
}

export interface DueConfirmationSend {
  /** Club-local date of the scheduled send (the configured weekday, on or before today). */
  date: string;
  /** Monday of the week it covers (the Monday on/after `date`). */
  weekStart: string;
}

/**
 * The most recent scheduled weekly send at or before `now` (club time) whose week hasn't
 * ended yet, ignoring whether it was already sent. Null when automatic sends are off or
 * that week is over. With a Monday 10 AM schedule: Mon 9:59 AM → null (last week is over);
 * Mon 10 AM … Sun → this week. With Thursday 5 PM: Thu 5 PM → next week; Fri–Wed → the
 * same week (still not over), so a Thursday missed while the server was down is caught up.
 */
export function lastDueConfirmationSend(settings: Settings, now: Date): DueConfirmationSend | null {
  if (!settings.confirmationsEnabled) return null;
  const today = todayInTz(settings.timezone, now);
  let daysAgo = (weekdayOf(today) - settings.confirmationDay + 7) % 7;
  if (daysAgo === 0 && nowMinutesInTz(settings.timezone, now) < settings.confirmationTimeMin) daysAgo = 7;
  const date = addDays(today, -daysAgo);
  const weekStart = mondayOnOrAfter(date);
  if (addDays(weekStart, 6) < today) return null;
  return { date, weekStart };
}

/**
 * The week whose confirmations are due at `now` (see `lastDueConfirmationSend`), ignoring
 * whether they were already sent.
 */
export function dueConfirmationWeek(settings: Settings, now: Date): string | null {
  return lastDueConfirmationSend(settings, now)?.weekStart ?? null;
}

/**
 * The club-local date whose daily catch-up is due at `now`, ignoring whether it already
 * ran: today once confirmationTimeMin has passed, when automatic confirmations and the
 * catch-up are both on. Null otherwise.
 */
export function dueCatchUpDate(settings: Settings, now: Date): string | null {
  if (!settings.confirmationsEnabled || !settings.catchUpEnabled) return null;
  if (nowMinutesInTz(settings.timezone, now) < settings.confirmationTimeMin) return null;
  return todayInTz(settings.timezone, now);
}

/**
 * When the next automatic send happens (club-local date + time), skipping weeks that
 * were already sent. Null when automatic sends are off. A send that is due but hasn't
 * fired yet (it will within a minute) is returned as-is, at `now` — including one that
 * was missed earlier in a week that isn't over.
 */
export function nextConfirmationSend(db: DbOrTx, now: Date = new Date()): NextConfirmationSend | null {
  const s = getSettings(db);
  if (!s.confirmationsEnabled) return null;
  const overdue = lastDueConfirmationSend(s, now);
  if (overdue && !hasRun(db, confirmationsJobKey(overdue.weekStart))) {
    return { date: overdue.date, startMin: s.confirmationTimeMin, at: now.getTime(), weekStart: overdue.weekStart };
  }
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
  /**
   * Set when this tick ran the daily catch-up (claimed `catch-up:<date>`). `sent` is 0
   * when the weekly send in the same tick already covered this week.
   */
  catchUp: (SendConfirmationsResult & { date: string; weekStart: string }) | null;
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
  const result: SchedulerTickResult = { confirmations: null, catchUp: null, cleanup: null };

  const today = todayInTz(settings.timezone, now);
  if (state.lastCleanupDate !== today) {
    state.lastCleanupDate = today;
    result.cleanup = runCleanup(db, now.getTime());
  }

  if (!settings.setupComplete) return result;

  const weekStart = dueConfirmationWeek(settings, now);
  if (weekStart && claim(db, confirmationsJobKey(weekStart), now)) {
    const sent = await sendConfirmationsForWeek(db, weekStart, { onlyUnsent: true, now });
    result.confirmations = { weekStart, ...sent };
    if (!env.isTest) {
      console.log(
        `[scheduler] Weekly confirmations for the week of ${weekStart}: ${sent.sent} emailed, ${sent.failed} failed.`,
      );
    }
  }

  // Daily catch-up: this week's spots booked after its confirmations went out.
  const catchUpDate = dueCatchUpDate(settings, now);
  if (catchUpDate && claim(db, catchUpJobKey(catchUpDate), now)) {
    const thisWeek = weekStartOf(catchUpDate);
    // The weekly send just went out for this very week (onlyUnsent): nothing is left to
    // catch up, and retrying its failures a moment later wouldn't help.
    const sent: SendConfirmationsResult =
      result.confirmations?.weekStart === thisWeek
        ? { sent: 0, failed: 0, comedianIds: [] }
        : await sendConfirmationsForWeek(db, thisWeek, { onlyUnsent: true, now });
    result.catchUp = { date: catchUpDate, weekStart: thisWeek, ...sent };
    if (!env.isTest && (sent.sent > 0 || sent.failed > 0)) {
      console.log(`[scheduler] Catch-up confirmations for ${catchUpDate}: ${sent.sent} emailed, ${sent.failed} failed.`);
    }
  }
  return result;
}

/** Insert the `job_runs` row; true when this caller claimed it (it didn't exist yet). */
function claim(db: Db, key: string, now: Date): boolean {
  return db.insert(jobRuns).values({ key, ranAt: now.getTime() }).onConflictDoNothing().run().changes === 1;
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
