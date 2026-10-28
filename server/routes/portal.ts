/**
 * F4 Comedian portal API (spec §6 F4). Contract and shapes: shared/api/portal.ts.
 *
 *   GET  /portal/me                      (requireComedian)
 *   GET  /portal/availability?month      (requireComedian)
 *   PUT  /portal/availability            (requireComedian)
 *   GET  /portal/spots                   (requireComedian)
 *   POST /portal/spots/confirm           (requireComedian)
 *   GET  /portal/profile                 (requireComedian)
 *   PUT  /portal/profile                 (requireComedian)
 *   GET  /portal/confirm/:token          (no session; read-only — email scanners prefetch links)
 *   POST /portal/confirm/:token          (no session; confirms the week + signs the comedian in)
 */
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  availabilityQuerySchema,
  confirmWeekSchema,
  defaultAvailabilityMonth,
  PAST_SPOT_WEEKS,
  putAvailabilitySchema,
  updatePortalProfileSchema,
  type ConfirmLinkInfo,
  type ConfirmLinkResult,
  type ConfirmWeekResponse,
  type PortalAvailabilityResponse,
  type PortalMeResponse,
  type PortalProfile,
  type PortalSpot,
  type PortalSpotsResponse,
  type PortalSpotWeek,
} from '../../shared/api/portal';
import { bookingStatus } from '../../shared/bookingStatus';
import { addDays, daysInMonth, formatMonthLong, monthOf, weekStartOf } from '../../shared/time';
import { requireComedian } from '../auth/middleware';
import { sha256Hex } from '../auth/crypto';
import { signIn } from '../auth/sessions';
import { findConfirmToken, touchToken } from '../auth/tokens';
import type { AppEnv } from '../context';
import type { DbOrTx } from '../db/client';
import {
  availability,
  availabilitySubmissions,
  bookings,
  comedians,
  locations,
  shows,
  tokens,
  type Comedian,
} from '../db/schema';
import { httpError, orNotFound } from '../lib/http';
import { clubToday, getAllNightRange, getClubInfo, getSettings } from '../lib/settings';
import { validate } from '../lib/validate';

export const portalRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toProfile(c: Comedian): PortalProfile {
  return { id: c.id, name: c.name, email: c.email, bio: c.bio, headshotUrl: c.headshotUrl };
}

function loadComedian(db: DbOrTx, id: number): Comedian {
  return orNotFound(db.select().from(comedians).where(eq(comedians.id, id)).get(), 'Comedian');
}

function loadAvailability(db: DbOrTx, comedianId: number, month: string): PortalAvailabilityResponse {
  const days = daysInMonth(month);
  const entries = db
    .select({ date: availability.date, startMin: availability.startMin, endMin: availability.endMin })
    .from(availability)
    .where(
      and(
        eq(availability.comedianId, comedianId),
        gte(availability.date, days[0]!),
        lte(availability.date, days[days.length - 1]!),
      ),
    )
    .orderBy(asc(availability.date))
    .all();
  const submission = db
    .select({ submittedAt: availabilitySubmissions.submittedAt })
    .from(availabilitySubmissions)
    .where(and(eq(availabilitySubmissions.comedianId, comedianId), eq(availabilitySubmissions.month, month)))
    .get();
  return {
    month,
    entries,
    submittedAt: submission?.submittedAt ?? null,
    allNight: getAllNightRange(getSettings(db)),
    today: clubToday(db),
  };
}

/** A comedian's spots on scheduled shows from `from` (inclusive) to `to` (inclusive, optional). */
function loadSpots(db: DbOrTx, comedianId: number, today: string, from: string, to?: string): PortalSpot[] {
  const conditions = [eq(bookings.comedianId, comedianId), eq(shows.status, 'scheduled'), gte(shows.date, from)];
  if (to) conditions.push(lte(shows.date, to));
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
      confirmedAt: bookings.confirmedAt,
      confirmedBy: bookings.confirmedBy,
      confirmationSentAt: bookings.confirmationSentAt,
    })
    .from(bookings)
    .innerJoin(shows, eq(bookings.showId, shows.id))
    .innerJoin(locations, eq(shows.locationId, locations.id))
    .where(and(...conditions))
    .orderBy(asc(shows.date), asc(shows.startMin), asc(locations.sortOrder), asc(bookings.id))
    .all()
    .map((row) => ({
      bookingId: row.bookingId,
      showId: row.showId,
      date: row.date,
      startMin: row.startMin,
      showName: row.showName,
      location: { id: row.locationId, name: row.locationName, address: row.locationAddress, color: row.locationColor },
      status: bookingStatus(row, row.date, today),
      confirmedAt: row.confirmedAt,
      confirmedBy: row.confirmedBy,
    }));
}

/**
 * Confirm all of a comedian's scheduled, unconfirmed spots in the week starting
 * `weekStart` (Monday). Returns how many were newly confirmed.
 */
function confirmWeek(db: DbOrTx, comedianId: number, weekStart: string, now = Date.now()): number {
  return db.transaction((tx) => {
    const ids = tx
      .select({ id: bookings.id })
      .from(bookings)
      .innerJoin(shows, eq(bookings.showId, shows.id))
      .where(
        and(
          eq(bookings.comedianId, comedianId),
          isNull(bookings.confirmedAt),
          eq(shows.status, 'scheduled'),
          gte(shows.date, weekStart),
          lte(shows.date, addDays(weekStart, 6)),
        ),
      )
      .all()
      .map((r) => r.id);
    if (ids.length === 0) return 0;
    return tx
      .update(bookings)
      .set({ confirmedAt: now, confirmedBy: 'comedian' })
      .where(inArray(bookings.id, ids))
      .run().changes;
  });
}

const unconfirmed = (spots: PortalSpot[]) => spots.filter((s) => s.confirmedAt == null).length;

/**
 * Resolve a confirm-link token to its (non-archived) comedian and week, or throw
 * 404 `invalid_token` / 410 `expired_token`. Read-only: never touches the token.
 */
function resolveConfirmToken(db: DbOrTx, token: string): { tokenId: number; comedian: Comedian; weekStart: string } {
  const found = token.length <= 200 ? findConfirmToken(db, token) : null;
  if (!found) {
    const expired =
      token.length <= 200 &&
      db
        .select({ id: tokens.id })
        .from(tokens)
        .where(and(eq(tokens.tokenHash, sha256Hex(token)), eq(tokens.purpose, 'confirm')))
        .get();
    if (expired) throw httpError(410, 'This confirmation link has expired', 'expired_token');
    throw httpError(404, "This confirmation link isn't valid", 'invalid_token');
  }
  const comedian = db
    .select()
    .from(comedians)
    .where(and(eq(comedians.id, found.comedianId), eq(comedians.archived, false)))
    .get();
  if (!comedian) throw httpError(404, "This confirmation link isn't valid", 'invalid_token');
  return { tokenId: found.tokenId, comedian, weekStart: found.weekStart };
}

function confirmLinkInfo(db: DbOrTx, comedian: Comedian, weekStart: string): ConfirmLinkInfo {
  const today = clubToday(db);
  const spots = loadSpots(db, comedian.id, today, weekStart, addDays(weekStart, 6));
  return { comedianName: comedian.name, weekStart, today, spots, unconfirmedCount: unconfirmed(spots) };
}

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

portalRoutes.get('/portal/me', requireComedian, (c) => {
  const db = c.var.db;
  const comedian = loadComedian(db, c.var.comedian.id);
  const today = clubToday(db);
  const spots = loadSpots(db, comedian.id, today, today);
  const body: PortalMeResponse = {
    comedian: toProfile(comedian),
    club: getClubInfo(db),
    today,
    spots: { upcoming: spots.length, unconfirmed: unconfirmed(spots) },
  };
  return c.json(body);
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

portalRoutes.get('/portal/availability', requireComedian, validate('query', availabilityQuerySchema), (c) => {
  const db = c.var.db;
  const month = c.req.valid('query').month ?? defaultAvailabilityMonth(clubToday(db));
  return c.json(loadAvailability(db, c.var.comedian.id, month));
});

portalRoutes.put('/portal/availability', requireComedian, validate('json', putAvailabilitySchema), (c) => {
  const db = c.var.db;
  const comedianId = c.var.comedian.id;
  const { month, entries } = c.req.valid('json');
  const today = clubToday(db);
  const days = daysInMonth(month);
  const first = days[0]!;
  const last = days[days.length - 1]!;

  if (last < today) throw httpError(400, `${formatMonthLong(month)} is over`, 'month_past');
  const seen = new Set<string>();
  for (const entry of entries) {
    if (monthOf(entry.date) !== month) {
      throw httpError(400, `${entry.date} isn't in ${formatMonthLong(month)}`, 'date_outside_month', { date: entry.date });
    }
    if (seen.has(entry.date)) {
      throw httpError(400, `${entry.date} is listed twice (one range per night)`, 'duplicate_date', { date: entry.date });
    }
    seen.add(entry.date);
  }

  // Only today and later can change; past nights keep whatever they had.
  const editableFrom = first < today ? today : first;
  const now = Date.now();
  db.transaction((tx) => {
    tx.delete(availability)
      .where(
        and(eq(availability.comedianId, comedianId), gte(availability.date, editableFrom), lte(availability.date, last)),
      )
      .run();
    const rows = entries
      .filter((e) => e.date >= editableFrom)
      .map((e) => ({ comedianId, date: e.date, startMin: e.startMin, endMin: e.endMin, updatedAt: now }));
    if (rows.length) tx.insert(availability).values(rows).run();
    tx.insert(availabilitySubmissions)
      .values({ comedianId, month, submittedAt: now })
      .onConflictDoUpdate({
        target: [availabilitySubmissions.comedianId, availabilitySubmissions.month],
        set: { submittedAt: now },
      })
      .run();
  });

  return c.json(loadAvailability(db, comedianId, month));
});

// ---------------------------------------------------------------------------
// Spots
// ---------------------------------------------------------------------------

portalRoutes.get('/portal/spots', requireComedian, (c) => {
  const db = c.var.db;
  const today = clubToday(db);
  const thisWeek = weekStartOf(today);
  const spots = loadSpots(db, c.var.comedian.id, today, addDays(thisWeek, -7 * PAST_SPOT_WEEKS));

  const byWeek = new Map<string, PortalSpot[]>();
  for (const spot of spots) {
    const week = weekStartOf(spot.date);
    const list = byWeek.get(week);
    if (list) list.push(spot);
    else byWeek.set(week, [spot]);
  }
  const weeks: PortalSpotWeek[] = [...byWeek].map(([weekStart, list]) => ({
    weekStart,
    spots: list,
    unconfirmedCount: unconfirmed(list),
    past: weekStart < thisWeek,
  }));
  const body: PortalSpotsResponse = { today, weeks };
  return c.json(body);
});

portalRoutes.post('/portal/spots/confirm', requireComedian, validate('json', confirmWeekSchema), (c) => {
  const db = c.var.db;
  const { weekStart } = c.req.valid('json');
  if (weekStartOf(weekStart) !== weekStart) throw httpError(400, 'weekStart must be a Monday', 'invalid_week');
  if (addDays(weekStart, 6) < clubToday(db)) throw httpError(400, 'That week is over', 'week_past');
  const body: ConfirmWeekResponse = { weekStart, confirmedCount: confirmWeek(db, c.var.comedian.id, weekStart) };
  return c.json(body);
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

portalRoutes.get('/portal/profile', requireComedian, (c) => {
  return c.json(toProfile(loadComedian(c.var.db, c.var.comedian.id)));
});

portalRoutes.put('/portal/profile', requireComedian, validate('json', updatePortalProfileSchema), (c) => {
  const db = c.var.db;
  const { name, bio, headshotUrl } = c.req.valid('json');
  const updated = db
    .update(comedians)
    .set({ name, bio, headshotUrl })
    .where(eq(comedians.id, c.var.comedian.id))
    .returning()
    .get();
  return c.json(toProfile(orNotFound(updated, 'Comedian')));
});

// ---------------------------------------------------------------------------
// Confirm links (no session)
// ---------------------------------------------------------------------------

portalRoutes.get('/portal/confirm/:token', (c) => {
  const db = c.var.db;
  const { comedian, weekStart } = resolveConfirmToken(db, c.req.param('token'));
  c.header('Cache-Control', 'no-store');
  return c.json(confirmLinkInfo(db, comedian, weekStart));
});

portalRoutes.post('/portal/confirm/:token', (c) => {
  const db = c.var.db;
  const { tokenId, comedian, weekStart } = resolveConfirmToken(db, c.req.param('token'));
  const now = Date.now();
  const confirmedCount = confirmWeek(db, comedian.id, weekStart, now);
  touchToken(db, tokenId, now);
  db.update(comedians).set({ lastLoginAt: now }).where(eq(comedians.id, comedian.id)).run();
  signIn(c, db, 'comedian', comedian.id);
  const body: ConfirmLinkResult = {
    ...confirmLinkInfo(db, comedian, weekStart),
    confirmedCount,
    comedian: { id: comedian.id, email: comedian.email, name: comedian.name },
  };
  return c.json(body);
});

