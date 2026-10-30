/**
 * When the next automatic confirmation email goes out, mirroring the scheduler (spec F5,
 * server/services/scheduler.ts): on `day` at or after `timeMin` (club time) it sends for the
 * week starting on the Monday on/after that day.
 *
 * Like the scheduler, a send that was due but never went out (the server was down, or the
 * schedule was just changed or switched on) still goes out while its week isn't over: the
 * next tick sends it, right after saving. `sentWeeks` (the weeks already sent, from
 * GET /api/settings) tells the two apart; without it every earlier send is assumed done.
 */
import { addDays, nowMinutesInTz, todayInTz, weekdayOf } from '../../../shared/time';

export interface NextConfirmationSend {
  /** Club-local date of the next send (for an overdue one, the day it was due). */
  date: string;
  /** Monday of the week it covers. */
  weekStart: string;
  /** Sunday of that week. */
  weekEnd: string;
  /** Due already and not sent: it goes out on the scheduler's next tick (within a minute). */
  overdue: boolean;
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
  /** Mondays of the weeks whose automatic send already ran. */
  sentWeeks?: readonly string[];
}): NextConfirmationSend {
  const now = params.now ?? new Date();
  const today = todayInTz(params.timeZone, now);
  const timePassed = nowMinutesInTz(params.timeZone, now) >= params.timeMin;
  const send = (date: string, overdue: boolean): NextConfirmationSend => {
    const weekStart = mondayOnOrAfter(date);
    return { date, weekStart, weekEnd: addDays(weekStart, 6), overdue };
  };

  if (params.sentWeeks) {
    // The most recent scheduled send (today once the time has passed), if its week isn't over.
    let daysAgo = (weekdayOf(today) - params.day + 7) % 7;
    if (daysAgo === 0 && !timePassed) daysAgo = 7;
    const last = send(addDays(today, -daysAgo), true);
    if (last.weekEnd >= today && !params.sentWeeks.includes(last.weekStart)) return last;
  }

  let diff = (params.day - weekdayOf(today) + 7) % 7;
  // Today's send time has passed: it already went out (or is going out now).
  if (diff === 0 && timePassed) diff = 7;
  const next = send(addDays(today, diff), false);
  return params.sentWeeks?.includes(next.weekStart) ? send(addDays(next.date, 7), false) : next;
}
