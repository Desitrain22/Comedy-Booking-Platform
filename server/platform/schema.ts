/**
 * Platform registry schema (hosted mode only, hosted MVP spec §3): `$DATA_DIR/platform.db`.
 * Each club's own data lives in `$DATA_DIR/clubs/<clubs.id>.db` with the club schema
 * (server/db/schema.ts); nothing here references club rows except by id.
 *
 * Same conventions as the club schema: integer ms timestamps, booleans as 0/1.
 * After changing this file run `npm run db:generate:platform`.
 */
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const now = () => Date.now();
const createdAt = () => integer('created_at').notNull().$defaultFn(now);

export const CLUB_STATUSES = ['active', 'suspended', 'archived'] as const;
export type ClubStatus = (typeof CLUB_STATUSES)[number];

/** One row per club account. `slug` is its subdomain: https://<slug>.<domain>. */
export const clubs = sqliteTable(
  'clubs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Lowercase, 3–30 chars of a-z 0-9 -, no hyphen at either end; never reused. */
    slug: text('slug').notNull().unique(),
    /** Company name at sign-up (the club's settings.clubName is the live one). */
    name: text('name').notNull(),
    status: text('status', { enum: CLUB_STATUSES }).notNull().default('active'),
    /** Owner's note for the latest suspend/archive ('' when none). Never shown to the club. */
    statusReason: text('status_reason').notNull().default(''),
    statusChangedAt: integer('status_changed_at'),
    /** The booker who signed up (the club's first admin). */
    ownerName: text('owner_name').notNull(),
    /** Always stored lowercased. */
    ownerEmail: text('owner_email').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('clubs_status_idx').on(t.status)],
);

/**
 * One-time sign-up handoff (spec §4): the platform host creates it, the club host redeems it
 * for a booker session cookie on its own host. Expires after 2 minutes.
 */
export const handoffs = sqliteTable('handoffs', {
  /** sha256 hex of the token (the raw token only travels in the URL fragment). */
  tokenHash: text('token_hash').primaryKey(),
  clubId: integer('club_id')
    .notNull()
    .references(() => clubs.id, { onDelete: 'cascade' }),
  /** users.id in that club's database. */
  userId: integer('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  createdAt: createdAt(),
});

/** Owner-console sessions (cookie `__Host-cbp_platform` / `cbp_platform`). */
export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    /** sha256 hex of the session token. */
    id: text('id').primaryKey(),
    /** Always stored lowercased; must still be in PLATFORM_ADMIN_EMAILS to be valid. */
    email: text('email').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('admin_sessions_expires_idx').on(t.expiresAt)],
);

/** 6-digit owner-console sign-in codes: 10 minutes, 5 tries. */
export const adminLoginCodes = sqliteTable(
  'admin_login_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    usedAt: integer('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('admin_login_codes_email_idx').on(t.email, t.createdAt)],
);

export const ADMIN_ACTIONS = ['suspend', 'reactivate', 'archive', 'restore', 'backup_download'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** Audit trail of owner-console actions. */
export const adminEvents = sqliteTable(
  'admin_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    adminEmail: text('admin_email').notNull(),
    clubId: integer('club_id').references(() => clubs.id, { onDelete: 'set null' }),
    action: text('action', { enum: ADMIN_ACTIONS }).notNull(),
    reason: text('reason').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('admin_events_club_idx').on(t.clubId, t.createdAt)],
);

export const PLATFORM_EMAIL_KINDS = ['admin_login_code', 'find_club', 'signup_notice'] as const;
export type PlatformEmailKind = (typeof PLATFORM_EMAIL_KINDS)[number];

/** Emails the platform itself sends (not on behalf of a club). Outbox rows hold the body for dev/e2e. */
export const platformEmailLog = sqliteTable(
  'platform_email_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    kind: text('kind', { enum: PLATFORM_EMAIL_KINDS }).notNull(),
    status: text('status', { enum: ['sent', 'failed', 'outbox'] }).notNull(),
    error: text('error'),
    bodyText: text('body_text').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('platform_email_log_created_idx').on(t.createdAt)],
);

/** Idempotency markers for platform jobs, e.g. key `backup:2026-11-02`. */
export const platformJobRuns = sqliteTable('platform_job_runs', {
  key: text('key').primaryKey(),
  ranAt: integer('ran_at').notNull().$defaultFn(now),
});

export type Club = typeof clubs.$inferSelect;
export type NewClub = typeof clubs.$inferInsert;
export type AdminEvent = typeof adminEvents.$inferSelect;
export type PlatformEmailLogEntry = typeof platformEmailLog.$inferSelect;
