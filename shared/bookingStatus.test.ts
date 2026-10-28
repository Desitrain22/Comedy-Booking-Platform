import { describe, expect, it } from 'vitest';
import { bookingStatus } from './bookingStatus';

const today = '2026-11-06';

describe('bookingStatus', () => {
  it('is confirmed whenever confirmedAt is set, even today', () => {
    expect(bookingStatus({ confirmedAt: 1, confirmationSentAt: 1 }, '2026-11-07', today)).toBe('confirmed');
    expect(bookingStatus({ confirmedAt: 1, confirmationSentAt: null }, today, today)).toBe('confirmed');
  });

  it('is awaiting when sent but not confirmed', () => {
    expect(bookingStatus({ confirmedAt: null, confirmationSentAt: 1 }, '2026-11-07', today)).toBe('awaiting');
  });

  it('is not_sent when nothing was sent', () => {
    expect(bookingStatus({ confirmedAt: null, confirmationSentAt: null }, '2026-11-07', today)).toBe('not_sent');
  });

  it('is unconfirmed_today for today’s unconfirmed bookings, overriding awaiting/not_sent', () => {
    expect(bookingStatus({ confirmedAt: null, confirmationSentAt: 1 }, today, today)).toBe('unconfirmed_today');
    expect(bookingStatus({ confirmedAt: null, confirmationSentAt: null }, today, today)).toBe('unconfirmed_today');
  });
});
