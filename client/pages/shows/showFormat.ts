/** Pure formatting and selection helpers for F1 pages (unit-tested in showFormat.test.ts). */
import { datesForWeekday, formatMonthName, formatTime, formatTimeShort, monthOf } from '../../../shared/time';

/** "The Cellar" → "Cellar" (pills are tight; the full name is in the accessible label). */
export function shortLocationName(name: string): string {
  const short = name.replace(/^the\s+/i, '').trim();
  return short || name;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Pill text: "7:30 · Cellar · 5/7". */
export function pillLabel(show: { startMin: number; locationName: string; bookedCount: number; slotCount: number }) {
  return `${formatTimeShort(show.startMin)} · ${shortLocationName(show.locationName)} · ${show.bookedCount}/${show.slotCount}`;
}

/** Screen-reader label for a calendar pill. */
export function pillAriaLabel(show: {
  startMin: number;
  name: string;
  locationName: string;
  bookedCount: number;
  slotCount: number;
  unconfirmedTodayCount: number;
  status: 'scheduled' | 'cancelled';
}): string {
  const parts = [
    `${formatTime(show.startMin)}${show.name ? ` ${show.name}` : ''} at ${show.locationName}`,
    `${show.bookedCount} of ${show.slotCount} booked`,
  ];
  if (show.unconfirmedTodayCount > 0) parts.push(`${show.unconfirmedTodayCount} unconfirmed tonight`);
  if (show.status === 'cancelled') parts.push('cancelled');
  return `${parts.join(', ')}. Edit show`;
}

/** "Fridays", "Sundays" … */
export const WEEKDAY_PLURALS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'] as const;

// ---------------------------------------------------------------------------
// Date selection (create-shows painter)
// ---------------------------------------------------------------------------

/** Dates in `month` on `weekday` that can still be picked (not before `today`). */
export function selectableWeekdayDates(month: string, weekday: number, today: string): string[] {
  return datesForWeekday(month, weekday).filter((d) => d >= today);
}

/** True when every selectable `weekday` in `month` is selected (and there is at least one). */
export function isWeekdayFullySelected(
  selected: ReadonlySet<string>,
  month: string,
  weekday: number,
  today: string,
): boolean {
  const dates = selectableWeekdayDates(month, weekday, today);
  return dates.length > 0 && dates.every((d) => selected.has(d));
}

/** Weekday chip: select every such day in the month, or clear them all if they already are. */
export function toggleWeekday(
  selected: ReadonlySet<string>,
  month: string,
  weekday: number,
  today: string,
): Set<string> {
  const dates = selectableWeekdayDates(month, weekday, today);
  const allOn = isWeekdayFullySelected(selected, month, weekday, today);
  const next = new Set(selected);
  for (const d of dates) {
    if (allOn) next.delete(d);
    else next.add(d);
  }
  return next;
}

/** Apply one paint step: add or remove `dates`. */
export function paintDates(selected: ReadonlySet<string>, dates: readonly string[], mode: 'add' | 'remove'): Set<string> {
  const next = new Set(selected);
  for (const d of dates) {
    if (mode === 'add') next.add(d);
    else next.delete(d);
  }
  return next;
}

/** "November" / "November and December" / "October, November and December" for the selected dates. */
export function monthsPhrase(dates: Iterable<string>): string {
  const months = [...new Set([...dates].map(monthOf))].sort().map(formatMonthName);
  if (months.length <= 1) return months[0] ?? '';
  return `${months.slice(0, -1).join(', ')} and ${months.at(-1)}`;
}

/** Count of dates per month, in month order: [['2026-11', 5], ['2026-12', 3]]. */
export function countByMonth(dates: Iterable<string>): [string, number][] {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(monthOf(d), (counts.get(monthOf(d)) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}
