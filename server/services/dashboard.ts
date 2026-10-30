/**
 * The dashboard payload (`GET /api/dashboard`, spec §6 F5) in one pass:
 * unconfirmed tonight, declined spots that need a replacement, tonight's shows, this week
 * (Mon–Sun containing tonight, club tz), confirmation send info (incl. the "not emailed yet"
 * nudge), availability progress (this month → planning month + 1) and the new-club
 * checklist counts.
 *
 * "Tonight" is the club *night* (`clubNightDate`): until 6 AM a 1 AM show is still tonight.
 * Month logic (availability, planning month) uses the calendar date.
 */
import { and, asc, count, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';
import type {
  DashboardLocation,
  DashboardResponse,
  DashboardSetup,
  NeedsReplacementRow,
  TonightShow,
  UnconfirmedTonightRow,
  WeekDayStats,
} from '../../shared/api/dashboard';
import { BOOKING_STATUSES, bookingStatus, isUnconfirmed, type BookingStatus } from '../../shared/bookingStatus';
import {
  addMonths,
  clubNightDate,
  monthOf,
  nowMinutesInTz,
  planningMonth,
  todayInTz,
  weekDates,
  weekStartOf,
} from '../../shared/time';
import type { DbOrTx } from '../db/client';
import { availabilityRequests, bookings, comedians, locations, shows, tags } from '../db/schema';
import { isEmailConfigured } from '../email/mailer';
import { getSettings } from '../lib/settings';
import { availabilityProgress } from './availabilityRequests';
import { countConfirmationRecipients, countUnsentSpots } from './confirmations';
import { nextConfirmationSend } from './scheduler';

export function buildDashboard(db: DbOrTx, now: Date = new Date()): DashboardResponse {
  const settings = getSettings(db);
  // The club *night*: until 6 AM a 1 AM show is still tonight (and still red).
  const today = clubNightDate(settings.timezone, now);
  const weekStart = weekStartOf(today);
  const days = weekDates(weekStart);
  const weekEnd = days[6]!;

  // Shows this week (with their location) -------------------------------------------
  const showRows = db
    .select({
      id: shows.id,
      date: shows.date,
      startMin: shows.startMin,
      name: shows.name,
      slotCount: shows.slotCount,
      status: shows.status,
      locationId: locations.id,
      locationName: locations.name,
      locationAddress: locations.address,
      locationColor: locations.color,
      locationOrder: locations.sortOrder,
    })
    .from(shows)
    .innerJoin(locations, eq(shows.locationId, locations.id))
    .where(and(gte(shows.date, weekStart), lte(shows.date, weekEnd)))
    .orderBy(asc(shows.date), asc(shows.startMin), asc(locations.sortOrder), asc(locations.id), asc(shows.id))
    .all();

  const bookingRows = showRows.length
    ? db
        .select({
          id: bookings.id,
          showId: bookings.showId,
          position: bookings.position,
          comedianId: bookings.comedianId,
          comedianName: comedians.name,
          comedianEmail: comedians.email,
          comedianArchived: comedians.archived,
          overrideUnavailable: bookings.overrideUnavailable,
          confirmationSentAt: bookings.confirmationSentAt,
          confirmedAt: bookings.confirmedAt,
          declinedAt: bookings.declinedAt,
        })
        .from(bookings)
        .innerJoin(comedians, eq(bookings.comedianId, comedians.id))
        .where(
          inArray(
            bookings.showId,
            showRows.map((s) => s.id),
          ),
        )
        .orderBy(asc(bookings.position))
        .all()
    : [];
  const bookingsByShow = new Map<number, typeof bookingRows>();
  for (const b of bookingRows) {
    const list = bookingsByShow.get(b.showId) ?? [];
    list.push(b);
    bookingsByShow.set(b.showId, list);
  }

  const locationOf = (s: (typeof showRows)[number]): DashboardLocation => ({
    id: s.locationId,
    name: s.locationName,
    address: s.locationAddress,
    color: s.locationColor,
  });

  // Tonight ------------------------------------------------------------------------
  const todays = showRows.filter((s) => s.date === today);
  const tonight: TonightShow[] = [
    ...todays.filter((s) => s.status === 'scheduled'),
    ...todays.filter((s) => s.status !== 'scheduled'),
  ].map((s) => {
    const list = bookingsByShow.get(s.id) ?? [];
    return {
      id: s.id,
      startMin: s.startMin,
      name: s.name,
      slotCount: s.slotCount,
      status: s.status,
      location: locationOf(s),
      bookedCount: list.length,
      confirmedCount: list.filter((b) => bookingStatus(b, s.date, today) === 'confirmed').length,
      bookings: list.map((b) => ({
        id: b.id,
        position: b.position,
        comedianId: b.comedianId,
        comedianName: b.comedianName,
        status: bookingStatus(b, s.date, today),
        overrideUnavailable: b.overrideUnavailable,
      })),
    };
  });

  const unconfirmedTonight: UnconfirmedTonightRow[] = todays
    .filter((s) => s.status === 'scheduled')
    .flatMap((s) =>
      (bookingsByShow.get(s.id) ?? [])
        .filter((b) => isUnconfirmed(b))
        .map((b) => ({
          bookingId: b.id,
          showId: s.id,
          comedianId: b.comedianId,
          comedianName: b.comedianName,
          comedianEmail: b.comedianEmail,
          comedianArchived: b.comedianArchived,
          startMin: s.startMin,
          showName: s.name,
          location: locationOf(s),
          confirmationSentAt: b.confirmationSentAt,
        })),
    );

  // This week ---------------------------------------------------------------------
  const remaining = Object.fromEntries(BOOKING_STATUSES.map((st) => [st, 0])) as Record<BookingStatus, number>;
  let lastSentAt: number | null = null;
  const dayStats: WeekDayStats[] = days.map((date) => {
    const scheduled = showRows.filter((s) => s.date === date && s.status === 'scheduled');
    const stats: WeekDayStats = {
      date,
      shows: scheduled.length,
      slots: 0,
      booked: 0,
      openSlots: 0,
      confirmed: 0,
      unconfirmed: 0,
      declined: 0,
    };
    for (const s of scheduled) {
      const list = bookingsByShow.get(s.id) ?? [];
      stats.slots += s.slotCount;
      stats.booked += list.length;
      stats.openSlots += Math.max(0, s.slotCount - list.length);
      for (const b of list) {
        const status = bookingStatus(b, date, today);
        if (status === 'declined') stats.declined++;
        else if (status === 'confirmed') stats.confirmed++;
        else stats.unconfirmed++;
        if (date >= today) remaining[status]++;
        if (b.confirmationSentAt != null && (lastSentAt == null || b.confirmationSentAt > lastSentAt)) {
          lastSentAt = b.confirmationSentAt;
        }
      }
    }
    return stats;
  });

  // Months: this month → the planning month and the one after (calendar date, not the night).
  const calendarToday = todayInTz(settings.timezone, now);
  const thisMonth = monthOf(calendarToday);
  const planning = planningMonth(calendarToday);
  const months = [...new Set([thisMonth, planning, addMonths(planning, 1)])];

  return {
    today,
    planningMonth: planning,
    nowMin: nowMinutesInTz(settings.timezone, now),
    emailConfigured: isEmailConfigured(db),
    unconfirmedTonight,
    needsReplacement: needsReplacement(db, today),
    tonight,
    week: {
      weekStart,
      weekEnd,
      days: dayStats,
      remaining,
      confirmations: {
        enabled: settings.confirmationsEnabled,
        day: settings.confirmationDay,
        timeMin: settings.confirmationTimeMin,
        lastSentAt,
        nextSend: nextConfirmationSend(db, now),
        ...countConfirmationRecipients(db, weekStart, { now }),
        // Never emailed and still to confirm, from now to Sunday: the same rule as the day
        // board's nudge, the daily catch-up and the nudge's Send, so Send always clears it.
        unsentBookings: countUnsentSpots(db, weekStart, { now }),
        catchUpEnabled: settings.catchUpEnabled,
      },
    },
    availability: availabilityProgress(db, months),
    tags: db.select({ id: tags.id, name: tags.name, color: tags.color }).from(tags).orderBy(asc(tags.name)).all(),
    setup: setupCounts(db),
  };
}

/** Declined spots on scheduled shows from tonight on (they keep their slot until replaced). */
function needsReplacement(db: DbOrTx, tonight: string): NeedsReplacementRow[] {
  return db
    .select({
      bookingId: bookings.id,
      showId: shows.id,
      date: shows.date,
      startMin: shows.startMin,
      showName: shows.name,
      locationId: locations.id,
      locationName: locations.name,
      locationAddress: locations.address,
      locationColor: locations.color,
      position: bookings.position,
      comedianId: comedians.id,
      comedianName: comedians.name,
      declinedAt: bookings.declinedAt,
      declineNote: bookings.declineNote,
    })
    .from(bookings)
    .innerJoin(shows, eq(bookings.showId, shows.id))
    .innerJoin(locations, eq(shows.locationId, locations.id))
    .innerJoin(comedians, eq(bookings.comedianId, comedians.id))
    .where(and(isNotNull(bookings.declinedAt), eq(shows.status, 'scheduled'), gte(shows.date, tonight)))
    .orderBy(asc(shows.date), asc(shows.startMin), asc(locations.sortOrder), asc(locations.id), asc(bookings.position))
    .all()
    .map(({ locationId, locationName, locationAddress, locationColor, declinedAt, ...row }) => ({
      ...row,
      declinedAt: declinedAt!,
      location: { id: locationId, name: locationName, address: locationAddress, color: locationColor },
    }));
}

function setupCounts(db: DbOrTx): DashboardSetup {
  const countOf = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  return {
    locations: countOf(db.select({ n: count() }).from(locations).where(eq(locations.archived, false)).all()),
    comedians: countOf(db.select({ n: count() }).from(comedians).where(eq(comedians.archived, false)).all()),
    shows: countOf(db.select({ n: count() }).from(shows).all()),
    availabilityRequests: countOf(db.select({ n: count() }).from(availabilityRequests).all()),
  };
}
