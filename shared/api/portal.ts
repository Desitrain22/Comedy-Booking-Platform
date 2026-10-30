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
 *                                          Also re-evaluates `overrideUnavailable` (the ⚠ "booked
 *                                          anyway" marker) on the comedian's bookings in the
 *                                          saved nights, so it stays truthful.
 *   GET  /api/portal/spots                 PortalSpotsResponse (past 2 weeks + upcoming)
 *   POST /api/portal/spots/confirm         ConfirmWeekInput → ConfirmWeekResponse
 *                                          400 `invalid_week` (not a Monday), 400 `week_past`.
 *                                          Never confirms a declined spot.
 *   POST   /api/portal/spots/:bookingId/decline   DeclineSpotInput → DeclineSpotResponse
 *                                          "Can't make it" (keeps the slot; the booker replaces
 *                                          it). Idempotent (keeps the first declinedAt, takes the
 *                                          latest note). 409 `declines_off` unless
 *                                          settings.allowDeclines, 404 `not_found` (not their
 *                                          spot / cancelled show), 409 `spot_past` (started).
 *   DELETE /api/portal/spots/:bookingId/decline   → DeclineSpotResponse — undo a decline
 *                                          (works even if declines were switched off since).
 *                                          404 `not_found`, 409 `spot_past`. Idempotent.
 *   GET  /api/portal/profile               PortalProfile
 *   PUT  /api/portal/profile               UpdatePortalProfileInput → PortalProfile
 *                                          (phone is optional: omitted keeps it, '' clears it)
 *   GET  /api/portal/confirm/:token        ConfirmLinkInfo — read-only, no session needed
 *                                          (email scanners prefetch links)
 *   POST /api/portal/confirm/:token        ConfirmLinkResult — confirms the week's scheduled,
 *                                          unconfirmed, not-declined spots (confirmedBy
 *                                          'comedian') and signs the comedian in. Idempotent.
 *   POST   /api/portal/confirm/:token/spots/:bookingId/decline  DeclineSpotInput → ConfirmLinkInfo
 *   DELETE /api/portal/confirm/:token/spots/:bookingId/decline  → ConfirmLinkInfo
 *                                          The same decline / undo from the emailed link (no
 *                                          session; the spot must be in the link's week).
 *                                          The email's per-spot link is a GET of the page with
 *                                          `?decline=<bookingId>`, which only opens the form.
 *                                          All confirm-link routes: 404 `invalid_token`,
 *                                          410 `expired_token`.
 *
 * All routes except the confirm-token ones require a comedian session (`cbp_comedian`);
 * a booker session never grants portal access.
 */
import { z } from 'zod';
import { isValidAvailabilityRange, type AvailabilityEntry, type AvailabilityRange } from '../availability';
import type { BookingStatus } from '../bookingStatus';
import { dateSchema, monthSchema } from '../schemas';
import { phoneSchema } from './comedians';
import { PLANNING_NEXT_MONTH_FROM_DAY, planningMonth } from '../time';
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
/** Longest note a comedian can leave when declining a spot (`bookings.declineNote`). */
export const DECLINE_NOTE_MAX = 300;

/**
 * Body for declining one spot ("Can't make it"; only when the club allows declines).
 * Shared by the portal's session route and the emailed confirm-link route.
 */
export const declineSpotSchema = z.object({
  note: z.string().trim().max(DECLINE_NOTE_MAX, `Keep it under ${DECLINE_NOTE_MAX} characters`).optional().default(''),
});
export type DeclineSpotInput = z.input<typeof declineSpotSchema>;

/**
 * Query param on the emailed confirm link that opens "Can't make it" for one spot:
 * `/portal/confirm/<token>?decline=<bookingId>`. The link only *opens* the page (email
 * scanners prefetch links); the decline itself is a POST from the page.
 */
export const DECLINE_QUERY_PARAM = 'decline';

/** The per-spot "Can't make it" link for a confirmation email. */
export function declineLink(confirmUrl: string, bookingId: number): string {
  const url = new URL(confirmUrl);
  url.searchParams.set(DECLINE_QUERY_PARAM, String(bookingId));
  return url.toString();
}

/** From this day of the month on, the availability page opens on next month. */
export const NEXT_MONTH_FROM_DAY = PLANNING_NEXT_MONTH_FROM_DAY;

/**
 * The month the availability page opens on when no `?month=` is given: the club's
 * planning month (`planningMonth`: next month from the 20th on, else the current month).
 */
export function defaultAvailabilityMonth(today: string): string {
  return planningMonth(today);
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
  /** Optional; only the club's bookers see it. Omitted = unchanged, '' = none. */
  phone: phoneSchema.optional(),
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
  /** Optional ('' when not given); bookers see it, it's never used for texting. */
  phone: string;
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
    /** …of which still to confirm (not confirmed, not declined; `isUnconfirmed`). */
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
  /** `declined` when the comedian said they can't make it (wins over `confirmed`). */
  status: BookingStatus;
  confirmedAt: number | null;
  confirmedBy: ConfirmedBy | null;
  /** When the comedian said "Can't make it", else null. */
  declinedAt: number | null;
  /** Their optional reason ('' when none). */
  declineNote: string;
  /** When the show starts (ms). Declining / undoing is possible until then. */
  startsAt: number;
}

export interface PortalSpotWeek {
  /** Monday. */
  weekStart: string;
  spots: PortalSpot[];
  /** Spots still to confirm (declined ones don't count). */
  unconfirmedCount: number;
  /** Spots the comedian can't make. */
  declinedCount: number;
  /** The whole week is before today (read-only, shown collapsed). */
  past: boolean;
}

/** `GET /api/portal/spots`: weeks with spots, oldest first. */
export interface PortalSpotsResponse {
  today: string;
  weeks: PortalSpotWeek[];
  /** The club lets comedians decline single spots (settings.allowDeclines). */
  allowDeclines: boolean;
}

/** `POST/DELETE /api/portal/spots/:bookingId/decline` — the spot as it is now. */
export interface DeclineSpotResponse {
  spot: PortalSpot;
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
  /** Includes declined spots (status `declined`). */
  spots: PortalSpot[];
  /** Spots still to confirm (declined ones don't count). */
  unconfirmedCount: number;
  /** The club lets comedians decline single spots (settings.allowDeclines). */
  allowDeclines: boolean;
}

/** `POST /api/portal/confirm/:token` — the state after confirming. */
export interface ConfirmLinkResult extends ConfirmLinkInfo {
  confirmedCount: number;
  /** The comedian now signed in. */
  comedian: MeComedian;
}
