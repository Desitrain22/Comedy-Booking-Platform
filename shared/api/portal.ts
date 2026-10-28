/**
 * F4 Comedian portal API contract (spec §6 F4): request schemas (zod, validated on the
 * server and reused by the client) and response shapes.
 *
 *   GET  /api/portal/me                    PortalMeResponse
 *   GET  /api/portal/availability[?month]  PortalAvailabilityResponse (month defaults to
 *                                          `defaultAvailabilityMonth(today)`)
 *   PUT  /api/portal/availability          PutAvailabilityInput → PortalAvailabilityResponse
 *                                          Replaces the month's non-past nights (past nights in
 *                                          the body are ignored, stored past nights are kept)
 *                                          and records a submission, even with zero nights.
 *                                          400 `validation_error` (bad range), 400
 *                                          `date_outside_month`, 400 `duplicate_date`,
 *                                          400 `month_past`
 *   GET  /api/portal/spots                 PortalSpotsResponse (past 2 weeks + upcoming)
 *   POST /api/portal/spots/confirm         ConfirmWeekInput → ConfirmWeekResponse
 *                                          400 `invalid_week` (not a Monday), 400 `week_past`
 *   GET  /api/portal/profile               PortalProfile
 *   PUT  /api/portal/profile               UpdatePortalProfileInput → PortalProfile
 *   GET  /api/portal/confirm/:token        ConfirmLinkInfo — read-only, no session needed
 *                                          (email scanners prefetch links)
 *   POST /api/portal/confirm/:token        ConfirmLinkResult — confirms the week's scheduled,
 *                                          unconfirmed spots (confirmedBy 'comedian') and signs
 *                                          the comedian in. Idempotent.
 *                                          Both: 404 `invalid_token`, 410 `expired_token`.
 *
 * All routes except the confirm-token ones require a comedian session (`cbp_comedian`);
 * a booker session never grants portal access.
 */
import { z } from 'zod';
import { isValidAvailabilityRange, type AvailabilityEntry, type AvailabilityRange } from '../availability';
import type { BookingStatus } from '../bookingStatus';
import { dateSchema, monthSchema } from '../schemas';
import { addMonths, monthOf } from '../time';
import type { ClubInfo, ConfirmedBy, MeComedian } from '../types';

// ---------------------------------------------------------------------------
// Limits & helpers
// ---------------------------------------------------------------------------

export const PORTAL_NAME_MAX = 100;
export const PORTAL_BIO_MAX = 1000;
export const PORTAL_HEADSHOT_URL_MAX = 500;
/** Brush time pickers: half-hour steps. */
export const AVAILABILITY_STEP_MIN = 30;
/** The custom brush starts at 9–11 PM (the owner's example). */
export const DEFAULT_CUSTOM_RANGE: AvailabilityRange = { startMin: 1260, endMin: 1380 };
/** How many past weeks `GET /api/portal/spots` includes (shown collapsed). */
export const PAST_SPOT_WEEKS = 2;
/** From this day of the month on, the availability page opens on next month. */
export const NEXT_MONTH_FROM_DAY = 20;

/**
 * The month the availability page opens on when no `?month=` is given: next month from
 * the 20th on (that's what the club is booking), else the current month.
 */
export function defaultAvailabilityMonth(today: string): string {
  const month = monthOf(today);
  return Number(today.slice(8, 10)) >= NEXT_MONTH_FROM_DAY ? addMonths(month, 1) : month;
}

/** `http(s)://host…` */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const availabilityQuerySchema = z.object({ month: monthSchema.optional() });
export type AvailabilityQuery = z.input<typeof availabilityQuerySchema>;

export const availabilityEntrySchema = z
  .object({
    date: dateSchema,
    startMin: z.number().int(),
    endMin: z.number().int(),
  })
  .refine(isValidAvailabilityRange, {
    message: 'Times must be between 4 PM and 2 AM, ending after they start',
    path: ['endMin'],
  });

/** `PUT /api/portal/availability`: the whole month (one range per night). */
export const putAvailabilitySchema = z.object({
  month: monthSchema,
  entries: z.array(availabilityEntrySchema).max(31, 'A month has at most 31 nights'),
});
export type PutAvailabilityInput = z.input<typeof putAvailabilitySchema>;

export const confirmWeekSchema = z.object({ weekStart: dateSchema });
export type ConfirmWeekInput = z.input<typeof confirmWeekSchema>;

export const updatePortalProfileSchema = z.object({
  name: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1, 'Enter your name').max(PORTAL_NAME_MAX, `Use at most ${PORTAL_NAME_MAX} characters`)),
  bio: z.string().trim().max(PORTAL_BIO_MAX, `Keep it under ${PORTAL_BIO_MAX} characters`),
  headshotUrl: z
    .string()
    .trim()
    .max(PORTAL_HEADSHOT_URL_MAX, 'That link is too long')
    .refine((v) => v === '' || isHttpUrl(v), 'Enter a link starting with http:// or https://'),
});
export type UpdatePortalProfileInput = z.input<typeof updatePortalProfileSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface PortalProfile {
  id: number;
  name: string;
  /** Read-only in the portal ("Contact the club to change it"). */
  email: string;
  bio: string;
  headshotUrl: string;
}

/** `GET /api/portal/me` */
export interface PortalMeResponse {
  comedian: PortalProfile;
  club: ClubInfo;
  /** Today in the club timezone. */
  today: string;
  spots: {
    /** Scheduled spots from today on. */
    upcoming: number;
    /** …of which not yet confirmed. */
    unconfirmed: number;
  };
}

/** `GET/PUT /api/portal/availability` */
export interface PortalAvailabilityResponse {
  month: string;
  /** Sorted by date; may include past nights (shown, not editable). */
  entries: AvailabilityEntry[];
  /** When the comedian last saved this month, or null if never. */
  submittedAt: number | null;
  /** The club's "All night" range. */
  allNight: AvailabilityRange;
  /** Today in the club timezone; nights before it can't be changed. */
  today: string;
}

export interface PortalSpotLocation {
  id: number;
  name: string;
  address: string;
  color: string;
}

/** One booked spot (only scheduled shows; cancelled ones are left out). */
export interface PortalSpot {
  bookingId: number;
  showId: number;
  date: string;
  startMin: number;
  showName: string;
  location: PortalSpotLocation;
  status: BookingStatus;
  confirmedAt: number | null;
  confirmedBy: ConfirmedBy | null;
}

export interface PortalSpotWeek {
  /** Monday. */
  weekStart: string;
  spots: PortalSpot[];
  unconfirmedCount: number;
  /** The whole week is before today (read-only, shown collapsed). */
  past: boolean;
}

/** `GET /api/portal/spots`: weeks with spots, oldest first. */
export interface PortalSpotsResponse {
  today: string;
  weeks: PortalSpotWeek[];
}

/** `POST /api/portal/spots/confirm` */
export interface ConfirmWeekResponse {
  weekStart: string;
  /** Spots newly confirmed by this request (0 when they already were). */
  confirmedCount: number;
}

/** `GET /api/portal/confirm/:token` */
export interface ConfirmLinkInfo {
  comedianName: string;
  weekStart: string;
  today: string;
  spots: PortalSpot[];
  unconfirmedCount: number;
}

/** `POST /api/portal/confirm/:token` — the state after confirming. */
export interface ConfirmLinkResult extends ConfirmLinkInfo {
  confirmedCount: number;
  /** The comedian now signed in. */
  comedian: MeComedian;
}
