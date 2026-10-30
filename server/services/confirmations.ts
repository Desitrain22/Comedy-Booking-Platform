/**
 * Weekly confirmation emails (spec §6 F5).
 *
 * One email per comedian listing all their scheduled spots that week (from today, club
 * time, through Sunday — spots already behind us aren't worth confirming), with a big
 * "Confirm my spots" button → createConfirmLink(db, comedianId, weekStart). Only
 * comedians with at least one unconfirmed spot are emailed. Every send is recorded in
 * email_log (via sendEmail) and, unless it failed, stamps `confirmationSentAt` on the
 * spots it listed.
 *
 * Declined spots (the comedian said "Can't make it"; only when settings.allowDeclines)
 * are left out entirely: never listed, never a reason to email, never re-stamped. When
 * declines are allowed each listed spot gets its own "Can't make it?" link.
 *
 * Who it comes from (hosted MVP spec §5): the booker who booked *every* spot listed
 * (`bookings.bookedById`, all equal and non-null) is passed as the sender, so with
 * senderMode `booker` the email comes from them and replies go to them. Mixed bookers, a
 * removed booker (bookedById set null) or an unknown one: the company. A company send's
 * Reply-To falls back to an admin's address when no company email is configured, so
 * "reply to this email" always reaches a person.
 *
 * The scheduler (./scheduler.ts) sends the weekly run and a daily catch-up of this week's
 * never-emailed bookings, both with `onlyUnsent`.
 */
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { declineLink } from '../../shared/api/portal';
import { isUnconfirmed, isUnsent } from '../../shared/bookingStatus';
import { addDays, clubNightDate, formatDateMedium, weekStartOf, zonedTimeToUtc } from '../../shared/time';
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
  confirmedAt: number | null;
  confirmationSentAt: number | null;
  /** The booker who booked it (null: unknown, or since removed). */
  bookedById: number | null;
}

export interface ComedianWeekSpots {
  comedianId: number;
  name: string;
  email: string;
  /** Date/time order. */
  spots: WeekSpot[];
}

/** First day of the week that still counts: tonight when the week is underway. */
function weekFrom(weekStart: string, tonight: string): string {
  return tonight > weekStart ? tonight : weekStart;
}

/**
 * Scheduled, not-declined spots of non-archived comedians in the week starting
 * `weekStart` that haven't started yet, from tonight (the club night, so a 1 AM show
 * still counts at 12:30 AM) through Sunday, grouped by comedian (ordered by name).
 */
export function weekSpotsByComedian(
  db: DbOrTx,
  weekStart: string,
  options: { now?: Date; comedianId?: number } = {},
): ComedianWeekSpots[] {
  const timeZone = getSettings(db).timezone;
  const now = options.now ?? new Date();
  const from = weekFrom(weekStart, clubNightDate(timeZone, now));
  const to = addDays(weekStart, 6);
  if (from > to) return [];

  const rows = db
    .select({
      bookingId: bookings.id,
      comedianId: bookings.comedianId,
      confirmedAt: bookings.confirmedAt,
      confirmationSentAt: bookings.confirmationSentAt,
      bookedById: bookings.bookedById,
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
        // A declined spot is the booker's to replace: never listed, confirmed or re-emailed.
        isNull(bookings.declinedAt),
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
    // Last night's 9 PM show is still on the club night at 1 AM, but it's over.
    if (zonedTimeToUtc(row.date, row.startMin, timeZone) <= now.getTime()) continue;
    let group = groups.get(row.comedianId);
    if (!group) {
      group = { comedianId: row.comedianId, name: row.comedianName, email: row.comedianEmail, spots: [] };
      groups.set(row.comedianId, group);
    }
    group.spots.push({
      bookingId: row.bookingId,
      confirmedAt: row.confirmedAt,
      confirmationSentAt: row.confirmationSentAt,
      bookedById: row.bookedById,
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

/** `isUnconfirmed` / `isUnsent` for a listed spot (declined spots are never listed). */
const spotStatusInput = (s: WeekSpot) => ({ ...s, declinedAt: null });

/** Has something to confirm (and, with `onlyUnsent`, something never emailed). */
function needsConfirmation(group: ComedianWeekSpots, onlyUnsent: boolean): boolean {
  return group.spots.some((s) => (onlyUnsent ? isUnsent(spotStatusInput(s)) : isUnconfirmed(spotStatusInput(s))));
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

/**
 * Spots in the week (from today on) that still need confirming but were never emailed —
 * booked after that week's confirmations went out. What the daily catch-up sends and the
 * "N booked this week haven't been emailed yet" nudge counts.
 */
export function countUnsentSpots(db: DbOrTx, weekStart: string, options: { now?: Date } = {}): number {
  return weekSpotsByComedian(db, weekStart, options).reduce(
    (n, group) => n + group.spots.filter((s) => isUnsent(spotStatusInput(s))).length,
    0,
  );
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

/**
 * Who a confirmation listing these spots is from: the booker who booked every one of them,
 * else null (the company) — two bookers sharing a comedian's week, or a removed booker.
 */
export function confirmationSenderId(spots: readonly Pick<WeekSpot, 'bookedById'>[]): number | null {
  const first = spots[0]?.bookedById ?? null;
  if (first == null) return null;
  return spots.every((s) => s.bookedById === first) ? first : null;
}

async function deliver(
  db: Db,
  group: ComedianWeekSpots,
  weekStart: string,
  now: Date,
): Promise<SendConfirmationResult> {
  const settings = getSettings(db);
  const url = createConfirmLink(db, group.comedianId, weekStart);
  const allowDeclines = settings.allowDeclines;
  const content = confirmationEmail({
    clubName: settings.clubName,
    name: group.name,
    spots: allowDeclines ? group.spots.map((s) => ({ ...s, declineUrl: declineLink(url, s.bookingId) })) : group.spots,
    url,
    weekPhrase: weekPhrase(weekStart, clubNightDate(settings.timezone, now)),
    allowDeclines,
  });
  const result = await sendEmail(db, {
    to: group.email,
    ...content,
    kind: 'confirmation',
    comedianId: group.comedianId,
    senderUserId: confirmationSenderId(group.spots),
    // "Can't make one? Reply to this email" must reach a person even with no company email.
    replyToPerson: true,
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
