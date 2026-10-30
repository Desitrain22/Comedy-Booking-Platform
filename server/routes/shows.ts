/**
 * F1 Shows API (spec §6 F1). Booker-only. Request schemas and response types live in
 * `shared/api/shows.ts`.
 *
 *   GET    /shows?from&to[&locationIds][&includeCancelled=0]   ShowDto[]
 *   POST   /shows/bulk           {locationId,name,startMin,slotCount,dates[]} → {created, skipped}
 *   POST   /shows/copy-pattern   {fromMonth,toMonth,locationIds?,dryRun} → {shows, skipped, …}
 *   GET    /shows/:id            ShowDetail (with bookings + minSlotCount)
 *   PATCH  /shows/:id            {name?,startMin?,slotCount?,notes?,status?,applyToMatching?}
 *                                → ShowDetail + confirmationsReset, newlyUnavailable, matching
 *   DELETE /shows/:id            {ok:true} (409 `has_bookings` when it has bookings)
 *   POST   /shows/bulk-delete    {ids} → {deleted, kept} (shows with bookings are kept)
 *   POST   /shows/bulk-status    {ids, status} → {updatedIds, skipped}
 *
 * Rules:
 * - A "duplicate" is another *scheduled* show at the same location, date and startMin.
 *   Bulk create and copy-pattern skip duplicates; PATCH refuses to create one (409
 *   `duplicate_show`) by changing the time or restoring a cancelled show.
 * - slotCount may not drop below the highest occupied position + 1 (409 `slots_occupied`).
 * - Changing startMin clears confirmationSentAt/confirmedAt/confirmedBy on the show's
 *   bookings (everyone has to re-confirm the new time) and re-evaluates each booking's
 *   `overrideUnavailable` against what the comedian marked for that date (spec §3), in the
 *   same transaction; the response lists who the new time newly leaves unavailable.
 * - `applyToMatching` carries name/startMin/slotCount over to the month's other scheduled shows
 *   at the same location, weekday and (old) start time, from today on (`isMatchingShow`); a
 *   show the change can't apply to (duplicate, occupied slot) is skipped and reported.
 * - Cancelled shows keep their bookings; they report `unconfirmedTodayCount: 0`.
 * - "Unconfirmed" never counts declined bookings (they need a replacement, not a confirmation).
 */
import { and, asc, count, eq, gte, inArray, lte, max, ne, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  bulkCreateShowsSchema,
  bulkDeleteShowsSchema,
  bulkShowStatusSchema,
  copyPatternSchema,
  isMatchingShow,
  listShowsQuerySchema,
  updateShowSchema,
  type BulkCreateShowsResponse,
  type BulkDeleteShowsResponse,
  type BulkShowStatusResponse,
  type CopyPatternResponse,
  type CopyPatternShow,
  type CopyPatternSkipped,
  type ShowBookingSummary,
  type ShowDetail,
  type ShowDto,
  type MatchingShowSkipped,
  type ShowLocation,
  type TimeChangeConflict,
  type UpdateShowResponse,
} from '../../shared/api/shows';
import { isAvailableFor } from '../../shared/availability';
import { bookingStatus } from '../../shared/bookingStatus';
import { datesForWeekday, firstDayOfMonth, lastDayOfMonth, monthOf, weekdayOf } from '../../shared/time';
import type { OkResponse } from '../../shared/types';
import { requireBooker } from '../auth/middleware';
import type { AppEnv } from '../context';
import type { DbOrTx } from '../db/client';
import {
  availability,
  availabilitySubmissions,
  bookings,
  comedians,
  locations,
  shows,
  type Show,
} from '../db/schema';
import { httpError, orNotFound, parseId } from '../lib/http';
import { clubNight, clubToday } from '../lib/settings';
import { validate } from '../lib/validate';

export const showsRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const locationColumns = {
  id: locations.id,
  name: locations.name,
  address: locations.address,
  color: locations.color,
  sortOrder: locations.sortOrder,
  archived: locations.archived,
};

/** Shows (with their location) matching `where`, sorted by date, time, location order. */
function selectShows(db: DbOrTx, where: SQL | undefined): { show: Show; location: ShowLocation }[] {
  return db
    .select({ show: shows, location: locationColumns })
    .from(shows)
    .innerJoin(locations, eq(shows.locationId, locations.id))
    .where(where)
    .orderBy(asc(shows.date), asc(shows.startMin), asc(locations.sortOrder), asc(locations.id), asc(shows.id))
    .all();
}

interface BookingCounts {
  booked: number;
  unconfirmed: number;
}

/** Booking counts per show for the shows matching `where` (a condition on `shows`). */
function bookingCountsFor(db: DbOrTx, where: SQL | undefined): Map<number, BookingCounts> {
  const rows = db
    .select({
      showId: bookings.showId,
      booked: count(),
      unconfirmed: sql<number>`coalesce(sum(case when ${bookings.confirmedAt} is null and ${bookings.declinedAt} is null then 1 else 0 end), 0)`,
    })
    .from(bookings)
    .innerJoin(shows, eq(bookings.showId, shows.id))
    .where(where)
    .groupBy(bookings.showId)
    .all();
  return new Map(rows.map((r) => [r.showId, { booked: r.booked, unconfirmed: Number(r.unconfirmed) }]));
}

function toShowDto(show: Show, location: ShowLocation, counts: BookingCounts | undefined, today: string): ShowDto {
  const booked = counts?.booked ?? 0;
  const unconfirmed = counts?.unconfirmed ?? 0;
  return {
    id: show.id,
    locationId: show.locationId,
    date: show.date,
    startMin: show.startMin,
    name: show.name,
    slotCount: show.slotCount,
    status: show.status,
    notes: show.notes,
    createdAt: show.createdAt,
    location,
    bookedCount: booked,
    unconfirmedTodayCount: show.status === 'scheduled' && show.date === today ? unconfirmed : 0,
  };
}

/** ShowDto[] for every show matching `where`. */
export function listShowDtos(db: DbOrTx, where: SQL | undefined, today: string = clubNight(db)): ShowDto[] {
  const rows = selectShows(db, where);
  if (rows.length === 0) return [];
  const counts = bookingCountsFor(db, where);
  return rows.map(({ show, location }) => toShowDto(show, location, counts.get(show.id), today));
}

/** The smallest slotCount that keeps every booking in a slot: highest position + 1 (min 1). */
function minSlotCountFor(db: DbOrTx, showId: number): number {
  const row = db.select({ top: max(bookings.position) }).from(bookings).where(eq(bookings.showId, showId)).get();
  return row?.top == null ? 1 : row.top + 1;
}

export function getShowDetail(db: DbOrTx, id: number, today: string = clubNight(db)): ShowDetail | undefined {
  const [dto] = listShowDtos(db, eq(shows.id, id), today);
  if (!dto) return undefined;
  const lineup: ShowBookingSummary[] = db
    .select({
      id: bookings.id,
      position: bookings.position,
      comedianId: bookings.comedianId,
      comedianName: comedians.name,
      overrideUnavailable: bookings.overrideUnavailable,
      confirmationSentAt: bookings.confirmationSentAt,
      confirmedAt: bookings.confirmedAt,
      confirmedBy: bookings.confirmedBy,
      declinedAt: bookings.declinedAt,
      availStart: availability.startMin,
      availEnd: availability.endMin,
      submittedMonth: availabilitySubmissions.month,
    })
    .from(bookings)
    .innerJoin(comedians, eq(bookings.comedianId, comedians.id))
    .leftJoin(availability, and(eq(availability.comedianId, bookings.comedianId), eq(availability.date, dto.date)))
    .leftJoin(
      availabilitySubmissions,
      and(eq(availabilitySubmissions.comedianId, bookings.comedianId), eq(availabilitySubmissions.month, monthOf(dto.date))),
    )
    .where(eq(bookings.showId, id))
    .orderBy(asc(bookings.position))
    .all()
    .map(({ availStart, availEnd, submittedMonth, ...b }) => ({
      ...b,
      status: bookingStatus(b, dto.date, today),
      availability: availStart != null && availEnd != null ? { startMin: availStart, endMin: availEnd } : null,
      submittedMonth: submittedMonth != null,
    }));
  const top = lineup.at(-1)?.position;
  return { ...dto, bookings: lineup, minSlotCount: top == null ? 1 : top + 1 };
}

/** Another scheduled show at the same location, date and time (ignoring `exceptId`). */
function findDuplicate(
  db: DbOrTx,
  where: { locationId: number; date: string; startMin: number; exceptId?: number },
): { id: number } | undefined {
  return db
    .select({ id: shows.id })
    .from(shows)
    .where(
      and(
        eq(shows.locationId, where.locationId),
        eq(shows.date, where.date),
        eq(shows.startMin, where.startMin),
        eq(shows.status, 'scheduled'),
        where.exceptId != null ? ne(shows.id, where.exceptId) : undefined,
      ),
    )
    .get();
}

const duplicateKey = (locationId: number, date: string, startMin: number) => `${locationId}|${date}|${startMin}`;

// ---------------------------------------------------------------------------
// GET /shows?from&to[&locationIds][&includeCancelled]
// ---------------------------------------------------------------------------

showsRoutes.get('/shows', requireBooker, validate('query', listShowsQuerySchema), (c) => {
  const { from, to, locationIds, includeCancelled } = c.req.valid('query');
  const where = and(
    gte(shows.date, from),
    lte(shows.date, to),
    locationIds.length ? inArray(shows.locationId, locationIds) : undefined,
    includeCancelled ? undefined : eq(shows.status, 'scheduled'),
  );
  return c.json(listShowDtos(c.var.db, where));
});

// ---------------------------------------------------------------------------
// POST /shows/bulk
// ---------------------------------------------------------------------------

showsRoutes.post('/shows/bulk', requireBooker, validate('json', bulkCreateShowsSchema), (c) => {
  const db = c.var.db;
  const input = c.req.valid('json');
  const location = orNotFound(
    db.select(locationColumns).from(locations).where(eq(locations.id, input.locationId)).get(),
    'Location',
  );
  if (location.archived) throw httpError(400, `${location.name} is archived`, 'location_archived');

  const dates = [...new Set(input.dates)].sort();
  const result = db.transaction((tx): BulkCreateShowsResponse => {
    const existing = new Map(
      tx
        .select({ id: shows.id, date: shows.date })
        .from(shows)
        .where(
          and(
            eq(shows.locationId, location.id),
            eq(shows.startMin, input.startMin),
            eq(shows.status, 'scheduled'),
            inArray(shows.date, dates),
          ),
        )
        .all()
        .map((s) => [s.date, s.id]),
    );
    const today = clubNight(tx);
    const created: ShowDto[] = [];
    const skipped: BulkCreateShowsResponse['skipped'] = [];
    for (const date of dates) {
      const showId = existing.get(date);
      if (showId != null) {
        skipped.push({ date, reason: 'duplicate', showId });
        continue;
      }
      const show = tx
        .insert(shows)
        .values({
          locationId: location.id,
          date,
          startMin: input.startMin,
          name: input.name,
          slotCount: input.slotCount,
        })
        .returning()
        .get();
      created.push(toShowDto(show, location, undefined, today));
    }
    return { created, skipped };
  });
  return c.json(result, result.created.length ? 201 : 200);
});

// ---------------------------------------------------------------------------
// POST /shows/copy-pattern
// ---------------------------------------------------------------------------

interface PatternEntry {
  locationId: number;
  location: ShowLocation;
  weekday: number;
  startMin: number;
  name: string;
  slotCount: number;
  /** Source shows with this exact (name, slotCount) variant. */
  count: number;
  lastDate: string;
}

/**
 * The weekly pattern of a month: one entry per (location, weekday, startMin). When the
 * same slot has different names/slot counts across weeks (e.g. one "Holiday Special"),
 * the most frequent variant wins, ties going to the most recent one, so the copy never
 * creates two shows at the same place and time.
 */
function monthPattern(rows: { show: Show; location: ShowLocation }[]): PatternEntry[] {
  const bySlot = new Map<string, Map<string, PatternEntry>>();
  for (const { show, location } of rows) {
    const weekday = weekdayOf(show.date);
    const slotKey = `${show.locationId}|${weekday}|${show.startMin}`;
    const variants = bySlot.get(slotKey) ?? new Map<string, PatternEntry>();
    bySlot.set(slotKey, variants);
    const variantKey = JSON.stringify([show.name, show.slotCount]);
    const entry = variants.get(variantKey);
    if (entry) {
      entry.count++;
      if (show.date > entry.lastDate) entry.lastDate = show.date;
    } else {
      variants.set(variantKey, {
        locationId: show.locationId,
        location,
        weekday,
        startMin: show.startMin,
        name: show.name,
        slotCount: show.slotCount,
        count: 1,
        lastDate: show.date,
      });
    }
  }
  return [...bySlot.values()].map(
    (variants) =>
      [...variants.values()].reduce((best, v) =>
        v.count > best.count || (v.count === best.count && v.lastDate > best.lastDate) ? v : best,
      ),
  );
}

showsRoutes.post('/shows/copy-pattern', requireBooker, validate('json', copyPatternSchema), (c) => {
  const db = c.var.db;
  const { fromMonth, toMonth, locationIds, dryRun } = c.req.valid('json');
  const today = clubToday(db);

  const source = selectShows(
    db,
    and(
      gte(shows.date, firstDayOfMonth(fromMonth)),
      lte(shows.date, lastDayOfMonth(fromMonth)),
      eq(shows.status, 'scheduled'),
      eq(locations.archived, false),
      locationIds?.length ? inArray(shows.locationId, locationIds) : undefined,
    ),
  );
  const pattern = monthPattern(source);

  const result = db.transaction((tx): CopyPatternResponse => {
    const existing = new Map(
      tx
        .select({ id: shows.id, locationId: shows.locationId, date: shows.date, startMin: shows.startMin })
        .from(shows)
        .where(
          and(
            gte(shows.date, firstDayOfMonth(toMonth)),
            lte(shows.date, lastDayOfMonth(toMonth)),
            eq(shows.status, 'scheduled'),
          ),
        )
        .all()
        .map((s) => [duplicateKey(s.locationId, s.date, s.startMin), s.id]),
    );

    const toCreate: (CopyPatternShow & { sortOrder: number })[] = [];
    const skipped: CopyPatternSkipped[] = [];
    for (const entry of pattern) {
      for (const date of datesForWeekday(toMonth, entry.weekday)) {
        const item: CopyPatternShow = {
          date,
          weekday: entry.weekday,
          locationId: entry.locationId,
          location: { id: entry.location.id, name: entry.location.name, color: entry.location.color },
          startMin: entry.startMin,
          name: entry.name,
          slotCount: entry.slotCount,
        };
        const showId = existing.get(duplicateKey(entry.locationId, date, entry.startMin));
        if (date < today) skipped.push({ ...item, reason: 'past' });
        else if (showId != null) skipped.push({ ...item, reason: 'duplicate', showId });
        else toCreate.push({ ...item, sortOrder: entry.location.sortOrder });
      }
    }

    const byDateTimeLocation = (
      a: CopyPatternShow & { sortOrder?: number },
      b: CopyPatternShow & { sortOrder?: number },
    ) =>
      a.date.localeCompare(b.date) ||
      a.startMin - b.startMin ||
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
      a.locationId - b.locationId;
    toCreate.sort(byDateTimeLocation);
    skipped.sort(byDateTimeLocation);

    const out: CopyPatternShow[] = toCreate.map(({ sortOrder: _sortOrder, ...item }) => {
      if (dryRun) return item;
      const { id } = tx
        .insert(shows)
        .values({
          locationId: item.locationId,
          date: item.date,
          startMin: item.startMin,
          name: item.name,
          slotCount: item.slotCount,
        })
        .returning({ id: shows.id })
        .get();
      return { id, ...item };
    });

    return { dryRun, fromMonth, toMonth, shows: out, skipped, sourceShowCount: source.length };
  });

  return c.json(result, !dryRun && result.shows.length ? 201 : 200);
});

// ---------------------------------------------------------------------------
// GET / PATCH / DELETE /shows/:id
// ---------------------------------------------------------------------------

showsRoutes.get('/shows/:id', requireBooker, (c) => {
  const id = parseId(c.req.param('id'));
  return c.json(orNotFound(getShowDetail(c.var.db, id), 'Show'));
});

/** 409 `slots_occupied` unless every booking of `showId` still has a slot with `slotCount`. */
function slotsOccupiedError(tx: DbOrTx, showId: number, slotCount: number) {
  const minSlotCount = minSlotCountFor(tx, showId);
  if (slotCount >= minSlotCount) return null;
  return httpError(
    409,
    `Slot ${minSlotCount} is booked. Move or remove that comedian before removing the slot.`,
    'slots_occupied',
    { minSlotCount },
  );
}

function duplicateShowError(tx: DbOrTx, show: Show, startMin: number) {
  const duplicate = findDuplicate(tx, { locationId: show.locationId, date: show.date, startMin, exceptId: show.id });
  return duplicate
    ? httpError(409, 'Another show is already scheduled there at that time', 'duplicate_show', { showId: duplicate.id })
    : null;
}

interface RetimeResult {
  confirmationsReset: number;
  newlyUnavailable: TimeChangeConflict[];
}

/**
 * `show` now starts at `startMin`: everyone booked re-confirms the new time, and each booking's
 * "booked anyway" flag is re-evaluated against what the comedian marked for the date (spec §3)
 * — set when the new time is outside their range, cleared when it is inside.
 */
function retimeBookings(tx: DbOrTx, show: Show, startMin: number): RetimeResult {
  const rows = tx
    .select({
      booking: bookings,
      comedianName: comedians.name,
      availStart: availability.startMin,
      availEnd: availability.endMin,
      submittedMonth: availabilitySubmissions.month,
    })
    .from(bookings)
    .innerJoin(comedians, eq(bookings.comedianId, comedians.id))
    .leftJoin(availability, and(eq(availability.comedianId, bookings.comedianId), eq(availability.date, show.date)))
    .leftJoin(
      availabilitySubmissions,
      and(eq(availabilitySubmissions.comedianId, bookings.comedianId), eq(availabilitySubmissions.month, monthOf(show.date))),
    )
    .where(eq(bookings.showId, show.id))
    .orderBy(asc(bookings.position))
    .all();

  const result: RetimeResult = { confirmationsReset: 0, newlyUnavailable: [] };
  for (const { booking, comedianName, availStart, availEnd, submittedMonth } of rows) {
    const range = availStart != null && availEnd != null ? { startMin: availStart, endMin: availEnd } : null;
    const unavailable = !isAvailableFor(range, startMin);
    if (booking.confirmedAt != null || booking.confirmationSentAt != null || booking.confirmedBy != null) {
      result.confirmationsReset++;
    }
    if (unavailable && !booking.overrideUnavailable) {
      result.newlyUnavailable.push({
        showId: show.id,
        bookingId: booking.id,
        comedianId: booking.comedianId,
        comedianName,
        availability: range,
        submittedMonth: submittedMonth != null,
      });
    }
    tx.update(bookings)
      .set({ confirmedAt: null, confirmedBy: null, confirmationSentAt: null, overrideUnavailable: unavailable })
      .where(eq(bookings.id, booking.id))
      .run();
  }
  return result;
}

showsRoutes.patch('/shows/:id', requireBooker, validate('json', updateShowSchema), (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  const { applyToMatching = false, ...patch } = c.req.valid('json');
  if (Object.keys(patch).length === 0) throw httpError(400, 'Nothing to update', 'validation_error');

  const outcome = db.transaction((tx) => {
    const show = orNotFound(tx.select().from(shows).where(eq(shows.id, id)).get(), 'Show');

    if (patch.slotCount !== undefined) {
      const error = slotsOccupiedError(tx, id, patch.slotCount);
      if (error) throw error;
    }

    const timeChanged = patch.startMin !== undefined && patch.startMin !== show.startMin;
    const nextStatus = patch.status ?? show.status;
    if (nextStatus === 'scheduled' && (timeChanged || show.status === 'cancelled')) {
      const error = duplicateShowError(tx, show, patch.startMin ?? show.startMin);
      if (error) throw error;
    }

    tx.update(shows).set(patch).where(eq(shows.id, id)).run();
    const retimed: RetimeResult = timeChanged
      ? retimeBookings(tx, show, patch.startMin!)
      : { confirmationsReset: 0, newlyUnavailable: [] };

    if (!applyToMatching) return { ...retimed, matching: null };

    // The same name/time/slots for the month's other matching shows (matched on the old time).
    const shared = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.startMin !== undefined ? { startMin: patch.startMin } : {}),
      ...(patch.slotCount !== undefined ? { slotCount: patch.slotCount } : {}),
    };
    const updatedIds: number[] = [];
    const skipped: MatchingShowSkipped[] = [];
    if (Object.keys(shared).length === 0) return { ...retimed, matching: { updatedIds, skipped } };

    const today = clubToday(tx);
    const month = monthOf(show.date);
    const others = tx
      .select()
      .from(shows)
      .where(
        and(
          eq(shows.locationId, show.locationId),
          eq(shows.startMin, show.startMin),
          gte(shows.date, firstDayOfMonth(month)),
          lte(shows.date, lastDayOfMonth(month)),
        ),
      )
      .orderBy(asc(shows.date))
      .all()
      .filter((other) => isMatchingShow(show, other, today));

    for (const other of others) {
      if (shared.slotCount !== undefined && slotsOccupiedError(tx, other.id, shared.slotCount)) {
        skipped.push({ id: other.id, date: other.date, reason: 'slots_occupied' });
        continue;
      }
      const otherRetimed = shared.startMin !== undefined && shared.startMin !== other.startMin;
      if (otherRetimed && duplicateShowError(tx, other, shared.startMin!)) {
        skipped.push({ id: other.id, date: other.date, reason: 'duplicate_show' });
        continue;
      }
      tx.update(shows).set(shared).where(eq(shows.id, other.id)).run();
      if (otherRetimed) {
        const r = retimeBookings(tx, other, shared.startMin!);
        retimed.confirmationsReset += r.confirmationsReset;
        retimed.newlyUnavailable.push(...r.newlyUnavailable);
      }
      updatedIds.push(other.id);
    }
    return { ...retimed, matching: { updatedIds, skipped } };
  });

  const detail = orNotFound(getShowDetail(db, id), 'Show');
  return c.json({ ...detail, ...outcome } satisfies UpdateShowResponse);
});

showsRoutes.delete('/shows/:id', requireBooker, (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  orNotFound(db.select({ id: shows.id }).from(shows).where(eq(shows.id, id)).get(), 'Show');
  const bookingCount = db.select({ n: count() }).from(bookings).where(eq(bookings.showId, id)).get()?.n ?? 0;
  if (bookingCount > 0) {
    throw httpError(
      409,
      `This show has ${bookingCount} booking${bookingCount === 1 ? '' : 's'}. Cancel it instead, or clear the lineup first.`,
      'has_bookings',
      { bookingCount },
    );
  }
  db.delete(shows).where(eq(shows.id, id)).run();
  return c.json({ ok: true } satisfies OkResponse);
});

// ---------------------------------------------------------------------------
// POST /shows/bulk-delete — Undo of a bulk create / copy-pattern
// ---------------------------------------------------------------------------

showsRoutes.post('/shows/bulk-delete', requireBooker, validate('json', bulkDeleteShowsSchema), (c) => {
  const db = c.var.db;
  const ids = [...new Set(c.req.valid('json').ids)];
  const result = db.transaction((tx): BulkDeleteShowsResponse => {
    const found = tx.select({ id: shows.id }).from(shows).where(inArray(shows.id, ids)).all().map((s) => s.id);
    const booked = new Map(
      tx
        .select({ showId: bookings.showId, n: count() })
        .from(bookings)
        .where(inArray(bookings.showId, ids))
        .groupBy(bookings.showId)
        .all()
        .map((r) => [r.showId, r.n]),
    );
    // Someone may have booked one of them since: those stay (cancel them instead).
    const kept = found.filter((id) => booked.has(id)).map((id) => ({ id, bookingCount: booked.get(id)! }));
    const deleted = found.filter((id) => !booked.has(id));
    if (deleted.length) tx.delete(shows).where(inArray(shows.id, deleted)).run();
    return { deleted: deleted.sort((a, b) => a - b), kept };
  });
  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /shows/bulk-status — "Cancel all shows this day" (and its Undo)
// ---------------------------------------------------------------------------

showsRoutes.post('/shows/bulk-status', requireBooker, validate('json', bulkShowStatusSchema), (c) => {
  const db = c.var.db;
  const { ids, status } = c.req.valid('json');
  const result = db.transaction((tx): BulkShowStatusResponse => {
    const updatedIds: number[] = [];
    const skipped: BulkShowStatusResponse['skipped'] = [];
    for (const id of [...new Set(ids)]) {
      const show = tx.select().from(shows).where(eq(shows.id, id)).get();
      if (!show) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      // Restoring must not double-book a location and time (as PATCH refuses).
      if (status === 'scheduled' && show.status === 'cancelled' && duplicateShowError(tx, show, show.startMin)) {
        skipped.push({ id, reason: 'duplicate_show' });
        continue;
      }
      // Already there (e.g. someone cancelled it from the calendar meanwhile): not ours to
      // report, or the day view's Undo would bring back a show that was cancelled on purpose.
      if (show.status === status) {
        skipped.push({ id, reason: 'unchanged' });
        continue;
      }
      tx.update(shows).set({ status }).where(eq(shows.id, id)).run();
      updatedIds.push(id);
    }
    return { updatedIds, skipped };
  });
  return c.json(result);
});
