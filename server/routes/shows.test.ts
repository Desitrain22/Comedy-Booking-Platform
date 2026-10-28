import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BulkCreateShowsResponse,
  CopyPatternResponse,
  ShowDetail,
  ShowDto,
  UpdateShowResponse,
} from '../../shared/api/shows';
import { addDays, addMonths, datesForWeekday, daysInMonth, monthOf, weekdayOf } from '../../shared/time';
import { bookings, shows } from '../db/schema';
import { clubToday } from '../lib/settings';
import {
  createBooking,
  createComedian,
  createLocation,
  createShow,
  loginAsBooker,
  loginAsComedian,
  makeTestApp,
  readJson,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';

let t: TestApp;
let headers: AuthHeaders;

beforeEach(async () => {
  t = makeTestApp();
  ({ headers } = await loginAsBooker(t, { role: 'booker' }));
});

afterEach(() => {
  t.close();
});

async function list(query: string): Promise<ShowDto[]> {
  const res = await t.request(`/api/shows?${query}`, { headers });
  expect(res.status).toBe(200);
  return readJson<ShowDto[]>(res);
}

function post(path: string, json: unknown, h: AuthHeaders = headers) {
  return t.request(path, { method: 'POST', headers: h, json });
}

function patch(id: number, json: unknown) {
  return t.request(`/api/shows/${id}`, { method: 'PATCH', headers, json });
}

function allShows() {
  return t.db.select().from(shows).all();
}

// Far-future months keep these tests independent of today's date (copy-pattern skips past dates).
const NOV = '2030-11';
const DEC = '2030-12';

describe('auth', () => {
  it('requires a booker on every endpoint', async () => {
    const show = createShow(t.db);
    const comedian = createComedian(t.db);
    const { headers: comedianHeaders } = await loginAsComedian(t, comedian.id);
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/shows?from=2026-11-01&to=2026-11-30'],
      ['POST', '/api/shows/bulk', { locationId: show.locationId, startMin: 1200, dates: ['2026-11-02'] }],
      ['POST', '/api/shows/copy-pattern', { fromMonth: '2026-10', toMonth: '2026-11', dryRun: true }],
      ['GET', `/api/shows/${show.id}`],
      ['PATCH', `/api/shows/${show.id}`, { name: 'X' }],
      ['DELETE', `/api/shows/${show.id}`],
    ];
    for (const [method, path, json] of calls) {
      expect((await t.request(path, { method, json })).status, `${method} ${path}`).toBe(401);
      // A comedian session is not a booker session.
      expect((await t.request(path, { method, json, headers: comedianHeaders })).status, `${method} ${path}`).toBe(401);
    }
    expect(allShows()).toHaveLength(1);
  });
});

describe('GET /api/shows', () => {
  it('lists shows in range with location and counts, sorted by date, time and location order', async () => {
    const cellar = createLocation(t.db, { name: 'The Cellar', sortOrder: 0, color: '#7c5cff' });
    const annex = createLocation(t.db, { name: 'The Annex', sortOrder: 1, color: '#f08c2e' });
    const late = createShow(t.db, { locationId: cellar.id, date: '2026-11-06', startMin: 1290, name: 'Late Show' });
    const annexEarly = createShow(t.db, { locationId: annex.id, date: '2026-11-06', startMin: 1140, slotCount: 5 });
    const cellarEarly = createShow(t.db, { locationId: cellar.id, date: '2026-11-06', startMin: 1140 });
    const nextDay = createShow(t.db, { locationId: annex.id, date: '2026-11-07', startMin: 1080 });
    createShow(t.db, { locationId: cellar.id, date: '2026-10-31' }); // out of range
    createShow(t.db, { locationId: cellar.id, date: '2026-12-01' }); // out of range

    const [a, b] = [createComedian(t.db), createComedian(t.db)];
    createBooking(t.db, { showId: late.id, comedianId: a!.id });
    createBooking(t.db, { showId: late.id, comedianId: b!.id, position: 4, confirmedAt: Date.now() });

    const body = await list('from=2026-11-01&to=2026-11-30');
    expect(body.map((s) => s.id)).toEqual([cellarEarly.id, annexEarly.id, late.id, nextDay.id]);
    expect(body[2]).toMatchObject({
      id: late.id,
      locationId: cellar.id,
      date: '2026-11-06',
      startMin: 1290,
      name: 'Late Show',
      slotCount: 6,
      status: 'scheduled',
      notes: '',
      location: { id: cellar.id, name: 'The Cellar', color: '#7c5cff', sortOrder: 0, archived: false },
      bookedCount: 2,
      unconfirmedTodayCount: 0, // not today
    });
    expect(body[1]).toMatchObject({ bookedCount: 0, unconfirmedTodayCount: 0, slotCount: 5 });
  });

  it('filters by location ids and can hide cancelled shows', async () => {
    const cellar = createLocation(t.db);
    const annex = createLocation(t.db);
    const roof = createLocation(t.db);
    const s1 = createShow(t.db, { locationId: cellar.id });
    const s2 = createShow(t.db, { locationId: annex.id, status: 'cancelled' });
    createShow(t.db, { locationId: roof.id });

    const filtered = await list(`from=2026-11-01&to=2026-11-30&locationIds=${cellar.id},${annex.id}`);
    expect(filtered.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect(filtered.find((s) => s.id === s2.id)?.status).toBe('cancelled');

    const scheduledOnly = await list(`from=2026-11-01&to=2026-11-30&locationIds=${cellar.id},${annex.id}&includeCancelled=0`);
    expect(scheduledOnly.map((s) => s.id)).toEqual([s1.id]);
  });

  it("counts today's unconfirmed bookings, but not on cancelled shows", async () => {
    const today = clubToday(t.db);
    const location = createLocation(t.db);
    const tonight = createShow(t.db, { locationId: location.id, date: today, startMin: 1200 });
    const cancelled = createShow(t.db, { locationId: location.id, date: today, startMin: 1320, status: 'cancelled' });
    const comics = [createComedian(t.db), createComedian(t.db), createComedian(t.db)];
    createBooking(t.db, { showId: tonight.id, comedianId: comics[0]!.id });
    createBooking(t.db, { showId: tonight.id, comedianId: comics[1]!.id, confirmationSentAt: Date.now() });
    createBooking(t.db, { showId: tonight.id, comedianId: comics[2]!.id, confirmedAt: Date.now(), confirmedBy: 'comedian' });
    createBooking(t.db, { showId: cancelled.id, comedianId: comics[0]!.id });

    const body = await list(`from=${today}&to=${today}`);
    expect(body.find((s) => s.id === tonight.id)).toMatchObject({ bookedCount: 3, unconfirmedTodayCount: 2 });
    // Cancelled shows keep their bookings but need no confirmation.
    expect(body.find((s) => s.id === cancelled.id)).toMatchObject({
      status: 'cancelled',
      bookedCount: 1,
      unconfirmedTodayCount: 0,
    });
  });

  it('validates the query', async () => {
    for (const query of [
      '',
      'from=2026-11-01',
      'from=2026-11-31&to=2026-12-01',
      'from=2026-11-30&to=2026-11-01',
      'from=2026-01-01&to=2027-06-01',
      'from=2026-11-01&to=2026-11-30&locationIds=a,b',
    ]) {
      const res = await t.request(`/api/shows?${query}`, { headers });
      expect(res.status, query).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error' });
    }
  });
});

describe('POST /api/shows/bulk', () => {
  it('creates one show per (de-duplicated) date', async () => {
    const location = createLocation(t.db, { name: 'The Cellar' });
    const res = await post('/api/shows/bulk', {
      locationId: location.id,
      name: ' Late Show ',
      startMin: 1290,
      slotCount: 7,
      dates: ['2026-11-13', '2026-11-06', '2026-11-13'],
    });
    expect(res.status).toBe(201);
    const body = await readJson<BulkCreateShowsResponse>(res);
    expect(body.skipped).toEqual([]);
    expect(body.created.map((s) => s.date)).toEqual(['2026-11-06', '2026-11-13']);
    expect(body.created[0]).toMatchObject({
      locationId: location.id,
      name: 'Late Show',
      startMin: 1290,
      slotCount: 7,
      status: 'scheduled',
      location: { name: 'The Cellar' },
      bookedCount: 0,
      unconfirmedTodayCount: 0,
    });
    expect(allShows()).toHaveLength(2);
  });

  it('defaults name and slot count', async () => {
    const location = createLocation(t.db);
    const res = await post('/api/shows/bulk', { locationId: location.id, startMin: 1200, dates: ['2026-11-06'] });
    expect((await readJson<BulkCreateShowsResponse>(res)).created[0]).toMatchObject({ name: '', slotCount: 6 });
  });

  it('skips duplicates (same location, date and time, scheduled) and reports them', async () => {
    const cellar = createLocation(t.db);
    const annex = createLocation(t.db);
    const existing = createShow(t.db, { locationId: cellar.id, date: '2026-11-06', startMin: 1290 });
    createShow(t.db, { locationId: cellar.id, date: '2026-11-13', startMin: 1290, status: 'cancelled' }); // not a duplicate
    createShow(t.db, { locationId: cellar.id, date: '2026-11-20', startMin: 1200 }); // other time
    createShow(t.db, { locationId: annex.id, date: '2026-11-27', startMin: 1290 }); // other location

    const res = await post('/api/shows/bulk', {
      locationId: cellar.id,
      startMin: 1290,
      dates: ['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27'],
    });
    expect(res.status).toBe(201);
    const body = await readJson<BulkCreateShowsResponse>(res);
    expect(body.created.map((s) => s.date)).toEqual(['2026-11-13', '2026-11-20', '2026-11-27']);
    expect(body.skipped).toEqual([{ date: '2026-11-06', reason: 'duplicate', showId: existing.id }]);

    // Everything skipped → 200 with nothing created.
    const again = await post('/api/shows/bulk', { locationId: cellar.id, startMin: 1290, dates: ['2026-11-06'] });
    expect(again.status).toBe(200);
    expect(await readJson(again)).toMatchObject({ created: [], skipped: [{ date: '2026-11-06' }] });
  });

  it('validates input', async () => {
    const location = createLocation(t.db);
    const base = { locationId: location.id, startMin: 1200, slotCount: 6, dates: ['2026-11-06'] };
    for (const json of [
      { ...base, dates: [] },
      { ...base, dates: ['2026-11-31'] },
      { ...base, startMin: 719 },
      { ...base, startMin: 1560 },
      { ...base, startMin: 1200.5 },
      { ...base, slotCount: 0 },
      { ...base, slotCount: 31 },
      { ...base, name: 'x'.repeat(101) },
      { ...base, locationId: undefined },
    ]) {
      const res = await post('/api/shows/bulk', json);
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error' });
    }
    // Edges of the start-time range are fine.
    expect((await post('/api/shows/bulk', { ...base, startMin: 720 })).status).toBe(201);
    expect((await post('/api/shows/bulk', { ...base, startMin: 1559 })).status).toBe(201);
  });

  it('rejects unknown and archived locations', async () => {
    const missing = await post('/api/shows/bulk', { locationId: 999, startMin: 1200, dates: ['2026-11-06'] });
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toMatchObject({ code: 'not_found' });

    const archived = createLocation(t.db, { archived: true });
    const res = await post('/api/shows/bulk', { locationId: archived.id, startMin: 1200, dates: ['2026-11-06'] });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ code: 'location_archived' });
    expect(allShows()).toHaveLength(0);
  });
});

describe('POST /api/shows/copy-pattern', () => {
  /** Nov 2030: Fridays 1, 8, 15, 22, 29; Wednesdays 6, 13, 20, 27. Dec 2030: Fridays 6, 13, 20, 27; Wednesdays 4, 11, 18, 25. */
  function seedNovember() {
    const cellar = createLocation(t.db, { name: 'The Cellar', sortOrder: 0 });
    const annex = createLocation(t.db, { name: 'The Annex', sortOrder: 1 });
    for (const date of datesForWeekday(NOV, 5)) {
      createShow(t.db, { locationId: cellar.id, date, startMin: 1140, slotCount: 6 });
      createShow(t.db, { locationId: cellar.id, date, startMin: 1290, name: 'Late Show', slotCount: 7 });
    }
    for (const date of datesForWeekday(NOV, 3)) {
      createShow(t.db, { locationId: annex.id, date, startMin: 1200, name: 'Open Mic', slotCount: 12 });
    }
    return { cellar, annex };
  }

  it('previews without writing (dryRun)', async () => {
    const { cellar, annex } = seedNovember();
    const before = allShows().length;
    const res = await post('/api/shows/copy-pattern', { fromMonth: NOV, toMonth: DEC, dryRun: true });
    expect(res.status).toBe(200);
    const body = await readJson<CopyPatternResponse>(res);
    expect(allShows()).toHaveLength(before);

    expect(body).toMatchObject({ dryRun: true, fromMonth: NOV, toMonth: DEC, skipped: [], sourceShowCount: 14 });
    // 4 Fridays × 2 Cellar shows + 4 Wednesdays × 1 Annex show.
    expect(body.shows).toHaveLength(12);
    expect(body.shows.every((s) => s.id === undefined)).toBe(true);
    expect(body.shows[0]).toEqual({
      date: '2030-12-04',
      weekday: 3,
      locationId: annex.id,
      location: { id: annex.id, name: 'The Annex', color: annex.color },
      startMin: 1200,
      name: 'Open Mic',
      slotCount: 12,
    });
    const fridays = body.shows.filter((s) => s.weekday === 5);
    expect(new Set(fridays.map((s) => s.date))).toEqual(new Set(datesForWeekday(DEC, 5)));
    expect(fridays.every((s) => s.locationId === cellar.id)).toBe(true);
    expect(body.shows.find((s) => s.date === '2030-12-06' && s.startMin === 1290)).toMatchObject({
      name: 'Late Show',
      slotCount: 7,
    });
    // Sorted by date then time.
    const keys = body.shows.map((s) => `${s.date}|${String(s.startMin).padStart(4, '0')}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('creates the previewed shows, without bookings', async () => {
    seedNovember();
    const source = allShows()[0]!;
    createBooking(t.db, { showId: source.id, comedianId: createComedian(t.db).id });

    const preview = await readJson<CopyPatternResponse>(
      await post('/api/shows/copy-pattern', { fromMonth: NOV, toMonth: DEC, dryRun: true }),
    );
    const res = await post('/api/shows/copy-pattern', { fromMonth: NOV, toMonth: DEC, dryRun: false });
    expect(res.status).toBe(201);
    const body = await readJson<CopyPatternResponse>(res);
    expect(body.dryRun).toBe(false);
    expect(body.shows.map(({ id: _id, ...s }) => s)).toEqual(preview.shows);
    expect(body.shows.every((s) => typeof s.id === 'number')).toBe(true);

    const december = allShows().filter((s) => monthOf(s.date) === DEC);
    expect(december).toHaveLength(12);
    expect(december.every((s) => s.status === 'scheduled' && s.notes === '')).toBe(true);
    const decIds = december.map((s) => s.id);
    expect(t.db.select().from(bookings).all().filter((b) => decIds.includes(b.showId))).toEqual([]);

    // Running it again creates nothing: everything is a duplicate now.
    const again = await post('/api/shows/copy-pattern', { fromMonth: NOV, toMonth: DEC });
    expect(again.status).toBe(200);
    const againBody = await readJson<CopyPatternResponse>(again);
    expect(againBody.shows).toEqual([]);
    expect(againBody.skipped).toHaveLength(12);
    expect(againBody.skipped.every((s) => s.reason === 'duplicate' && typeof s.showId === 'number')).toBe(true);
  });

  it('skips existing duplicates in the target month', async () => {
    const { cellar } = seedNovember();
    const existing = createShow(t.db, { locationId: cellar.id, date: '2030-12-13', startMin: 1290 });
    // A cancelled show at the same place and time doesn't block the copy.
    createShow(t.db, { locationId: cellar.id, date: '2030-12-20', startMin: 1290, status: 'cancelled' });

    const body = await readJson<CopyPatternResponse>(
      await post('/api/shows/copy-pattern', { fromMonth: NOV, toMonth: DEC, dryRun: true }),
    );
    expect(body.shows).toHaveLength(11);
    expect(body.skipped).toEqual([
      expect.objectContaining({ date: '2030-12-13', startMin: 1290, reason: 'duplicate', showId: existing.id }),
    ]);
    expect(body.shows.some((s) => s.date === '2030-12-20' && s.startMin === 1290)).toBe(true);
  });

  it('ignores cancelled source shows and archived locations; filters by location', async () => {
    const { cellar, annex } = seedNovember();
    const roof = createLocation(t.db, { name: 'Roof', archived: true });
    createShow(t.db, { locationId: roof.id, date: '2030-11-02', startMin: 1200 });
    createShow(t.db, { locationId: cellar.id, date: '2030-11-04', startMin: 1200, status: 'cancelled' }); // a Monday

    const all = await readJson<CopyPatternResponse>(
      await post('/api/shows/copy-pattern', { fromMonth: NOV, toMonth: DEC, dryRun: true }),
    );
    expect(all.shows.some((s) => s.locationId === roof.id || s.weekday === 1)).toBe(false);
    expect(all.sourceShowCount).toBe(14);

    const annexOnly = await readJson<CopyPatternResponse>(
      await post('/api/shows/copy-pattern', { fromMonth: NOV, toMonth: DEC, dryRun: true, locationIds: [annex.id] }),
    );
    expect(annexOnly.sourceShowCount).toBe(4);
    expect(annexOnly.shows).toHaveLength(4);
    expect(annexOnly.shows.every((s) => s.locationId === annex.id && s.weekday === 3)).toBe(true);
  });

  it('uses the most frequent name/slot count when a weekly slot varies, so it never doubles up', async () => {
    const cellar = createLocation(t.db);
    const fridays = datesForWeekday(NOV, 5);
    fridays.forEach((date, i) =>
      createShow(t.db, {
        locationId: cellar.id,
        date,
        startMin: 1200,
        name: i === 2 ? 'Holiday Special' : 'Friday Night',
        slotCount: i === 2 ? 10 : 6,
      }),
    );
    const body = await readJson<CopyPatternResponse>(
      await post('/api/shows/copy-pattern', { fromMonth: NOV, toMonth: DEC, dryRun: true }),
    );
    expect(body.shows).toHaveLength(datesForWeekday(DEC, 5).length);
    expect(body.shows.every((s) => s.name === 'Friday Night' && s.slotCount === 6)).toBe(true);
  });

  it('skips dates before today', async () => {
    const today = clubToday(t.db);
    const thisMonth = monthOf(today);
    const lastMonth = addMonths(thisMonth, -1);
    const location = createLocation(t.db);
    // One show on every weekday of last month's first week → a pattern covering all weekdays.
    for (let i = 0; i < 7; i++) createShow(t.db, { locationId: location.id, date: addDays(`${lastMonth}-01`, i), startMin: 1200 });

    const body = await readJson<CopyPatternResponse>(
      await post('/api/shows/copy-pattern', { fromMonth: lastMonth, toMonth: thisMonth, dryRun: true }),
    );
    // The pattern covers every weekday, so each day of this month is either created or skipped as past.
    expect(body.shows.length + body.skipped.length).toBe(daysInMonth(thisMonth).length);
    expect(body.shows.every((s) => s.date >= today)).toBe(true);
    expect(body.skipped.every((s) => s.reason === 'past' && s.date < today)).toBe(true);
    expect(body.skipped).toHaveLength(Number(today.slice(8)) - 1);
  });

  it('validates input and reports an empty source month', async () => {
    for (const json of [
      { fromMonth: '2030-13', toMonth: DEC },
      { fromMonth: NOV, toMonth: NOV },
      { fromMonth: NOV },
      { fromMonth: NOV, toMonth: DEC, locationIds: ['x'] },
    ]) {
      const res = await post('/api/shows/copy-pattern', json);
      expect(res.status, JSON.stringify(json)).toBe(400);
    }
    const empty = await post('/api/shows/copy-pattern', { fromMonth: NOV, toMonth: DEC, dryRun: false });
    expect(empty.status).toBe(200);
    expect(await readJson(empty)).toMatchObject({ shows: [], skipped: [], sourceShowCount: 0 });
  });
});

describe('GET /api/shows/:id', () => {
  it('returns the show with its lineup and the minimum slot count', async () => {
    const show = createShow(t.db, { date: '2030-11-01', slotCount: 7 });
    const jo = createComedian(t.db, { name: 'Jo' });
    const al = createComedian(t.db, { name: 'Al' });
    createBooking(t.db, { showId: show.id, comedianId: jo.id, position: 4, confirmedAt: 1, confirmedBy: 'booker' });
    createBooking(t.db, { showId: show.id, comedianId: al.id, position: 1, confirmationSentAt: 1 });

    const res = await t.request(`/api/shows/${show.id}`, { headers });
    expect(res.status).toBe(200);
    const body = await readJson<ShowDetail>(res);
    expect(body).toMatchObject({ id: show.id, bookedCount: 2, minSlotCount: 5, slotCount: 7 });
    expect(body.bookings).toEqual([
      expect.objectContaining({ position: 1, comedianId: al.id, comedianName: 'Al', status: 'awaiting' }),
      expect.objectContaining({ position: 4, comedianId: jo.id, comedianName: 'Jo', status: 'confirmed', confirmedBy: 'booker' }),
    ]);

    const empty = createShow(t.db);
    expect(await readJson(await t.request(`/api/shows/${empty.id}`, { headers }))).toMatchObject({
      bookings: [],
      minSlotCount: 1,
    });
  });

  it('404s and 400s', async () => {
    expect((await t.request('/api/shows/999', { headers })).status).toBe(404);
    expect((await t.request('/api/shows/abc', { headers })).status).toBe(400);
  });
});

describe('PATCH /api/shows/:id', () => {
  it('updates name, notes and slot count', async () => {
    const show = createShow(t.db);
    const res = await patch(show.id, { name: ' Late Show ', notes: 'Bring the mic stand.', slotCount: 8 });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      id: show.id,
      name: 'Late Show',
      notes: 'Bring the mic stand.',
      slotCount: 8,
      confirmationsReset: 0,
    });
  });

  it('refuses to drop slotCount below the highest occupied position + 1 (409 slots_occupied)', async () => {
    const show = createShow(t.db, { slotCount: 7 });
    createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id, position: 0 });
    createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id, position: 4 });

    const res = await patch(show.id, { slotCount: 4 });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ code: 'slots_occupied', minSlotCount: 5 });
    expect(t.db.select().from(shows).where(eq(shows.id, show.id)).get()?.slotCount).toBe(7);

    // Exactly max position + 1 is fine; so is removing empty trailing slots.
    expect((await patch(show.id, { slotCount: 5 })).status).toBe(200);
    expect((await patch(show.id, { slotCount: 6 })).status).toBe(200);

    // An empty show can go down to 1, not 0.
    const empty = createShow(t.db, { slotCount: 3 });
    expect((await patch(empty.id, { slotCount: 1 })).status).toBe(200);
    expect((await patch(empty.id, { slotCount: 0 })).status).toBe(400);
  });

  it("resets the bookings' confirmations when the start time changes", async () => {
    const show = createShow(t.db, { startMin: 1260 });
    const now = Date.now();
    const confirmed = createBooking(t.db, {
      showId: show.id,
      comedianId: createComedian(t.db).id,
      confirmationSentAt: now,
      confirmedAt: now,
      confirmedBy: 'comedian',
    });
    const awaiting = createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id, confirmationSentAt: now });
    createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id });

    // Same time: nothing changes.
    const same = await readJson<UpdateShowResponse>(await patch(show.id, { startMin: 1260, name: 'Late' }));
    expect(same.confirmationsReset).toBe(0);
    expect(same.bookings.find((b) => b.id === confirmed.id)).toMatchObject({ confirmedAt: now, status: 'confirmed' });

    const res = await patch(show.id, { startMin: 1290 });
    expect(res.status).toBe(200);
    const body = await readJson<UpdateShowResponse>(res);
    expect(body).toMatchObject({ startMin: 1290, confirmationsReset: 2, bookedCount: 3 });
    expect(body.bookings.every((b) => b.status === 'not_sent')).toBe(true);
    for (const id of [confirmed.id, awaiting.id]) {
      expect(t.db.select().from(bookings).where(eq(bookings.id, id)).get()).toMatchObject({
        confirmedAt: null,
        confirmedBy: null,
        confirmationSentAt: null,
      });
    }
  });

  it('cancels (keeping bookings) and restores', async () => {
    const show = createShow(t.db, { date: clubToday(t.db) });
    createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id });

    const cancelled = await readJson<UpdateShowResponse>(await patch(show.id, { status: 'cancelled' }));
    expect(cancelled).toMatchObject({ status: 'cancelled', bookedCount: 1, unconfirmedTodayCount: 0 });
    expect(cancelled.bookings).toHaveLength(1);

    const restored = await readJson<UpdateShowResponse>(await patch(show.id, { status: 'scheduled' }));
    expect(restored).toMatchObject({ status: 'scheduled', bookedCount: 1, unconfirmedTodayCount: 1 });
  });

  it('refuses to create a duplicate by changing the time or restoring (409 duplicate_show)', async () => {
    const location = createLocation(t.db);
    const nine = createShow(t.db, { locationId: location.id, startMin: 1260 });
    const seven = createShow(t.db, { locationId: location.id, startMin: 1140 });

    const moved = await patch(seven.id, { startMin: 1260 });
    expect(moved.status).toBe(409);
    expect(await readJson(moved)).toMatchObject({ code: 'duplicate_show', showId: nine.id });

    const cancelledTwin = createShow(t.db, { locationId: location.id, startMin: 1260, status: 'cancelled' });
    const restore = await patch(cancelledTwin.id, { status: 'scheduled' });
    expect(restore.status).toBe(409);
    expect(await readJson(restore)).toMatchObject({ code: 'duplicate_show', showId: nine.id });

    // Cancelled shows may share a time; renaming a scheduled show is never a conflict.
    expect((await patch(cancelledTwin.id, { name: 'Old' })).status).toBe(200);
    expect((await patch(nine.id, { name: 'Late' })).status).toBe(200);
    // Moving and cancelling at once is fine too.
    expect((await patch(seven.id, { startMin: 1260, status: 'cancelled' })).status).toBe(200);
  });

  it('validates input', async () => {
    const show = createShow(t.db);
    for (const json of [{}, { startMin: 600 }, { status: 'deleted' }, { slotCount: 31 }, { notes: 'x'.repeat(2001) }]) {
      const res = await patch(show.id, json);
      expect(res.status, JSON.stringify(json)).toBe(400);
    }
    expect((await patch(999, { name: 'X' })).status).toBe(404);
  });
});

describe('DELETE /api/shows/:id', () => {
  it('deletes a show without bookings', async () => {
    const show = createShow(t.db);
    const res = await t.request(`/api/shows/${show.id}`, { method: 'DELETE', headers });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true });
    expect(allShows()).toHaveLength(0);
    expect((await t.request(`/api/shows/${show.id}`, { method: 'DELETE', headers })).status).toBe(404);
  });

  it('refuses when the show has bookings (409 has_bookings)', async () => {
    const show = createShow(t.db, { status: 'cancelled' });
    createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id });
    const res = await t.request(`/api/shows/${show.id}`, { method: 'DELETE', headers });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ code: 'has_bookings', bookingCount: 1 });
    expect(allShows()).toHaveLength(1);
  });
});

// Keep `weekdayOf` honest about the fixture months used above.
it('fixture months fall where the tests expect', () => {
  expect(weekdayOf('2030-11-01')).toBe(5);
  expect(weekdayOf('2030-12-04')).toBe(3);
});
