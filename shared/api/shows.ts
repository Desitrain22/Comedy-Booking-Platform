/**
 * F1 Shows API contract (spec §6 F1): request schemas (zod, validated on the server and
 * reused by the client) and response shapes.
 *
 *   GET    /api/shows?from&to[&locationIds]   ShowDto[]
 *   POST   /api/shows/bulk                     BulkCreateShowsInput → BulkCreateShowsResponse
 *   POST   /api/shows/copy-pattern             CopyPatternInput → CopyPatternResponse
 *   GET    /api/shows/:id                      ShowDetail
 *   PATCH  /api/shows/:id                      UpdateShowInput → UpdateShowResponse
 *                                              (409 `slots_occupied` {minSlotCount},
 *                                               409 `duplicate_show` {showId})
 *   DELETE /api/shows/:id                      OkResponse (409 `has_bookings` {bookingCount})
 */
import { z } from 'zod';
import type { BookingStatus } from '../bookingStatus';
import { dateSchema, idSchema, monthSchema, queryIdListSchema } from '../schemas';
import { diffDays } from '../time';
import { SHOW_STATUSES, type ConfirmedBy, type ShowStatus } from '../types';

// ---------------------------------------------------------------------------
// Limits & primitives
// ---------------------------------------------------------------------------

/** Show start times run 12 PM … 1:59 AM (spec §3); the create-shows picker uses 15-min steps to 1:45 AM. */
export const SHOW_START_MIN = 720;
export const SHOW_START_MAX = 1559;
export const SHOW_START_PICKER_MAX = 1545;
export const SHOW_START_STEP = 15;
export const SLOT_COUNT_MIN = 1;
export const SLOT_COUNT_MAX = 30;
export const DEFAULT_SLOT_COUNT = 6;
/** 8 PM: a sensible default for a new run of shows. */
export const DEFAULT_SHOW_START = 1200;
export const SHOW_NAME_MAX = 100;
export const SHOW_NOTES_MAX = 2000;
/** The widest `GET /api/shows` range (a month grid plus slack, or a year view). */
export const SHOWS_RANGE_MAX_DAYS = 400;
export const BULK_DATES_MAX = 400;

export const showStartMinSchema = z
  .number()
  .int()
  .min(SHOW_START_MIN, 'Shows start at 12 PM or later')
  .max(SHOW_START_MAX, 'Shows start before 2 AM');

export const slotCountSchema = z
  .number()
  .int()
  .min(SLOT_COUNT_MIN, `At least ${SLOT_COUNT_MIN} slot`)
  .max(SLOT_COUNT_MAX, `At most ${SLOT_COUNT_MAX} slots`);

export const showNameSchema = z.string().trim().max(SHOW_NAME_MAX);
export const showNotesSchema = z.string().trim().max(SHOW_NOTES_MAX);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** `GET /api/shows?from=2026-11-01&to=2026-11-30&locationIds=1,2` (inclusive range). */
export const listShowsQuerySchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
    locationIds: queryIdListSchema,
    /** `0` hides cancelled shows (default: included, the calendar strikes them through). */
    includeCancelled: z
      .enum(['1', '0', 'true', 'false'])
      .optional()
      .transform((v) => v !== '0' && v !== 'false'),
  })
  .refine((q) => q.from <= q.to, { message: '`from` must be on or before `to`', path: ['to'] })
  .refine((q) => diffDays(q.from, q.to) <= SHOWS_RANGE_MAX_DAYS, {
    message: `Ask for at most ${SHOWS_RANGE_MAX_DAYS} days at a time`,
    path: ['to'],
  });
export type ListShowsQuery = z.input<typeof listShowsQuerySchema>;

/** `POST /api/shows/bulk`: one show per date (dates are de-duplicated). */
export const bulkCreateShowsSchema = z.object({
  locationId: idSchema,
  name: showNameSchema.default(''),
  startMin: showStartMinSchema,
  slotCount: slotCountSchema.default(DEFAULT_SLOT_COUNT),
  dates: z
    .array(dateSchema)
    .min(1, 'Pick at least one date')
    .max(BULK_DATES_MAX, `At most ${BULK_DATES_MAX} dates at a time`),
});
export type BulkCreateShowsInput = z.input<typeof bulkCreateShowsSchema>;

/** `POST /api/shows/copy-pattern`: preview with `dryRun: true`, then create with `dryRun: false`. */
export const copyPatternSchema = z
  .object({
    fromMonth: monthSchema,
    toMonth: monthSchema,
    /** Only copy shows at these locations (omit or empty = all). */
    locationIds: z.array(idSchema).optional(),
    dryRun: z.boolean().default(false),
  })
  .refine((v) => v.fromMonth !== v.toMonth, { message: 'Pick two different months', path: ['toMonth'] });
export type CopyPatternInput = z.input<typeof copyPatternSchema>;

/** `PATCH /api/shows/:id`: any subset. */
export const updateShowSchema = z
  .object({
    name: showNameSchema,
    startMin: showStartMinSchema,
    slotCount: slotCountSchema,
    notes: showNotesSchema,
    status: z.enum(SHOW_STATUSES),
  })
  .partial();
export type UpdateShowInput = z.input<typeof updateShowSchema>;


// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The location embedded in every show. */
export interface ShowLocation {
  id: number;
  name: string;
  address: string;
  color: string;
  sortOrder: number;
  archived: boolean;
}

/**
 * One show as listed by `GET /api/shows` (sorted by date, startMin, location order).
 *
 * - `bookedCount`: bookings on the show (cancelled shows keep theirs and report them).
 * - `unconfirmedTodayCount`: unconfirmed bookings when the show is today in the club
 *   timezone; always 0 for cancelled shows (they need no confirmation).
 */
export interface ShowDto {
  id: number;
  locationId: number;
  date: string;
  startMin: number;
  name: string;
  slotCount: number;
  status: ShowStatus;
  notes: string;
  createdAt: number;
  location: ShowLocation;
  bookedCount: number;
  unconfirmedTodayCount: number;
}

/** A booking as summarized on `GET /api/shows/:id`. */
export interface ShowBookingSummary {
  id: number;
  position: number;
  comedianId: number;
  comedianName: string;
  status: BookingStatus;
  overrideUnavailable: boolean;
  confirmationSentAt: number | null;
  confirmedAt: number | null;
  confirmedBy: ConfirmedBy | null;
}

/** `GET /api/shows/:id` */
export interface ShowDetail extends ShowDto {
  /** Sorted by position. */
  bookings: ShowBookingSummary[];
  /** The smallest slotCount a PATCH accepts: highest occupied position + 1 (min 1). */
  minSlotCount: number;
}

/** `PATCH /api/shows/:id` */
export interface UpdateShowResponse extends ShowDetail {
  /** Bookings whose confirmation was cleared because the start time changed. */
  confirmationsReset: number;
}

export type SkipReason = 'duplicate' | 'past';

/** `POST /api/shows/bulk` → 201 when anything was created, else 200. */
export interface BulkCreateShowsResponse {
  created: ShowDto[];
  /** Dates not created: a scheduled show already exists at that location, date and time. */
  skipped: { date: string; reason: 'duplicate'; showId: number }[];
}

/** One show the copy would create (or skipped). `id` is set once created (`dryRun: false`). */
export interface CopyPatternShow {
  id?: number;
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  locationId: number;
  location: Pick<ShowLocation, 'id' | 'name' | 'color'>;
  startMin: number;
  name: string;
  slotCount: number;
}

export interface CopyPatternSkipped extends CopyPatternShow {
  /** `duplicate`: a scheduled show already exists there; `past`: the date is before today. */
  reason: SkipReason;
  /** The existing show for `duplicate`. */
  showId?: number;
}

/**
 * `POST /api/shows/copy-pattern` → `{ shows }` that will be created (`dryRun`) or were
 * created. Pattern = distinct (locationId, weekday, startMin, name, slotCount) of the
 * source month's scheduled shows at non-archived locations, applied to every matching
 * weekday of the target month. No bookings are copied.
 */
export interface CopyPatternResponse {
  dryRun: boolean;
  fromMonth: string;
  toMonth: string;
  /** Sorted by date, startMin, location order. */
  shows: CopyPatternShow[];
  skipped: CopyPatternSkipped[];
  /** Scheduled shows found in the source month (after the location filter). */
  sourceShowCount: number;
}

/** `DELETE /api/shows/:id` 409 body extra. */
export interface HasBookingsErrorExtra {
  bookingCount: number;
}

/** `PATCH /api/shows/:id` 409 `slots_occupied` body extra. */
export interface SlotsOccupiedErrorExtra {
  minSlotCount: number;
}
