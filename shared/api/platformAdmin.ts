/**
 * The owner console (hosted MVP spec §6): `/admin` on the platform host. Its API lives under
 * `/api/platform/admin/*`, which only the platform host answers (404 `not_found` elsewhere).
 *
 * Sign-in (an email in PLATFORM_ADMIN_EMAILS gets a 6-digit code; 10 minutes, 5 tries):
 *   POST /api/platform/admin/request-code    AdminRequestCodeRequest → OkResponse (always ok)
 *   POST /api/platform/admin/verify-code     AdminVerifyCodeRequest → AdminMeResponse + cookie
 *                                            (`__Host-cbp_platform` over https, else `cbp_platform`; 7 days)
 *   GET  /api/platform/admin/me              AdminMeResponse ({ admin: null } when signed out)
 *   POST /api/platform/admin/logout          OkResponse
 *
 * Signed in (401 `unauthorized` otherwise):
 *   GET  /api/platform/admin/overview?status=&search=   AdminOverview
 *   GET  /api/platform/admin/clubs/:id                  AdminClubDetail
 *   POST /api/platform/admin/clubs/:id/suspend          AdminSuspendRequest → AdminActionResponse
 *   POST /api/platform/admin/clubs/:id/reactivate       {} → AdminActionResponse
 *   POST /api/platform/admin/clubs/:id/archive          AdminArchiveRequest → AdminActionResponse
 *   POST /api/platform/admin/clubs/:id/restore          {} → AdminActionResponse
 *   GET  /api/platform/admin/clubs/:id/backup           the club's database (.db download)
 *
 * Errors: 400 `invalid_code` (wrong, expired or used-up code; also any address that isn't an
 * owner), 400 `confirm_slug_mismatch` (archive), 404 `not_found` (no such club), 409
 * `invalid_transition` (e.g. suspending a suspended club; body has the club's `status`),
 * 429 `rate_limited`.
 *
 * Every action (and every backup download) is written to the admin event log.
 */
import { z } from 'zod';
import { emailSchema, verifyCodeSchema } from '../schemas';

export const ADMIN_CLUB_STATUSES = ['active', 'suspended', 'archived'] as const;
export type AdminClubStatus = (typeof ADMIN_CLUB_STATUSES)[number];

/** The overview's status filter (default `active`). */
export const ADMIN_CLUB_FILTERS = ['active', 'suspended', 'archived', 'all'] as const;
export type AdminClubFilter = (typeof ADMIN_CLUB_FILTERS)[number];

export const ADMIN_EVENT_ACTIONS = ['suspend', 'reactivate', 'archive', 'restore', 'backup_download'] as const;
export type AdminEventAction = (typeof ADMIN_EVENT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export const adminRequestCodeSchema = z.object({ email: emailSchema });
export type AdminRequestCodeRequest = z.infer<typeof adminRequestCodeSchema>;

/** `{ email, code }`; spaces and dashes in the code are ignored. */
export const adminVerifyCodeSchema = verifyCodeSchema;
export type AdminVerifyCodeRequest = z.input<typeof adminVerifyCodeSchema>;

export interface AdminMe {
  email: string;
}

export interface AdminMeResponse {
  admin: AdminMe | null;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export const adminOverviewQuerySchema = z.object({
  status: z.enum(ADMIN_CLUB_FILTERS).default('active'),
  /** Part of the club's name, address (slug) or owner's email/name; case-insensitive. */
  search: z.string().trim().max(200).default(''),
});
export type AdminOverviewQuery = z.input<typeof adminOverviewQuerySchema>;

/** Numbers read from a club's own database. */
export interface AdminClubStats {
  /** Bookers, invited ones included. */
  bookers: number;
  /** Latest booker sign-in or booking made (ms), or null. */
  lastActiveAt: number | null;
  /** Locations in use (not archived). */
  locations: number;
  /** Comedians on the roster (not archived). */
  comedians: number;
  /** Scheduled shows from today through the next 30 days (club time). */
  upcomingShows: number;
  /** Emails delivered (status `sent`) in the last 7 / 30 days. */
  emailsSent7d: number;
  emailsSent30d: number;
  /** Emails that failed in the last 30 days. */
  emailsFailed30d: number;
  /**
   * Of those, the ones that went (or tried to go) out through the platform sender (`via`
   * `platform`): the shared sending domain, and the club's daily cap.
   */
  platformSent30d: number;
  platformFailed30d: number;
  senderMode: 'company' | 'booker';
  /** The company mailbox (Settings → Email SMTP) is connected. */
  companyMailbox: boolean;
  /** Bookers with their own mailbox connected. */
  bookerMailboxes: number;
}

export interface AdminClubRow {
  id: number;
  slug: string;
  /** The club's current name (its settings), else the name it signed up with. */
  name: string;
  /** `https://<slug>.<domain>` */
  url: string;
  /** `<slug>.<domain>` */
  host: string;
  status: AdminClubStatus;
  /** The owner's note on the latest suspend/archive ('' when none). Never shown to the club. */
  statusReason: string;
  statusChangedAt: number | null;
  createdAt: number;
  /** The booker who signed the club up. */
  owner: { name: string; email: string };
  /** Null when the club's database couldn't be read. */
  stats: AdminClubStats | null;
}

export interface AdminTotals {
  clubs: Record<AdminClubStatus, number>;
  /** These add up the active and suspended clubs (archived clubs are left out). */
  bookers: number;
  comedians: number;
  upcomingShows: number;
  emailsSent7d: number;
  emailsSent30d: number;
}

export interface AdminOverview {
  totals: AdminTotals;
  status: AdminClubFilter;
  search: string;
  /** Oldest first. */
  clubs: AdminClubRow[];
}

// ---------------------------------------------------------------------------
// Club detail
// ---------------------------------------------------------------------------

export interface AdminBooker {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'booker';
  lastLoginAt: number | null;
  /** `invited`: invite pending; `invite_expired`: invited, link expired. */
  status: 'active' | 'invited' | 'invite_expired';
  /** Has their own mailbox connected. */
  mailbox: boolean;
}

export interface AdminLocation {
  id: number;
  name: string;
  address: string;
  archived: boolean;
}

export interface AdminWeekUsage {
  /** Monday of the week (club time), `YYYY-MM-DD`. */
  weekStart: string;
  emailsSent: number;
  emailsFailed: number;
  bookings: number;
  availabilitySubmissions: number;
}

/** How a club email went out (email_log.via; '' for rows from before it was recorded). */
export type AdminEmailVia = '' | 'company-mailbox' | 'booker-mailbox' | 'platform' | 'outbox';

/** A failed email, without its body (bodies hold sign-in links). */
export interface AdminFailedEmail {
  id: number;
  createdAt: number;
  kind: string;
  via: AdminEmailVia;
  toEmail: string;
  subject: string;
  error: string | null;
}

export interface AdminEvent {
  id: number;
  action: AdminEventAction;
  adminEmail: string;
  reason: string;
  createdAt: number;
}

export interface AdminClubDetail {
  club: AdminClubRow;
  /** The club's timezone (weeks below are in it), or null when unreadable. */
  timezone: string | null;
  bookers: AdminBooker[];
  locations: AdminLocation[];
  /** The last 8 weeks, oldest first; the last one is this week. */
  usage: AdminWeekUsage[];
  /** The last 10, newest first. */
  failedEmails: AdminFailedEmail[];
  /** The database file (and its write-ahead log), or null when missing. */
  dbSizeBytes: number | null;
  /** Owner-console actions on this club, newest first. */
  events: AdminEvent[];
  /** Why the club's database couldn't be read (its numbers are then empty), or null. */
  dataError: string | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const reasonSchema = z.string().trim().max(500).default('');

export const adminSuspendSchema = z.object({ reason: reasonSchema });
export type AdminSuspendRequest = z.input<typeof adminSuspendSchema>;

export const adminArchiveSchema = z.object({
  /** Must be the club's address (its slug), typed by the owner. */
  confirmSlug: z.string().trim().toLowerCase().max(200),
  reason: reasonSchema,
});
export type AdminArchiveRequest = z.input<typeof adminArchiveSchema>;

/** reactivate / restore take no fields. */
export const adminEmptySchema = z.object({}).strip();

export interface AdminActionResponse {
  club: AdminClubRow;
}

/** 409 body when an action doesn't apply to the club's current status. */
export interface AdminInvalidTransitionBody {
  error: string;
  code: 'invalid_transition';
  status: AdminClubStatus;
}
