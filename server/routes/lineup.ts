/**
 * F2 Day view / lineup board API (spec §6 F2). Shapes live in `shared/api/lineup.ts`.
 *
 *   GET    /api/days/:date              every scheduled show that day with its lineup, plus the
 *                                       comedian pool (tags, availability, bookings that day)
 *   POST   /api/bookings                book a comedian into an empty slot
 *   PATCH  /api/bookings/:id            move (swap when the target slot is occupied)
 *   DELETE /api/bookings/:id            unbook
 *   POST   /api/bookings/:id/confirm    booker marks a booking confirmed (F5's dashboard too)
 *
 * Availability (spec §3, `isAvailableFor`) is checked when booking and when moving to a
 * different show; an unavailable comedian → 409 `unavailable` with what they marked, unless
 * `force: true`, which stores `overrideUnavailable`. Moving to a different show resets the
 * booking's confirmation (it is a different spot now). Swaps run in one transaction and park
 * the moving booking on a temporary negative position so the unique (showId, position)
 * index never sees two bookings in one slot.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createBookingSchema,
  moveBookingSchema,
  type DayComedian,
  type DayResponse,
  type DayShow,
  type LineupBooking,
  type LineupTag,
  type MoveBookingResponse,
  type UnavailableConflict,
} from '../../shared/api/lineup';
import { isAvailableFor, type AvailabilityRange } from '../../shared/availability';
import { bookingStatus } from '../../shared/bookingStatus';
import { dateSchema } from '../../shared/schemas';
import { formatTime, monthOf } from '../../shared/time';
import type { OkResponse } from '../../shared/types';
import { requireBooker } from '../auth/middleware';
import type { AppEnv } from '../context';
import type { DbOrTx } from '../db/client';
import {
  availability,
  availabilitySubmissions,
  bookings,
  comedians,
  comedianTags,
  locations,
  shows,
  tags,
  type Booking,
  type Show,
} from '../db/schema';
import { httpError, orNotFound, parseId, type HttpError } from '../lib/http';
import { clubToday } from '../lib/settings';
import { validate } from '../lib/validate';

export const lineupRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function toLineupBooking(booking: Booking, comedianName: string, showDate: string, today: string): LineupBooking {
  return {
    id: booking.id,
    showId: booking.showId,
    position: booking.position,
    comedianId: booking.comedianId,
    comedianName,
    status: bookingStatus(booking, showDate, today),
    overrideUnavailable: booking.overrideUnavailable,
    confirmedAt: booking.confirmedAt,
    confirmedBy: booking.confirmedBy,
    confirmationSentAt: booking.confirmationSentAt,
  };
}

/** A booking with its show and comedian name, or undefined. */
function findBooking(db: DbOrTx, id: number) {
  return db
    .select({ booking: bookings, show: shows, comedianName: comedians.name })
    .from(bookings)
    .innerJoin(shows, eq(bookings.showId, shows.id))
    .innerJoin(comedians, eq(bookings.comedianId, comedians.id))
    .where(eq(bookings.id, id))
    .get();
}

function bookingDto(db: DbOrTx, id: number, today: string): LineupBooking {
  const row = orNotFound(findBooking(db, id), 'Booking');
  return toLineupBooking(row.booking, row.comedianName, row.show.date, today);
}

function findShow(db: DbOrTx, id: number): Show {
  return orNotFound(db.select().from(shows).where(eq(shows.id, id)).get(), 'Show');
}

function showLabel(show: Show): string {
  return `the ${formatTime(show.startMin)}${show.name ? ` ${show.name}` : ''} show`;
}

function assertBookable(show: Show): void {
  if (show.status === 'cancelled') {
    throw httpError(409, `${capitalize(showLabel(show))} is cancelled`, 'show_cancelled', { showId: show.id });
  }
}

function assertPosition(show: Show, position: number): void {
  if (position >= show.slotCount) {
    throw httpError(400, `${capitalize(showLabel(show))} has ${show.slotCount} slots`, 'invalid_position', {
      slotCount: show.slotCount,
    });
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function bookingAt(db: DbOrTx, showId: number, position: number) {
  return db
    .select({ booking: bookings, comedianName: comedians.name })
    .from(bookings)
    .innerJoin(comedians, eq(bookings.comedianId, comedians.id))
    .where(and(eq(bookings.showId, showId), eq(bookings.position, position)))
    .get();
}

function bookingOf(db: DbOrTx, showId: number, comedianId: number): Booking | undefined {
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.showId, showId), eq(bookings.comedianId, comedianId)))
    .get();
}

function alreadyInShow(existing: Booking, comedianName: string, show: Show): HttpError {
  return httpError(409, `${comedianName} is already in ${showLabel(show)}`, 'already_in_show', {
    bookingId: existing.id,
    position: existing.position,
    comedianId: existing.comedianId,
    showId: show.id,
  });
}

/** Why `comedian` can't play `show`, or null when they are available (spec §3). */
function availabilityConflict(
  db: DbOrTx,
  comedian: { id: number; name: string },
  show: Show,
): UnavailableConflict | null {
  const row: AvailabilityRange | null =
    db
      .select({ startMin: availability.startMin, endMin: availability.endMin })
      .from(availability)
      .where(and(eq(availability.comedianId, comedian.id), eq(availability.date, show.date)))
      .get() ?? null;
  if (isAvailableFor(row, show.startMin)) return null;
  const month = monthOf(show.date);
  const submitted = db
    .select({ month: availabilitySubmissions.month })
    .from(availabilitySubmissions)
    .where(and(eq(availabilitySubmissions.comedianId, comedian.id), eq(availabilitySubmissions.month, month)))
    .get();
  return {
    comedianId: comedian.id,
    comedianName: comedian.name,
    showId: show.id,
    date: show.date,
    startMin: show.startMin,
    month,
    availability: row,
    submittedMonth: submitted != null,
  };
}

function unavailableError(conflicts: UnavailableConflict[]): HttpError {
  const first = conflicts[0]!;
  const error =
    conflicts.length === 1
      ? `${first.comedianName} isn't available during this slot`
      : `${conflicts.map((c) => c.comedianName).join(' and ')} aren't available for those slots`;
  return httpError(409, error, 'unavailable', { ...first, conflicts });
}

// ---------------------------------------------------------------------------
// GET /api/days/:date
// ---------------------------------------------------------------------------

export function getDay(db: DbOrTx, date: string, today: string = clubToday(db)): DayResponse {
  const showRows = db
    .select({ show: shows, location: locations })
    .from(shows)
    .innerJoin(locations, eq(shows.locationId, locations.id))
    .where(and(eq(shows.date, date), eq(shows.status, 'scheduled')))
    .orderBy(asc(locations.sortOrder), asc(locations.id), asc(shows.startMin), asc(shows.id))
    .all();
  const showIds = showRows.map((r) => r.show.id);

  const bookingRows = showIds.length
    ? db
        .select({ booking: bookings, comedianName: comedians.name })
        .from(bookings)
        .innerJoin(comedians, eq(bookings.comedianId, comedians.id))
        .where(inArray(bookings.showId, showIds))
        .orderBy(asc(bookings.position))
        .all()
    : [];

  const dayShows: DayShow[] = showRows.map(({ show, location }) => ({
    id: show.id,
    date: show.date,
    location: { id: location.id, name: location.name, color: location.color, address: location.address },
    startMin: show.startMin,
    name: show.name,
    slotCount: show.slotCount,
    status: show.status,
    notes: show.notes,
    bookings: bookingRows
      .filter((r) => r.booking.showId === show.id)
      .map((r) => toLineupBooking(r.booking, r.comedianName, show.date, today)),
  }));

  const tagList: LineupTag[] = db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .all()
    .sort(byName);
  const tagById = new Map(tagList.map((tag) => [tag.id, tag]));

  const tagsByComedian = new Map<number, LineupTag[]>();
  for (const { comedianId, tagId } of db.select().from(comedianTags).all()) {
    const tag = tagById.get(tagId);
    if (!tag) continue;
    const list = tagsByComedian.get(comedianId) ?? [];
    list.push(tag);
    tagsByComedian.set(comedianId, list);
  }
  for (const list of tagsByComedian.values()) list.sort(byName);

  const rangeByComedian = new Map(
    db
      .select({ comedianId: availability.comedianId, startMin: availability.startMin, endMin: availability.endMin })
      .from(availability)
      .where(eq(availability.date, date))
      .all()
      .map((r) => [r.comedianId, { startMin: r.startMin, endMin: r.endMin }]),
  );
  const submitted = new Set(
    db
      .select({ comedianId: availabilitySubmissions.comedianId })
      .from(availabilitySubmissions)
      .where(eq(availabilitySubmissions.month, monthOf(date)))
      .all()
      .map((r) => r.comedianId),
  );

  const showById = new Map(dayShows.map((s) => [s.id, s]));
  const pool: DayComedian[] = db
    .select({ id: comedians.id, name: comedians.name, headshotUrl: comedians.headshotUrl })
    .from(comedians)
    .where(eq(comedians.archived, false))
    .all()
    .sort((a, b) => byName(a, b) || a.id - b.id)
    .map((comedian) => ({
      ...comedian,
      tags: tagsByComedian.get(comedian.id) ?? [],
      availability: rangeByComedian.get(comedian.id) ?? null,
      submittedMonth: submitted.has(comedian.id),
      bookings: bookingRows
        .filter((r) => r.booking.comedianId === comedian.id)
        .map((r) => {
          const show = showById.get(r.booking.showId)!;
          return {
            bookingId: r.booking.id,
            showId: show.id,
            startMin: show.startMin,
            locationName: show.location.name,
            position: r.booking.position,
          };
        })
        .sort((a, b) => a.startMin - b.startMin),
    }));

  return { date, today, shows: dayShows, comedians: pool, tags: tagList };
}

lineupRoutes.get('/days/:date', requireBooker, validate('param', z.object({ date: dateSchema })), (c) => {
  const { date } = c.req.valid('param');
  return c.json(getDay(c.var.db, date) satisfies DayResponse);
});

// ---------------------------------------------------------------------------
// POST /api/bookings
// ---------------------------------------------------------------------------

lineupRoutes.post('/bookings', requireBooker, validate('json', createBookingSchema), (c) => {
  const db = c.var.db;
  const input = c.req.valid('json');
  const bookedById = c.var.booker.id;

  const id = db.transaction((tx) => {
    const show = findShow(tx, input.showId);
    assertBookable(show);
    const comedian = orNotFound(
      tx
        .select({ id: comedians.id, name: comedians.name, archived: comedians.archived })
        .from(comedians)
        .where(eq(comedians.id, input.comedianId))
        .get(),
      'Comedian',
    );
    if (comedian.archived) {
      throw httpError(409, `${comedian.name} is archived`, 'comedian_archived', { comedianId: comedian.id });
    }
    assertPosition(show, input.position);

    const existing = bookingOf(tx, show.id, comedian.id);
    if (existing) throw alreadyInShow(existing, comedian.name, show);

    const occupant = bookingAt(tx, show.id, input.position);
    if (occupant) {
      throw httpError(409, `Slot ${input.position + 1} is taken by ${occupant.comedianName}`, 'slot_taken', {
        bookingId: occupant.booking.id,
        comedianId: occupant.booking.comedianId,
        comedianName: occupant.comedianName,
      });
    }

    // Checked last, so "Book anyway" can't then fail for a different reason.
    const conflict = availabilityConflict(tx, comedian, show);
    if (conflict && !input.force) throw unavailableError([conflict]);

    return tx
      .insert(bookings)
      .values({
        showId: show.id,
        comedianId: comedian.id,
        position: input.position,
        overrideUnavailable: conflict != null,
        bookedById,
      })
      .returning({ id: bookings.id })
      .get().id;
  });

  return c.json(bookingDto(db, id, clubToday(db)) satisfies LineupBooking, 201);
});

// ---------------------------------------------------------------------------
// PATCH /api/bookings/:id — move / swap
// ---------------------------------------------------------------------------

lineupRoutes.patch('/bookings/:id', requireBooker, validate('json', moveBookingSchema), (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  const input = c.req.valid('json');

  const swappedId = db.transaction((tx) => {
    const current = orNotFound(findBooking(tx, id), 'Booking');
    const source = current.show;
    const from = current.booking;
    const target = input.showId === undefined || input.showId === source.id ? source : findShow(tx, input.showId);
    const sameShow = target.id === source.id;

    assertBookable(target);
    assertPosition(target, input.position);
    if (sameShow && input.position === from.position) return null; // dropped where it was

    const occupant = bookingAt(tx, target.id, input.position);
    if (occupant && !sameShow) assertBookable(source); // the occupant would land in `source`

    let moverConflict: UnavailableConflict | null = null;
    let occupantConflict: UnavailableConflict | null = null;
    if (!sameShow) {
      const duplicate = bookingOf(tx, target.id, from.comedianId);
      if (duplicate) throw alreadyInShow(duplicate, current.comedianName, target);
      if (occupant) {
        const occupantDuplicate = bookingOf(tx, source.id, occupant.booking.comedianId);
        if (occupantDuplicate) throw alreadyInShow(occupantDuplicate, occupant.comedianName, source);
      }

      moverConflict = availabilityConflict(tx, { id: from.comedianId, name: current.comedianName }, target);
      occupantConflict = occupant
        ? availabilityConflict(tx, { id: occupant.booking.comedianId, name: occupant.comedianName }, source)
        : null;
      const conflicts = [moverConflict, occupantConflict].filter((x): x is UnavailableConflict => x != null);
      if (conflicts.length && !input.force) throw unavailableError(conflicts);
    }

    // A different show is a different spot: confirmation starts over, override re-evaluated.
    const reset = (conflict: UnavailableConflict | null) =>
      sameShow
        ? {}
        : { confirmationSentAt: null, confirmedAt: null, confirmedBy: null, overrideUnavailable: conflict != null };

    // Park the mover on a unique temporary position, then fill both slots.
    tx.update(bookings).set({ position: -id }).where(eq(bookings.id, id)).run();
    if (occupant) {
      tx.update(bookings)
        .set({ showId: source.id, position: from.position, ...reset(occupantConflict) })
        .where(eq(bookings.id, occupant.booking.id))
        .run();
    }
    tx.update(bookings)
      .set({ showId: target.id, position: input.position, ...reset(moverConflict) })
      .where(eq(bookings.id, id))
      .run();
    return occupant?.booking.id ?? null;
  });

  const today = clubToday(db);
  return c.json({
    booking: bookingDto(db, id, today),
    swapped: swappedId == null ? null : bookingDto(db, swappedId, today),
  } satisfies MoveBookingResponse);
});

// ---------------------------------------------------------------------------
// DELETE /api/bookings/:id
// ---------------------------------------------------------------------------

lineupRoutes.delete('/bookings/:id', requireBooker, (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  const deleted = db.delete(bookings).where(eq(bookings.id, id)).returning({ id: bookings.id }).get();
  orNotFound(deleted, 'Booking');
  return c.json({ ok: true } satisfies OkResponse);
});

// ---------------------------------------------------------------------------
// POST /api/bookings/:id/confirm
// ---------------------------------------------------------------------------

lineupRoutes.post('/bookings/:id/confirm', requireBooker, (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  const row = orNotFound(findBooking(db, id), 'Booking');
  // Idempotent: an already-confirmed booking keeps who confirmed it and when.
  if (row.booking.confirmedAt == null) {
    db.update(bookings).set({ confirmedAt: Date.now(), confirmedBy: 'booker' }).where(eq(bookings.id, id)).run();
  }
  return c.json(bookingDto(db, id, clubToday(db)) satisfies LineupBooking);
});
