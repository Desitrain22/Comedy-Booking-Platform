/**
 * F2 Day view / lineup board API contract (spec §6 F2): request schemas (zod, validated on
 * the server and reused by the client) and response shapes.
 *
 *   GET    /api/days/:date              DayResponse
 *   POST   /api/bookings                CreateBookingInput → 201 CreateBookingResponse
 *                                       (`replaceBookingId`: unbook that occupant of the slot
 *                                       first; `restore`: re-create a removed booking exactly —
 *                                       the lineup's Undo)
 *                                       409 `unavailable` UnavailableErrorBody
 *                                       409 `already_in_show` {bookingId, position, comedianId}
 *                                       409 `slot_taken` {bookingId, comedianId, comedianName}
 *                                       (occupied by anyone but `replaceBookingId`)
 *                                       409 `show_cancelled`, 409 `comedian_archived`
 *                                       400 `invalid_position` {slotCount} (position ≥ slotCount)
 *   PATCH  /api/bookings/:id            MoveBookingInput → MoveBookingResponse
 *                                       (swaps with the occupant of the target slot; moving to
 *                                       a different show resets confirmation and re-checks
 *                                       availability → 409 `unavailable` unless `force`)
 *   DELETE /api/bookings/:id            DeleteBookingResponse (the removed booking, for Undo)
 *   POST   /api/bookings/:id/confirm    LineupBooking (booker marks it confirmed manually)
 */
import { z } from 'zod';
import type { AvailabilityRange } from '../availability';
import type { BookingStatus } from '../bookingStatus';
import { idSchema } from '../schemas';
import { CONFIRMED_BY, type ConfirmedBy, type ShowStatus } from '../types';

/** Highest slot index + 1 a show can have (matches F1's slot count limit). */
export const LINEUP_MAX_SLOTS = 30;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** 0-based slot index. The upper bound (`< show.slotCount`) is checked by the server → 400 `invalid_position`. */
const positionSchema = z.number().int().min(0, 'Slots are numbered from 0').max(999);

/** Epoch milliseconds. The server also refuses times in the future. */
const timestampSchema = z.number().int().min(0);

/**
 * A removed booking's state, sent back to re-create it exactly (Undo after removing or
 * replacing someone): confirmation, "booked anyway", who booked it and when.
 */
export const bookingRestoreSchema = z
  .object({
    overrideUnavailable: z.boolean(),
    confirmationSentAt: timestampSchema.nullable(),
    confirmedAt: timestampSchema.nullable(),
    confirmedBy: z.enum(CONFIRMED_BY).nullable(),
    bookedById: idSchema.nullable(),
    createdAt: timestampSchema,
  })
  .refine((r) => (r.confirmedAt == null) === (r.confirmedBy == null), {
    message: 'confirmedAt and confirmedBy go together',
    path: ['confirmedBy'],
  });
export type BookingRestore = z.infer<typeof bookingRestoreSchema>;

/**
 * `POST /api/bookings` — `force` books even when the comedian isn't available.
 * `replaceBookingId` replaces that booking when it holds the slot (it goes back to the pool;
 * the response's `replaced` has it, for Undo). `restore` re-creates a removed booking's state.
 */
export const createBookingSchema = z.object({
  showId: idSchema,
  position: positionSchema,
  comedianId: idSchema,
  force: z.boolean().optional().default(false),
  replaceBookingId: idSchema.optional(),
  restore: bookingRestoreSchema.optional(),
});
export type CreateBookingInput = z.input<typeof createBookingSchema>;

/**
 * `PATCH /api/bookings/:id` — move to `(showId, position)`; `showId` defaults to the
 * booking's current show. Dropping onto an occupied slot swaps the two bookings.
 */
export const moveBookingSchema = z.object({
  showId: idSchema.optional(),
  position: positionSchema,
  force: z.boolean().optional().default(false),
});
export type MoveBookingInput = z.input<typeof moveBookingSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface LineupTag {
  id: number;
  name: string;
  color: string;
}

export interface LineupLocation {
  id: number;
  name: string;
  color: string;
  address: string;
}

/** A filled slot. `status` is derived (spec §4) with the club's today. */
export interface LineupBooking {
  id: number;
  showId: number;
  /** 0-based slot index (the UI shows position + 1). */
  position: number;
  comedianId: number;
  comedianName: string;
  status: BookingStatus;
  /** Booked although the comedian wasn't marked available ("Book anyway"). */
  overrideUnavailable: boolean;
  confirmedAt: number | null;
  confirmedBy: ConfirmedBy | null;
  confirmationSentAt: number | null;
}

export interface DayShow {
  id: number;
  date: string;
  location: LineupLocation;
  startMin: number;
  name: string;
  slotCount: number;
  status: ShowStatus;
  notes: string;
  /** Sorted by position. */
  bookings: LineupBooking[];
}

/** Where a comedian is already booked on this date. */
export interface DayComedianBooking {
  bookingId: number;
  showId: number;
  startMin: number;
  locationName: string;
  position: number;
}

export interface DayComedian {
  id: number;
  name: string;
  headshotUrl: string;
  tags: LineupTag[];
  /** Their range for this date, or null when they haven't marked it. */
  availability: AvailabilityRange | null;
  /** Whether they submitted availability for this date's month. */
  submittedMonth: boolean;
  /** Their bookings in this date's (scheduled) shows, by start time. */
  bookings: DayComedianBooking[];
}

/** `GET /api/days/:date` */
export interface DayResponse {
  date: string;
  /** Today in the club timezone (for the red "unconfirmed today" status). */
  today: string;
  /** Scheduled shows only, by location (sort order) then start time. */
  shows: DayShow[];
  /** Non-archived comedians, by name. */
  comedians: DayComedian[];
  /** Every tag, by name. */
  tags: LineupTag[];
}

/** A booking that was just removed, with everything needed to restore it (`BookingRestore`). */
export interface RemovedBooking extends LineupBooking {
  bookedById: number | null;
  createdAt: number;
}

/** `POST /api/bookings` (201) — `replaced` is the occupant that `replaceBookingId` unbooked. */
export interface CreateBookingResponse extends LineupBooking {
  replaced: RemovedBooking | null;
}

/** `DELETE /api/bookings/:id` */
export interface DeleteBookingResponse {
  ok: true;
  booking: RemovedBooking;
}

/** The `restore` body that re-creates `removed` exactly. */
export function restoreOf(removed: RemovedBooking): BookingRestore {
  return {
    overrideUnavailable: removed.overrideUnavailable,
    confirmationSentAt: removed.confirmationSentAt,
    confirmedAt: removed.confirmedAt,
    confirmedBy: removed.confirmedBy,
    bookedById: removed.bookedById,
    createdAt: removed.createdAt,
  };
}

/** `PATCH /api/bookings/:id` — `swapped` is the booking that traded places, if any. */
export interface MoveBookingResponse {
  booking: LineupBooking;
  swapped: LineupBooking | null;
}

/** One comedian who isn't available for the show they would land in. */
export interface UnavailableConflict {
  comedianId: number;
  comedianName: string;
  showId: number;
  /** The show's date and start time. */
  date: string;
  startMin: number;
  /** `date`'s month (`YYYY-MM`). */
  month: string;
  /** What they marked for `date` (outside the show's time), or null. */
  availability: AvailabilityRange | null;
  /** Whether they submitted availability for `month`. */
  submittedMonth: boolean;
}

/**
 * 409 `unavailable`: the first conflict's fields are spread at the top level (so
 * `availability` / `submittedMonth` are always present); `conflicts` lists every one
 * (a cross-show swap can move two comedians). Retry with `force: true` to book anyway.
 */
export interface UnavailableErrorBody extends UnavailableConflict {
  error: string;
  code: 'unavailable';
  conflicts: UnavailableConflict[];
}
