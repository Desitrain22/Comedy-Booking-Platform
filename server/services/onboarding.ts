/**
 * Setup guide (onboarding) state for one booker (`GET /api/onboarding`, onboarding design §2).
 *
 * Steps are derived from club data (never from clicks), so the guide advances when the real
 * thing happened: shows exist, comedians exist, an availability request went out for a month
 * with shows. The per-booker flags (`guideDismissedAt`, `guideCompletedAt`) only say whether
 * the guide should start on its own. See shared/api/onboarding.ts for the rules (incl. mode).
 */
import { and, count, eq, gte, inArray, min, sql } from 'drizzle-orm';
import {
  SHOWS_TARGET,
  type GuideMode,
  type OnboardingCounts,
  type OnboardingResponse,
  type OnboardingStep,
  type OnboardingStepKey,
  type OnboardingStepStatus,
} from '../../shared/api/onboarding';
import { firstDayOfMonth, monthOf, planningMonth, todayInTz } from '../../shared/time';
import type { Role } from '../../shared/types';
import type { DbOrTx } from '../db/client';
import { availabilityRequests, comedians, locations, shows, users } from '../db/schema';
import { isEmailConfigured } from '../email/mailer';
import { getSettings } from '../lib/settings';

export interface OnboardingBooker {
  id: number;
  role: Role;
}

export type GuideAction = 'dismiss' | 'resume' | 'complete';

const countOf = (rows: { n: number }[]) => rows[0]?.n ?? 0;

/** `YYYY-MM` of a show's date, in SQL. */
const showMonth = sql<string>`substr(${shows.date}, 1, 7)`;

/** Scheduled shows per month, from `fromMonth` on. */
function scheduledShowsByMonth(db: DbOrTx, fromMonth: string): Map<string, number> {
  const rows = db
    .select({ month: showMonth, n: count() })
    .from(shows)
    .where(and(eq(shows.status, 'scheduled'), gte(shows.date, firstDayOfMonth(fromMonth))))
    .groupBy(showMonth)
    .all();
  return new Map(rows.map((r) => [r.month, r.n]));
}

/**
 * The month the guide works on: the planning month when it has shows, else the upcoming month
 * with the most shows (earliest on a tie), else the planning month.
 */
export function pickSuggestedMonth(planning: string, showsByMonth: ReadonlyMap<string, number>): string {
  if ((showsByMonth.get(planning) ?? 0) > 0) return planning;
  let best: string | null = null;
  let bestCount = 0;
  for (const [month, n] of [...showsByMonth].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > bestCount) {
      best = month;
      bestCount = n;
    }
  }
  return best ?? planning;
}

/** An availability request or reminder went out for a month that has scheduled shows. */
function requestedForAMonthWithShows(db: DbOrTx): boolean {
  const monthsWithShows = db
    .selectDistinct({ month: showMonth })
    .from(shows)
    .where(eq(shows.status, 'scheduled'));
  const row = db
    .select({ id: availabilityRequests.id })
    .from(availabilityRequests)
    .where(inArray(availabilityRequests.month, monthsWithShows))
    .limit(1)
    .get();
  return row != null;
}

function counts(db: DbOrTx): OnboardingCounts {
  return {
    locations: countOf(db.select({ n: count() }).from(locations).where(eq(locations.archived, false)).all()),
    scheduledShows: countOf(db.select({ n: count() }).from(shows).where(eq(shows.status, 'scheduled')).all()),
    comedians: countOf(db.select({ n: count() }).from(comedians).where(eq(comedians.archived, false)).all()),
    bookers: countOf(db.select({ n: count() }).from(users).all()),
  };
}

/** The club's founding booker: the account /setup created (the first user). */
function founderId(db: DbOrTx): number | null {
  return db.select({ id: min(users.id) }).from(users).get()?.id ?? null;
}

/**
 * `setup` for the founding admin, or any admin while shows or comedians aren't done;
 * `tour` for everyone else (bookers, and admins who join a club that's already set up).
 */
export function guideMode(
  booker: OnboardingBooker,
  isFounder: boolean,
  done: Record<OnboardingStepKey, boolean>,
): GuideMode {
  if (booker.role !== 'admin') return 'tour';
  return isFounder || !(done.shows && done.comedians) ? 'setup' : 'tour';
}

export function buildOnboarding(db: DbOrTx, booker: OnboardingBooker, now: Date = new Date()): OnboardingResponse {
  const settings = getSettings(db);
  const today = todayInTz(settings.timezone, now);
  const planning = planningMonth(today);
  const c = counts(db);
  const availabilityRequested = requestedForAMonthWithShows(db);

  const done: Record<OnboardingStepKey, boolean> = {
    club: settings.setupComplete && c.locations > 0,
    shows: c.scheduledShows >= SHOWS_TARGET,
    comedians: c.comedians > 0 && availabilityRequested,
  };
  const order: OnboardingStepKey[] = ['club', 'shows', 'comedians'];
  const currentStep = order.find((key) => !done[key]) ?? null;
  const statusOf = (key: OnboardingStepKey): OnboardingStepStatus =>
    done[key] ? 'done' : key === currentStep ? 'current' : 'todo';
  const steps: OnboardingStep[] = order.map((key) => ({
    key,
    status: statusOf(key),
    ...(key === 'shows' ? { progress: { count: c.scheduledShows, target: SHOWS_TARGET } } : {}),
  }));

  const user = db
    .select({ dismissedAt: users.guideDismissedAt, completedAt: users.guideCompletedAt })
    .from(users)
    .where(eq(users.id, booker.id))
    .get();

  return {
    steps,
    currentStep,
    completedAt: user?.completedAt ?? null,
    dismissedAt: user?.dismissedAt ?? null,
    emailConfigured: isEmailConfigured(db),
    suggestedMonth: pickSuggestedMonth(planning, scheduledShowsByMonth(db, monthOf(today))),
    mode: guideMode(booker, founderId(db) === booker.id, done),
    counts: c,
    availabilityRequested,
  };
}

/**
 * Record a guide action for one booker:
 * - `dismiss` ("Skip guide"): it stops starting on its own until resumed.
 * - `resume` (user menu / Getting started): clears the skip. A finished guide stays finished.
 * - `complete`: finished (or the tour was skipped); keeps the first completion time.
 */
export function updateGuide(db: DbOrTx, userId: number, action: GuideAction, now: number = Date.now()): void {
  if (action === 'dismiss') {
    db.update(users).set({ guideDismissedAt: now }).where(eq(users.id, userId)).run();
  } else if (action === 'resume') {
    db.update(users).set({ guideDismissedAt: null }).where(eq(users.id, userId)).run();
  } else {
    db.update(users)
      .set({ guideCompletedAt: sql`coalesce(${users.guideCompletedAt}, ${now})` })
      .where(eq(users.id, userId))
      .run();
  }
}
