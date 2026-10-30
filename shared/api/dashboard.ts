/**
 * F5 Dashboard, availability requests & confirmations API contract (spec §6 F5):
 * request schemas (zod, validated on the server and reused by the client) and
 * response shapes.
 *
 *   GET  /api/dashboard                               DashboardResponse
 *   POST /api/confirmations/send                      SendConfirmationsInput → SendConfirmationsResponse
 *   POST /api/confirmations/resend                    ResendConfirmationInput → ResendConfirmationResponse
 *                                                     (404 `not_found` for an unknown comedian;
 *                                                     `status: 'archived'` and no email for an archived one)
 *   POST /api/availability-requests                   CreateAvailabilityRequestInput → 201 CreateAvailabilityRequestResponse
 *                                                     (400 `unknown_tag`, 409 `no_recipients`)
 *   GET  /api/availability-requests[?month]           AvailabilityRequestSummary[] (newest first)
 *   GET  /api/availability-requests/preview?month&message[&kind][&audience]
 *                                                     AvailabilityRequestPreview
 *
 * "Mark confirmed" on the dashboard uses F2's `POST /api/bookings/:id/confirm`; its Undo uses
 * `POST /api/bookings/:id/unconfirm` with the booking's prior `{confirmedAt, confirmedBy}`.
 */
import { z } from 'zod';
import type { BookingStatus } from '../bookingStatus';
import { dateSchema, idSchema, monthSchema } from '../schemas';
import { isValidDate, weekdayOf } from '../time';
import {
  AVAILABILITY_REQUEST_KINDS,
  type AvailabilityAudience,
  type AvailabilityRequestKind,
  type EmailStatus,
  type ShowStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Longest personal message a booker can add to an availability request. */
export const AVAILABILITY_MESSAGE_MAX = 1000;

/** A Monday (`weekStart`, spec §3). */
export const weekStartSchema = dateSchema.refine((d) => isValidDate(d) && weekdayOf(d) === 1, 'Expected a Monday');

/** `all` or `tag:<id>`. */
export const audienceSchema = z
  .string()
  .regex(/^(all|tag:[1-9]\d*)$/, 'Expected "all" or "tag:<id>"')
  .transform((v) => v as AvailabilityAudience);

export type ParsedAudience = { kind: 'all' } | { kind: 'tag'; tagId: number };

export function parseAudience(audience: AvailabilityAudience | string): ParsedAudience {
  const match = /^tag:([1-9]\d*)$/.exec(audience);
  return match ? { kind: 'tag', tagId: Number(match[1]) } : { kind: 'all' };
}

export function tagAudience(tagId: number): AvailabilityAudience {
  return `tag:${tagId}`;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const sendConfirmationsSchema = z.object({
  weekStart: weekStartSchema,
  /** Only comedians with an unconfirmed spot that has never had a confirmation sent. */
  onlyUnsent: z.boolean().optional(),
});
export type SendConfirmationsInput = z.input<typeof sendConfirmationsSchema>;

export const resendConfirmationSchema = z.object({
  comedianId: idSchema,
  weekStart: weekStartSchema,
});
export type ResendConfirmationInput = z.input<typeof resendConfirmationSchema>;

const messageSchema = z.string().trim().max(AVAILABILITY_MESSAGE_MAX, `Keep the message under ${AVAILABILITY_MESSAGE_MAX} characters`);

export const createAvailabilityRequestSchema = z.object({
  month: monthSchema,
  audience: audienceSchema.default('all'),
  message: messageSchema.default(''),
  /** `reminder` emails only the audience's comedians who haven't submitted the month. */
  kind: z.enum(AVAILABILITY_REQUEST_KINDS).default('request'),
});
export type CreateAvailabilityRequestInput = z.input<typeof createAvailabilityRequestSchema>;

export const listAvailabilityRequestsQuerySchema = z.object({
  month: monthSchema.optional(),
});

export const availabilityPreviewQuerySchema = z.object({
  month: monthSchema,
  message: messageSchema.default(''),
  kind: z.enum(AVAILABILITY_REQUEST_KINDS).default('request'),
  /** Picks the sample comedian (first by name) and the recipient count. Default `all`. */
  audience: audienceSchema.default('all'),
});
export type AvailabilityPreviewQuery = z.input<typeof availabilityPreviewQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface DashboardLocation {
  id: number;
  name: string;
  address: string;
  color: string;
}

/**
 * One unconfirmed booking on a scheduled show tonight ("John · 7 PM @ The Cellar · unconfirmed").
 * Declined spots are not here (see `needsReplacement`).
 */
export interface UnconfirmedTonightRow {
  bookingId: number;
  showId: number;
  comedianId: number;
  comedianName: string;
  comedianEmail: string;
  /** Archived comedians are never emailed: the dashboard offers no Resend for them. */
  comedianArchived: boolean;
  startMin: number;
  showName: string;
  location: DashboardLocation;
  /** When the weekly confirmation email covering this spot was last sent (null = never). */
  confirmationSentAt: number | null;
}

/**
 * A declined spot on a scheduled show from tonight on: the comedian said they can't make it,
 * the booking keeps its slot until the booker replaces them ("Needs a replacement").
 */
export interface NeedsReplacementRow {
  bookingId: number;
  showId: number;
  /** The show's (club night) date. */
  date: string;
  startMin: number;
  showName: string;
  location: DashboardLocation;
  /** 0-based slot index. */
  position: number;
  comedianId: number;
  comedianName: string;
  declinedAt: number;
  /** The comedian's optional reason ('' when none). */
  declineNote: string;
}

export interface TonightBooking {
  id: number;
  position: number;
  comedianId: number;
  comedianName: string;
  status: BookingStatus;
  overrideUnavailable: boolean;
}

export interface TonightShow {
  id: number;
  startMin: number;
  name: string;
  slotCount: number;
  status: ShowStatus;
  location: DashboardLocation;
  bookedCount: number;
  confirmedCount: number;
  /** Ordered by position. */
  bookings: TonightBooking[];
}

/** Per-day counts over the week's scheduled shows. */
export interface WeekDayStats {
  date: string;
  shows: number;
  slots: number;
  /** Every booking, declined ones included (they still hold their slot). */
  booked: number;
  openSlots: number;
  confirmed: number;
  /** Still have to confirm (not confirmed, not declined). */
  unconfirmed: number;
  /** Declined: need a replacement. */
  declined: number;
}

export interface NextConfirmationSend {
  /** Club-local date and time of the next automatic send. */
  date: string;
  startMin: number;
  /** The same instant in ms since epoch. */
  at: number;
  /** The Monday of the week it will cover. */
  weekStart: string;
}

export interface ConfirmationsInfo {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  day: number;
  timeMin: number;
  /** Latest confirmationSentAt among this week's bookings. */
  lastSentAt: number | null;
  /** Null when automatic sends are off. */
  nextSend: NextConfirmationSend | null;
  /** Comedians with an unconfirmed spot between today and Sunday ("Send confirmations now" audience). */
  pendingComedians: number;
  /** …of whom have at least one such spot that was never emailed (the `onlyUnsent` audience). */
  unsentComedians: number;
  /**
   * Spots from tonight to Sunday that still have to be confirmed and were never emailed
   * (scheduled shows, non-archived comedians): the "N booked this week haven't been emailed
   * yet – Send" nudge, which sends with `onlyUnsent`.
   */
  unsentBookings: number;
  /** The daily catch-up send of those spots is on (setting `catchUpEnabled`). */
  catchUpEnabled: boolean;
}

export interface DashboardWeek {
  weekStart: string;
  weekEnd: string;
  /** Monday → Sunday. */
  days: WeekDayStats[];
  /** Booking statuses for the rest of the week (today → Sunday, scheduled shows). */
  remaining: Record<BookingStatus, number>;
  confirmations: ConfirmationsInfo;
}

export interface AvailabilityRequestSummary {
  id: number;
  month: string;
  kind: AvailabilityRequestKind;
  audience: AvailabilityAudience;
  /** "Everyone" or the tag's name. */
  audienceLabel: string;
  message: string;
  recipientCount: number;
  sentAt: number;
  sentByName: string | null;
}

export interface AudienceProgress {
  audience: AvailabilityAudience;
  /** "Everyone" or the tag's name. */
  label: string;
  /** Tag color (null for everyone). */
  color: string | null;
  /** Non-archived comedians in the audience. */
  total: number;
  /** …who have submitted the month. */
  submitted: number;
}

export interface MonthAvailabilityProgress {
  month: string;
  /** Everyone (non-archived). */
  total: number;
  submitted: number;
  notSubmitted: number;
  /** `all` first, then one entry per tag (by name). */
  audiences: AudienceProgress[];
  lastRequest: AvailabilityRequestSummary | null;
  lastReminder: AvailabilityRequestSummary | null;
}

export interface DashboardTag {
  id: number;
  name: string;
  color: string;
}

/** Counts behind the "Getting started" checklist on a new club's dashboard. */
export interface DashboardSetup {
  /** Active (non-archived) locations. */
  locations: number;
  /** Active (non-archived) comedians. */
  comedians: number;
  /** Shows ever created (any status). */
  shows: number;
  /** Availability requests and reminders ever sent. */
  availabilityRequests: number;
}

/** `GET /api/dashboard` */
export interface DashboardResponse {
  /**
   * Tonight in the club: the club *night* (`clubNightDate`), so until 6 AM it is still the
   * previous date and its after-midnight shows stay on the dashboard.
   */
  today: string;
  /**
   * The month the club is planning (`planningMonth` of the club's calendar date): the
   * default month for availability requests.
   */
  planningMonth: string;
  /** Club-local minutes after midnight right now. */
  nowMin: number;
  /** False → emails go to the outbox. */
  emailConfigured: boolean;
  /** Ordered by time, then location, then slot. */
  unconfirmedTonight: UnconfirmedTonightRow[];
  /** Declined spots from tonight on, soonest first (by date, time, location, slot). */
  needsReplacement: NeedsReplacementRow[];
  /** Today's shows: scheduled first (by time, then location), then cancelled. */
  tonight: TonightShow[];
  week: DashboardWeek;
  /**
   * This month, the planning month and the month after it, oldest first (no repeats):
   * on Oct 5 that is October and November; on Oct 30 October, November and December.
   */
  availability: MonthAvailabilityProgress[];
  tags: DashboardTag[];
  setup: DashboardSetup;
}

/** `POST /api/confirmations/send` */
export interface SendConfirmationsResponse {
  weekStart: string;
  /** Comedians emailed (sent or outbox). */
  sent: number;
  failed: number;
  comedianIds: number[];
}

/** `POST /api/confirmations/resend` */
export interface ResendConfirmationResponse {
  /**
   * `skipped`: the comedian has no unconfirmed spots left that week.
   * `archived`: the comedian is archived, so nothing was sent (archived comedians are never emailed).
   */
  status: EmailStatus | 'skipped' | 'archived';
  bookingCount: number;
  error?: string;
}

/** `POST /api/availability-requests` */
export interface CreateAvailabilityRequestResponse {
  recipientCount: number;
  /** Emailed (sent or outbox). */
  sent: number;
  failed: number;
  request: AvailabilityRequestSummary;
}

/** `GET /api/availability-requests/preview` */
export interface AvailabilityRequestPreview {
  subject: string;
  html: string;
  text: string;
  /** The comedian the preview is addressed to. */
  sampleName: string;
  /** How many comedians this request would go to right now. */
  recipientCount: number;
}
