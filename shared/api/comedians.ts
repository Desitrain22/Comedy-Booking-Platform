/**
 * F3 — Comedians, tags, notes: request schemas, response shapes, and the per-row checks
 * for bulk add / CSV import (shared so the client's live preview and the server agree; the
 * CSV parser itself lives in `shared/csv.ts`).
 *
 *   GET    /api/comedians?search&tagIds&archived     ComedianListItem[] (search: name, email or phone)
 *   POST   /api/comedians                            { name, email, phone?, sendLoginLink? } → 201 CreateComedianResponse
 *                                                    (409 email_taken)
 *   POST   /api/comedians/bulk                       { rows: [{ name, email, phone?, note? }], dryRun?, sendLoginLinks? }
 *                                                    → BulkAddResult. Up to BULK_ADD_MAX rows; bad rows are skipped
 *                                                    with a reason (never the whole request); existing emails are
 *                                                    skipped, never overwritten; a note becomes a booker note by the
 *                                                    importing booker. Body limit BULK_ADD_BODY_MAX_BYTES (larger than
 *                                                    the rest of the API).
 *   POST   /api/comedians/bulk-tag                   { comedianIds, tagId, action } → { updated }
 *   POST   /api/comedians/bulk-archive               { comedianIds, archived } → { updated }
 *   POST   /api/comedians/bulk-send-login-link       { comedianIds } → BulkLoginLinkResult (archived skipped)
 *   GET    /api/comedians/:id                        ComedianDetail
 *   PATCH  /api/comedians/:id                        { name?, email?, phone?, bio?, headshotUrl?, archived? } → ComedianDetail
 *                                                    (a new email signs them out everywhere and voids their
 *                                                    sign-in links, confirmation links and codes)
 *   PUT    /api/comedians/:id/tags                   { tagIds } → TagSummary[]
 *   GET    /api/comedians/:id/availability?month     ComedianAvailability (month defaults to the planning month)
 *   GET    /api/comedians/:id/bookings[?upcoming=1]  ComedianBooking[]
 *   GET    /api/comedians/:id/card                   ComedianCard (hover card)
 *   POST   /api/comedians/:id/send-login-link        SendLoginLinkResponse
 *   GET    /api/comedians/:id/notes                  NoteDto[] (newest first)
 *   POST   /api/comedians/:id/notes                  { body } → 201 NoteDto
 *   PATCH  /api/notes/:id                            { body } → NoteDto (author or admin)
 *   DELETE /api/notes/:id                            { ok } (author or admin)
 *   GET    /api/tags                                 TagWithCount[] (by name)
 *   POST   /api/tags                                 { name, color? } → 201 TagWithCount (409 tag_exists)
 *   PATCH  /api/tags/:id                             { name?, color? } → TagWithCount
 *   DELETE /api/tags/:id                             { ok }
 */
import { z } from 'zod';
import type { AvailabilityEntry, AvailabilityRange } from '../availability';
import type { BookingStatus } from '../bookingStatus';
import {
  emailSchema,
  hexColorSchema,
  idSchema,
  monthSchema,
  normalizeEmail,
  queryBooleanSchema,
  queryIdListSchema,
} from '../schemas';
import { paletteColor, TAG_PALETTE, type EmailStatus, type ShowStatus } from '../types';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const COMEDIAN_NAME_MAX = 100;
export const COMEDIAN_BIO_MAX = 1000;
export const HEADSHOT_URL_MAX = 500;
export const NOTE_MAX = 2000;
export const TAG_NAME_MAX = 40;
/** Phone numbers are optional and stored as typed (trimmed). */
export const PHONE_MAX = 40;
/** Rows per bulk-add request (Import CSV and Bulk add). */
export const BULK_ADD_MAX = 1000;
/** Largest CSV file Import CSV accepts. */
export const CSV_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Largest `POST /api/comedians/bulk` body: a full 2 MB CSV as JSON, with room for quoting
 * and multi-byte characters. The rest of the API keeps its smaller limit.
 */
export const BULK_ADD_BODY_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Hard caps on the raw strings in a bulk row. Longer values reject the whole request, so
 * clients clamp to these before sending; anything over the real limits (name 100, phone 40,
 * note 2,000) is still reported per row.
 */
export const BULK_RAW_MAX = { name: 500, email: 500, phone: 200, note: 4 * NOTE_MAX } as const;
/** Notes included in the hover card. */
export const CARD_NOTE_COUNT = 3;

/** Default color for a new tag: the first palette color no tag uses yet, else cycle. */
export function nextTagColor(usedColors: readonly string[]): string {
  const used = new Set(usedColors.map((c) => c.toLowerCase()));
  return TAG_PALETTE.find((c) => !used.has(c.toLowerCase())) ?? paletteColor(usedColors.length, TAG_PALETTE);
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const comedianNameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Enter a name').max(COMEDIAN_NAME_MAX, `Use at most ${COMEDIAN_NAME_MAX} characters`));

/** `http(s)://…` or empty (no headshot). */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export const headshotUrlSchema = z
  .string()
  .trim()
  .max(HEADSHOT_URL_MAX)
  .refine((v) => v === '' || isHttpUrl(v), 'Enter a link starting with http:// or https://');

// ---------------------------------------------------------------------------
// Phone (optional; shown to bookers, never used for texting)
// ---------------------------------------------------------------------------

/** Trim and collapse runs of whitespace (spreadsheets paste tabs and non-breaking spaces). */
export function normalizePhone(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * A (normalized) phone number as people type them: digits, spaces, `+ ( ) - .`, and an
 * extension written with `ext` or `x`, at most PHONE_MAX characters, with at least one
 * digit. `''` (no phone) is valid.
 */
export function isValidPhone(value: string): boolean {
  if (value === '') return true;
  if (value.length > PHONE_MAX || !/\d/.test(value)) return false;
  return /^[\d+().\- ]*$/.test(value.replace(/ext|x/gi, ''));
}

export const PHONE_HINT = 'Use digits, spaces and + ( ) - . (add an extension with "ext" or "x")';

/** Optional phone: normalized, '' when blank. */
export const phoneSchema = z
  .string()
  .max(BULK_RAW_MAX.phone, `Use at most ${PHONE_MAX} characters`)
  .transform(normalizePhone)
  .pipe(
    z
      .string()
      .max(PHONE_MAX, `Use at most ${PHONE_MAX} characters`)
      // (Length has its own message above.)
      .refine((v) => v.length > PHONE_MAX || isValidPhone(v), PHONE_HINT),
  );

/**
 * `tel:` link for a stored phone: its digits (keeping a leading +), and an extension as a
 * dialing pause (`tel:+12125550142,12`). Null when there's nothing to dial.
 */
export function telHref(phone: string): string | null {
  const match = /^(.*?)(?:\s*(?:ext|x)\.?\s*(\d+))?\s*$/i.exec(phone.trim());
  const main = match?.[1] ?? '';
  const digits = main.replace(/\D/g, '');
  if (!digits) return null;
  const plus = main.trimStart().startsWith('+') ? '+' : '';
  const ext = match?.[2];
  return `tel:${plus}${digits}${ext ? `,${ext}` : ''}`;
}

/** Notes keep their line breaks (as \n) and lose surrounding whitespace. */
export function normalizeNote(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

/** `GET /api/comedians` query. `archived=1` includes archived comedians (default: active only). */
export const listComediansQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  /** Comedians with ANY of these tags. */
  tagIds: queryIdListSchema,
  archived: queryBooleanSchema,
});
export type ListComediansQuery = z.input<typeof listComediansQuerySchema>;

export const createComedianSchema = z.object({
  name: comedianNameSchema,
  email: emailSchema,
  /** Optional ('' or omitted = none). */
  phone: phoneSchema.optional(),
  /** Email them a portal sign-in link right away ("Email them a sign-in link", on by default in the UI). */
  sendLoginLink: z.boolean().optional(),
});
export type CreateComedianInput = z.input<typeof createComedianSchema>;

export const updateComedianSchema = z
  .object({
    name: comedianNameSchema,
    email: emailSchema,
    /** '' clears it. */
    phone: phoneSchema,
    bio: z.string().trim().max(COMEDIAN_BIO_MAX, `Keep it under ${COMEDIAN_BIO_MAX} characters`),
    headshotUrl: headshotUrlSchema,
    archived: z.boolean(),
  })
  .partial();
export type UpdateComedianInput = z.input<typeof updateComedianSchema>;

/**
 * One bulk row as sent. Only the raw lengths are checked here (BULK_RAW_MAX); every real
 * rule is checked per row by `bulkRowIssues`, so a bad row is skipped, not the request.
 */
export const bulkRowSchema = z.object({
  name: z.string().max(BULK_RAW_MAX.name),
  email: z.string().max(BULK_RAW_MAX.email),
  phone: z.string().max(BULK_RAW_MAX.phone).optional(),
  /** Becomes a private booker note on the new comedian, authored by the importing booker. */
  note: z.string().max(BULK_RAW_MAX.note).optional(),
});

/** Rows are validated one by one on the server (bad rows are skipped, not rejected). */
export const bulkAddSchema = z.object({
  rows: z
    .array(bulkRowSchema)
    .min(1, 'Paste at least one comedian')
    .max(BULK_ADD_MAX, `Add at most ${BULK_ADD_MAX.toLocaleString('en-US')} at a time`),
  /** Preview only: report what would be created/skipped without writing. */
  dryRun: z.boolean().optional(),
  /** Email each comedian created a portal sign-in link (ignored on a dry run). */
  sendLoginLinks: z.boolean().optional(),
});
export type BulkAddInput = z.input<typeof bulkAddSchema>;

export const setComedianTagsSchema = z.object({ tagIds: z.array(idSchema).max(200) });
export type SetComedianTagsInput = z.input<typeof setComedianTagsSchema>;

export const bulkTagSchema = z.object({
  comedianIds: z.array(idSchema).min(1).max(2000),
  tagId: idSchema,
  action: z.enum(['add', 'remove']),
});
export type BulkTagInput = z.input<typeof bulkTagSchema>;

export const bulkArchiveSchema = z.object({
  comedianIds: z.array(idSchema).min(1).max(2000),
  archived: z.boolean(),
});
export type BulkArchiveInput = z.input<typeof bulkArchiveSchema>;

/** `POST /api/comedians/bulk-send-login-link` — archived comedians are skipped. */
export const bulkSendLoginLinkSchema = z.object({
  comedianIds: z.array(idSchema).min(1).max(2000),
});
export type BulkSendLoginLinkInput = z.input<typeof bulkSendLoginLinkSchema>;

/**
 * `GET /api/comedians/:id/availability` — month defaults to the club's planning month
 * (`planningMonth`: next month from the 20th on).
 */
export const comedianAvailabilityQuerySchema = z.object({ month: monthSchema.optional() });

export const comedianBookingsQuerySchema = z.object({ upcoming: queryBooleanSchema });

export const noteBodySchema = z.object({
  body: z.string().trim().min(1, 'Write something first').max(NOTE_MAX, `Keep notes under ${NOTE_MAX} characters`),
});
export type NoteBodyInput = z.input<typeof noteBodySchema>;

const tagNameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Enter a tag name').max(TAG_NAME_MAX, `Use at most ${TAG_NAME_MAX} characters`));

export const createTagSchema = z.object({
  name: tagNameSchema,
  /** Defaults to the next palette color. */
  color: hexColorSchema.optional(),
});
export type CreateTagInput = z.input<typeof createTagSchema>;

export const updateTagSchema = z.object({ name: tagNameSchema, color: hexColorSchema }).partial();
export type UpdateTagInput = z.input<typeof updateTagSchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface TagSummary {
  id: number;
  name: string;
  color: string;
}

/** `GET /api/tags` row. `memberCount` counts non-archived comedians. */
export interface TagWithCount extends TagSummary {
  memberCount: number;
  createdAt: number;
}

/** `GET /api/comedians` row. */
export interface ComedianListItem {
  id: number;
  name: string;
  email: string;
  /** '' when not given. */
  phone: string;
  headshotUrl: string;
  archived: boolean;
  tags: TagSummary[];
  /**
   * Has submitted availability for the planning month (`planningMonth` of the club's today:
   * this month until the 19th, next month from the 20th on).
   */
  planningMonthSubmitted: boolean;
  /** Bookings on scheduled shows from today on. */
  upcomingCount: number;
  lastLoginAt: number | null;
  createdAt: number;
}

export interface ComedianDetail {
  id: number;
  name: string;
  email: string;
  /** '' when not given. */
  phone: string;
  bio: string;
  headshotUrl: string;
  archived: boolean;
  tags: TagSummary[];
  upcomingCount: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

export interface NoteDto {
  id: number;
  comedianId: number;
  body: string;
  authorId: number | null;
  /** Null when the author's account was removed. */
  authorName: string | null;
  createdAt: number;
  updatedAt: number;
  /** The signed-in booker wrote it, or is an admin. */
  canEdit: boolean;
}

/** `GET /api/comedians/:id/card` — everything the hover card shows. */
export interface ComedianCard {
  id: number;
  name: string;
  email: string;
  /** '' when not given. */
  phone: string;
  bio: string;
  headshotUrl: string;
  archived: boolean;
  tags: TagSummary[];
  /** Latest notes, newest first (at most CARD_NOTE_COUNT). */
  notes: NoteDto[];
  /** Total notes on the profile. */
  noteCount: number;
}

export interface ComedianBooking {
  id: number;
  showId: number;
  date: string;
  startMin: number;
  showName: string;
  showStatus: ShowStatus;
  /** 0-based slot index. */
  position: number;
  location: { id: number; name: string; color: string; address: string };
  status: BookingStatus;
  overrideUnavailable: boolean;
  confirmationSentAt: number | null;
  confirmedAt: number | null;
}

/** `GET /api/comedians/:id/availability?month` */
export interface ComedianAvailability {
  month: string;
  entries: AvailabilityEntry[];
  /** When they saved this month in the portal, or null if they haven't. */
  submittedAt: number | null;
  allNight: AvailabilityRange;
  /** Their spots in this month (scheduled shows), to show alongside availability. */
  bookings: ComedianBooking[];
  today: string;
}

/**
 * Why a bulk row was skipped, in priority order (a row reports the first that applies).
 * `invalid_email` covers a missing email too (shown as "Needs an email").
 */
export const BULK_SKIP_REASONS = [
  'invalid_email',
  'missing_name',
  'name_too_long',
  'duplicate',
  'email_taken',
  'invalid_phone',
  'note_too_long',
] as const;
export type BulkSkipReason = (typeof BULK_SKIP_REASONS)[number];
/** Problems a row has on its own (no database needed). */
export type BulkRowIssue = Exclude<BulkSkipReason, 'email_taken'>;

export const BULK_SKIP_LABELS: Record<BulkSkipReason, string> = {
  invalid_email: 'Invalid email',
  missing_name: 'Needs a name',
  name_too_long: 'Name too long',
  duplicate: 'Duplicate in list',
  email_taken: 'Already on roster',
  invalid_phone: 'Invalid phone',
  note_too_long: 'Note too long',
};

/** Longer explanations (tooltips). */
export const BULK_SKIP_HINTS: Record<BulkSkipReason, string> = {
  invalid_email: 'Comedians sign in with their email, so each one needs a valid address.',
  missing_name: 'Add a name for this comedian.',
  name_too_long: `Names can be at most ${COMEDIAN_NAME_MAX} characters.`,
  duplicate: 'This email appears earlier in the list; only the first one is added.',
  email_taken: 'Someone on the roster already uses this email. They are left as they are.',
  invalid_phone: `${PHONE_HINT}, at most ${PHONE_MAX} characters.`,
  note_too_long: `Notes can be at most ${NOTE_MAX.toLocaleString('en-US')} characters.`,
};

/** The status label for a skipped row ("Needs an email" when the email is blank). */
export function bulkSkipLabel(reason: BulkSkipReason, email: string, source: 'list' | 'file' = 'list'): string {
  if (reason === 'invalid_email' && email.trim() === '') return 'Needs an email';
  if (reason === 'duplicate') return source === 'file' ? 'Duplicate in file' : BULK_SKIP_LABELS.duplicate;
  return BULK_SKIP_LABELS[reason];
}

/** The first reason in priority order, or null. */
export function firstBulkReason<R extends BulkSkipReason>(reasons: readonly R[]): R | null {
  let best: R | null = null;
  for (const reason of reasons) {
    if (best === null || BULK_SKIP_REASONS.indexOf(reason) < BULK_SKIP_REASONS.indexOf(best)) best = reason;
  }
  return best;
}

export interface BulkRow {
  name: string;
  email: string;
  phone?: string;
  note?: string;
}

export interface BulkSkip {
  /** Index into the request's `rows`. */
  index: number;
  /** The row as sent. */
  row: BulkRow;
  reason: BulkSkipReason;
  /** For `email_taken`: the existing comedian (left unchanged). */
  existing?: { id: number; name: string; archived: boolean };
}

export interface BulkCreated {
  index: number;
  /** 0 on a dry run. */
  id: number;
  name: string;
  email: string;
  /** '' when none. */
  phone: string;
  /** The booker note added with them ('' when none). */
  note: string;
}

export interface BulkAddResult {
  dryRun: boolean;
  created: BulkCreated[];
  skipped: BulkSkip[];
  /** Sign-in links emailed to the comedians created (null unless `sendLoginLinks` on a real run). */
  loginLinks: BulkLoginLinkResult | null;
}

/** One sign-in link email. `outbox` when email isn't set up (it's in Settings → Email log). */
export interface LoginLinkResult {
  status: EmailStatus;
  error?: string;
}

/** `POST /api/comedians` */
export interface CreateComedianResponse extends ComedianDetail {
  /** The sign-in link email, when `sendLoginLink` was set. */
  loginLink: LoginLinkResult | null;
}

/** Sign-in links sent to many comedians at once. */
export interface BulkLoginLinkResult {
  /** Delivered to the mail server. */
  sent: number;
  /** Went to the outbox (email isn't set up). */
  outbox: number;
  failed: number;
  /** Archived comedians (never emailed). */
  skipped: number;
}

export interface BulkUpdateResult {
  updated: number;
}

export interface SendLoginLinkResponse {
  ok: true;
  /** `outbox` when email isn't set up (the link is in Settings → Email log). */
  status: EmailStatus;
  error?: string;
}

/** 409 `email_taken` extra fields. */
export interface EmailTakenErrorExtra {
  existing: { id: number; name: string; archived: boolean };
}

// ---------------------------------------------------------------------------
// Bulk-add row checks (pure; shared by the client preview, the server and tests)
// ---------------------------------------------------------------------------

/** A bulk row as it will be stored. */
export interface NormalizedBulkRow {
  name: string;
  email: string;
  phone: string;
  note: string;
}

export function normalizeBulkRow(row: BulkRow): NormalizedBulkRow {
  return {
    name: row.name.trim().replace(/\s+/g, ' '),
    email: normalizeEmail(row.email),
    phone: normalizePhone(row.phone ?? ''),
    note: normalizeNote(row.note ?? ''),
  };
}

/** One row's own problems (every one that applies, in priority order). */
function rowIssues(row: BulkRow): BulkRowIssue[] {
  const { name, phone, note } = normalizeBulkRow(row);
  const issues: BulkRowIssue[] = [];
  if (!emailSchema.safeParse(row.email).success) issues.push('invalid_email');
  if (!name) issues.push('missing_name');
  else if (name.length > COMEDIAN_NAME_MAX) issues.push('name_too_long');
  if (!isValidPhone(phone)) issues.push('invalid_phone');
  if (note.length > NOTE_MAX) issues.push('note_too_long');
  return issues;
}

/**
 * Every problem each row has without looking at the database, in priority order: invalid
 * or missing email, missing or too-long name, an email used by an earlier row (that has a
 * valid name and email), an invalid phone, a note over NOTE_MAX. `[]` = looks fine. The
 * server adds `email_taken`.
 */
export function bulkRowIssues(rows: readonly BulkRow[]): BulkRowIssue[][] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const issues = rowIssues(row);
    if (issues.includes('invalid_email') || issues.includes('missing_name') || issues.includes('name_too_long')) {
      return issues;
    }
    const email = normalizeEmail(row.email);
    // Only phone/note problems can be left here, and `duplicate` outranks them.
    if (seen.has(email)) return ['duplicate', ...issues];
    seen.add(email);
    return issues;
  });
}

/** The first problem of each row (see `bulkRowIssues`), or null when it looks fine. */
export function checkBulkRows(rows: readonly BulkRow[]): (BulkRowIssue | null)[] {
  return bulkRowIssues(rows).map((issues) => firstBulkReason(issues));
}
