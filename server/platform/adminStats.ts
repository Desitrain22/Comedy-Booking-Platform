/**
 * Owner console numbers (hosted MVP spec §6), read straight from each club's own database.
 *
 *   buildAdminOverview(platform, { status: 'active', search: '' });  // totals + the clubs table
 *   buildAdminClubDetail(platform, club);                            // one club in depth
 *
 * Every club is one pass: two small queries (its settings, then one row of counts). Active and
 * suspended clubs use the registry's cached handle. Archived clubs are closed (archiving
 * closed them) and stay closed: they are read through a temporary read-only handle that is
 * closed again before this returns (`withReadOnlyClubDb`). A club whose database can't be read
 * still gets its registry row, with `stats: null`.
 *
 * Plain SQL on the better-sqlite3 handle, so the same code reads both kinds of handle.
 */
import Database from 'better-sqlite3';
import { desc, eq } from 'drizzle-orm';
import { existsSync, rmSync, statSync } from 'node:fs';
import type {
  AdminBooker,
  AdminClubDetail,
  AdminClubFilter,
  AdminClubRow,
  AdminClubStats,
  AdminEmailVia,
  AdminEvent,
  AdminFailedEmail,
  AdminLocation,
  AdminOverview,
  AdminTotals,
  AdminWeekUsage,
} from '../../shared/api/platformAdmin';
import { addDays, todayInTz, weekStartOf, zonedTimeToUtc } from '../../shared/time';
import { clubHost } from './hosts';
import type { Platform } from './index';
import { adminEvents, type Club } from './schema';

type Sqlite = Database.Database;

const DAY_MS = 86_400_000;
/** "Upcoming shows": today and the next 29 days (club time). */
export const UPCOMING_DAYS = 30;
/** Weeks of usage on the club page, this week included. */
export const USAGE_WEEKS = 8;
export const FAILED_EMAILS_SHOWN = 10;
export const EVENTS_SHOWN = 100;

// ---------------------------------------------------------------------------
// Opening club databases
// ---------------------------------------------------------------------------

const SIDECARS = ['-wal', '-shm'] as const;

/**
 * Run `fn` on a temporary read-only handle to a club database that isn't open (an archived
 * club), then close it. A read-only connection to a WAL database creates the `-wal` / `-shm`
 * files when they're missing and leaves them behind; the ones it created are removed again
 * while the log is empty, so the club's folder looks as it did. Throws when the file is missing.
 */
export function withReadOnlyClubDb<T>(file: string, fn: (sqlite: Sqlite) => T): T {
  const created = SIDECARS.filter((suffix) => !existsSync(file + suffix));
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma('busy_timeout = 5000');
    return fn(sqlite);
  } finally {
    sqlite.close();
    const wal = file + '-wal';
    const walEmpty = !existsSync(wal) || statSync(wal).size === 0;
    if (walEmpty) for (const suffix of created) rmSync(file + suffix, { force: true });
  }
}

/**
 * Run `fn` on the club's database: the registry's cached handle for an active or suspended
 * club, a temporary read-only one for an archived club (which stays closed).
 */
export function withClubSqlite<T>(platform: Platform, club: Club, fn: (sqlite: Sqlite) => T): T {
  if (club.status === 'archived') return withReadOnlyClubDb(platform.registry.clubDbFile(club.id), fn);
  return fn(platform.registry.openClubDb(club).$client);
}

/** Size of the club's database file plus its write-ahead log, or null when there is no file. */
export function clubDbSize(platform: Platform, clubId: number): number | null {
  const file = platform.registry.clubDbFile(clubId);
  if (!existsSync(file)) return null;
  const wal = file + '-wal';
  return statSync(file).size + (existsSync(wal) ? statSync(wal).size : 0);
}

// ---------------------------------------------------------------------------
// Reading one club
// ---------------------------------------------------------------------------

interface SettingsRow {
  club_name: string;
  timezone: string;
  sender_mode: string;
  smtp_host: string;
}

interface ClubBasics {
  clubName: string;
  timezone: string;
  senderMode: 'company' | 'booker';
  companyMailbox: boolean;
}

function readBasics(sqlite: Sqlite): ClubBasics {
  const row = sqlite
    .prepare('SELECT club_name, timezone, sender_mode, smtp_host FROM settings WHERE id = 1')
    .get() as SettingsRow | undefined;
  return {
    clubName: row?.club_name ?? '',
    timezone: row?.timezone || 'America/New_York',
    senderMode: row?.sender_mode === 'booker' ? 'booker' : 'company',
    companyMailbox: Boolean(row?.smtp_host?.trim()),
  };
}

interface CountsRow {
  bookers: number;
  booker_mailboxes: number;
  last_sign_in: number | null;
  last_booking: number | null;
  locations: number;
  comedians: number;
  upcoming_shows: number;
  sent_7d: number;
  sent_30d: number;
  failed_30d: number;
  platform_sent_30d: number;
  platform_failed_30d: number;
}

const COUNTS_SQL = `
  SELECT
    (SELECT count(*) FROM users) AS bookers,
    (SELECT count(*) FROM users WHERE smtp_host <> '') AS booker_mailboxes,
    (SELECT max(last_login_at) FROM users) AS last_sign_in,
    (SELECT max(created_at) FROM bookings) AS last_booking,
    (SELECT count(*) FROM locations WHERE archived = 0) AS locations,
    (SELECT count(*) FROM comedians WHERE archived = 0) AS comedians,
    (SELECT count(*) FROM shows WHERE status = 'scheduled' AND date >= @today AND date < @until) AS upcoming_shows,
    (SELECT count(*) FROM email_log WHERE status = 'sent' AND created_at >= @since7) AS sent_7d,
    (SELECT count(*) FROM email_log WHERE status = 'sent' AND created_at >= @since30) AS sent_30d,
    (SELECT count(*) FROM email_log WHERE status = 'failed' AND created_at >= @since30) AS failed_30d,
    (SELECT count(*) FROM email_log WHERE status = 'sent' AND via = 'platform' AND created_at >= @since30)
      AS platform_sent_30d,
    (SELECT count(*) FROM email_log WHERE status = 'failed' AND via = 'platform' AND created_at >= @since30)
      AS platform_failed_30d`;

export interface ClubReading {
  basics: ClubBasics;
  stats: AdminClubStats;
}

/** One club's settings and counts (two queries). */
export function readClubStats(sqlite: Sqlite, now = Date.now()): ClubReading {
  const basics = readBasics(sqlite);
  const today = todayInTz(basics.timezone, new Date(now));
  const row = sqlite.prepare(COUNTS_SQL).get({
    today,
    until: addDays(today, UPCOMING_DAYS),
    since7: now - 7 * DAY_MS,
    since30: now - 30 * DAY_MS,
  }) as CountsRow;
  const lastActive = Math.max(row.last_sign_in ?? 0, row.last_booking ?? 0);
  return {
    basics,
    stats: {
      bookers: row.bookers,
      lastActiveAt: lastActive > 0 ? lastActive : null,
      locations: row.locations,
      comedians: row.comedians,
      upcomingShows: row.upcoming_shows,
      emailsSent7d: row.sent_7d,
      emailsSent30d: row.sent_30d,
      emailsFailed30d: row.failed_30d,
      platformSent30d: row.platform_sent_30d,
      platformFailed30d: row.platform_failed_30d,
      senderMode: basics.senderMode,
      companyMailbox: basics.companyMailbox,
      bookerMailboxes: row.booker_mailboxes,
    },
  };
}

/**
 * `CASE WHEN col >= ? THEN 7 WHEN col >= ? THEN 6 … WHEN col >= ? THEN 0 END`: the index of
 * the week a timestamp falls in. `bounds` are the weeks' start instants, oldest first; the
 * newest is tested first, so the parameters run newest first.
 */
function weekBucket(column: string, bounds: number[]): { sql: string; params: number[] } {
  const indexes = bounds.map((_, i) => i).reverse();
  const whens = indexes.map((i) => `WHEN ${column} >= ? THEN ${i}`);
  return { sql: `CASE ${whens.join(' ')} END`, params: indexes.map((i) => bounds[i]!) };
}

/** The last `USAGE_WEEKS` weeks (Monday starts, club time), oldest first, with their start instants. */
export function usageWeeks(timezone: string, now = Date.now()): { weekStart: string; from: number }[] {
  const thisWeek = weekStartOf(todayInTz(timezone, new Date(now)));
  return Array.from({ length: USAGE_WEEKS }, (_, i) => {
    const weekStart = addDays(thisWeek, -7 * (USAGE_WEEKS - 1 - i));
    return { weekStart, from: zonedTimeToUtc(weekStart, 0, timezone) };
  });
}

function readUsage(sqlite: Sqlite, timezone: string, now: number): AdminWeekUsage[] {
  const weeks = usageWeeks(timezone, now);
  const bounds = weeks.map((w) => w.from);
  const usage: AdminWeekUsage[] = weeks.map((w) => ({
    weekStart: w.weekStart,
    emailsSent: 0,
    emailsFailed: 0,
    bookings: 0,
    availabilitySubmissions: 0,
  }));
  const since = bounds[0]!;

  const emails = weekBucket('created_at', bounds);
  const emailRows = sqlite
    .prepare(
      `SELECT ${emails.sql} AS week, status, count(*) AS n FROM email_log
       WHERE created_at >= ? AND status IN ('sent', 'failed') GROUP BY week, status`,
    )
    .all(...emails.params, since) as { week: number; status: string; n: number }[];
  for (const row of emailRows) {
    const week = usage[row.week];
    if (!week) continue;
    if (row.status === 'sent') week.emailsSent += row.n;
    else week.emailsFailed += row.n;
  }

  const bookings = weekBucket('created_at', bounds);
  const bookingRows = sqlite
    .prepare(`SELECT ${bookings.sql} AS week, count(*) AS n FROM bookings WHERE created_at >= ? GROUP BY week`)
    .all(...bookings.params, since) as { week: number; n: number }[];
  for (const row of bookingRows) if (usage[row.week]) usage[row.week]!.bookings += row.n;

  const submissions = weekBucket('submitted_at', bounds);
  const submissionRows = sqlite
    .prepare(
      `SELECT ${submissions.sql} AS week, count(*) AS n FROM availability_submissions WHERE submitted_at >= ? GROUP BY week`,
    )
    .all(...submissions.params, since) as { week: number; n: number }[];
  for (const row of submissionRows) if (usage[row.week]) usage[row.week]!.availabilitySubmissions += row.n;

  return usage;
}

interface BookerRow {
  id: number;
  name: string;
  email: string;
  role: string;
  last_login_at: number | null;
  has_password: number;
  invite_expires_at: number | null;
  mailbox: number;
}

function readBookers(sqlite: Sqlite, now: number): AdminBooker[] {
  const rows = sqlite
    .prepare(
      `SELECT id, name, email, role, last_login_at, password_hash IS NOT NULL AS has_password,
              invite_expires_at, smtp_host <> '' AS mailbox
       FROM users ORDER BY role = 'admin' DESC, name COLLATE NOCASE, id`,
    )
    .all() as BookerRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === 'admin' ? 'admin' : 'booker',
    lastLoginAt: row.last_login_at,
    status: row.has_password
      ? 'active'
      : row.invite_expires_at != null && row.invite_expires_at > now
        ? 'invited'
        : 'invite_expired',
    mailbox: Boolean(row.mailbox),
  }));
}

function readLocations(sqlite: Sqlite): AdminLocation[] {
  const rows = sqlite
    .prepare('SELECT id, name, address, archived FROM locations ORDER BY archived, sort_order, id')
    .all() as { id: number; name: string; address: string; archived: number }[];
  return rows.map((row) => ({ id: row.id, name: row.name, address: row.address, archived: Boolean(row.archived) }));
}

interface FailedEmailRow {
  id: number;
  created_at: number;
  kind: string;
  via: string;
  to_email: string;
  subject: string;
  error: string | null;
}

const EMAIL_VIAS: readonly AdminEmailVia[] = ['', 'company-mailbox', 'booker-mailbox', 'platform', 'outbox'];

/** The latest failed emails. Never their bodies: those hold sign-in links and codes. */
function readFailedEmails(sqlite: Sqlite): AdminFailedEmail[] {
  const rows = sqlite
    .prepare(
      `SELECT id, created_at, kind, via, to_email, subject, error FROM email_log
       WHERE status = 'failed' ORDER BY created_at DESC, id DESC LIMIT ${FAILED_EMAILS_SHOWN}`,
    )
    .all() as FailedEmailRow[];
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    via: EMAIL_VIAS.includes(row.via as AdminEmailVia) ? (row.via as AdminEmailVia) : '',
    toEmail: row.to_email,
    subject: row.subject,
    error: row.error,
  }));
}

// ---------------------------------------------------------------------------
// Rows, overview, detail
// ---------------------------------------------------------------------------

export function toAdminClubRow(platform: Platform, club: Club, reading: ClubReading | null): AdminClubRow {
  return {
    id: club.id,
    slug: club.slug,
    name: reading?.basics.clubName || club.name,
    url: platform.registry.clubUrl(club),
    host: clubHost(platform.hosted, club.slug),
    status: club.status,
    statusReason: club.statusReason,
    statusChangedAt: club.statusChangedAt,
    createdAt: club.createdAt,
    owner: { name: club.ownerName, email: club.ownerEmail },
    stats: reading?.stats ?? null,
  };
}

/** The club's settings and counts, or null (logged) when its database can't be read. */
export function readClub(platform: Platform, club: Club, now = Date.now()): ClubReading | null {
  try {
    return withClubSqlite(platform, club, (sqlite) => readClubStats(sqlite, now));
  } catch (err) {
    console.error(`[owner-console] could not read the database of club ${club.slug}`, err);
    return null;
  }
}

function matchesSearch(row: AdminClubRow, club: Club, search: string): boolean {
  if (!search) return true;
  const q = search.toLowerCase();
  return [club.slug, club.name, row.name, club.ownerEmail, club.ownerName].some((value) =>
    value.toLowerCase().includes(q),
  );
}

export interface AdminOverviewOptions {
  status: AdminClubFilter;
  search: string;
  now?: number;
}

/**
 * Totals (clubs by status; everything else over active and suspended clubs) and the clubs
 * table, filtered by status and search. One pass per active/suspended club; archived clubs
 * are only read when the filter shows them.
 */
export function buildAdminOverview(platform: Platform, options: AdminOverviewOptions): AdminOverview {
  const now = options.now ?? Date.now();
  const search = options.search.trim();
  const all = platform.registry.listClubs({ status: 'all' });
  const totals: AdminTotals = {
    clubs: { active: 0, suspended: 0, archived: 0 },
    bookers: 0,
    comedians: 0,
    upcomingShows: 0,
    emailsSent7d: 0,
    emailsSent30d: 0,
  };
  const rows: AdminClubRow[] = [];
  for (const club of all) {
    totals.clubs[club.status] += 1;
    const live = club.status !== 'archived';
    const shown = options.status === 'all' || options.status === club.status;
    if (!live && !shown) continue;

    const reading = readClub(platform, club, now);
    if (live && reading) {
      totals.bookers += reading.stats.bookers;
      totals.comedians += reading.stats.comedians;
      totals.upcomingShows += reading.stats.upcomingShows;
      totals.emailsSent7d += reading.stats.emailsSent7d;
      totals.emailsSent30d += reading.stats.emailsSent30d;
    }
    if (!shown) continue;
    const row = toAdminClubRow(platform, club, reading);
    if (matchesSearch(row, club, search)) rows.push(row);
  }
  return { totals, status: options.status, search, clubs: rows };
}

export function listAdminEvents(platform: Platform, clubId: number): AdminEvent[] {
  return platform.db
    .select()
    .from(adminEvents)
    .where(eq(adminEvents.clubId, clubId))
    .orderBy(desc(adminEvents.createdAt), desc(adminEvents.id))
    .limit(EVENTS_SHOWN)
    .all()
    .map((event) => ({
      id: event.id,
      action: event.action,
      adminEmail: event.adminEmail,
      reason: event.reason,
      createdAt: event.createdAt,
    }));
}

/** Everything the club page shows. An archived club is read read-only and left closed. */
export function buildAdminClubDetail(platform: Platform, club: Club, now = Date.now()): AdminClubDetail {
  let dataError: string | null = null;
  let detail: Pick<AdminClubDetail, 'timezone' | 'bookers' | 'locations' | 'usage' | 'failedEmails'> & {
    reading: ClubReading | null;
  } = { reading: null, timezone: null, bookers: [], locations: [], usage: [], failedEmails: [] };
  try {
    detail = withClubSqlite(platform, club, (sqlite) => {
      const reading = readClubStats(sqlite, now);
      return {
        reading,
        timezone: reading.basics.timezone,
        bookers: readBookers(sqlite, now),
        locations: readLocations(sqlite),
        usage: readUsage(sqlite, reading.basics.timezone, now),
        failedEmails: readFailedEmails(sqlite),
      };
    });
  } catch (err) {
    console.error(`[owner-console] could not read the database of club ${club.slug}`, err);
    dataError = err instanceof Error ? err.message : String(err);
  }
  return {
    club: toAdminClubRow(platform, club, detail.reading),
    timezone: detail.timezone,
    bookers: detail.bookers,
    locations: detail.locations,
    usage: detail.usage,
    failedEmails: detail.failedEmails,
    dbSizeBytes: clubDbSize(platform, club.id),
    events: listAdminEvents(platform, club.id),
    dataError,
  };
}
