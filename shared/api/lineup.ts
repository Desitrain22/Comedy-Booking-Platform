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
 *                                       availability → 409 `unavailable` unless `force`. An
 *                                       occupant in another show who declined is replaced, not
 *                                       swapped: unbooked and returned as `replaced`)
 *                                       409 `comedian_archived` (moving an archived comedian —
 *                                       or swapping one — into a different show)
 *   DELETE /api/bookings/:id            DeleteBookingResponse (the removed booking, for Undo)
 *   POST   /api/bookings/:id/confirm    ConfirmBookingResponse (booker marks it confirmed
 *                                       manually; also clears a decline; `previous` is the
 *                                       state before, for Undo)
 *   POST   /api/bookings/:id/unconfirm  BookingConfirmationState → LineupBooking (Undo of
 *                                       "Mark confirmed": puts `previous` back)
 */
import { z } from 'zod';
import type { AvailabilityRange } from '../availability';
import type { BookingStatus } from '../bookingStatus';
import { idSchema } from '../schemas';
import { CONFIRMED_BY, type ConfirmedBy, type ShowStatus } from '../types';
import { DECLINE_NOTE_MAX } from './portal';

/** Highest slot index + 1 a show can have (matches F1's slot count limit). */
export const LINEUP_MAX_SLOTS = 30;

/**
 * Two of one comedian's bookings that start less than this many minutes apart on the same
 * night are flagged ("Also booked 7 PM · Cellar"): a soft warning, never a block.
 */
export const BOOKING_OVERLAP_MIN = 90;

/** Longest note excerpt (`DayComedian.latestNote`) sent with the day. */
export const NOTE_EXCERPT_MAX = 120;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** 0-based slot index. The upper bound (`< show.slotCount`) is checked by the server → 400 `invalid_position`. */
const positionSchema = z.number().int().min(0, 'Slots are numbered from 0').max(999);

/** Epoch milliseconds. The server also refuses times in the future. */
const timestampSchema = z.number().int().min(0);

const declineNoteSchema = z.string().trim().max(DECLINE_NOTE_MAX);

/**
 * A removed booking's state, sent back to re-create it exactly (Undo after removing or
 * replacing someone): confirmation, decline, "booked anyway", who booked it and when.
 */
export const bookingRestoreSchema = z
  .object({
    overrideUnavailable: z.boolean(),
    confirmationSentAt: timestampSchema.nullable(),
    confirmedAt: timestampSchema.nullable(),
    confirmedBy: z.enum(CONFIRMED_BY).nullable(),
    /** Optional for older clients: a restore without them is not declined. */
    declinedAt: timestampSchema.nullable().optional().default(null),
    declineNote: declineNoteSchema.optional().default(''),
    bookedById: idSchema.nullable(),
    createdAt: timestampSchema,
  })
  .refine((r) => (r.confirmedAt == null) === (r.confirmedBy == null), {
    message: 'confirmedAt and confirmedBy go together',
    path: ['confirmedBy'],
  });
export type BookingRestore = z.infer<typeof bookingRestoreSchema>;

/**
 * `POST /api/bookings/:id/unconfirm` — put a booking's confirmation (and decline) back the way
 * it was before "Mark confirmed" (`ConfirmBookingResponse.previous`). `declinedAt` omitted =
 * leave the decline as it is now. `{}` simply unconfirms.
 */
export const unconfirmBookingSchema = z
  .object({
    confirmedAt: timestampSchema.nullable().default(null),
    confirmedBy: z.enum(CONFIRMED_BY).nullable().default(null),
    declinedAt: timestampSchema.nullable().optional(),
    declineNote: declineNoteSchema.optional(),
  })
  .refine((r) => (r.confirmedAt == null) === (r.confirmedBy == null), {
    message: 'confirmedAt and confirmedBy go together',
    path: ['confirmedBy'],
  });
export type UnconfirmBookingInput = z.input<typeof unconfirmBookingSchema>;

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
  /** The comedian said "Can't make it" (status `declined`): the slot needs a replacement. */
  declinedAt: number | null;
  declineNote: string;
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
  /** Private booker notes about them (count) and the first line of the newest one. */
  noteCount: number;
  latestNote: string | null;
}

/**
 * This week's spots (tonight → Sunday, scheduled shows, active comedians) booked after the
 * confirmations went out and never emailed (`isUnsent`): the "N booked this week haven't been
 * emailed yet – Send" nudge (`POST /api/confirmations/send { weekStart, onlyUnsent: true }`).
 */
export interface UnsentThisWeek {
  /** Monday of the club night's week. */
  weekStart: string;
  /** Its Sunday. */
  weekEnd: string;
  /** Bookings never emailed. */
  count: number;
}

/** `GET /api/days/:date` */
export interface DayResponse {
  date: string;
  /** The club's current night (`clubNightDate`; for "tonight" and the red status). */
  today: string;
  /** Scheduled shows only, by location (sort order) then start time. */
  shows: DayShow[];
  /** Non-archived comedians, by name. */
  comedians: DayComedian[];
  /** Every tag, by name. */
  tags: LineupTag[];
  /** This week's never-emailed spots (whatever date is being viewed). */
  unsentThisWeek: UnsentThisWeek;
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
    declinedAt: removed.declinedAt,
    declineNote: removed.declineNote,
    bookedById: removed.bookedById,
    createdAt: removed.createdAt,
  };
}

/** A booking's confirmation and decline, as "Mark confirmed" found it. */
export interface BookingConfirmationState {
  confirmedAt: number | null;
  confirmedBy: ConfirmedBy | null;
  declinedAt: number | null;
  declineNote: string;
}

/** `POST /api/bookings/:id/confirm` — `previous` goes back to `/unconfirm` for Undo. */
export interface ConfirmBookingResponse extends LineupBooking {
  previous: BookingConfirmationState;
}

/** `PATCH /api/bookings/:id` — `swapped` is the booking that traded places, if any. */
export interface MoveBookingResponse {
  booking: LineupBooking;
  swapped: LineupBooking | null;
  /** The declined occupant of the target slot (another show), unbooked; for Undo. */
  replaced: RemovedBooking | null;
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
