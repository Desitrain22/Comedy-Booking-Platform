/** Small copy helpers for the dashboard (pure; unit-tested in format.test.ts). */
import type { DashboardResponse, MonthAvailabilityProgress, NextConfirmationSend } from '../../../shared/api/dashboard';
import { addDays, formatDateMedium, formatDateShort, formatTime, monthOf, todayInTz } from '../../../shared/time';
import type { AvailabilityRequestKind } from '../../../shared/types';

/** plural(1, 'comedian') → "1 comedian", plural(3, 'spot') → "3 spots". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "John Mercer" → "John". */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "today" / "tomorrow" / "Mon, Nov 2" relative to `today`. */
export function relativeDay(date: string, today: string): string {
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  return formatDateMedium(date);
}

/**
 * "Mon, Nov 2 at 10 AM", "today at 10 AM", or "Any minute now" for a send that is already
 * due (e.g. one missed while the server was down: it goes out on the scheduler's next tick).
 */
export function formatNextSend(next: NextConfirmationSend, today: string, nowMs?: number): string {
  if (nowMs !== undefined && next.at <= nowMs) return 'Any minute now';
  return `${relativeDay(next.date, today)} at ${formatTime(next.startMin)}`;
}

/** "Oct 26 – Nov 1", or "Nov 2 – 8" within one month. */
export function formatWeekRange(weekStart: string, weekEnd: string): string {
  if (monthOf(weekStart) === monthOf(weekEnd)) return `${formatDateShort(weekStart)} – ${Number(weekEnd.slice(8))}`;
  return `${formatDateShort(weekStart)} – ${formatDateShort(weekEnd)}`;
}

/** "7 PM @ The Cellar". */
export function spotLabel(startMin: number, locationName: string): string {
  return `${formatTime(startMin)} @ ${locationName}`;
}

/** Whole-number percentage, 0 when there is nothing to measure. */
export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/** "Tonight" for tonight's club night, else "Thu, Nov 5". */
export function nightLabel(date: string, tonight: string): string {
  return date === tonight ? 'Tonight' : formatDateMedium(date);
}

// ---------------------------------------------------------------------------
// Tonight
// ---------------------------------------------------------------------------

export interface TonightCounts {
  shows: number;
  booked: number;
  confirmed: number;
  unconfirmed: number;
  declined: number;
}

/** Scheduled shows tonight and how their bookings stand. */
export function tonightCounts(data: Pick<DashboardResponse, 'tonight' | 'unconfirmedTonight'>): TonightCounts {
  const scheduled = data.tonight.filter((s) => s.status === 'scheduled');
  const booked = scheduled.reduce((n, s) => n + s.bookedCount, 0);
  const confirmed = scheduled.reduce((n, s) => n + s.confirmedCount, 0);
  const declined = scheduled.reduce((n, s) => n + s.bookings.filter((b) => b.status === 'declined').length, 0);
  return { shows: scheduled.length, booked, confirmed, unconfirmed: data.unconfirmedTonight.length, declined };
}

/**
 * The line under the dashboard's date: "3 shows tonight · 14 booked · 2 unconfirmed".
 * Never claims "all confirmed" when nobody is booked.
 */
export function tonightSummary(counts: TonightCounts): string {
  if (counts.shows === 0) return 'No shows tonight';
  const parts = [`${plural(counts.shows, 'show')} tonight`];
  if (counts.booked === 0) {
    parts.push('No one is booked yet');
    return parts.join(' · ');
  }
  parts.push(`${counts.booked} booked`);
  if (counts.unconfirmed > 0) parts.push(`${counts.unconfirmed} unconfirmed`);
  if (counts.declined > 0) parts.push(`${counts.declined} declined`);
  if (counts.unconfirmed === 0 && counts.declined === 0) parts.push('all confirmed');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Availability requests
// ---------------------------------------------------------------------------

/**
 * What the request dialog starts on for a month: a reminder once the month has been asked
 * for and someone still hasn't submitted (re-asking emails everyone again), else a request.
 */
export function defaultRequestKind(progress: MonthAvailabilityProgress | undefined): AvailabilityRequestKind {
  return progress?.lastRequest && progress.notSubmitted > 0 ? 'reminder' : 'request';
}

/**
 * "You asked on Oct 22 · 18 of 29 have submitted" (plus "· reminded Oct 27" when a later
 * reminder went out), or null when the month was never asked for. Dates in the club timezone.
 */
export function askedLine(progress: MonthAvailabilityProgress | undefined, timeZone: string): string | null {
  const request = progress?.lastRequest;
  if (!progress || !request) return null;
  const day = (at: number) => formatDateShort(todayInTz(timeZone, new Date(at)));
  const who = request.audience === 'all' ? '' : ` ${request.audienceLabel}`;
  const parts = [
    `You asked${who} on ${day(request.sentAt)}`,
    `${progress.submitted} of ${progress.total} ${progress.submitted === 1 ? 'has' : 'have'} submitted`,
  ];
  const reminder = progress.lastReminder;
  if (reminder && reminder.sentAt > request.sentAt) parts.splice(1, 0, `reminded ${day(reminder.sentAt)}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Getting started (new clubs)
// ---------------------------------------------------------------------------

export type SetupStepId = 'location' | 'comedians' | 'shows' | 'email' | 'availability';

export interface SetupStep {
  id: SetupStepId;
  done: boolean;
}

/**
 * The new-club checklist, in order. "Connect email" is an admin's job, so bookers don't see it.
 */
export function setupSteps(
  data: Pick<DashboardResponse, 'setup' | 'emailConfigured'>,
  isAdmin: boolean,
): SetupStep[] {
  const { setup } = data;
  const steps: SetupStep[] = [
    { id: 'location', done: setup.locations > 0 },
    { id: 'comedians', done: setup.comedians > 0 },
    { id: 'shows', done: setup.shows > 0 },
  ];
  if (isAdmin) steps.push({ id: 'email', done: data.emailConfigured });
  steps.push({ id: 'availability', done: setup.availabilityRequests > 0 });
  return steps;
}

/**
 * Show the checklist while something besides email is left to do. A running club that only
 * lacks email gets the slimmer "emails are in the outbox" banner instead (admins).
 */
export function showChecklist(steps: SetupStep[]): boolean {
  return steps.some((s) => !s.done && s.id !== 'email');
}
