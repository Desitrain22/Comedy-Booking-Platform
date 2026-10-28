/**
 * Derived booking status (spec §4):
 * - confirmed          confirmedAt set                                  → emerald
 * - awaiting           confirmation sent, not confirmed                 → amber
 * - not_sent           no confirmation sent yet                         → zinc
 * - unconfirmed_today  show is today (club tz) and not confirmed        → red
 *   (overrides awaiting / not_sent)
 */
export const BOOKING_STATUSES = ['confirmed', 'awaiting', 'not_sent', 'unconfirmed_today'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface BookingStatusInput {
  confirmedAt: number | null;
  confirmationSentAt: number | null;
}

/**
 * @param showDate the show's date (YYYY-MM-DD)
 * @param today today's date in the club timezone (see `todayInTz`)
 */
export function bookingStatus(booking: BookingStatusInput, showDate: string, today: string): BookingStatus {
  if (booking.confirmedAt != null) return 'confirmed';
  if (showDate === today) return 'unconfirmed_today';
  return booking.confirmationSentAt != null ? 'awaiting' : 'not_sent';
}

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  confirmed: 'Confirmed',
  awaiting: 'Awaiting confirmation',
  not_sent: 'Not sent',
  unconfirmed_today: 'Unconfirmed',
};

/** Shorter labels for chips and tight spaces. */
export const BOOKING_STATUS_SHORT_LABELS: Record<BookingStatus, string> = {
  confirmed: 'Confirmed',
  awaiting: 'Awaiting',
  not_sent: 'Not sent',
  unconfirmed_today: 'Unconfirmed',
};
