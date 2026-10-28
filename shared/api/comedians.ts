/**
 * F3 — Comedians, tags, notes: request schemas, response shapes, and the bulk-add line
 * parser (shared so the client's live preview and the server agree).
 *
 *   GET    /api/comedians?search&tagIds&archived     ComedianListItem[]
 *   POST   /api/comedians                            { name, email } → 201 ComedianDetail (409 email_taken)
 *   POST   /api/comedians/bulk                       { rows, dryRun? } → BulkAddResult
 *   POST   /api/comedians/bulk-tag                   { comedianIds, tagId, action } → { updated }
 *   POST   /api/comedians/bulk-archive               { comedianIds, archived } → { updated }
 *   GET    /api/comedians/:id                        ComedianDetail
 *   PATCH  /api/comedians/:id                        { name?, email?, bio?, headshotUrl?, archived? } → ComedianDetail
 *   PUT    /api/comedians/:id/tags                   { tagIds } → TagSummary[]
 *   GET    /api/comedians/:id/availability?month     ComedianAvailability
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
import { emailSchema, hexColorSchema, idSchema, monthSchema, queryBooleanSchema, queryIdListSchema } from '../schemas';
import { paletteColor, TAG_PALETTE, type EmailStatus, type ShowStatus } from '../types';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const COMEDIAN_NAME_MAX = 100;
export const COMEDIAN_BIO_MAX = 1000;
export const HEADSHOT_URL_MAX = 500;
export const NOTE_MAX = 2000;
export const TAG_NAME_MAX = 40;
/** Rows per bulk-add request. */
export const BULK_ADD_MAX = 500;
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
});
export type CreateComedianInput = z.input<typeof createComedianSchema>;

export const updateComedianSchema = z
  .object({
    name: comedianNameSchema,
    email: emailSchema,
    bio: z.string().trim().max(COMEDIAN_BIO_MAX, `Keep it under ${COMEDIAN_BIO_MAX} characters`),
    headshotUrl: headshotUrlSchema,
    archived: z.boolean(),
  })
  .partial();
export type UpdateComedianInput = z.input<typeof updateComedianSchema>;

/** Rows are validated one by one on the server (bad rows are skipped, not rejected). */
export const bulkAddSchema = z.object({
  rows: z
    .array(z.object({ name: z.string().max(500), email: z.string().max(500) }))
    .min(1, 'Paste at least one comedian')
    .max(BULK_ADD_MAX, `Add at most ${BULK_ADD_MAX} at a time`),
  /** Preview only: report what would be created/skipped without writing. */
  dryRun: z.boolean().optional(),
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

/** `GET /api/comedians/:id/availability` — month defaults to the club's current month. */
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
  headshotUrl: string;
  archived: boolean;
  tags: TagSummary[];
  /** Has submitted availability for next month (club timezone). */
  nextMonthSubmitted: boolean;
  /** Bookings on scheduled shows from today on. */
  upcomingCount: number;
  lastLoginAt: number | null;
  createdAt: number;
}

export interface ComedianDetail {
  id: number;
  name: string;
  email: string;
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

export const BULK_SKIP_REASONS = ['missing_name', 'invalid_email', 'duplicate', 'email_taken'] as const;
export type BulkSkipReason = (typeof BULK_SKIP_REASONS)[number];

export const BULK_SKIP_LABELS: Record<BulkSkipReason, string> = {
  missing_name: 'Missing name',
  invalid_email: 'Invalid email',
  duplicate: 'Duplicate in list',
  email_taken: 'Already on roster',
};

export interface BulkRow {
  name: string;
  email: string;
}

export interface BulkSkip {
  /** Index into the request's `rows`. */
  index: number;
  row: BulkRow;
  reason: BulkSkipReason;
  /** For `email_taken`: the existing comedian. */
  existing?: { id: number; name: string; archived: boolean };
}

export interface BulkCreated {
  index: number;
  /** 0 on a dry run. */
  id: number;
  name: string;
  email: string;
}

export interface BulkAddResult {
  dryRun: boolean;
  created: BulkCreated[];
  skipped: BulkSkip[];
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
// Bulk-add parsing (pure; shared by the client preview and tests)
// ---------------------------------------------------------------------------

export interface ParsedBulkLine extends BulkRow {
  /** 1-based line number in the pasted text. */
  line: number;
  raw: string;
}

function cleanName(value: string): string {
  return value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanEmail(value: string): string {
  return value
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^[<("']+|[>)"',;.]+$/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Parse pasted lines. Accepts `Name, email`, `Name <email>`, `email, Name`, tab- or
 * semicolon-separated columns (spreadsheet pastes), and `Name email`. Blank lines are
 * ignored. Unparseable parts come back as empty strings (flagged by `checkBulkRows`).
 */
export function parseBulkLines(text: string): ParsedBulkLine[] {
  const out: ParsedBulkLine[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const raw = rawLine.trim();
    if (!raw) return;
    const line = i + 1;

    const angle = /^(.*?)<([^<>]*)>\s*[,;]?\s*$/.exec(raw);
    if (angle) {
      out.push({ line, raw, name: cleanName(angle[1]!.replace(/[,;]\s*$/, '')), email: cleanEmail(angle[2]!) });
      return;
    }

    const parts = raw
      .split(/[,;\t]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const emailIdx = parts.findIndex((p) => p.includes('@'));
      if (emailIdx === -1) {
        out.push({ line, raw, name: cleanName(parts.join(' ')), email: '' });
        return;
      }
      const name = parts.filter((_, idx) => idx !== emailIdx).join(' ');
      out.push({ line, raw, name: cleanName(name), email: cleanEmail(parts[emailIdx]!) });
      return;
    }

    // One column: maybe "Name email" separated by spaces.
    const tokens = raw.split(/\s+/);
    const emailIdx = tokens.findIndex((tok) => tok.includes('@'));
    if (emailIdx === -1) {
      out.push({ line, raw, name: cleanName(raw), email: '' });
      return;
    }
    const name = tokens.filter((_, idx) => idx !== emailIdx).join(' ');
    out.push({ line, raw, name: cleanName(name), email: cleanEmail(tokens[emailIdx]!) });
  });
  return out;
}

/**
 * Per-row problems that need no database: missing name, invalid email, or an email that
 * appeared earlier in the same batch. `null` = looks fine. The server adds `email_taken`.
 */
export function checkBulkRows(rows: readonly BulkRow[]): (BulkSkipReason | null)[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const name = comedianNameSchema.safeParse(row.name);
    const email = emailSchema.safeParse(row.email);
    if (!email.success) return 'invalid_email';
    if (!name.success) return 'missing_name';
    if (seen.has(email.data)) return 'duplicate';
    seen.add(email.data);
    return null;
  });
}
