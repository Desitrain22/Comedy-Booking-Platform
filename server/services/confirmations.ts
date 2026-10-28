/**
 * Weekly confirmation emails (spec §6 F5).
 *
 * One email per comedian listing all their scheduled spots that week (from today, club
 * time, through Sunday — spots already behind us aren't worth confirming), with a big
 * "Confirm my spots" button → createConfirmLink(db, comedianId, weekStart). Only
 * comedians with at least one unconfirmed spot are emailed. Every send is recorded in
 * email_log (via sendEmail) and, unless it failed, stamps `confirmationSentAt` on the
 * spots it listed.
 */
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { addDays, formatDateMedium, todayInTz, weekStartOf } from '../../shared/time';
import { createConfirmLink } from '../auth/tokens';
import type { Db, DbOrTx } from '../db/client';
import { bookings, comedians, locations, shows } from '../db/schema';
import { confirmationEmail, type ConfirmationSpot } from '../email/featureTemplates';
import { sendEmail } from '../email/mailer';
import { getSettings } from '../lib/settings';
import { EMAIL_CONCURRENCY, mapWithConcurrency } from './batch';

export interface SendConfirmationsOptions {
  /** Only comedians with bookings that have never had a confirmation sent. */
  onlyUnsent?: boolean;
  /** Clock override (tests, scheduler). Decides "today" in the club timezone. */
  now?: Date;
}

export interface SendConfirmationsResult {
  /** Comedians emailed (sent or outbox). */
  sent: number;
  failed: number;
  comedianIds: number[];
}

export interface SendConfirmationResult {
  status: 'sent' | 'outbox' | 'failed' | 'skipped';
  bookingCount: number;
  /** The mailer's error when `status` is `failed`. */
  error?: string;
}

export interface SendConfirmationOptions {
  now?: Date;
}

// ---------------------------------------------------------------------------
// Who has what this week
// ---------------------------------------------------------------------------

export interface WeekSpot extends ConfirmationSpot {
  bookingId: number;
  confirmationSentAt: number | null;
}

export interface ComedianWeekSpots {
  comedianId: number;
  name: string;
  email: string;
  /** Date/time order. */
  spots: WeekSpot[];
}

/** First day of the week that still counts: today when the week is underway. */
function weekFrom(weekStart: string, today: string): string {
  return today > weekStart ? today : weekStart;
}

/**
 * Scheduled spots of non-archived comedians in the week starting `weekStart`, from today
 * (club tz) through Sunday, grouped by comedian (ordered by name).
 */
export function weekSpotsByComedian(
  db: DbOrTx,
  weekStart: string,
  options: { now?: Date; comedianId?: number } = {},
): ComedianWeekSpots[] {
  const today = todayInTz(getSettings(db).timezone, options.now ?? new Date());
  const from = weekFrom(weekStart, today);
  const to = addDays(weekStart, 6);
  if (from > to) return [];

  const rows = db
    .select({
      bookingId: bookings.id,
      comedianId: bookings.comedianId,
      confirmedAt: bookings.confirmedAt,
      confirmationSentAt: bookings.confirmationSentAt,
      date: shows.date,
      startMin: shows.startMin,
      showName: shows.name,
      locationName: locations.name,
      locationAddress: locations.address,
      comedianName: comedians.name,
      comedianEmail: comedians.email,
    })
    .from(bookings)
    .innerJoin(shows, eq(bookings.showId, shows.id))
    .innerJoin(locations, eq(shows.locationId, locations.id))
    .innerJoin(comedians, eq(bookings.comedianId, comedians.id))
    .where(
      and(
        eq(shows.status, 'scheduled'),
        gte(shows.date, from),
        lte(shows.date, to),
        eq(comedians.archived, false),
        options.comedianId === undefined ? undefined : eq(bookings.comedianId, options.comedianId),
      ),
    )
    .orderBy(
      asc(comedians.name),
      asc(comedians.id),
      asc(shows.date),
      asc(shows.startMin),
      asc(locations.sortOrder),
      asc(locations.id),
    )
    .all();

  const groups = new Map<number, ComedianWeekSpots>();
  for (const row of rows) {
    let group = groups.get(row.comedianId);
    if (!group) {
      group = { comedianId: row.comedianId, name: row.comedianName, email: row.comedianEmail, spots: [] };
      groups.set(row.comedianId, group);
    }
    group.spots.push({
      bookingId: row.bookingId,
      confirmationSentAt: row.confirmationSentAt,
      date: row.date,
      startMin: row.startMin,
      showName: row.showName,
      locationName: row.locationName,
      locationAddress: row.locationAddress,
      confirmed: row.confirmedAt != null,
    });
  }
  return [...groups.values()];
}

/** Has something to confirm (and, with `onlyUnsent`, something never emailed). */
function needsConfirmation(group: ComedianWeekSpots, onlyUnsent: boolean): boolean {
  return group.spots.some((s) => !s.confirmed && (!onlyUnsent || s.confirmationSentAt == null));
}

/** How many comedians "Send confirmations now" would email for the week (both modes). */
export function countConfirmationRecipients(
  db: DbOrTx,
  weekStart: string,
  options: { now?: Date } = {},
): { pendingComedians: number; unsentComedians: number } {
  const groups = weekSpotsByComedian(db, weekStart, options);
  return {
    pendingComedians: groups.filter((g) => needsConfirmation(g, false)).length,
    unsentComedians: groups.filter((g) => needsConfirmation(g, true)).length,
  };
}

/** "this week" | "next week" | "the week of Mon, Nov 9" (relative to today in the club). */
export function weekPhrase(weekStart: string, today: string): string {
  const current = weekStartOf(today);
  if (weekStart === current) return 'this week';
  if (weekStart === addDays(current, 7)) return 'next week';
  return `the week of ${formatDateMedium(weekStart)}`;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function deliver(
  db: Db,
  group: ComedianWeekSpots,
  weekStart: string,
  now: Date,
): Promise<SendConfirmationResult> {
  const settings = getSettings(db);
  const url = createConfirmLink(db, group.comedianId, weekStart);
  const content = confirmationEmail({
    clubName: settings.clubName,
    name: group.name,
    spots: group.spots,
    url,
    weekPhrase: weekPhrase(weekStart, todayInTz(settings.timezone, now)),
  });
  const result = await sendEmail(db, {
    to: group.email,
    ...content,
    kind: 'confirmation',
    comedianId: group.comedianId,
  });
  if (result.status !== 'failed') {
    db.update(bookings)
      .set({ confirmationSentAt: now.getTime() })
      .where(
        inArray(
          bookings.id,
          group.spots.map((s) => s.bookingId),
        ),
      )
      .run();
  }
  return {
    status: result.status,
    bookingCount: group.spots.length,
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Email every comedian with an unconfirmed spot in the week (from today through Sunday)
 * one message listing all their spots that week.
 */
export async function sendConfirmationsForWeek(
  db: Db,
  weekStart: string,
  options: SendConfirmationsOptions = {},
): Promise<SendConfirmationsResult> {
  const now = options.now ?? new Date();
  const recipients = weekSpotsByComedian(db, weekStart, { now }).filter((g) =>
    needsConfirmation(g, options.onlyUnsent ?? false),
  );
  const results = await mapWithConcurrency(recipients, EMAIL_CONCURRENCY, (group) =>
    deliver(db, group, weekStart, now),
  );
  const comedianIds = recipients.filter((_, i) => results[i]!.status !== 'failed').map((g) => g.comedianId);
  return { sent: comedianIds.length, failed: recipients.length - comedianIds.length, comedianIds };
}

/**
 * (Re)send one comedian's confirmation for the week. `skipped` when they have no
 * unconfirmed spots left that week.
 */
export async function sendConfirmationToComedian(
  db: Db,
  comedianId: number,
  weekStart: string,
  options: SendConfirmationOptions = {},
): Promise<SendConfirmationResult> {
  const now = options.now ?? new Date();
  const [group] = weekSpotsByComedian(db, weekStart, { now, comedianId });
  if (!group || !needsConfirmation(group, false)) return { status: 'skipped', bookingCount: 0 };
  return deliver(db, group, weekStart, now);
}
