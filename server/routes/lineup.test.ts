import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  restoreOf,
  type CreateBookingResponse,
  type DayResponse,
  type DeleteBookingResponse,
  type LineupBooking,
  type MoveBookingResponse,
  type UnavailableErrorBody,
} from '../../shared/api/lineup';
import type { ApiErrorBody } from '../../shared/types';
import { bookings, shows, users } from '../db/schema';
import { clubToday } from '../lib/settings';
import {
  createAvailability,
  createBooking,
  createComedian,
  createLocation,
  createShow,
  createSubmission,
  createTag,
  createUser,
  loginAsBooker,
  loginAsComedian,
  makeTestApp,
  readJson,
  tagComedian,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';

let t: TestApp;
let headers: AuthHeaders;
let bookerId: number;

const DATE = '2026-11-07'; // a Saturday

beforeEach(async () => {
  t = makeTestApp();
  const login = await loginAsBooker(t, { role: 'booker' });
  headers = login.headers;
  bookerId = login.user.id;
});

afterEach(() => {
  t.close();
});

function bookingRow(id: number) {
  return t.db.select().from(bookings).where(eq(bookings.id, id)).get();
}

async function book(json: Record<string, unknown>) {
  const res = await t.request('/api/bookings', { method: 'POST', headers, json });
  return { status: res.status, body: await readJson<CreateBookingResponse & ApiErrorBody>(res) };
}

async function unbook(id: number) {
  const res = await t.request(`/api/bookings/${id}`, { method: 'DELETE', headers });
  return { status: res.status, body: await readJson<DeleteBookingResponse & ApiErrorBody>(res) };
}

async function move(id: number, json: Record<string, unknown>) {
  const res = await t.request(`/api/bookings/${id}`, { method: 'PATCH', headers, json });
  return { status: res.status, body: await readJson<MoveBookingResponse & ApiErrorBody>(res) };
}

async function getDay(date = DATE): Promise<DayResponse> {
  const res = await t.request(`/api/days/${date}`, { headers });
  expect(res.status).toBe(200);
  return readJson<DayResponse>(res);
}

/** An available comedian for `show` (marked 7–11 PM that night). */
function availableComic(date = DATE, name?: string) {
  const comedian = createComedian(t.db, { name });
  createSubmission(t.db, comedian.id, date.slice(0, 7));
  createAvailability(t.db, { comedianId: comedian.id, date, startMin: 1140, endMin: 1380 });
  return comedian;
}

// ---------------------------------------------------------------------------

describe('guards', () => {
  it('every endpoint requires a booker session', async () => {
    const comedian = createComedian(t.db);
    const { headers: comedianHeaders } = await loginAsComedian(t, comedian.id);
    const calls: [string, string][] = [
      ['GET', `/api/days/${DATE}`],
      ['POST', '/api/bookings'],
      ['PATCH', '/api/bookings/1'],
      ['DELETE', '/api/bookings/1'],
      ['POST', '/api/bookings/1/confirm'],
    ];
    for (const [method, path] of calls) {
      const json = method === 'POST' || method === 'PATCH' ? { showId: 1, position: 0, comedianId: 1 } : undefined;
      for (const h of [undefined, comedianHeaders]) {
        const res = await t.request(path, { method, headers: h, json });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(await readJson(res)).toMatchObject({ code: 'unauthorized' });
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/days/:date', () => {
  it('rejects malformed dates', async () => {
    for (const bad of ['2026-13-01', '2026-11-31', 'tomorrow']) {
      const res = await t.request(`/api/days/${bad}`, { headers });
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error' });
    }
  });

  it('lists scheduled shows by location order then time, with lineups and statuses', async () => {
    const annex = createLocation(t.db, { name: 'The Annex', sortOrder: 1, address: '216 Sullivan St' });
    const cellar = createLocation(t.db, { name: 'The Cellar', sortOrder: 0 });
    const annex8 = createShow(t.db, { locationId: annex.id, date: DATE, startMin: 1200, name: 'Annex Showcase' });
    const cellar9 = createShow(t.db, { locationId: cellar.id, date: DATE, startMin: 1260, slotCount: 7 });
    const annex6 = createShow(t.db, { locationId: annex.id, date: DATE, startMin: 1080 });
    const cellar7 = createShow(t.db, { locationId: cellar.id, date: DATE, startMin: 1140 });
    const cellar730 = createShow(t.db, { locationId: cellar.id, date: DATE, startMin: 1170 });
    createShow(t.db, { locationId: cellar.id, date: DATE, startMin: 1380, status: 'cancelled' });
    createShow(t.db, { locationId: cellar.id, date: '2026-11-08', startMin: 1140 });

    const [a, b, c] = [createComedian(t.db, { name: 'Ann' }), createComedian(t.db, { name: 'Bo' }), createComedian(t.db, { name: 'Cy' })];
    createBooking(t.db, { showId: cellar9.id, comedianId: a.id, position: 2, confirmedAt: 1000, confirmedBy: 'comedian', confirmationSentAt: 500 });
    createBooking(t.db, { showId: cellar9.id, comedianId: b.id, position: 0, confirmationSentAt: 500 });
    createBooking(t.db, { showId: cellar9.id, comedianId: c.id, position: 5, overrideUnavailable: true });

    const day = await getDay();
    expect(day.date).toBe(DATE);
    expect(day.today).toBe(clubToday(t.db));
    expect(day.shows.map((s) => s.id)).toEqual([cellar7.id, cellar730.id, cellar9.id, annex6.id, annex8.id]);

    const nine = day.shows.find((s) => s.id === cellar9.id)!;
    expect(nine).toMatchObject({
      date: DATE,
      startMin: 1260,
      slotCount: 7,
      status: 'scheduled',
      location: { id: cellar.id, name: 'The Cellar', color: cellar.color, address: '' },
    });
    expect(nine.bookings.map((bk) => [bk.position, bk.comedianName, bk.status, bk.overrideUnavailable])).toEqual([
      [0, 'Bo', 'awaiting', false],
      [2, 'Ann', 'confirmed', false],
      [5, 'Cy', 'not_sent', true],
    ]);
    expect(nine.bookings[1]).toMatchObject({ showId: cellar9.id, comedianId: a.id, confirmedBy: 'comedian', confirmedAt: 1000, confirmationSentAt: 500 });
    expect(day.shows.find((s) => s.id === annex8.id)).toMatchObject({ name: 'Annex Showcase', bookings: [] });
  });

  it('marks unconfirmed bookings on today’s shows red', async () => {
    const today = clubToday(t.db);
    const show = createShow(t.db, { date: today });
    const [x, y] = [createComedian(t.db), createComedian(t.db)];
    createBooking(t.db, { showId: show.id, comedianId: x.id, confirmationSentAt: 1 });
    createBooking(t.db, { showId: show.id, comedianId: y.id, confirmedAt: 2, confirmationSentAt: 1 });
    const day = await getDay(today);
    expect(day.shows[0]!.bookings.map((b) => b.status)).toEqual(['unconfirmed_today', 'confirmed']);
  });

  it('describes the comedian pool: tags, availability state, submissions, bookings that day', async () => {
    const cellar = createLocation(t.db, { name: 'The Cellar', sortOrder: 0 });
    const annex = createLocation(t.db, { name: 'The Annex', sortOrder: 1 });
    const seven = createShow(t.db, { locationId: cellar.id, date: DATE, startMin: 1140 });
    const ten = createShow(t.db, { locationId: annex.id, date: DATE, startMin: 1320 });
    const cancelled = createShow(t.db, { locationId: cellar.id, date: DATE, startMin: 1380, status: 'cancelled' });
    const otherDay = createShow(t.db, { locationId: cellar.id, date: '2026-11-06' });

    const hosts = createTag(t.db, { name: 'Hosts', color: '#3b82f6' });
    const allStars = createTag(t.db, { name: 'All Stars', color: '#d946ef' });

    const zed = createComedian(t.db, { name: 'Zed Available' });
    createSubmission(t.db, zed.id, '2026-11');
    createAvailability(t.db, { comedianId: zed.id, date: DATE, startMin: 1260, endMin: 1380 });
    createAvailability(t.db, { comedianId: zed.id, date: '2026-11-08', startMin: 1140, endMin: 1380 });
    tagComedian(t.db, zed.id, hosts.id);
    tagComedian(t.db, zed.id, allStars.id);

    const amy = createComedian(t.db, { name: 'amy Unavailable' });
    createSubmission(t.db, amy.id, '2026-11');
    createSubmission(t.db, amy.id, '2026-10');

    const bob = createComedian(t.db, { name: 'Bob Unknown' });
    createSubmission(t.db, bob.id, '2026-12'); // a different month doesn't count

    createComedian(t.db, { name: 'Archie Archived', archived: true });

    const bTen = createBooking(t.db, { showId: ten.id, comedianId: zed.id, position: 3 });
    const bSeven = createBooking(t.db, { showId: seven.id, comedianId: zed.id, position: 0 });
    createBooking(t.db, { showId: cancelled.id, comedianId: zed.id });
    createBooking(t.db, { showId: otherDay.id, comedianId: zed.id });

    const day = await getDay();
    expect(day.comedians.map((c) => c.name)).toEqual(['amy Unavailable', 'Bob Unknown', 'Zed Available']);
    expect(day.tags).toEqual([
      { id: allStars.id, name: 'All Stars', color: '#d946ef' },
      { id: hosts.id, name: 'Hosts', color: '#3b82f6' },
    ]);

    const [a, b, z] = day.comedians;
    expect(z).toEqual({
      id: zed.id,
      name: 'Zed Available',
      headshotUrl: '',
      tags: [
        { id: allStars.id, name: 'All Stars', color: '#d946ef' },
        { id: hosts.id, name: 'Hosts', color: '#3b82f6' },
      ],
      availability: { startMin: 1260, endMin: 1380 },
      submittedMonth: true,
      bookings: [
        { bookingId: bSeven.id, showId: seven.id, startMin: 1140, locationName: 'The Cellar', position: 0 },
        { bookingId: bTen.id, showId: ten.id, startMin: 1320, locationName: 'The Annex', position: 3 },
      ],
    });
    expect(a).toMatchObject({ availability: null, submittedMonth: true, tags: [], bookings: [] });
    expect(b).toMatchObject({ availability: null, submittedMonth: false, tags: [], bookings: [] });
  });

  it('returns an empty board for a dark day', async () => {
    createShow(t.db, { date: '2026-11-06' });
    const day = await getDay('2026-11-09');
    expect(day.shows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/bookings', () => {
  it('books an available comedian into an empty slot', async () => {
    const show = createShow(t.db, { date: DATE, startMin: 1260 });
    const comic = availableComic(DATE, 'Jason Park');
    const res = await book({ showId: show.id, position: 2, comedianId: comic.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      showId: show.id,
      position: 2,
      comedianId: comic.id,
      comedianName: 'Jason Park',
      status: 'not_sent',
      overrideUnavailable: false,
      confirmedAt: null,
      confirmedBy: null,
      confirmationSentAt: null,
    });
    expect(bookingRow(res.body.id)).toMatchObject({ bookedById: bookerId, overrideUnavailable: false });
  });

  it('validates the body and finds the show and comedian', async () => {
    const show = createShow(t.db, { date: DATE });
    const comic = availableComic();
    for (const json of [{}, { showId: show.id, position: -1, comedianId: comic.id }, { showId: show.id, position: 1.5, comedianId: comic.id }]) {
      const res = await book(json);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_error');
    }
    expect((await book({ showId: 999, position: 0, comedianId: comic.id })).body).toMatchObject({ code: 'not_found' });
    expect((await book({ showId: show.id, position: 0, comedianId: 999 })).status).toBe(404);
  });

  it('rejects a position at or past the slot count with 400', async () => {
    const show = createShow(t.db, { date: DATE, slotCount: 4 });
    const comic = availableComic();
    const res = await book({ showId: show.id, position: 4, comedianId: comic.id });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_position', slotCount: 4 });
    expect((await book({ showId: show.id, position: 3, comedianId: comic.id })).status).toBe(201);
  });

  it('409 already_in_show when the comedian is already in the lineup', async () => {
    const show = createShow(t.db, { date: DATE });
    const comic = availableComic();
    const existing = createBooking(t.db, { showId: show.id, comedianId: comic.id, position: 1 });
    const res = await book({ showId: show.id, position: 3, comedianId: comic.id });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'already_in_show', bookingId: existing.id, position: 1, comedianId: comic.id });
  });

  it('409 slot_taken when the slot is occupied', async () => {
    const show = createShow(t.db, { date: DATE });
    const occupant = createComedian(t.db, { name: 'Maria Delgado' });
    const taken = createBooking(t.db, { showId: show.id, comedianId: occupant.id, position: 0 });
    const res = await book({ showId: show.id, position: 0, comedianId: availableComic().id });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'slot_taken',
      bookingId: taken.id,
      comedianId: occupant.id,
      comedianName: 'Maria Delgado',
    });
  });

  it('409 unavailable explains why, and force books anyway with overrideUnavailable', async () => {
    const show = createShow(t.db, { date: DATE, startMin: 1380 }); // 11 PM

    // Marked a range that doesn't cover 11 PM.
    const early = createComedian(t.db, { name: 'Jason Park' });
    createSubmission(t.db, early.id, '2026-11');
    createAvailability(t.db, { comedianId: early.id, date: DATE, startMin: 1140, endMin: 1260 });
    const r1 = await book({ showId: show.id, position: 0, comedianId: early.id });
    expect(r1.status).toBe(409);
    const body = r1.body as unknown as UnavailableErrorBody;
    expect(body).toMatchObject({
      code: 'unavailable',
      error: "Jason Park isn't available during this slot",
      comedianId: early.id,
      comedianName: 'Jason Park',
      showId: show.id,
      date: DATE,
      startMin: 1380,
      month: '2026-11',
      availability: { startMin: 1140, endMin: 1260 },
      submittedMonth: true,
    });
    expect(body.conflicts).toHaveLength(1);

    // Submitted November but left the 7th blank.
    const blank = createComedian(t.db);
    createSubmission(t.db, blank.id, '2026-11');
    expect((await book({ showId: show.id, position: 0, comedianId: blank.id })).body).toMatchObject({
      code: 'unavailable',
      availability: null,
      submittedMonth: true,
    });

    // Never submitted November.
    const silent = createComedian(t.db);
    const r3 = await book({ showId: show.id, position: 0, comedianId: silent.id });
    expect(r3.status).toBe(409);
    expect(r3.body).toMatchObject({ code: 'unavailable', availability: null, submittedMonth: false });

    expect(t.db.select().from(bookings).all()).toHaveLength(0);

    const forced = await book({ showId: show.id, position: 0, comedianId: early.id, force: true });
    expect(forced.status).toBe(201);
    expect(forced.body).toMatchObject({ overrideUnavailable: true, position: 0 });
  });

  it('treats the range ends as inclusive and force on an available comedian stores no override', async () => {
    const show = createShow(t.db, { date: DATE, startMin: 1380 });
    const comic = createComedian(t.db);
    createAvailability(t.db, { comedianId: comic.id, date: DATE, startMin: 1140, endMin: 1380 });
    const res = await book({ showId: show.id, position: 0, comedianId: comic.id, force: true });
    expect(res.status).toBe(201);
    expect(res.body.overrideUnavailable).toBe(false);
  });

  it('refuses cancelled shows and archived comedians', async () => {
    const cancelled = createShow(t.db, { date: DATE, status: 'cancelled' });
    const comic = availableComic();
    expect((await book({ showId: cancelled.id, position: 0, comedianId: comic.id, force: true })).body).toMatchObject({
      code: 'show_cancelled',
    });
    const show = createShow(t.db, { date: DATE });
    const archived = createComedian(t.db, { archived: true });
    const res = await book({ showId: show.id, position: 0, comedianId: archived.id, force: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('comedian_archived');
  });
});

// ---------------------------------------------------------------------------

describe('PATCH /api/bookings/:id', () => {
  const confirmed = { confirmationSentAt: 100, confirmedAt: 200, confirmedBy: 'comedian' as const };

  it('moves within a show and keeps the confirmation', async () => {
    const show = createShow(t.db, { date: DATE });
    const comic = createComedian(t.db); // not even available: same show, no re-check
    const b = createBooking(t.db, { showId: show.id, comedianId: comic.id, position: 0, ...confirmed });
    const res = await move(b.id, { showId: show.id, position: 4 });
    expect(res.status).toBe(200);
    expect(res.body.swapped).toBeNull();
    expect(res.body.booking).toMatchObject({ id: b.id, showId: show.id, position: 4, status: 'confirmed', confirmedAt: 200 });
    expect(bookingRow(b.id)).toMatchObject({ position: 4, confirmedAt: 200, confirmationSentAt: 100 });
  });

  it('defaults to the current show and treats dropping in place as a no-op', async () => {
    const show = createShow(t.db, { date: DATE });
    const b = createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id, position: 2 });
    expect((await move(b.id, { position: 2 })).body).toMatchObject({ booking: { position: 2 }, swapped: null });
    expect((await move(b.id, { position: 5 })).body.booking.position).toBe(5);
  });

  it('swaps with the occupant within a show', async () => {
    const show = createShow(t.db, { date: DATE });
    const [x, y] = [createComedian(t.db), createComedian(t.db)];
    const bx = createBooking(t.db, { showId: show.id, comedianId: x.id, position: 0, ...confirmed });
    const by = createBooking(t.db, { showId: show.id, comedianId: y.id, position: 3 });
    const res = await move(bx.id, { showId: show.id, position: 3 });
    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({ id: bx.id, position: 3, status: 'confirmed' });
    expect(res.body.swapped).toMatchObject({ id: by.id, position: 0, showId: show.id });
    expect(bookingRow(bx.id)?.position).toBe(3);
    expect(bookingRow(by.id)?.position).toBe(0);
  });

  it('moves to another show: resets confirmation and re-evaluates the override', async () => {
    const seven = createShow(t.db, { date: DATE, startMin: 1140 });
    const nine = createShow(t.db, { date: DATE, startMin: 1260 });
    const comic = availableComic();
    const b = createBooking(t.db, { showId: seven.id, comedianId: comic.id, position: 1, overrideUnavailable: true, ...confirmed });
    const res = await move(b.id, { showId: nine.id, position: 0 });
    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({
      showId: nine.id,
      position: 0,
      status: 'not_sent',
      confirmedAt: null,
      confirmedBy: null,
      confirmationSentAt: null,
      overrideUnavailable: false,
    });
    expect(bookingRow(b.id)).toMatchObject({ showId: nine.id, confirmedAt: null, confirmationSentAt: null });
  });

  it('re-checks availability across shows: 409 unless force', async () => {
    const seven = createShow(t.db, { date: DATE, startMin: 1140 });
    const late = createShow(t.db, { date: DATE, startMin: 1440 }); // midnight
    const comic = availableComic(DATE, 'Early Bird'); // 7–11 PM
    const b = createBooking(t.db, { showId: seven.id, comedianId: comic.id, position: 0, ...confirmed });

    const res = await move(b.id, { showId: late.id, position: 2 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'unavailable',
      comedianName: 'Early Bird',
      showId: late.id,
      startMin: 1440,
      availability: { startMin: 1140, endMin: 1380 },
      submittedMonth: true,
    });
    expect(bookingRow(b.id)).toMatchObject({ showId: seven.id, position: 0, confirmedAt: 200 });

    const forced = await move(b.id, { showId: late.id, position: 2, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.booking).toMatchObject({ showId: late.id, position: 2, overrideUnavailable: true, confirmedAt: null });
  });

  it('swaps across shows atomically, re-checking both comedians', async () => {
    const seven = createShow(t.db, { date: DATE, startMin: 1140 });
    const late = createShow(t.db, { date: DATE, startMin: 1440 });
    const x = availableComic(DATE, 'Xena'); // 7–11 PM: fine at 7, not at midnight
    const y = createComedian(t.db, { name: 'Yuri' }); // never submitted
    const bx = createBooking(t.db, { showId: seven.id, comedianId: x.id, position: 0, ...confirmed });
    const by = createBooking(t.db, { showId: late.id, comedianId: y.id, position: 1, ...confirmed });

    const res = await move(bx.id, { showId: late.id, position: 1 });
    expect(res.status).toBe(409);
    const body = res.body as unknown as UnavailableErrorBody;
    expect(body.error).toBe("Xena and Yuri aren't available for those slots");
    expect(body.conflicts.map((c) => [c.comedianName, c.showId, c.submittedMonth])).toEqual([
      ['Xena', late.id, true],
      ['Yuri', seven.id, false],
    ]);
    expect(bookingRow(bx.id)).toMatchObject({ showId: seven.id, position: 0 });
    expect(bookingRow(by.id)).toMatchObject({ showId: late.id, position: 1 });

    const forced = await move(bx.id, { showId: late.id, position: 1, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.booking).toMatchObject({ id: bx.id, showId: late.id, position: 1, overrideUnavailable: true, confirmedAt: null });
    expect(forced.body.swapped).toMatchObject({ id: by.id, showId: seven.id, position: 0, overrideUnavailable: true, confirmedAt: null, status: 'not_sent' });
  });

  it('swaps across shows without a modal when both comedians are available', async () => {
    const seven = createShow(t.db, { date: DATE, startMin: 1140 });
    const nine = createShow(t.db, { date: DATE, startMin: 1260 });
    const [x, y] = [availableComic(), availableComic()];
    const bx = createBooking(t.db, { showId: seven.id, comedianId: x.id, position: 2 });
    const by = createBooking(t.db, { showId: nine.id, comedianId: y.id, position: 4 });
    const res = await move(bx.id, { showId: nine.id, position: 4 });
    expect(res.status).toBe(200);
    expect(bookingRow(bx.id)).toMatchObject({ showId: nine.id, position: 4 });
    expect(bookingRow(by.id)).toMatchObject({ showId: seven.id, position: 2 });
  });

  it('409 already_in_show when either comedian would appear twice in a show', async () => {
    const seven = createShow(t.db, { date: DATE, startMin: 1140 });
    const nine = createShow(t.db, { date: DATE, startMin: 1260 });
    const [x, y] = [availableComic(), availableComic()];
    const bx7 = createBooking(t.db, { showId: seven.id, comedianId: x.id, position: 0 });
    const bx9 = createBooking(t.db, { showId: nine.id, comedianId: x.id, position: 0 });
    expect((await move(bx7.id, { showId: nine.id, position: 3 })).body).toMatchObject({
      code: 'already_in_show',
      bookingId: bx9.id,
    });

    // Swapping y (9 PM) into the 7 PM slot held by x would put x in the 9 PM show twice.
    const by9 = createBooking(t.db, { showId: nine.id, comedianId: y.id, position: 1 });
    const res = await move(by9.id, { showId: seven.id, position: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'already_in_show', bookingId: bx9.id, comedianId: x.id });
    expect(bookingRow(by9.id)).toMatchObject({ showId: nine.id, position: 1 });
  });

  it('validates the target position, show and booking', async () => {
    const show = createShow(t.db, { date: DATE, slotCount: 3 });
    const other = createShow(t.db, { date: DATE, startMin: 1140, status: 'cancelled' });
    const b = createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id });
    expect((await move(b.id, { position: 3 })).body).toMatchObject({ code: 'invalid_position', slotCount: 3 });
    expect((await move(b.id, { showId: 999, position: 0 })).status).toBe(404);
    expect((await move(b.id, { showId: other.id, position: 0, force: true })).body).toMatchObject({ code: 'show_cancelled' });
    expect((await move(999, { position: 0 })).status).toBe(404);
    expect((await move(b.id, {})).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('DELETE /api/bookings/:id', () => {
  it('unbooks and returns the removed booking in full', async () => {
    const show = createShow(t.db, { date: DATE });
    const comic = createComedian(t.db, { name: 'Maria Delgado' });
    const b = createBooking(t.db, {
      showId: show.id,
      comedianId: comic.id,
      position: 2,
      overrideUnavailable: true,
      bookedById: bookerId,
      confirmationSentAt: 1_000,
      confirmedAt: 2_000,
      confirmedBy: 'comedian',
    });
    const res = await t.request(`/api/bookings/${b.id}`, { method: 'DELETE', headers });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      ok: true,
      booking: {
        id: b.id,
        showId: show.id,
        position: 2,
        comedianId: comic.id,
        comedianName: 'Maria Delgado',
        status: 'confirmed',
        overrideUnavailable: true,
        confirmationSentAt: 1_000,
        confirmedAt: 2_000,
        confirmedBy: 'comedian',
        bookedById: bookerId,
        createdAt: b.createdAt,
      },
    });
    expect(bookingRow(b.id)).toBeUndefined();
    expect((await t.request(`/api/bookings/${b.id}`, { method: 'DELETE', headers })).status).toBe(404);
    expect((await t.request('/api/bookings/abc', { method: 'DELETE', headers })).status).toBe(400);
  });
});

describe('Undo: restoring a removed booking', () => {
  it('re-creates a removed booking exactly: confirmation, override, who booked it and when', async () => {
    const show = createShow(t.db, { date: DATE, startMin: 1380 });
    const comic = createComedian(t.db); // never marked available → needs force
    const otherBooker = createUser(t.db);
    const original = createBooking(t.db, {
      showId: show.id,
      comedianId: comic.id,
      position: 3,
      overrideUnavailable: true,
      bookedById: otherBooker.id,
      confirmationSentAt: 1_000,
      confirmedAt: 2_000,
      confirmedBy: 'comedian',
      createdAt: 500,
    });
    const { body: removed } = await unbook(original.id);

    // Without force it still asks (they aren't available).
    const asked = await book({ showId: show.id, position: 3, comedianId: comic.id, restore: restoreOf(removed.booking) });
    expect(asked.body.code).toBe('unavailable');

    const res = await book({ showId: show.id, position: 3, comedianId: comic.id, force: true, restore: restoreOf(removed.booking) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      showId: show.id,
      position: 3,
      comedianId: comic.id,
      status: 'confirmed',
      overrideUnavailable: true,
      confirmationSentAt: 1_000,
      confirmedAt: 2_000,
      confirmedBy: 'comedian',
      replaced: null,
    });
    const { id: _oldId, ...originalFields } = original;
    const { id: _newId, ...restoredFields } = bookingRow(res.body.id)!;
    expect(restoredFields).toEqual(originalFields);
  });

  it('keeps the original booker only while they still exist', async () => {
    const show = createShow(t.db, { date: DATE });
    const comic = availableComic();
    const gone = createUser(t.db);
    const b = createBooking(t.db, { showId: show.id, comedianId: comic.id, bookedById: gone.id });
    const { body } = await unbook(b.id);
    t.db.delete(users).where(eq(users.id, gone.id)).run();
    const res = await book({ showId: show.id, position: b.position, comedianId: comic.id, restore: restoreOf(body.booking) });
    expect(res.status).toBe(201);
    expect(bookingRow(res.body.id)?.bookedById).toBeNull();
  });

  it('validates the restore object', async () => {
    const show = createShow(t.db, { date: DATE });
    const comic = availableComic();
    const valid = {
      overrideUnavailable: false,
      confirmationSentAt: null,
      confirmedAt: null,
      confirmedBy: null,
      bookedById: bookerId,
      createdAt: 1_000,
    };
    for (const restore of [
      { ...valid, confirmedAt: 5 }, // confirmedAt without confirmedBy
      { ...valid, confirmedBy: 'booker' }, // and the other way round
      { ...valid, confirmedBy: 'someone', confirmedAt: 5 },
      { ...valid, createdAt: -1 },
      { ...valid, createdAt: Date.now() + 86_400_000 }, // in the future
      { ...valid, confirmedAt: Date.now() + 86_400_000, confirmedBy: 'booker' },
      { overrideUnavailable: false },
    ]) {
      const res = await book({ showId: show.id, position: 0, comedianId: comic.id, restore });
      expect(res.status, JSON.stringify(restore)).toBe(400);
      expect(res.body.code).toBe('validation_error');
    }
    expect(t.db.select().from(bookings).all()).toHaveLength(0);
    expect((await book({ showId: show.id, position: 0, comedianId: comic.id, restore: valid })).status).toBe(201);
  });
});

describe('Replacing a slot’s occupant from the pool', () => {
  it('replaceBookingId books into an occupied slot; the occupant goes back to the pool', async () => {
    const show = createShow(t.db, { date: DATE });
    const occupant = availableComic(DATE, 'Maria Delgado');
    const taken = createBooking(t.db, {
      showId: show.id,
      comedianId: occupant.id,
      position: 1,
      confirmationSentAt: 1_000,
      confirmedAt: 2_000,
      confirmedBy: 'booker',
    });
    const incoming = availableComic(DATE, 'Jason Park');

    const res = await book({ showId: show.id, position: 1, comedianId: incoming.id, replaceBookingId: taken.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      showId: show.id,
      position: 1,
      comedianId: incoming.id,
      confirmedAt: null,
      replaced: {
        id: taken.id,
        comedianId: occupant.id,
        comedianName: 'Maria Delgado',
        position: 1,
        confirmedAt: 2_000,
        confirmedBy: 'booker',
        confirmationSentAt: 1_000,
        createdAt: taken.createdAt,
      },
    });
    expect(bookingRow(taken.id)).toBeUndefined();
    const day = await getDay();
    expect(day.shows[0]!.bookings.map((b) => b.comedianName)).toEqual(['Jason Park']);
    expect(day.comedians.find((c) => c.id === occupant.id)?.bookings).toEqual([]);

    // Undo: put the occupant back exactly, replacing the newcomer.
    const undo = await book({
      showId: show.id,
      position: 1,
      comedianId: occupant.id,
      force: true,
      replaceBookingId: res.body.id,
      restore: restoreOf(res.body.replaced!),
    });
    expect(undo.status).toBe(201);
    expect(undo.body).toMatchObject({ comedianId: occupant.id, status: 'confirmed', confirmedAt: 2_000, confirmedBy: 'booker' });
    expect(undo.body.replaced).toMatchObject({ id: res.body.id, comedianId: incoming.id });
    const { id: _a, ...before } = taken;
    const { id: _b, ...after } = bookingRow(undo.body.id)!;
    expect(after).toEqual(before);
    expect(bookingRow(res.body.id)).toBeUndefined();
  });

  it('still asks about an unavailable newcomer, leaving the occupant in place', async () => {
    const show = createShow(t.db, { date: DATE, startMin: 1380 });
    const taken = createBooking(t.db, { showId: show.id, comedianId: availableComic().id, position: 0 });
    const notMarked = createComedian(t.db, { name: 'Omar Haddad' });

    const asked = await book({ showId: show.id, position: 0, comedianId: notMarked.id, replaceBookingId: taken.id });
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ code: 'unavailable', comedianId: notMarked.id });
    expect(bookingRow(taken.id)).toBeDefined();

    const forced = await book({ showId: show.id, position: 0, comedianId: notMarked.id, replaceBookingId: taken.id, force: true });
    expect(forced.status).toBe(201);
    expect(forced.body).toMatchObject({ overrideUnavailable: true, replaced: { id: taken.id } });
  });

  it('409 slot_taken when someone else holds the slot now; an emptied slot just books', async () => {
    const show = createShow(t.db, { date: DATE });
    const first = createBooking(t.db, { showId: show.id, comedianId: availableComic().id, position: 0 });
    const other = createBooking(t.db, { showId: show.id, comedianId: availableComic().id, position: 1 });
    const incoming = availableComic();

    const wrong = await book({ showId: show.id, position: 0, comedianId: incoming.id, replaceBookingId: other.id });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ code: 'slot_taken', bookingId: first.id });
    expect(bookingRow(other.id)).toBeDefined();

    await unbook(first.id);
    const empty = await book({ showId: show.id, position: 0, comedianId: incoming.id, replaceBookingId: first.id });
    expect(empty.status).toBe(201);
    expect(empty.body.replaced).toBeNull();
    expect(bookingRow(other.id)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/bookings/:id/confirm', () => {
  it('marks a booking confirmed by the booker, idempotently', async () => {
    const show = createShow(t.db, { date: clubToday(t.db) });
    const b = createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id, confirmationSentAt: 50 });
    const before = Date.now();
    const res = await t.request(`/api/bookings/${b.id}/confirm`, { method: 'POST', headers });
    expect(res.status).toBe(200);
    const body = await readJson<LineupBooking>(res);
    expect(body).toMatchObject({ id: b.id, status: 'confirmed', confirmedBy: 'booker', confirmationSentAt: 50 });
    expect(body.confirmedAt).toBeGreaterThanOrEqual(before);

    const again = await readJson<LineupBooking>(
      await t.request(`/api/bookings/${b.id}/confirm`, { method: 'POST', headers }),
    );
    expect(again.confirmedAt).toBe(body.confirmedAt);

    expect((await t.request('/api/bookings/999/confirm', { method: 'POST', headers })).status).toBe(404);
  });

  it('keeps an existing comedian confirmation', async () => {
    const show = createShow(t.db, { date: DATE });
    const b = createBooking(t.db, { showId: show.id, comedianId: createComedian(t.db).id, confirmedAt: 7, confirmedBy: 'comedian' });
    const res = await t.request(`/api/bookings/${b.id}/confirm`, { method: 'POST', headers });
    expect(await readJson(res)).toMatchObject({ confirmedAt: 7, confirmedBy: 'comedian' });
  });
});

describe('day view after changes elsewhere', () => {
  it('drops a show from the board once it is cancelled', async () => {
    const show = createShow(t.db, { date: DATE });
    expect((await getDay()).shows).toHaveLength(1);
    t.db.update(shows).set({ status: 'cancelled' }).where(eq(shows.id, show.id)).run();
    expect((await getDay()).shows).toHaveLength(0);
  });
});
