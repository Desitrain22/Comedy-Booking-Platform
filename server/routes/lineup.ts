/**
 * F2 Day view / lineup board API (spec §6 F2). Shapes live in `shared/api/lineup.ts`.
 *
 *   GET    /api/days/:date              every scheduled show that day with its lineup, plus the
 *                                       comedian pool (tags, availability, bookings that day)
 *   POST   /api/bookings                book a comedian into an empty slot, or replace the
 *                                       slot's occupant (`replaceBookingId`); `restore`
 *                                       re-creates a removed booking exactly (Undo)
 *   PATCH  /api/bookings/:id            move (swap when the target slot is occupied)
 *   DELETE /api/bookings/:id            unbook; returns the removed booking (for Undo)
 *   POST   /api/bookings/:id/confirm    booker marks a booking confirmed (F5's dashboard too);
 *                                       clears a decline; returns the `previous` state
 *   POST   /api/bookings/:id/unconfirm  puts that `previous` state back (Undo)
 *
 * Availability (spec §3, `isAvailableFor`) is checked when booking and when moving to a
 * different show; an unavailable comedian → 409 `unavailable` with what they marked, unless
 * `force: true`, which stores `overrideUnavailable`. Moving to a different show resets the
 * booking's confirmation and decline (it is a different spot now); archived comedians can't
 * be booked or moved into another show (409 `comedian_archived`). Swaps run in one
 * transaction and park the moving booking on a temporary negative position so the unique
 * (showId, position) index never sees two bookings in one slot.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  NOTE_EXCERPT_MAX,
  createBookingSchema,
  moveBookingSchema,
  unconfirmBookingSchema,
  type BookingRestore,
  type ConfirmBookingResponse,
  type CreateBookingResponse,
  type DayComedian,
  type DeleteBookingResponse,
  type DayResponse,
  type DayShow,
  type LineupBooking,
  type LineupTag,
  type MoveBookingResponse,
  type RemovedBooking,
  type UnavailableConflict,
  type UnsentThisWeek,
} from '../../shared/api/lineup';
import { isAvailableFor, type AvailabilityRange } from '../../shared/availability';
import { bookingStatus } from '../../shared/bookingStatus';
import { dateSchema } from '../../shared/schemas';
import { addDays, formatTime, monthOf, weekStartOf } from '../../shared/time';
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
  notes,
  shows,
  tags,
  users,
  type Booking,
  type Show,
} from '../db/schema';
import { httpError, orNotFound, parseId, type HttpError } from '../lib/http';
import { clubNight } from '../lib/settings';
import { validate } from '../lib/validate';
import { countUnsentSpots } from '../services/confirmations';

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
    declinedAt: booking.declinedAt,
    declineNote: booking.declineNote,
  };
}

/** A booking that is being removed, with what `restore` needs to re-create it. */
function toRemovedBooking(booking: Booking, comedianName: string, showDate: string, today: string): RemovedBooking {
  return {
    ...toLineupBooking(booking, comedianName, showDate, today),
    bookedById: booking.bookedById,
    createdAt: booking.createdAt,
  };
}

/** 400 when a restored timestamp is in the future (a minute of clock slack). */
function assertNotFuture(values: Record<string, number | null | undefined>, prefix: string): void {
  const latest = Date.now() + 60_000;
  for (const [key, value] of Object.entries(values)) {
    if (value != null && value > latest) {
      throw httpError(400, `${prefix}${key} is in the future`, 'validation_error', {
        issues: [{ path: `${prefix}${key}`, message: 'Must not be in the future' }],
      });
    }
  }
}

/** A restored booking's stored fields; refuses times in the future. */
function restoredFields(db: DbOrTx, restore: BookingRestore, conflict: UnavailableConflict | null) {
  const { confirmationSentAt, confirmedAt, declinedAt, createdAt } = restore;
  assertNotFuture({ confirmationSentAt, confirmedAt, declinedAt, createdAt }, 'restore.');
  // Who booked it, unless that booker has since been removed (as the foreign key would do).
  const bookedById =
    restore.bookedById != null &&
    db.select({ id: users.id }).from(users).where(eq(users.id, restore.bookedById)).get()
      ? restore.bookedById
      : null;
  return {
    // Exactly as it was — but never hide a conflict that exists now.
    overrideUnavailable: restore.overrideUnavailable || conflict != null,
    confirmationSentAt: restore.confirmationSentAt,
    confirmedAt: restore.confirmedAt,
    confirmedBy: restore.confirmedBy,
    declinedAt: restore.declinedAt,
    declineNote: restore.declineNote,
    bookedById,
    createdAt: restore.createdAt,
  };
}

/** A booking with its show and comedian name, or undefined. */
function findBooking(db: DbOrTx, id: number) {
  return db
    .select({ booking: bookings, show: shows, comedianName: comedians.name, comedianArchived: comedians.archived })
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
    .select({ booking: bookings, comedianName: comedians.name, comedianArchived: comedians.archived })
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

function archivedError(comedian: { id: number; name: string }): HttpError {
  return httpError(409, `${comedian.name} is archived`, 'comedian_archived', { comedianId: comedian.id });
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

export function getDay(db: DbOrTx, date: string, today: string = clubNight(db)): DayResponse {
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

  // Notes: how many, and the first line of the newest (newest first, so the first seen wins).
  const notesByComedian = new Map<number, { count: number; latest: string }>();
  for (const note of db
    .select({ comedianId: notes.comedianId, body: notes.body })
    .from(notes)
    .innerJoin(comedians, eq(notes.comedianId, comedians.id))
    .where(eq(comedians.archived, false))
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .all()) {
    const entry = notesByComedian.get(note.comedianId);
    if (entry) entry.count++;
    else notesByComedian.set(note.comedianId, { count: 1, latest: noteExcerpt(note.body) });
  }

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
      noteCount: notesByComedian.get(comedian.id)?.count ?? 0,
      latestNote: notesByComedian.get(comedian.id)?.latest ?? null,
    }));

  return { date, today, shows: dayShows, comedians: pool, tags: tagList, unsentThisWeek: unsentThisWeek(db) };
}

/** The first non-empty line of a note, cut to `NOTE_EXCERPT_MAX` characters. */
function noteExcerpt(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > NOTE_EXCERPT_MAX ? `${line.slice(0, NOTE_EXCERPT_MAX - 1).trimEnd()}…` : line;
}

/**
 * This week's spots booked after the confirmations went out and never emailed: the same count
 * (and the same rules) as the dashboard's nudge and the daily catch-up (`countUnsentSpots`), so
 * the board's "Send" clears it. The week is the club night's.
 */
export function unsentThisWeek(db: DbOrTx, now: Date = new Date()): UnsentThisWeek {
  const weekStart = weekStartOf(clubNight(db, now));
  return { weekStart, weekEnd: addDays(weekStart, 6), count: countUnsentSpots(db, weekStart, { now }) };
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
  const today = clubNight(db);

  const { id, replaced } = db.transaction((tx) => {
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
    if (comedian.archived) throw archivedError(comedian);
    assertPosition(show, input.position);

    const existing = bookingOf(tx, show.id, comedian.id);
    if (existing) throw alreadyInShow(existing, comedian.name, show);

    // Only the occupant the client meant to replace may be replaced (it may have changed since).
    const occupant = bookingAt(tx, show.id, input.position);
    if (occupant && occupant.booking.id !== input.replaceBookingId) {
      throw httpError(409, `Slot ${input.position + 1} is taken by ${occupant.comedianName}`, 'slot_taken', {
        bookingId: occupant.booking.id,
        comedianId: occupant.booking.comedianId,
        comedianName: occupant.comedianName,
      });
    }

    // Checked last, so "Book anyway" can't then fail for a different reason.
    const conflict = availabilityConflict(tx, comedian, show);
    if (conflict && !input.force) throw unavailableError([conflict]);

    const fields = input.restore
      ? restoredFields(tx, input.restore, conflict)
      : { overrideUnavailable: conflict != null, bookedById };

    // The replaced comedian goes back to the pool.
    if (occupant) tx.delete(bookings).where(eq(bookings.id, occupant.booking.id)).run();

    const newId = tx
      .insert(bookings)
      .values({ showId: show.id, comedianId: comedian.id, position: input.position, ...fields })
      .returning({ id: bookings.id })
      .get().id;
    return {
      id: newId,
      replaced: occupant ? toRemovedBooking(occupant.booking, occupant.comedianName, show.date, today) : null,
    };
  });

  return c.json({ ...bookingDto(db, id, today), replaced } satisfies CreateBookingResponse, 201);
});

// ---------------------------------------------------------------------------
// PATCH /api/bookings/:id — move / swap
// ---------------------------------------------------------------------------

lineupRoutes.patch('/bookings/:id', requireBooker, validate('json', moveBookingSchema), (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  const input = c.req.valid('json');

  const { swappedId, replaced } = db.transaction((tx) => {
    const current = orNotFound(findBooking(tx, id), 'Booking');
    const source = current.show;
    const from = current.booking;
    const target = input.showId === undefined || input.showId === source.id ? source : findShow(tx, input.showId);
    const sameShow = target.id === source.id;

    assertBookable(target);
    assertPosition(target, input.position);
    if (sameShow && input.position === from.position) return { swappedId: null, replaced: null }; // dropped where it was

    const found = bookingAt(tx, target.id, input.position);
    // Someone who declined only holds the slot until it's filled: moving another show's
    // comedian onto them replaces them (as booking from the pool does). Swapping would put
    // them in a show they never agreed to and wipe their decline.
    const replacing = found && !sameShow && found.booking.declinedAt != null ? found : null;
    const occupant = replacing ? null : found;
    if (occupant && !sameShow) assertBookable(source); // the occupant would land in `source`

    let moverConflict: UnavailableConflict | null = null;
    let occupantConflict: UnavailableConflict | null = null;
    if (!sameShow) {
      // A different show is a new spot: archived comedians can't take one (as when booking).
      if (current.comedianArchived) throw archivedError({ id: from.comedianId, name: current.comedianName });
      if (occupant?.comedianArchived) {
        throw archivedError({ id: occupant.booking.comedianId, name: occupant.comedianName });
      }
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

    // A different show is a different spot: confirmation and decline start over, override re-evaluated.
    const reset = (conflict: UnavailableConflict | null) =>
      sameShow
        ? {}
        : {
            confirmationSentAt: null,
            confirmedAt: null,
            confirmedBy: null,
            declinedAt: null,
            declineNote: '',
            overrideUnavailable: conflict != null,
          };

    // Park the mover on a unique temporary position, then fill both slots.
    tx.update(bookings).set({ position: -id }).where(eq(bookings.id, id)).run();
    if (replacing) tx.delete(bookings).where(eq(bookings.id, replacing.booking.id)).run();
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
    return {
      swappedId: occupant?.booking.id ?? null,
      replaced: replacing
        ? toRemovedBooking(replacing.booking, replacing.comedianName, target.date, clubNight(tx))
        : null,
    };
  });

  const today = clubNight(db);
  return c.json({
    booking: bookingDto(db, id, today),
    swapped: swappedId == null ? null : bookingDto(db, swappedId, today),
    replaced,
  } satisfies MoveBookingResponse);
});

// ---------------------------------------------------------------------------
// DELETE /api/bookings/:id
// ---------------------------------------------------------------------------

lineupRoutes.delete('/bookings/:id', requireBooker, (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  const row = orNotFound(findBooking(db, id), 'Booking');
  db.delete(bookings).where(eq(bookings.id, id)).run();
  // Everything Undo needs to put it back exactly (POST /bookings with `restore`).
  const booking = toRemovedBooking(row.booking, row.comedianName, row.show.date, clubNight(db));
  return c.json({ ok: true, booking } satisfies DeleteBookingResponse);
});

// ---------------------------------------------------------------------------
// POST /api/bookings/:id/confirm
// ---------------------------------------------------------------------------

lineupRoutes.post('/bookings/:id/confirm', requireBooker, (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  const { booking } = orNotFound(findBooking(db, id), 'Booking');
  const previous = {
    confirmedAt: booking.confirmedAt,
    confirmedBy: booking.confirmedBy,
    declinedAt: booking.declinedAt,
    declineNote: booking.declineNote,
  };
  // Idempotent: an already-confirmed booking keeps who confirmed it and when. The booker
  // confirming also takes back a decline (the comedian can make it after all).
  const changes = {
    ...(booking.confirmedAt == null ? { confirmedAt: Date.now(), confirmedBy: 'booker' as const } : {}),
    ...(booking.declinedAt != null ? { declinedAt: null, declineNote: '' } : {}),
  };
  if (Object.keys(changes).length) db.update(bookings).set(changes).where(eq(bookings.id, id)).run();
  return c.json({ ...bookingDto(db, id, clubNight(db)), previous } satisfies ConfirmBookingResponse);
});

// ---------------------------------------------------------------------------
// POST /api/bookings/:id/unconfirm — Undo of "Mark confirmed"
// ---------------------------------------------------------------------------

lineupRoutes.post('/bookings/:id/unconfirm', requireBooker, validate('json', unconfirmBookingSchema), (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  const input = c.req.valid('json');
  orNotFound(findBooking(db, id), 'Booking');
  assertNotFuture({ confirmedAt: input.confirmedAt, declinedAt: input.declinedAt }, '');
  db.update(bookings)
    .set({
      confirmedAt: input.confirmedAt,
      confirmedBy: input.confirmedBy,
      // Omitted = leave the decline alone; given = put it back as it was.
      ...(input.declinedAt !== undefined
        ? { declinedAt: input.declinedAt, declineNote: input.declinedAt == null ? '' : (input.declineNote ?? '') }
        : {}),
    })
    .where(eq(bookings.id, id))
    .run();
  return c.json(bookingDto(db, id, clubNight(db)) satisfies LineupBooking);
});
