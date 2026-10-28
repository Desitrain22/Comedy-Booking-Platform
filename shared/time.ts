/**
 * Date & time helpers shared by client and server. Pure functions, no dependencies.
 *
 * Conventions (spec §3):
 * - A date is a `YYYY-MM-DD` string in the club's timezone. Never a JS Date.
 * - A month is a `YYYY-MM` string.
 * - A time is integer minutes after local midnight of the show's date. Values >= 1440
 *   belong to the same night but fall after midnight (1470 = 12:30 AM).
 * - Weeks run Monday → Sunday; `weekStart` is that Monday's date.
 */

export const MINUTES_PER_DAY = 1440;

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
/** Sun-first short names: Sun, Mon, … */
export const WEEKDAY_SHORT = WEEKDAY_NAMES.map((d) => d.slice(0, 3));
/** Sun-first one-letter labels: S M T W T F S */
export const WEEKDAY_LETTERS = WEEKDAY_NAMES.map((d) => d.slice(0, 1));
/** Sun-first two-letter labels: Su Mo Tu We Th Fr Sa */
export const WEEKDAY_MINI = WEEKDAY_NAMES.map((d) => d.slice(0, 2));

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

const pad2 = (n: number) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

interface ClockParts {
  hour12: number;
  minute: number;
  meridiem: 'AM' | 'PM';
}

function clockParts(minutes: number): ClockParts {
  const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour24 = Math.floor(m / 60);
  return {
    hour12: hour24 % 12 || 12,
    minute: m % 60,
    meridiem: hour24 < 12 ? 'AM' : 'PM',
  };
}

function clock({ hour12, minute }: ClockParts): string {
  return minute ? `${hour12}:${pad2(minute)}` : String(hour12);
}

/** 1170 → "7:30 PM", 1140 → "7 PM", 1470 → "12:30 AM". */
export function formatTime(minutes: number): string {
  const p = clockParts(minutes);
  return `${clock(p)} ${p.meridiem}`;
}

/** Like formatTime without the meridiem: 1170 → "7:30", 1140 → "7". Good for dense pills. */
export function formatTimeShort(minutes: number): string {
  return clock(clockParts(minutes));
}

/**
 * Compact range: (1260, 1380) → "9–11 PM", (1320, 1440) → "10 PM–12 AM",
 * (1170, 1380) → "7:30–11 PM". Uses an en dash.
 */
export function formatRange(startMin: number, endMin: number): string {
  const a = clockParts(startMin);
  const b = clockParts(endMin);
  const sameHalf = a.meridiem === b.meridiem && endMin > startMin && endMin - startMin < 720;
  return sameHalf ? `${clock(a)}–${formatTime(endMin)}` : `${formatTime(startMin)}–${formatTime(endMin)}`;
}

/** "HH:MM" 24h clock (wrapping past midnight): 1470 → "00:30". */
export function formatTime24(minutes: number): string {
  const m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export interface TimeOption {
  value: number;
  label: string;
}

/**
 * Options for a time <select>, inclusive of both ends.
 * timeOptions(720, 1545, 15) → 12 PM … 1:45 AM (create shows);
 * timeOptions(960, 1560, 30) → 4 PM … 2 AM (availability brush).
 */
export function timeOptions(fromMin: number, toMin: number, stepMin: number): TimeOption[] {
  const out: TimeOption[] = [];
  for (let m = fromMin; m <= toMin; m += stepMin) out.push({ value: m, label: formatTime(m) });
  return out;
}

// ---------------------------------------------------------------------------
// Calendar dates (pure string math via UTC, never local JS time)
// ---------------------------------------------------------------------------

function parseDate(date: string): { y: number; m: number; d: number } {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function parseMonth(month: string): { y: number; m: number } {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error(`Invalid month "${month}" (expected YYYY-MM)`);
  return { y: Number(match[1]), m: Number(match[2]) };
}

function toUtcMs(date: string): number {
  const { y, m, d } = parseDate(date);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

const DAY_MS = 86_400_000;

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  return fromUtcMs(toUtcMs(value)) === value;
}

export function isValidMonth(value: string): boolean {
  const match = MONTH_RE.exec(value);
  if (!match) return false;
  const m = Number(match[2]);
  return m >= 1 && m <= 12;
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

/** The Monday on or before `date`. */
export function weekStartOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** The 7 dates Monday → Sunday of the week starting `weekStart`. */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** "2026-11-08" → "2026-11". */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, months: number): string {
  const { y, m } = parseMonth(month);
  const index = y * 12 + (m - 1) + months;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

export function firstDayOfMonth(month: string): string {
  parseMonth(month);
  return `${month}-01`;
}

export function lastDayOfMonth(month: string): string {
  return addDays(firstDayOfMonth(addMonths(month, 1)), -1);
}

/** Every date in the month, in order. */
export function daysInMonth(month: string): string[] {
  const first = firstDayOfMonth(month);
  const count = Number(lastDayOfMonth(month).slice(8));
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

/** Inclusive list of dates from `from` to `to` (empty when to < from). */
export function datesBetween(from: string, to: string): string[] {
  const n = diffDays(from, to);
  return n < 0 ? [] : Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

/** All dates in `month` that fall on `weekday` (0 = Sun). */
export function datesForWeekday(month: string, weekday: number): string[] {
  return daysInMonth(month).filter((d) => weekdayOf(d) === weekday);
}

/**
 * Sun-first calendar layout: an array of weeks, each 7 cells, `null` for padding
 * cells outside the month.
 */
export function monthGrid(month: string): (string | null)[][] {
  const days = daysInMonth(month);
  const cells: (string | null)[] = [...Array<null>(weekdayOf(days[0]!)).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ---------------------------------------------------------------------------
// Formatting dates
// ---------------------------------------------------------------------------

/** "2026-11-08" → "Sunday, Nov 8" */
export function formatDateLong(date: string): string {
  const { m, d } = parseDate(date);
  return `${WEEKDAY_NAMES[weekdayOf(date)]}, ${MONTH_SHORT[m - 1]} ${d}`;
}

/** "2026-11-08" → "Sun, Nov 8" */
export function formatDateMedium(date: string): string {
  const { m, d } = parseDate(date);
  return `${WEEKDAY_SHORT[weekdayOf(date)]}, ${MONTH_SHORT[m - 1]} ${d}`;
}

/** "2026-11-08" → "Nov 8" */
export function formatDateShort(date: string): string {
  const { m, d } = parseDate(date);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}

/** "2026-11-08" → "Sunday" */
export function formatWeekday(date: string): string {
  return WEEKDAY_NAMES[weekdayOf(date)]!;
}

/** "2026-11" → "November 2026" */
export function formatMonthLong(month: string): string {
  const { y, m } = parseMonth(month);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** "2026-11" → "November" */
export function formatMonthName(month: string): string {
  return MONTH_NAMES[parseMonth(month).m - 1]!;
}

/** "2026-11" → "Nov" */
export function formatMonthShort(month: string): string {
  return MONTH_SHORT[parseMonth(month).m - 1]!;
}

/** Human relative time for timestamps (ms): "just now", "5m ago", "3h ago", "2d ago", "Nov 8". */
export function formatRelative(timestampMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.round((nowMs - timestampMs) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const dt = new Date(timestampMs);
  const label = `${MONTH_SHORT[dt.getMonth()]} ${dt.getDate()}`;
  return dt.getFullYear() === new Date(nowMs).getFullYear() ? label : `${label}, ${dt.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Timezones
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const out: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of zonedFormatter(timeZone).formatToParts(instant)) {
    if (part.type in out) out[part.type as keyof ZonedParts] = Number(part.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** True when `timeZone` is a valid IANA zone for this runtime. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    zonedFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Today's date in the given IANA timezone. */
export function todayInTz(timeZone: string, now: Date = new Date()): string {
  const p = zonedParts(now, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Minutes after local midnight right now in the given timezone (0–1439). */
export function nowMinutesInTz(timeZone: string, now: Date = new Date()): number {
  const p = zonedParts(now, timeZone);
  return p.hour * 60 + p.minute;
}

function offsetMs(utcMs: number, timeZone: string): number {
  const p = zonedParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The instant (ms since epoch) of `minutes` after local midnight on `date` in `timeZone`.
 * Minutes >= 1440 roll into the next day (show-night convention).
 * e.g. zonedTimeToUtc('2026-11-02', 600, 'America/New_York') → Mon Nov 2 10:00 AM EST.
 */
export function zonedTimeToUtc(date: string, minutes: number, timeZone: string): number {
  const { y, m, d } = parseDate(date);
  const localAsUtc = Date.UTC(y, m - 1, d, 0, minutes);
  const guess = localAsUtc - offsetMs(localAsUtc, timeZone);
  return localAsUtc - offsetMs(guess, timeZone);
}
