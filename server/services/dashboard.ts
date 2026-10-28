/**
 * The dashboard payload (`GET /api/dashboard`, spec §6 F5) in one pass:
 * unconfirmed tonight, tonight's shows, this week (Mon–Sun containing today, club tz),
 * confirmation send info, and availability progress for this month and next.
 */
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type {
  DashboardLocation,
  DashboardResponse,
  TonightShow,
  UnconfirmedTonightRow,
  WeekDayStats,
} from '../../shared/api/dashboard';
import { BOOKING_STATUSES, bookingStatus, type BookingStatus } from '../../shared/bookingStatus';
import { addMonths, monthOf, nowMinutesInTz, todayInTz, weekDates, weekStartOf } from '../../shared/time';
import type { DbOrTx } from '../db/client';
import { bookings, comedians, locations, shows, tags } from '../db/schema';
import { isEmailConfigured } from '../email/mailer';
import { getSettings } from '../lib/settings';
import { availabilityProgress } from './availabilityRequests';
import { countConfirmationRecipients } from './confirmations';
import { nextConfirmationSend } from './scheduler';

export function buildDashboard(db: DbOrTx, now: Date = new Date()): DashboardResponse {
  const settings = getSettings(db);
  const today = todayInTz(settings.timezone, now);
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
          overrideUnavailable: bookings.overrideUnavailable,
          confirmationSentAt: bookings.confirmationSentAt,
          confirmedAt: bookings.confirmedAt,
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
      confirmedCount: list.filter((b) => b.confirmedAt != null).length,
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
        .filter((b) => b.confirmedAt == null)
        .map((b) => ({
          bookingId: b.id,
          showId: s.id,
          comedianId: b.comedianId,
          comedianName: b.comedianName,
          comedianEmail: b.comedianEmail,
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
    const stats: WeekDayStats = { date, shows: scheduled.length, slots: 0, booked: 0, openSlots: 0, confirmed: 0, unconfirmed: 0 };
    for (const s of scheduled) {
      const list = bookingsByShow.get(s.id) ?? [];
      stats.slots += s.slotCount;
      stats.booked += list.length;
      stats.openSlots += Math.max(0, s.slotCount - list.length);
      for (const b of list) {
        if (b.confirmedAt != null) stats.confirmed++;
        else stats.unconfirmed++;
        if (date >= today) remaining[bookingStatus(b, date, today)]++;
        if (b.confirmationSentAt != null && (lastSentAt == null || b.confirmationSentAt > lastSentAt)) {
          lastSentAt = b.confirmationSentAt;
        }
      }
    }
    return stats;
  });

  const thisMonth = monthOf(today);
  return {
    today,
    nowMin: nowMinutesInTz(settings.timezone, now),
    emailConfigured: isEmailConfigured(db),
    unconfirmedTonight,
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
      },
    },
    availability: availabilityProgress(db, [thisMonth, addMonths(thisMonth, 1)]),
    tags: db.select({ id: tags.id, name: tags.name, color: tags.color }).from(tags).orderBy(asc(tags.name)).all(),
  };
}
