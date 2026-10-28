/**
 * Pure logic behind the availability painter (/portal). A *draft* is the month's nights
 * as the comedian is editing them: date → range, one range per night. Nothing persists
 * until Save, which sends `entriesFromDraft(draft)` as the whole month.
 */
import {
  AVAILABILITY_MAX_END,
  AVAILABILITY_MIN_START,
  isSameRange,
  type AvailabilityEntry,
  type AvailabilityRange,
} from '../../../shared/availability';
import { AVAILABILITY_STEP_MIN } from '../../../shared/api/portal';
import { datesForWeekday, formatRange, timeOptions, type TimeOption } from '../../../shared/time';

export type Draft = ReadonlyMap<string, AvailabilityRange>;

/** What a tap or drag paints: the club's all-night range, a custom range, or "not available" (erase). */
export type BrushKind = 'allNight' | 'custom' | 'off';

export function draftFromEntries(entries: readonly AvailabilityEntry[]): Draft {
  return new Map(entries.map((e) => [e.date, { startMin: e.startMin, endMin: e.endMin }]));
}

/** The draft as a sorted entry list (the PUT body), optionally only nights on/after `from`. */
export function entriesFromDraft(draft: Draft, from?: string): AvailabilityEntry[] {
  return [...draft]
    .filter(([date]) => !from || date >= from)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, r]) => ({ date, startMin: r.startMin, endMin: r.endMin }));
}

/**
 * Paint `dates` with `range` (null erases). Painting over a night replaces its range.
 * Returns the same object when nothing changes, so React can skip the re-render.
 */
export function paint(draft: Draft, dates: readonly string[], range: AvailabilityRange | null): Draft {
  let next: Map<string, AvailabilityRange> | null = null;
  for (const date of dates) {
    const current = (next ?? draft).get(date);
    const unchanged = range ? current != null && isSameRange(current, range) : current == null;
    if (unchanged) continue;
    next ??= new Map(draft);
    if (range) next.set(date, { startMin: range.startMin, endMin: range.endMin });
    else next.delete(date);
  }
  return next ?? draft;
}

export function sameDraft(a: Draft, b: Draft): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [date, range] of a) {
    const other = b.get(date);
    if (!other || !isSameRange(range, other)) return false;
  }
  return true;
}

/** Every day of `weekday` (0 = Sun) in the month that isn't before `today`. */
export function paintableWeekdayDates(month: string, weekday: number, today: string): string[] {
  return datesForWeekday(month, weekday).filter((d) => d >= today);
}

/** Start-time options: 4 PM … 1:30 AM, half-hour steps. */
export const START_OPTIONS: readonly TimeOption[] = timeOptions(
  AVAILABILITY_MIN_START,
  AVAILABILITY_MAX_END - AVAILABILITY_STEP_MIN,
  AVAILABILITY_STEP_MIN,
);

/** End-time options: 4:30 PM … 2 AM, half-hour steps. */
export const END_OPTIONS: readonly TimeOption[] = timeOptions(
  AVAILABILITY_MIN_START + AVAILABILITY_STEP_MIN,
  AVAILABILITY_MAX_END,
  AVAILABILITY_STEP_MIN,
);

/** A new start keeps the end when it's still later; otherwise the end moves to start + 2h (capped at 2 AM). */
export function withStart(range: AvailabilityRange, startMin: number): AvailabilityRange {
  if (range.endMin > startMin) return { startMin, endMin: range.endMin };
  return { startMin, endMin: Math.min(startMin + 120, AVAILABILITY_MAX_END) };
}

/** A new end keeps the start when it's still earlier; otherwise the start moves to end − 2h (not before 4 PM). */
export function withEnd(range: AvailabilityRange, endMin: number): AvailabilityRange {
  if (range.startMin < endMin) return { startMin: range.startMin, endMin };
  return { startMin: Math.max(endMin - 120, AVAILABILITY_MIN_START), endMin };
}

/**
 * The label painted into a day: "All night" for the club's all-night range, else the
 * compact range ("9–11 PM", "10 PM–12 AM"). `[before, after]` split at the dash so the
 * cell can wrap there on narrow phones.
 */
export function dayLabel(range: AvailabilityRange, allNight: AvailabilityRange): { allNight: boolean; parts: [string, string] } {
  const text = formatRange(range.startMin, range.endMin);
  const dash = text.indexOf('–');
  const parts: [string, string] = dash < 0 ? [text, ''] : [text.slice(0, dash + 1), text.slice(dash + 1)];
  return { allNight: isSameRange(range, allNight), parts };
}
