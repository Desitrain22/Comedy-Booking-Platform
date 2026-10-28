/**
 * Weekly confirmation emails (F5-owned; foundation ships these stubs with the spec
 * signatures so other modules can import them).
 *
 * One email per comedian listing all their scheduled spots that week, with a
 * "Confirm my spots" button → createConfirmLink(db, comedianId, weekStart).
 * Sets `confirmationSentAt` on those bookings.
 */
import type { Db } from '../db/client';

export interface SendConfirmationsOptions {
  /** Only comedians with bookings that have never had a confirmation sent. */
  onlyUnsent?: boolean;
}

export interface SendConfirmationsResult {
  /** Comedians emailed (sent or outbox). */
  sent: number;
  failed: number;
  comedianIds: number[];
}

export interface SendConfirmationResult {
  status: 'sent' | 'outbox' | 'failed' | 'skipped';
  bookingCount: number;
}

export async function sendConfirmationsForWeek(
  _db: Db,
  _weekStart: string,
  _options: SendConfirmationsOptions = {},
): Promise<SendConfirmationsResult> {
  return { sent: 0, failed: 0, comedianIds: [] };
}

export async function sendConfirmationToComedian(
  _db: Db,
  _comedianId: number,
  _weekStart: string,
): Promise<SendConfirmationResult> {
  return { status: 'skipped', bookingCount: 0 };
}
