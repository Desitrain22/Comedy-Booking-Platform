import { describe, expect, it } from 'vitest';
import { mondayOnOrAfter, nextConfirmationSend } from './confirmationSchedule';

const tz = 'America/New_York';
/** 2026-10-28 is a Wednesday. 14:00 UTC = 10 AM in New York (EDT). */
const wedTenAm = new Date('2026-10-28T14:00:00Z');

describe('mondayOnOrAfter', () => {
  it('returns the same day for Mondays and the next Monday otherwise', () => {
    expect(mondayOnOrAfter('2026-11-02')).toBe('2026-11-02'); // Mon
    expect(mondayOnOrAfter('2026-11-01')).toBe('2026-11-02'); // Sun
    expect(mondayOnOrAfter('2026-10-29')).toBe('2026-11-02'); // Thu
    expect(mondayOnOrAfter('2026-11-03')).toBe('2026-11-09'); // Tue
  });
});

describe('nextConfirmationSend', () => {
  it('finds the next Monday 10 AM send for that week', () => {
    expect(nextConfirmationSend({ day: 1, timeMin: 600, timeZone: tz, now: wedTenAm })).toEqual({
      date: '2026-11-02',
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
      overdue: false,
    });
  });

  it('sends later today when the time has not passed yet', () => {
    expect(nextConfirmationSend({ day: 3, timeMin: 660, timeZone: tz, now: wedTenAm }).date).toBe('2026-10-28');
  });

  it('moves to next week once today’s time has passed', () => {
    expect(nextConfirmationSend({ day: 3, timeMin: 600, timeZone: tz, now: wedTenAm }).date).toBe('2026-11-04');
  });

  it('a Thursday send covers the following week', () => {
    expect(nextConfirmationSend({ day: 4, timeMin: 600, timeZone: tz, now: wedTenAm })).toEqual({
      date: '2026-10-29',
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
      overdue: false,
    });
  });

  it('uses the club timezone, not UTC', () => {
    // 02:00 UTC Thursday is still Wednesday 10 PM in New York.
    const lateWed = new Date('2026-10-29T02:00:00Z');
    expect(nextConfirmationSend({ day: 3, timeMin: 1380, timeZone: tz, now: lateWed }).date).toBe('2026-10-28');
  });

  describe('with the weeks already sent (mirrors the scheduler’s missed-send catch-up)', () => {
    /** Thu Nov 5, 2026, noon in New York (EST). */
    const thuNoon = new Date('2026-11-05T17:00:00Z');

    it('switching Monday → Wednesday mid-week: the missed Wednesday send goes out right away', () => {
      // Monday's send covered Nov 2–8. Wednesday's (Nov 4) would cover Nov 9–15 and never ran.
      expect(nextConfirmationSend({ day: 3, timeMin: 600, timeZone: tz, now: thuNoon, sentWeeks: ['2026-11-02'] })).toEqual({
        date: '2026-11-04',
        weekStart: '2026-11-09',
        weekEnd: '2026-11-15',
        overdue: true,
      });
    });

    it('turning automatic sends on mid-week sends this week’s email right away', () => {
      expect(nextConfirmationSend({ day: 1, timeMin: 600, timeZone: tz, now: thuNoon, sentWeeks: [] })).toMatchObject({
        date: '2026-11-02',
        weekStart: '2026-11-02',
        overdue: true,
      });
    });

    it('an overdue send whose week is over is dropped, and sent weeks are skipped', () => {
      // Friday send covers the next week: last Friday's (Oct 30 → Nov 2–8) was sent.
      expect(nextConfirmationSend({ day: 5, timeMin: 600, timeZone: tz, now: thuNoon, sentWeeks: ['2026-11-02'] })).toEqual({
        date: '2026-11-06',
        weekStart: '2026-11-09',
        weekEnd: '2026-11-15',
        overdue: false,
      });
      // Sunday sends: Nov 1's (→ Nov 2–8) and Nov 8's (→ Nov 9–15) both ran → Nov 15 is next.
      expect(
        nextConfirmationSend({ day: 0, timeMin: 600, timeZone: tz, now: thuNoon, sentWeeks: ['2026-11-02', '2026-11-09'] }),
      ).toMatchObject({ date: '2026-11-15', weekStart: '2026-11-16', overdue: false });
    });

    it('today’s send, once its time has passed and it ran, moves to next week', () => {
      expect(
        nextConfirmationSend({ day: 3, timeMin: 600, timeZone: tz, now: wedTenAm, sentWeeks: ['2026-11-02'] }),
      ).toMatchObject({ date: '2026-11-04', overdue: false });
    });
  });
});
