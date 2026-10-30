import { describe, expect, it } from 'vitest';
import { bookingStatus, isUnconfirmed, isUnsent } from './bookingStatus';

const today = '2026-11-06';
const base = { confirmedAt: null, confirmationSentAt: null, declinedAt: null };

describe('bookingStatus', () => {
  it('is confirmed whenever confirmedAt is set, even today', () => {
    expect(bookingStatus({ ...base, confirmedAt: 1, confirmationSentAt: 1 }, '2026-11-07', today)).toBe('confirmed');
    expect(bookingStatus({ ...base, confirmedAt: 1 }, today, today)).toBe('confirmed');
  });

  it('is awaiting when sent but not confirmed', () => {
    expect(bookingStatus({ ...base, confirmationSentAt: 1 }, '2026-11-07', today)).toBe('awaiting');
  });

  it('is not_sent when nothing was sent', () => {
    expect(bookingStatus(base, '2026-11-07', today)).toBe('not_sent');
  });

  it('is unconfirmed_today for today’s unconfirmed bookings, overriding awaiting/not_sent', () => {
    expect(bookingStatus({ ...base, confirmationSentAt: 1 }, today, today)).toBe('unconfirmed_today');
    expect(bookingStatus(base, today, today)).toBe('unconfirmed_today');
  });

  it('is declined whenever declinedAt is set, over every other status', () => {
    expect(bookingStatus({ ...base, declinedAt: 5 }, '2026-11-07', today)).toBe('declined');
    expect(bookingStatus({ ...base, declinedAt: 5, confirmationSentAt: 1 }, '2026-11-07', today)).toBe('declined');
    expect(bookingStatus({ ...base, declinedAt: 5 }, today, today)).toBe('declined');
    expect(bookingStatus({ confirmedAt: 1, confirmationSentAt: 1, declinedAt: 5 }, today, today)).toBe('declined');
  });

  it('compares against the night it is passed, not the calendar date', () => {
    // 1 AM Saturday: the club night is still Friday, so Friday's late show stays red.
    expect(bookingStatus({ ...base, confirmationSentAt: 1 }, '2026-11-06', '2026-11-06')).toBe('unconfirmed_today');
    expect(bookingStatus({ ...base, confirmationSentAt: 1 }, '2026-11-07', '2026-11-06')).toBe('awaiting');
  });
});

describe('isUnconfirmed', () => {
  it('is true only for spots neither confirmed nor declined', () => {
    expect(isUnconfirmed(base)).toBe(true);
    expect(isUnconfirmed({ ...base, confirmedAt: 1 })).toBe(false);
    expect(isUnconfirmed({ ...base, declinedAt: 1 })).toBe(false);
  });
});

describe('isUnsent', () => {
  it('is true only for open spots that were never emailed', () => {
    expect(isUnsent(base)).toBe(true);
    expect(isUnsent({ ...base, confirmationSentAt: 1 })).toBe(false);
    expect(isUnsent({ ...base, confirmedAt: 1 })).toBe(false); // booker confirmed it directly
    expect(isUnsent({ ...base, declinedAt: 1 })).toBe(false);
  });
});
