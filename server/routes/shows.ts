/**
 * F1 Shows API (spec §6 F1). Booker-only. Request schemas and response types live in
 * `shared/api/shows.ts`.
 *
 *   GET    /shows?from&to[&locationIds][&includeCancelled=0]   ShowDto[]
 *   POST   /shows/bulk           {locationId,name,startMin,slotCount,dates[]} → {created, skipped}
 *   POST   /shows/copy-pattern   {fromMonth,toMonth,locationIds?,dryRun} → {shows, skipped, …}
 *   GET    /shows/:id            ShowDetail (with bookings + minSlotCount)
 *   PATCH  /shows/:id            {name?,startMin?,slotCount?,notes?,status?} → ShowDetail + confirmationsReset
 *   DELETE /shows/:id            {ok:true} (409 `has_bookings` when it has bookings)
 *
 * Rules:
 * - A "duplicate" is another *scheduled* show at the same location, date and startMin.
 *   Bulk create and copy-pattern skip duplicates; PATCH refuses to create one (409
 *   `duplicate_show`) by changing the time or restoring a cancelled show.
 * - slotCount may not drop below the highest occupied position + 1 (409 `slots_occupied`).
 * - Changing startMin clears confirmationSentAt/confirmedAt/confirmedBy on the show's
 *   bookings: everyone has to re-confirm the new time.
 * - Cancelled shows keep their bookings; they report `unconfirmedTodayCount: 0`.
 */
import { and, asc, count, eq, gte, inArray, isNotNull, lte, max, ne, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  bulkCreateShowsSchema,
  copyPatternSchema,
  listShowsQuerySchema,
  updateShowSchema,
  type BulkCreateShowsResponse,
  type CopyPatternResponse,
  type CopyPatternShow,
  type CopyPatternSkipped,
  type ShowBookingSummary,
  type ShowDetail,
  type ShowDto,
  type ShowLocation,
  type UpdateShowResponse,
} from '../../shared/api/shows';
import { bookingStatus } from '../../shared/bookingStatus';
import { datesForWeekday, firstDayOfMonth, lastDayOfMonth, weekdayOf } from '../../shared/time';
import type { OkResponse } from '../../shared/types';
import { requireBooker } from '../auth/middleware';
import type { AppEnv } from '../context';
import type { DbOrTx } from '../db/client';
import { bookings, comedians, locations, shows, type Show } from '../db/schema';
import { httpError, orNotFound, parseId } from '../lib/http';
import { clubToday } from '../lib/settings';
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
      unconfirmed: sql<number>`coalesce(sum(case when ${bookings.confirmedAt} is null then 1 else 0 end), 0)`,
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
export function listShowDtos(db: DbOrTx, where: SQL | undefined, today: string = clubToday(db)): ShowDto[] {
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

export function getShowDetail(db: DbOrTx, id: number, today: string = clubToday(db)): ShowDetail | undefined {
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
    })
    .from(bookings)
    .innerJoin(comedians, eq(bookings.comedianId, comedians.id))
    .where(eq(bookings.showId, id))
    .orderBy(asc(bookings.position))
    .all()
    .map((b) => ({ ...b, status: bookingStatus(b, dto.date, today) }));
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
    const today = clubToday(tx);
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

showsRoutes.patch('/shows/:id', requireBooker, validate('json', updateShowSchema), (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  const patch = c.req.valid('json');
  if (Object.keys(patch).length === 0) throw httpError(400, 'Nothing to update', 'validation_error');

  const confirmationsReset = db.transaction((tx) => {
    const show = orNotFound(tx.select().from(shows).where(eq(shows.id, id)).get(), 'Show');

    if (patch.slotCount !== undefined) {
      const minSlotCount = minSlotCountFor(tx, id);
      if (patch.slotCount < minSlotCount) {
        throw httpError(
          409,
          `Slot ${minSlotCount} is booked. Move or remove that comedian before removing the slot.`,
          'slots_occupied',
          { minSlotCount },
        );
      }
    }

    const timeChanged = patch.startMin !== undefined && patch.startMin !== show.startMin;
    const nextStatus = patch.status ?? show.status;
    if (nextStatus === 'scheduled' && (timeChanged || show.status === 'cancelled')) {
      const startMin = patch.startMin ?? show.startMin;
      const duplicate = findDuplicate(tx, { locationId: show.locationId, date: show.date, startMin, exceptId: id });
      if (duplicate) {
        throw httpError(409, 'Another show is already scheduled there at that time', 'duplicate_show', {
          showId: duplicate.id,
        });
      }
    }

    tx.update(shows).set(patch).where(eq(shows.id, id)).run();
    if (!timeChanged) return 0;

    // A new time needs a fresh confirmation from everyone booked.
    const touched = tx
      .select({ n: count() })
      .from(bookings)
      .where(
        and(
          eq(bookings.showId, id),
          or(isNotNull(bookings.confirmedAt), isNotNull(bookings.confirmationSentAt), isNotNull(bookings.confirmedBy)),
        ),
      )
      .get();
    tx.update(bookings)
      .set({ confirmedAt: null, confirmedBy: null, confirmationSentAt: null })
      .where(eq(bookings.showId, id))
      .run();
    return touched?.n ?? 0;
  });

  const detail = orNotFound(getShowDetail(db, id), 'Show');
  return c.json({ ...detail, confirmationsReset } satisfies UpdateShowResponse);
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
