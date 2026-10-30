/**
 * Database schema (spec §4). Foundation-owned: features must not edit this file.
 *
 * Conventions: integer autoincrement ids, timestamps are integer ms since epoch,
 * dates are YYYY-MM-DD strings in the club timezone, times are minutes after local
 * midnight. Booleans are stored as 0/1 integers (drizzle `mode: 'boolean'`).
 *
 * After changing this file run `npm run db:generate` to create a migration.
 */
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = () => Date.now();
const createdAt = () => integer('created_at').notNull().$defaultFn(now);
const bool = (name: string) => integer(name, { mode: 'boolean' });

// ---------------------------------------------------------------------------
// Club settings (singleton row id = 1)
// ---------------------------------------------------------------------------

export const settings = sqliteTable(
  'settings',
  {
    id: integer('id').primaryKey().default(1),
    clubName: text('club_name').notNull().default(''),
    timezone: text('timezone').notNull().default('America/New_York'),
    /** Base URL used for links in emails, e.g. https://booking.example.com (no trailing slash). */
    appUrl: text('app_url').notNull().default(''),
    allNightStartMin: integer('all_night_start_min').notNull().default(1140),
    allNightEndMin: integer('all_night_end_min').notNull().default(1380),
    /** Empty host = SMTP not configured here (env vars, then the outbox, are used). */
    smtpHost: text('smtp_host').notNull().default(''),
    smtpPort: integer('smtp_port').notNull().default(587),
    smtpSecure: bool('smtp_secure').notNull().default(false),
    smtpUser: text('smtp_user').notNull().default(''),
    smtpPass: text('smtp_pass').notNull().default(''),
    fromName: text('from_name').notNull().default(''),
    fromEmail: text('from_email').notNull().default(''),
    replyTo: text('reply_to').notNull().default(''),
    confirmationsEnabled: bool('confirmations_enabled').notNull().default(true),
    /** 0 = Sunday … 6 = Saturday. */
    confirmationDay: integer('confirmation_day').notNull().default(1),
    confirmationTimeMin: integer('confirmation_time_min').notNull().default(600),
    /**
     * Daily catch-up: each day at confirmationTimeMin, email comedians whose spots in the
     * current week (Mon–Sun) were booked after that week's confirmations went out.
     */
    catchUpEnabled: bool('catch_up_enabled').notNull().default(true),
    /**
     * Comedians may decline a single spot ("Can't make it") from the portal and the
     * confirmation email. Off = all-or-nothing "confirm the week".
     */
    allowDeclines: bool('allow_declines').notNull().default(false),
    setupComplete: bool('setup_complete').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [check('settings_singleton', sql`${t.id} = 1`)],
);

// ---------------------------------------------------------------------------
// People & auth
// ---------------------------------------------------------------------------

/** Bookers (club staff). */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Always stored lowercased. */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  /** Null until the invite is accepted. */
  passwordHash: text('password_hash'),
  role: text('role', { enum: ['admin', 'booker'] }).notNull().default('booker'),
  inviteTokenHash: text('invite_token_hash').unique(),
  inviteExpiresAt: integer('invite_expires_at'),
  createdAt: createdAt(),
  lastLoginAt: integer('last_login_at'),
  /** Setup guide / welcome tour: when this booker skipped it (null = not skipped). */
  guideDismissedAt: integer('guide_dismissed_at'),
  /** Setup guide / welcome tour: when this booker finished it (never auto-starts again). */
  guideCompletedAt: integer('guide_completed_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** sha256 hex of the session token (the raw token only lives in the cookie). */
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['booker', 'comedian'] }).notNull(),
    /** users.id for bookers, comedians.id for comedians. */
    subjectId: integer('subject_id').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_subject_idx').on(t.kind, t.subjectId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

export const comedians = sqliteTable('comedians', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Always stored lowercased. */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  bio: text('bio').notNull().default(''),
  headshotUrl: text('headshot_url').notNull().default(''),
  /** Optional, stored as typed (never used for texting). */
  phone: text('phone').notNull().default(''),
  archived: bool('archived').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: integer('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
  lastLoginAt: integer('last_login_at'),
});

/** One-time 6-digit sign-in codes for comedians (stored hashed). */
export const loginCodes = sqliteTable(
  'login_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    comedianId: integer('comedian_id')
      .notNull()
      .references(() => comedians.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: integer('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('login_codes_comedian_idx').on(t.comedianId, t.createdAt)],
);

/** Magic-link (`login`) and weekly confirmation (`confirm`) tokens for comedians. */
export const tokens = sqliteTable(
  'tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenHash: text('token_hash').notNull().unique(),
    comedianId: integer('comedian_id')
      .notNull()
      .references(() => comedians.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['login', 'confirm'] }).notNull(),
    /** Monday of the week, for `confirm` tokens. */
    weekStart: text('week_start'),
    /** In-app path to land on after a `login` token is used. */
    redirectTo: text('redirect_to'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('tokens_comedian_idx').on(t.comedianId)],
);

// ---------------------------------------------------------------------------
// Venues & shows
// ---------------------------------------------------------------------------

export const locations = sqliteTable('locations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  address: text('address').notNull().default(''),
  /** Hex color, e.g. #7c5cff. */
  color: text('color').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  archived: bool('archived').notNull().default(false),
  createdAt: createdAt(),
});

export const shows = sqliteTable(
  'shows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    locationId: integer('location_id')
      .notNull()
      .references(() => locations.id),
    date: text('date').notNull(),
    /** Minutes after local midnight, 720–1559. */
    startMin: integer('start_min').notNull(),
    name: text('name').notNull().default(''),
    slotCount: integer('slot_count').notNull().default(6),
    status: text('status', { enum: ['scheduled', 'cancelled'] }).notNull().default('scheduled'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('shows_date_idx').on(t.date),
    index('shows_location_date_idx').on(t.locationId, t.date, t.startMin),
  ],
);

export const bookings = sqliteTable(
  'bookings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    showId: integer('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    comedianId: integer('comedian_id')
      .notNull()
      .references(() => comedians.id),
    /** 0-based slot index within the show. */
    position: integer('position').notNull(),
    overrideUnavailable: bool('override_unavailable').notNull().default(false),
    bookedById: integer('booked_by_id').references(() => users.id, { onDelete: 'set null' }),
    confirmationSentAt: integer('confirmation_sent_at'),
    confirmedAt: integer('confirmed_at'),
    confirmedBy: text('confirmed_by', { enum: ['comedian', 'booker'] }),
    /**
     * The comedian said they can't make it (only when settings.allowDeclines). The booking
     * keeps its slot so the booker sees who to replace; status `declined` wins over all.
     */
    declinedAt: integer('declined_at'),
    /** Optional reason the comedian gave when declining ('' when none). */
    declineNote: text('decline_note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bookings_show_position_uq').on(t.showId, t.position),
    uniqueIndex('bookings_show_comedian_uq').on(t.showId, t.comedianId),
    index('bookings_comedian_idx').on(t.comedianId),
  ],
);

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export const availability = sqliteTable(
  'availability',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    comedianId: integer('comedian_id')
      .notNull()
      .references(() => comedians.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    /** Range in [960, 1560], inclusive of both ends when matching shows. */
    startMin: integer('start_min').notNull(),
    endMin: integer('end_min').notNull(),
    updatedAt: integer('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
  },
  (t) => [
    uniqueIndex('availability_comedian_date_uq').on(t.comedianId, t.date),
    index('availability_date_idx').on(t.date),
  ],
);

/** A comedian saved a month (even with zero nights) → "submitted". */
export const availabilitySubmissions = sqliteTable(
  'availability_submissions',
  {
    comedianId: integer('comedian_id')
      .notNull()
      .references(() => comedians.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    submittedAt: integer('submitted_at').notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.comedianId, t.month] })],
);

export const availabilityRequests = sqliteTable(
  'availability_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    month: text('month').notNull(),
    kind: text('kind', { enum: ['request', 'reminder'] }).notNull(),
    message: text('message').notNull().default(''),
    /** `all` or `tag:<id>`. */
    audience: text('audience').notNull().default('all'),
    recipientCount: integer('recipient_count').notNull().default(0),
    sentById: integer('sent_by_id').references(() => users.id, { onDelete: 'set null' }),
    sentAt: integer('sent_at').notNull().$defaultFn(now),
  },
  (t) => [index('availability_requests_month_idx').on(t.month)],
);

// ---------------------------------------------------------------------------
// Tags & notes
// ---------------------------------------------------------------------------

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  color: text('color').notNull(),
  createdAt: createdAt(),
});

export const comedianTags = sqliteTable(
  'comedian_tags',
  {
    comedianId: integer('comedian_id')
      .notNull()
      .references(() => comedians.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.comedianId, t.tagId] }), index('comedian_tags_tag_idx').on(t.tagId)],
);

/** Private booker notes about a comedian. */
export const notes = sqliteTable(
  'notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    comedianId: integer('comedian_id')
      .notNull()
      .references(() => comedians.id, { onDelete: 'cascade' }),
    /** Null if the author's account was removed. */
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
    updatedAt: integer('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
  },
  (t) => [index('notes_comedian_idx').on(t.comedianId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Email & jobs
// ---------------------------------------------------------------------------

export const emailLog = sqliteTable(
  'email_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    kind: text('kind', {
      enum: [
        'login_code',
        'login_link',
        'availability_request',
        'availability_reminder',
        'confirmation',
        'booker_invite',
        'test',
      ],
    }).notNull(),
    status: text('status', { enum: ['sent', 'failed', 'outbox'] }).notNull(),
    error: text('error'),
    comedianId: integer('comedian_id').references(() => comedians.id, { onDelete: 'set null' }),
    bodyHtml: text('body_html').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('email_log_created_idx').on(t.createdAt), index('email_log_comedian_idx').on(t.comedianId)],
);

/** Idempotency markers for scheduled jobs, e.g. key `confirmations:2026-11-02`. */
export const jobRuns = sqliteTable('job_runs', {
  key: text('key').primaryKey(),
  ranAt: integer('ran_at').notNull().$defaultFn(now),
});

// ---------------------------------------------------------------------------
// Relations (for drizzle's relational queries: db.query.shows.findMany({ with: … }))
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  notes: many(notes),
  bookingsMade: many(bookings),
}));

export const comediansRelations = relations(comedians, ({ many }) => ({
  bookings: many(bookings),
  availability: many(availability),
  submissions: many(availabilitySubmissions),
  comedianTags: many(comedianTags),
  notes: many(notes),
  tokens: many(tokens),
  loginCodes: many(loginCodes),
}));

export const loginCodesRelations = relations(loginCodes, ({ one }) => ({
  comedian: one(comedians, { fields: [loginCodes.comedianId], references: [comedians.id] }),
}));

export const tokensRelations = relations(tokens, ({ one }) => ({
  comedian: one(comedians, { fields: [tokens.comedianId], references: [comedians.id] }),
}));

export const locationsRelations = relations(locations, ({ many }) => ({
  shows: many(shows),
}));

export const showsRelations = relations(shows, ({ one, many }) => ({
  location: one(locations, { fields: [shows.locationId], references: [locations.id] }),
  bookings: many(bookings),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  show: one(shows, { fields: [bookings.showId], references: [shows.id] }),
  comedian: one(comedians, { fields: [bookings.comedianId], references: [comedians.id] }),
  bookedBy: one(users, { fields: [bookings.bookedById], references: [users.id] }),
}));

export const availabilityRelations = relations(availability, ({ one }) => ({
  comedian: one(comedians, { fields: [availability.comedianId], references: [comedians.id] }),
}));

export const availabilitySubmissionsRelations = relations(availabilitySubmissions, ({ one }) => ({
  comedian: one(comedians, {
    fields: [availabilitySubmissions.comedianId],
    references: [comedians.id],
  }),
}));

export const availabilityRequestsRelations = relations(availabilityRequests, ({ one }) => ({
  sentBy: one(users, { fields: [availabilityRequests.sentById], references: [users.id] }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  comedianTags: many(comedianTags),
}));

export const comedianTagsRelations = relations(comedianTags, ({ one }) => ({
  comedian: one(comedians, { fields: [comedianTags.comedianId], references: [comedians.id] }),
  tag: one(tags, { fields: [comedianTags.tagId], references: [tags.id] }),
}));

export const notesRelations = relations(notes, ({ one }) => ({
  comedian: one(comedians, { fields: [notes.comedianId], references: [comedians.id] }),
  author: one(users, { fields: [notes.authorId], references: [users.id] }),
}));

export const emailLogRelations = relations(emailLog, ({ one }) => ({
  comedian: one(comedians, { fields: [emailLog.comedianId], references: [comedians.id] }),
}));

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type Settings = typeof settings.$inferSelect;
export type SettingsUpdate = Partial<Omit<typeof settings.$inferInsert, 'id' | 'createdAt'>>;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Comedian = typeof comedians.$inferSelect;
export type NewComedian = typeof comedians.$inferInsert;
export type LoginCode = typeof loginCodes.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
export type Show = typeof shows.$inferSelect;
export type NewShow = typeof shows.$inferInsert;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type Availability = typeof availability.$inferSelect;
export type NewAvailability = typeof availability.$inferInsert;
export type AvailabilitySubmission = typeof availabilitySubmissions.$inferSelect;
export type AvailabilityRequest = typeof availabilityRequests.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type ComedianTag = typeof comedianTags.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type EmailLogEntry = typeof emailLog.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
