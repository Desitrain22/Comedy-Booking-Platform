import { describe, expect, it } from 'vitest';
import {
  countByMonth,
  isWeekdayFullySelected,
  monthsPhrase,
  paintDates,
  pillAriaLabel,
  pillLabel,
  shortLocationName,
  toggleWeekday,
} from './showFormat';

// November 2026: Fridays are 6, 13, 20, 27.
const FRIDAYS = ['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27'];

describe('labels', () => {
  it('shortens location names for pills', () => {
    expect(shortLocationName('The Cellar')).toBe('Cellar');
    expect(shortLocationName('the annex')).toBe('annex');
    expect(shortLocationName('Theatre One')).toBe('Theatre One');
    expect(shortLocationName('The')).toBe('The');
  });

  it('formats pills like "7:30 · Cellar · 5/7"', () => {
    expect(pillLabel({ startMin: 1170, locationName: 'The Cellar', bookedCount: 5, slotCount: 7 })).toBe(
      '7:30 · Cellar · 5/7',
    );
    expect(pillLabel({ startMin: 1470, locationName: 'Annex', bookedCount: 0, slotCount: 6 })).toBe('12:30 · Annex · 0/6');
  });

  it('describes a pill for screen readers', () => {
    expect(
      pillAriaLabel({
        startMin: 1290,
        name: 'Late Show',
        locationName: 'The Cellar',
        bookedCount: 5,
        slotCount: 7,
        unconfirmedTodayCount: 2,
        status: 'cancelled',
      }),
    ).toBe('9:30 PM Late Show at The Cellar, 5 of 7 booked, 2 unconfirmed tonight, cancelled. Edit show');
  });
});

describe('date selection', () => {
  it('toggles every selectable weekday in the month', () => {
    const on = toggleWeekday(new Set(), '2026-11', 5, '2026-11-01');
    expect([...on].sort()).toEqual(FRIDAYS);
    expect(isWeekdayFullySelected(on, '2026-11', 5, '2026-11-01')).toBe(true);

    // Partly selected → fills in the rest; fully selected → clears them (other dates untouched).
    const partial = new Set(['2026-11-13', '2026-11-03']);
    const filled = toggleWeekday(partial, '2026-11', 5, '2026-11-01');
    expect([...filled].sort()).toEqual(['2026-11-03', ...FRIDAYS]);
    expect([...toggleWeekday(filled, '2026-11', 5, '2026-11-01')]).toEqual(['2026-11-03']);
  });

  it('skips past days when toggling a weekday', () => {
    const on = toggleWeekday(new Set(), '2026-11', 5, '2026-11-14');
    expect([...on].sort()).toEqual(['2026-11-20', '2026-11-27']);
    expect(isWeekdayFullySelected(on, '2026-11', 5, '2026-11-14')).toBe(true);
    // A month entirely in the past has nothing to select.
    expect(toggleWeekday(new Set(), '2026-10', 5, '2026-11-14').size).toBe(0);
    expect(isWeekdayFullySelected(new Set(), '2026-10', 5, '2026-11-14')).toBe(false);
  });

  it('paints and erases', () => {
    const added = paintDates(new Set(['2026-11-01']), ['2026-11-02', '2026-11-03'], 'add');
    expect([...added].sort()).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect([...paintDates(added, ['2026-11-01', '2026-11-03'], 'remove')]).toEqual(['2026-11-02']);
  });

  it('summarizes months', () => {
    expect(monthsPhrase([])).toBe('');
    expect(monthsPhrase(['2026-11-06'])).toBe('November');
    expect(monthsPhrase(['2026-12-04', '2026-11-06'])).toBe('November and December');
    expect(monthsPhrase(['2026-12-04', '2026-11-06', '2027-01-01'])).toBe('November, December and January');
    expect(countByMonth(['2026-12-04', '2026-11-06', '2026-11-13'])).toEqual([
      ['2026-11', 2],
      ['2026-12', 1],
    ]);
  });
});
