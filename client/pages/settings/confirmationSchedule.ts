/**
 * When the next automatic confirmation email goes out, mirroring the scheduler (spec F5):
 * on `day` at or after `timeMin` (club time) it sends for the week starting on the
 * Monday on/after that day.
 */
import { addDays, nowMinutesInTz, todayInTz, weekdayOf } from '../../../shared/time';

export interface NextConfirmationSend {
  /** Club-local date of the next send. */
  date: string;
  /** Monday of the week it covers. */
  weekStart: string;
  /** Sunday of that week. */
  weekEnd: string;
}

/** Monday on/after `date` (the date itself when it's a Monday). */
export function mondayOnOrAfter(date: string): string {
  return addDays(date, (8 - weekdayOf(date)) % 7);
}

export function nextConfirmationSend(params: {
  day: number;
  timeMin: number;
  timeZone: string;
  now?: Date;
}): NextConfirmationSend {
  const now = params.now ?? new Date();
  const today = todayInTz(params.timeZone, now);
  let diff = (params.day - weekdayOf(today) + 7) % 7;
  // Today's send time has passed: it already went out (or is going out now).
  if (diff === 0 && nowMinutesInTz(params.timeZone, now) >= params.timeMin) diff = 7;
  const date = addDays(today, diff);
  const weekStart = mondayOnOrAfter(date);
  return { date, weekStart, weekEnd: addDays(weekStart, 6) };
}
