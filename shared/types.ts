/**
 * Cross-cutting types and constants shared by client and server.
 * Feature-specific API shapes live in `shared/api/<feature>.ts` (owned by each feature).
 */
import type { AvailabilityRange } from './availability';

// ---------------------------------------------------------------------------
// Enums (mirrors of the DB enums in server/db/schema.ts)
// ---------------------------------------------------------------------------

export const ROLES = ['admin', 'booker'] as const;
export type Role = (typeof ROLES)[number];

export const SESSION_KINDS = ['booker', 'comedian'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const SHOW_STATUSES = ['scheduled', 'cancelled'] as const;
export type ShowStatus = (typeof SHOW_STATUSES)[number];

export const CONFIRMED_BY = ['comedian', 'booker'] as const;
export type ConfirmedBy = (typeof CONFIRMED_BY)[number];

export const TOKEN_PURPOSES = ['login', 'confirm'] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export const AVAILABILITY_REQUEST_KINDS = ['request', 'reminder'] as const;
export type AvailabilityRequestKind = (typeof AVAILABILITY_REQUEST_KINDS)[number];

export const EMAIL_KINDS = [
  'login_code',
  'login_link',
  'availability_request',
  'availability_reminder',
  'confirmation',
  'booker_invite',
  'test',
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export const EMAIL_STATUSES = ['sent', 'failed', 'outbox'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** `all` or `tag:<id>` */
export type AvailabilityAudience = 'all' | `tag:${number}`;

// ---------------------------------------------------------------------------
// Palettes (spec §8)
// ---------------------------------------------------------------------------

/** Location colors, assigned in order. */
export const LOCATION_PALETTE = [
  '#7c5cff',
  '#f08c2e',
  '#14b8a6',
  '#e5484d',
  '#3b82f6',
  '#d946ef',
  '#84cc16',
  '#eab308',
] as const;

/** Tag colors (same family as locations plus a neutral). */
export const TAG_PALETTE = [...LOCATION_PALETTE, '#71717a'] as const;

export function paletteColor(index: number, palette: readonly string[] = LOCATION_PALETTE): string {
  return palette[((index % palette.length) + palette.length) % palette.length]!;
}

// ---------------------------------------------------------------------------
// API envelopes
// ---------------------------------------------------------------------------

/** Every API error body: `{ error, code?, ...extra }`. */
export interface ApiErrorBody {
  error: string;
  code?: string;
  [extra: string]: unknown;
}

export interface OkResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// Auth / session
// ---------------------------------------------------------------------------

export interface MeBooker {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface MeComedian {
  id: number;
  email: string;
  name: string;
}

export interface ClubInfo {
  name: string;
  timezone: string;
  allNight: AvailabilityRange;
}

/** `GET /api/auth/me` */
export interface MeResponse {
  booker: MeBooker | null;
  comedian: MeComedian | null;
  setupComplete: boolean;
  club: ClubInfo;
}

/** `GET /api/auth/invite/:token` */
export interface InviteInfo {
  email: string;
  name: string;
  clubName: string;
}

/** `POST /api/auth/magic` */
export interface MagicLinkResponse {
  redirectTo: string;
  comedian: MeComedian;
}

// ---------------------------------------------------------------------------
// Locations (foundation-owned API)
// ---------------------------------------------------------------------------

export interface Location {
  id: number;
  name: string;
  address: string;
  color: string;
  sortOrder: number;
  archived: boolean;
  createdAt: number;
}
