/** Small copy helpers for the dashboard (pure; unit-tested in format.test.ts). */
import type { NextConfirmationSend } from '../../../shared/api/dashboard';
import { addDays, formatDateMedium, formatDateShort, formatTime, monthOf } from '../../../shared/time';

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

/** "Mon, Nov 2 at 10 AM", "today at 10 AM". */
export function formatNextSend(next: NextConfirmationSend, today: string): string {
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
