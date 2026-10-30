/**
 * Derived booking status (spec §4), first match wins:
 * - declined           declinedAt set (comedian said they can't make it) → muted, struck through
 *                      Wins over everything, even confirmed: the slot needs a replacement.
 * - confirmed          confirmedAt set                                  → emerald
 * - unconfirmed_today  show is tonight (the club *night*) and unconfirmed → red
 *   (overrides awaiting / not_sent)
 * - awaiting           confirmation sent, not confirmed                 → amber
 * - not_sent           no confirmation sent yet                         → zinc
 */
export const BOOKING_STATUSES = ['confirmed', 'awaiting', 'not_sent', 'unconfirmed_today', 'declined'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface BookingStatusInput {
  confirmedAt: number | null;
  confirmationSentAt: number | null;
  /** Set when the comedian declined the spot. Select `bookings.declinedAt` wherever you derive a status. */
  declinedAt: number | null;
}

/**
 * @param showDate the show's date (YYYY-MM-DD)
 * @param tonight the club's current night (see `clubNightDate`, server: `clubNight(db)`),
 *   NOT the calendar date: until 6 AM it is still the previous night, so a 1 AM show stays red.
 */
export function bookingStatus(booking: BookingStatusInput, showDate: string, tonight: string): BookingStatus {
  if (booking.declinedAt != null) return 'declined';
  if (booking.confirmedAt != null) return 'confirmed';
  if (showDate === tonight) return 'unconfirmed_today';
  return booking.confirmationSentAt != null ? 'awaiting' : 'not_sent';
}

/**
 * A spot the comedian still has to confirm (not confirmed, not declined). Use for every
 * "unconfirmed" count; declined spots are counted separately ("needs a replacement").
 */
export function isUnconfirmed(booking: Pick<BookingStatusInput, 'confirmedAt' | 'declinedAt'>): boolean {
  return booking.confirmedAt == null && booking.declinedAt == null;
}

/**
 * Unconfirmed and never emailed (booked after the confirmations went out): what the daily
 * catch-up sends and the "N booked this week haven't been emailed yet" nudge counts
 * (callers also restrict to scheduled shows, non-archived comedians, tonight → Sunday).
 */
export function isUnsent(booking: BookingStatusInput): boolean {
  return booking.confirmationSentAt == null && isUnconfirmed(booking);
}

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  confirmed: 'Confirmed',
  awaiting: 'Awaiting confirmation',
  not_sent: 'Not sent',
  unconfirmed_today: 'Unconfirmed',
  declined: 'Declined',
};

/** Shorter labels for chips and tight spaces. */
export const BOOKING_STATUS_SHORT_LABELS: Record<BookingStatus, string> = {
  confirmed: 'Confirmed',
  awaiting: 'Awaiting',
  not_sent: 'Not sent',
  unconfirmed_today: 'Unconfirmed',
  declined: 'Declined',
};
