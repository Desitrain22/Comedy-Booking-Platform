import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  afterMidnightLabel,
  clubNightDate,
  datesBetween,
  datesForWeekday,
  daysInMonth,
  diffDays,
  formatDateLong,
  formatDateMedium,
  formatDateShort,
  formatMonthLong,
  formatRange,
  formatRelative,
  formatShowTime,
  formatShowWhen,
  formatTime,
  formatTime24,
  formatTimeShort,
  isValidDate,
  isValidMonth,
  isValidTimeZone,
  lastDayOfMonth,
  monthGrid,
  monthOf,
  nowMinutesInTz,
  planningMonth,
  showStartDate,
  timeOptions,
  todayInTz,
  weekDates,
  weekStartOf,
  weekdayOf,
  zonedTimeToUtc,
} from './time';

describe('formatTime', () => {
  it('formats the spec examples', () => {
    expect(formatTime(1170)).toBe('7:30 PM');
    expect(formatTime(1140)).toBe('7 PM');
    expect(formatTime(1470)).toBe('12:30 AM');
  });

  it('handles noon, midnight and the morning', () => {
    expect(formatTime(720)).toBe('12 PM');
    expect(formatTime(1440)).toBe('12 AM');
    expect(formatTime(0)).toBe('12 AM');
    expect(formatTime(605)).toBe('10:05 AM');
    expect(formatTime(1559)).toBe('1:59 AM');
  });

  it('has a short form without the meridiem and a 24h form', () => {
    expect(formatTimeShort(1170)).toBe('7:30');
    expect(formatTimeShort(1140)).toBe('7');
    expect(formatTime24(1170)).toBe('19:30');
    expect(formatTime24(1470)).toBe('00:30');
  });
});

describe('formatRange', () => {
  it('formats the spec examples', () => {
    expect(formatRange(1260, 1380)).toBe('9–11 PM');
    expect(formatRange(1320, 1440)).toBe('10 PM–12 AM');
  });

  it('collapses the meridiem only when both ends share it', () => {
    expect(formatRange(1140, 1380)).toBe('7–11 PM');
    expect(formatRange(1170, 1380)).toBe('7:30–11 PM');
    expect(formatRange(1440, 1500)).toBe('12–1 AM');
    expect(formatRange(1320, 1500)).toBe('10 PM–1 AM');
    expect(formatRange(600, 1380)).toBe('10 AM–11 PM');
  });
});

describe('timeOptions', () => {
  it('builds inclusive select options', () => {
    const opts = timeOptions(720, 1545, 15);
    expect(opts[0]).toEqual({ value: 720, label: '12 PM' });
    expect(opts.at(-1)).toEqual({ value: 1545, label: '1:45 AM' });
    expect(opts).toHaveLength(56);
    expect(timeOptions(960, 1560, 30).map((o) => o.label).slice(0, 3)).toEqual(['4 PM', '4:30 PM', '5 PM']);
  });
});

describe('date math', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(diffDays('2026-11-01', '2026-11-08')).toBe(7);
    expect(diffDays('2026-11-08', '2026-11-01')).toBe(-7);
  });

  it('is immune to DST transitions (pure calendar math)', () => {
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
  });

  it('knows weekdays (0 = Sunday)', () => {
    expect(weekdayOf('2026-11-01')).toBe(0);
    expect(weekdayOf('2026-11-08')).toBe(0);
    expect(weekdayOf('2026-10-28')).toBe(3);
    expect(weekdayOf('2026-11-07')).toBe(6);
  });

  it('starts weeks on Monday', () => {
    expect(weekStartOf('2026-11-02')).toBe('2026-11-02'); // Monday
    expect(weekStartOf('2026-11-08')).toBe('2026-11-02'); // Sunday belongs to the week before
    expect(weekStartOf('2026-11-01')).toBe('2026-10-26');
    expect(weekStartOf('2026-10-28')).toBe('2026-10-26');
    expect(weekDates('2026-11-02')).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('handles months', () => {
    expect(monthOf('2026-11-08')).toBe('2026-11');
    expect(addMonths('2026-11', 1)).toBe('2026-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', -13)).toBe('2025-10');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });

  it('lists the days of a month', () => {
    const nov = daysInMonth('2026-11');
    expect(nov).toHaveLength(30);
    expect(nov[0]).toBe('2026-11-01');
    expect(nov[29]).toBe('2026-11-30');
    expect(daysInMonth('2026-02')).toHaveLength(28);
    expect(datesForWeekday('2026-11', 5)).toEqual(['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27']);
    expect(datesBetween('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    expect(datesBetween('2026-11-02', '2026-11-01')).toEqual([]);
  });

  it('lays out a Sun-first month grid', () => {
    const nov = monthGrid('2026-11'); // Nov 1 2026 is a Sunday
    expect(nov[0]![0]).toBe('2026-11-01');
    expect(nov.every((week) => week.length === 7)).toBe(true);
    expect(nov.flat().filter(Boolean)).toHaveLength(30);

    const oct = monthGrid('2026-10'); // Oct 1 2026 is a Thursday
    expect(oct[0]).toEqual([null, null, null, null, '2026-10-01', '2026-10-02', '2026-10-03']);
    expect(oct.at(-1)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
  });

  it('validates dates and months', () => {
    expect(isValidDate('2026-11-08')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-11-8')).toBe(false);
    expect(isValidMonth('2026-11')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
  });
});

describe('date formatting', () => {
  it('formats dates and months', () => {
    expect(formatDateLong('2026-11-08')).toBe('Sunday, Nov 8');
    expect(formatDateMedium('2026-11-08')).toBe('Sun, Nov 8');
    expect(formatDateShort('2026-11-08')).toBe('Nov 8');
    expect(formatMonthLong('2026-11')).toBe('November 2026');
  });

  it('formats relative times', () => {
    const now = Date.UTC(2026, 10, 8, 12);
    expect(formatRelative(now - 10_000, now)).toBe('just now');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('timezones', () => {
  // 2026-11-08 03:30 UTC is still Nov 7 (10:30 PM) in New York.
  const instant = new Date(Date.UTC(2026, 10, 8, 3, 30));

  it('computes today and minutes in a timezone', () => {
    expect(todayInTz('America/New_York', instant)).toBe('2026-11-07');
    expect(todayInTz('UTC', instant)).toBe('2026-11-08');
    expect(nowMinutesInTz('America/New_York', instant)).toBe(22 * 60 + 30);
    expect(nowMinutesInTz('UTC', instant)).toBe(3 * 60 + 30);
  });

  it('converts club-local times to instants, across DST', () => {
    // EDT (UTC-4) before Nov 1 2026, EST (UTC-5) after.
    expect(zonedTimeToUtc('2026-10-26', 600, 'America/New_York')).toBe(Date.UTC(2026, 9, 26, 14, 0));
    expect(zonedTimeToUtc('2026-11-02', 600, 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 15, 0));
    // Minutes past 1440 roll into the next day.
    expect(zonedTimeToUtc('2026-11-06', 1470, 'America/New_York')).toBe(Date.UTC(2026, 10, 7, 5, 30));
    expect(zonedTimeToUtc('2026-11-06', 0, 'UTC')).toBe(Date.UTC(2026, 10, 6));
    // 2:30 AM doesn't exist on spring-forward day: the first instant after the gap, 3 AM EDT.
    expect(zonedTimeToUtc('2027-03-14', 150, 'America/New_York')).toBe(Date.UTC(2027, 2, 14, 7, 0));
    expect(zonedTimeToUtc('2027-03-14', 180, 'America/New_York')).toBe(Date.UTC(2027, 2, 14, 7, 0));
    // Fall-back 1:30 AM happens twice: the first one (EDT) as before.
    expect(zonedTimeToUtc('2026-11-01', 90, 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it('validates timezone names', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('clubNightDate', () => {
  // New York is UTC-5 (EST) in mid-November 2026.
  const at = (iso: string) => new Date(iso);

  it('is the calendar date from 6 AM on', () => {
    expect(clubNightDate('America/New_York', at('2026-11-09T11:00:00Z'))).toBe('2026-11-09'); // 6:00 AM Mon
    expect(clubNightDate('America/New_York', at('2026-11-09T04:30:00Z'))).toBe('2026-11-08'); // 11:30 PM Sun
    expect(clubNightDate('America/New_York', at('2026-11-09T17:00:00Z'))).toBe('2026-11-09'); // noon Mon
  });

  it('is still the previous night before 6 AM', () => {
    expect(clubNightDate('America/New_York', at('2026-11-09T05:00:00Z'))).toBe('2026-11-08'); // midnight
    expect(clubNightDate('America/New_York', at('2026-11-09T06:30:00Z'))).toBe('2026-11-08'); // 1:30 AM Mon
    expect(clubNightDate('America/New_York', at('2026-11-09T10:59:00Z'))).toBe('2026-11-08'); // 5:59 AM Mon
    // Across a month boundary.
    expect(clubNightDate('America/New_York', at('2026-12-01T06:00:00Z'))).toBe('2026-11-30'); // 1 AM Dec 1
  });

  it('uses the club timezone and a custom cutoff', () => {
    const instant = at('2026-11-09T09:00:00Z'); // 4 AM New York, 1 AM Los Angeles, 9 AM UTC
    expect(clubNightDate('America/New_York', instant)).toBe('2026-11-08');
    expect(clubNightDate('America/Los_Angeles', instant)).toBe('2026-11-08');
    expect(clubNightDate('UTC', instant)).toBe('2026-11-09');
    expect(clubNightDate('America/New_York', instant, 0)).toBe('2026-11-09'); // cutoff 0 = calendar date
    expect(clubNightDate('America/New_York', instant, 180)).toBe('2026-11-09'); // 3 AM cutoff
  });
});

describe('planningMonth', () => {
  it('is next month from the 20th on, else this month', () => {
    expect(planningMonth('2026-11-01')).toBe('2026-11');
    expect(planningMonth('2026-11-19')).toBe('2026-11');
    expect(planningMonth('2026-11-20')).toBe('2026-12');
    expect(planningMonth('2026-12-31')).toBe('2027-01');
  });
});

describe('comedian-facing show times', () => {
  it('formats shows before midnight plainly', () => {
    expect(showStartDate('2026-11-08', 1260)).toBe('2026-11-08');
    expect(afterMidnightLabel('2026-11-08', 1260)).toBeNull();
    expect(formatShowTime('2026-11-08', 1260)).toBe('9 PM');
    expect(formatShowWhen('2026-11-08', 1260)).toBe('Sun, Nov 8 · 9 PM');
    expect(formatShowWhen('2026-11-08', 1410)).toBe('Sun, Nov 8 · 11:30 PM');
  });

  it('adds the real calendar day to after-midnight shows', () => {
    expect(showStartDate('2026-11-08', 1500)).toBe('2026-11-09');
    expect(afterMidnightLabel('2026-11-08', 1500)).toBe('early Mon, Nov 9');
    expect(formatShowTime('2026-11-08', 1500)).toBe('1 AM (early Mon, Nov 9)');
    expect(formatShowWhen('2026-11-08', 1500)).toBe('Sun, Nov 8 · 1 AM (early Mon, Nov 9)');
    expect(formatShowWhen('2026-11-08', 1440)).toBe('Sun, Nov 8 · 12 AM (early Mon, Nov 9)');
    // Month and year boundaries.
    expect(formatShowWhen('2026-11-30', 1470)).toBe('Mon, Nov 30 · 12:30 AM (early Tue, Dec 1)');
    expect(formatShowWhen('2026-12-31', 1530)).toBe('Thu, Dec 31 · 1:30 AM (early Fri, Jan 1)');
  });

  it('has long-weekday and separator variants for emails', () => {
    expect(formatShowWhen('2026-11-08', 1500, { weekday: 'long', separator: ' — ' })).toBe(
      'Sunday, Nov 8 — 1 AM (early Monday, Nov 9)',
    );
    expect(formatShowWhen('2026-11-08', 1260, { weekday: 'long' })).toBe('Sunday, Nov 8 · 9 PM');
    expect(formatShowTime('2026-11-08', 1500, { weekday: 'long' })).toBe('1 AM (early Monday, Nov 9)');
  });
});
