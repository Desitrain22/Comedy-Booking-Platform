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
    });
  });

  it('uses the club timezone, not UTC', () => {
    // 02:00 UTC Thursday is still Wednesday 10 PM in New York.
    const lateWed = new Date('2026-10-29T02:00:00Z');
    expect(nextConfirmationSend({ day: 3, timeMin: 1380, timeZone: tz, now: lateWed }).date).toBe('2026-10-28');
  });
});
