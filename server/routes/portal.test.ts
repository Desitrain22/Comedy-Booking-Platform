import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfirmLinkInfo,
  ConfirmLinkResult,
  ConfirmWeekResponse,
  DeclineSpotResponse,
  PortalAvailabilityResponse,
  PortalMeResponse,
  PortalProfile,
  PortalSpotsResponse,
} from '../../shared/api/portal';
import { DECLINE_NOTE_MAX, declineLink, defaultAvailabilityMonth } from '../../shared/api/portal';
import type { MeResponse } from '../../shared/types';
import { SESSION_COOKIES } from '../auth/sessions';
import { createConfirmLink, createLoginLink } from '../auth/tokens';
import { availability, availabilitySubmissions, bookings, comedians, sessions, tokens, type Comedian } from '../db/schema';
import { updateSettings } from '../lib/settings';
import { CONFIRM_LINK_SESSION_TTL_MS } from './portal';
import {
  cookieFrom,
  createAvailability,
  createBooking,
  createComedian,
  createLocation,
  createShow,
  createSubmission,
  loginAsBooker,
  loginAsComedian,
  makeTestApp,
  readJson,
  withCookies,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';

// Tue Nov 10 2026, 12 PM in New York (the club timezone). This week = Mon Nov 9 – Sun Nov 15.
const NOW = new Date('2026-11-10T17:00:00Z');
const TODAY = '2026-11-10';
const THIS_WEEK = '2026-11-09';

let t: TestApp;
let john: Comedian;
let headers: AuthHeaders;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = makeTestApp();
  john = createComedian(t.db, { name: 'John Mercer', email: 'john@example.test' });
  ({ headers } = await loginAsComedian(t, john.id));
});

afterEach(() => {
  t.close();
  vi.useRealTimers();
});

function get(path: string, h: AuthHeaders | undefined = headers) {
  return t.request(path, { headers: h });
}

function put(path: string, json: unknown, h: AuthHeaders | undefined = headers) {
  return t.request(path, { method: 'PUT', json, headers: h });
}

function post(path: string, json: unknown = {}, h: AuthHeaders | undefined = headers) {
  return t.request(path, { method: 'POST', json, headers: h });
}

function rowsFor(comedianId: number) {
  return t.db
    .select({ date: availability.date, startMin: availability.startMin, endMin: availability.endMin })
    .from(availability)
    .where(eq(availability.comedianId, comedianId))
    .orderBy(availability.date)
    .all();
}

function bookingRow(id: number) {
  return t.db.select().from(bookings).where(eq(bookings.id, id)).get()!;
}

/** The token at the end of an absolute link like http://…/portal/confirm/<token>. */
function tokenFromUrl(url: string): string {
  return url.split('/').pop()!;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('portal guards', () => {
  const guarded: [method: string, path: string, json?: unknown][] = [
    ['GET', '/api/portal/me'],
    ['GET', '/api/portal/availability?month=2026-11'],
    ['PUT', '/api/portal/availability', { month: '2026-11', entries: [] }],
    ['GET', '/api/portal/spots'],
    ['POST', '/api/portal/spots/confirm', { weekStart: THIS_WEEK }],
    ['GET', '/api/portal/profile'],
    ['PUT', '/api/portal/profile', { name: 'X', bio: '', headshotUrl: '' }],
  ];

  it('401s without a comedian session — a booker session does not grant portal access', async () => {
    const booker = await loginAsBooker(t);
    for (const [method, path, json] of guarded) {
      for (const h of [undefined, booker.headers]) {
        const res = await t.request(path, { method, json, headers: h });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(await readJson(res)).toEqual({ error: 'Please sign in', code: 'unauthorized' });
      }
    }
    // A booker token presented under the comedian cookie name doesn't work either.
    const swapped = { cookie: booker.cookie.replace(SESSION_COOKIES.booker, SESSION_COOKIES.comedian) };
    expect((await get('/api/portal/me', swapped)).status).toBe(401);
    // Nothing was written by the rejected PUTs.
    expect(t.db.select().from(availabilitySubmissions).all()).toEqual([]);
  });

  it('401s for an archived comedian', async () => {
    t.db.update(comedians).set({ archived: true }).where(eq(comedians.id, john.id)).run();
    expect((await get('/api/portal/me')).status).toBe(401);
  });

  it('works for a comedian even with a booker cookie in the same browser', async () => {
    const booker = await loginAsBooker(t);
    const res = await get('/api/portal/me', withCookies(booker.headers, headers));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

describe('GET /api/portal/me', () => {
  it('returns the profile, club info and upcoming spot counts', async () => {
    t.db.update(comedians).set({ bio: 'Dry wit.', headshotUrl: 'https://img.test/j.jpg' }).where(eq(comedians.id, john.id)).run();
    const past = createShow(t.db, { date: '2026-11-05' });
    const soon = createShow(t.db, { date: '2026-11-12' });
    const later = createShow(t.db, { date: '2026-11-20' });
    createBooking(t.db, { showId: past.id, comedianId: john.id });
    createBooking(t.db, { showId: soon.id, comedianId: john.id, confirmedAt: Date.now(), confirmedBy: 'comedian' });
    createBooking(t.db, { showId: later.id, comedianId: john.id });

    const res = await get('/api/portal/me');
    expect(res.status).toBe(200);
    expect(await readJson<PortalMeResponse>(res)).toEqual({
      comedian: {
        id: john.id,
        name: 'John Mercer',
        email: 'john@example.test',
        phone: '',
        bio: 'Dry wit.',
        headshotUrl: 'https://img.test/j.jpg',
      },
      club: {
        name: 'Test Comedy Club',
        timezone: 'America/New_York',
        allNight: { startMin: 1140, endMin: 1380 },
        allowDeclines: false,
      },
      today: TODAY,
      spots: { upcoming: 2, unconfirmed: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

describe('GET /api/portal/availability', () => {
  it("returns the month's nights for this comedian only, with the submission and all-night range", async () => {
    t.close();
    t = makeTestApp({ settings: { allNightStartMin: 1200, allNightEndMin: 1440 } });
    john = createComedian(t.db, { name: 'John' });
    ({ headers } = await loginAsComedian(t, john.id));
    const other = createComedian(t.db);
    createAvailability(t.db, { comedianId: john.id, date: '2026-11-21', startMin: 1260, endMin: 1380 });
    createAvailability(t.db, { comedianId: john.id, date: '2026-11-03' });
    createAvailability(t.db, { comedianId: john.id, date: '2026-12-01' }); // other month
    createAvailability(t.db, { comedianId: other.id, date: '2026-11-21' }); // other comedian
    createSubmission(t.db, john.id, '2026-11', 1_700_000_000_000);

    const res = await get('/api/portal/availability?month=2026-11');
    expect(res.status).toBe(200);
    expect(await readJson<PortalAvailabilityResponse>(res)).toEqual({
      month: '2026-11',
      entries: [
        { date: '2026-11-03', startMin: 1140, endMin: 1380 },
        { date: '2026-11-21', startMin: 1260, endMin: 1380 },
      ],
      submittedAt: 1_700_000_000_000,
      allNight: { startMin: 1200, endMin: 1440 },
      today: TODAY,
    });

    const dec = await readJson<PortalAvailabilityResponse>(await get('/api/portal/availability?month=2026-12'));
    expect(dec).toMatchObject({ month: '2026-12', submittedAt: null });
    expect(dec.entries).toHaveLength(1);
  });

  it('defaults to the current month before the 20th, next month from the 20th', async () => {
    expect((await readJson<PortalAvailabilityResponse>(await get('/api/portal/availability'))).month).toBe('2026-11');
    vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
    expect((await readJson<PortalAvailabilityResponse>(await get('/api/portal/availability'))).month).toBe('2026-12');
    vi.setSystemTime(new Date('2026-12-25T15:00:00Z'));
    expect((await readJson<PortalAvailabilityResponse>(await get('/api/portal/availability'))).month).toBe('2027-01');

    expect(defaultAvailabilityMonth('2026-11-19')).toBe('2026-11');
    expect(defaultAvailabilityMonth('2026-11-20')).toBe('2026-12');
    expect(defaultAvailabilityMonth('2026-12-31')).toBe('2027-01');
  });

  it('rejects a malformed month', async () => {
    const res = await get('/api/portal/availability?month=2026-13');
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ code: 'validation_error' });
  });
});

describe('PUT /api/portal/availability', () => {
  it("replaces the month's non-past nights, keeps past nights and other months, and records a submission", async () => {
    const other = createComedian(t.db);
    createAvailability(t.db, { comedianId: john.id, date: '2026-11-03', startMin: 1200, endMin: 1320 }); // past
    createAvailability(t.db, { comedianId: john.id, date: '2026-11-10' }); // today: editable, dropped below
    createAvailability(t.db, { comedianId: john.id, date: '2026-11-14' }); // replaced
    createAvailability(t.db, { comedianId: john.id, date: '2026-11-25' }); // dropped
    createAvailability(t.db, { comedianId: john.id, date: '2026-12-05' }); // other month
    createAvailability(t.db, { comedianId: other.id, date: '2026-11-14' }); // other comedian

    const saturdays = ['2026-11-14', '2026-11-21', '2026-11-28'];
    const res = await put('/api/portal/availability', {
      month: '2026-11',
      entries: [
        // A past night in the body is ignored (it can't change any more).
        { date: '2026-11-07', startMin: 1260, endMin: 1380 },
        { date: '2026-11-03', startMin: 1260, endMin: 1380 },
        ...saturdays.map((date) => ({ date, startMin: 1260, endMin: 1380 })),
        { date: '2026-11-30', startMin: 1320, endMin: 1560 },
      ],
    });
    expect(res.status).toBe(200);
    const body = await readJson<PortalAvailabilityResponse>(res);
    expect(body.month).toBe('2026-11');
    expect(body.submittedAt).toBe(NOW.getTime());
    expect(body.entries).toEqual([
      { date: '2026-11-03', startMin: 1200, endMin: 1320 },
      ...saturdays.map((date) => ({ date, startMin: 1260, endMin: 1380 })),
      { date: '2026-11-30', startMin: 1320, endMin: 1560 },
    ]);
    expect(rowsFor(john.id)).toEqual([...body.entries, { date: '2026-12-05', startMin: 1140, endMin: 1380 }]);
    expect(rowsFor(other.id)).toEqual([{ date: '2026-11-14', startMin: 1140, endMin: 1380 }]);

    const subs = t.db.select().from(availabilitySubmissions).all();
    expect(subs).toEqual([{ comedianId: john.id, month: '2026-11', submittedAt: NOW.getTime() }]);
  });

  it('records a submission with zero nights, and re-saving updates the time', async () => {
    createAvailability(t.db, { comedianId: john.id, date: '2026-12-04' });
    const first = await put('/api/portal/availability', { month: '2026-12', entries: [] });
    expect(first.status).toBe(200);
    expect(await readJson(first)).toMatchObject({ month: '2026-12', entries: [], submittedAt: NOW.getTime() });
    expect(rowsFor(john.id)).toEqual([]);

    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const second = await put('/api/portal/availability', {
      month: '2026-12',
      entries: [{ date: '2026-12-31', startMin: 1140, endMin: 1380 }],
    });
    expect(await readJson(second)).toMatchObject({ submittedAt: NOW.getTime() + 60_000 });
    expect(t.db.select().from(availabilitySubmissions).all()).toHaveLength(1);
  });

  it('accepts the edges of the allowed range (4 PM – 2 AM)', async () => {
    const res = await put('/api/portal/availability', {
      month: '2026-12',
      entries: [{ date: '2026-12-01', startMin: 960, endMin: 1560 }],
    });
    expect(res.status).toBe(200);
  });

  it('rejects invalid ranges, dates outside the month, duplicates and past months — writing nothing', async () => {
    createAvailability(t.db, { comedianId: john.id, date: '2026-12-04' });
    const cases: [entries: unknown[], code: string, month?: string][] = [
      [[{ date: '2026-12-01', startMin: 1380, endMin: 1260 }], 'validation_error'], // end before start
      [[{ date: '2026-12-01', startMin: 1260, endMin: 1260 }], 'validation_error'], // empty
      [[{ date: '2026-12-01', startMin: 900, endMin: 1260 }], 'validation_error'], // before 4 PM
      [[{ date: '2026-12-01', startMin: 1260, endMin: 1590 }], 'validation_error'], // after 2 AM
      [[{ date: '2026-12-01', startMin: 1260.5, endMin: 1380 }], 'validation_error'], // not an integer
      [[{ date: '2026-12-32', startMin: 1260, endMin: 1380 }], 'validation_error'], // not a date
      [[{ date: '2027-01-01', startMin: 1260, endMin: 1380 }], 'date_outside_month'],
      [[{ date: '2026-11-30', startMin: 1260, endMin: 1380 }], 'date_outside_month'],
      [
        [
          { date: '2026-12-01', startMin: 1260, endMin: 1380 },
          { date: '2026-12-01', startMin: 1140, endMin: 1380 },
        ],
        'duplicate_date',
      ],
      [[], 'month_past', '2026-10'],
      [[], 'validation_error', 'December'],
    ];
    for (const [entries, code, month = '2026-12'] of cases) {
      const res = await put('/api/portal/availability', { month, entries });
      expect(res.status, JSON.stringify(entries)).toBe(400);
      expect(await readJson(res)).toMatchObject({ code });
    }
    expect(rowsFor(john.id)).toEqual([{ date: '2026-12-04', startMin: 1140, endMin: 1380 }]);
    expect(t.db.select().from(availabilitySubmissions).all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Spots
// ---------------------------------------------------------------------------

describe('GET /api/portal/spots', () => {
  it('groups own scheduled spots by week (past 2 weeks flagged past), excluding cancelled and others', async () => {
    const cellar = createLocation(t.db, { name: 'The Cellar', address: '1 Main St', sortOrder: 0 });
    const annex = createLocation(t.db, { name: 'The Annex', sortOrder: 1 });
    const other = createComedian(t.db);
    const show = (date: string, startMin: number, locationId = cellar.id, status: 'scheduled' | 'cancelled' = 'scheduled') =>
      createShow(t.db, { date, startMin, locationId, status, name: `Show ${date}` });

    const tooOld = show('2026-10-25', 1260); // Sunday 3 weeks ago: excluded
    const twoWeeksAgo = show('2026-10-26', 1260);
    const lastWeek = show('2026-11-06', 1260);
    const earlierThisWeek = show('2026-11-09', 1200);
    const today = show(TODAY, 1260, annex.id);
    const todayEarly = show(TODAY, 1140);
    const cancelled = show('2026-11-12', 1260, cellar.id, 'cancelled');
    const nextWeek = show('2026-11-21', 1320);
    const othersOnly = show('2026-11-13', 1260);

    for (const s of [tooOld, twoWeeksAgo, lastWeek, earlierThisWeek, today, todayEarly, cancelled, nextWeek]) {
      createBooking(t.db, { showId: s.id, comedianId: john.id });
    }
    createBooking(t.db, { showId: othersOnly.id, comedianId: other.id });
    t.db
      .update(bookings)
      .set({ confirmedAt: 1, confirmedBy: 'booker' })
      .where(and(eq(bookings.showId, todayEarly.id), eq(bookings.comedianId, john.id)))
      .run();
    t.db
      .update(bookings)
      .set({ confirmationSentAt: 1 })
      .where(and(eq(bookings.showId, nextWeek.id), eq(bookings.comedianId, john.id)))
      .run();

    const res = await get('/api/portal/spots');
    expect(res.status).toBe(200);
    const body = await readJson<PortalSpotsResponse>(res);
    expect(body.today).toBe(TODAY);
    expect(body.allowDeclines).toBe(false);
    expect(body.weeks.every((w) => w.declinedCount === 0)).toBe(true);
    expect(body.weeks.map((w) => [w.weekStart, w.past, w.unconfirmedCount, w.spots.map((s) => s.date)])).toEqual([
      ['2026-10-26', true, 1, ['2026-10-26']],
      ['2026-11-02', true, 1, ['2026-11-06']],
      [THIS_WEEK, false, 2, ['2026-11-09', TODAY, TODAY]],
      ['2026-11-16', false, 1, ['2026-11-21']],
    ]);

    const thisWeek = body.weeks[2]!;
    // Sorted by date then time: 7 PM Cellar (confirmed) before 9 PM Annex (unconfirmed today → red).
    expect(thisWeek.spots.slice(1)).toEqual([
      {
        bookingId: expect.any(Number),
        showId: todayEarly.id,
        date: TODAY,
        startMin: 1140,
        showName: `Show ${TODAY}`,
        location: { id: cellar.id, name: 'The Cellar', address: '1 Main St', color: cellar.color },
        status: 'confirmed',
        confirmedAt: 1,
        confirmedBy: 'booker',
        declinedAt: null,
        declineNote: '',
        startsAt: new Date('2026-11-11T00:00:00Z').getTime(), // 7 PM EST
      },
      expect.objectContaining({ showId: today.id, status: 'unconfirmed_today', location: expect.objectContaining({ name: 'The Annex' }) }),
    ]);
    expect(thisWeek.spots[0]).toMatchObject({ status: 'not_sent' });
    expect(body.weeks[3]!.spots[0]).toMatchObject({ status: 'awaiting', startMin: 1320 });
  });

  it('is empty for a comedian with no spots', async () => {
    expect(await readJson(await get('/api/portal/spots'))).toEqual({ today: TODAY, weeks: [], allowDeclines: false });
  });
});

describe('POST /api/portal/spots/confirm', () => {
  it("confirms only this comedian's scheduled, unconfirmed spots in that week", async () => {
    const other = createComedian(t.db);
    const mine = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-13' }).id, comedianId: john.id });
    const sunday = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-15' }).id, comedianId: john.id });
    const byBooker = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-14' }).id,
      comedianId: john.id,
      confirmedAt: 123,
      confirmedBy: 'booker',
    });
    const cancelled = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-14', status: 'cancelled' }).id,
      comedianId: john.id,
    });
    const nextWeek = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-16' }).id, comedianId: john.id });
    const othersSpot = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-13' }).id, comedianId: other.id });

    const res = await post('/api/portal/spots/confirm', { weekStart: THIS_WEEK });
    expect(res.status).toBe(200);
    expect(await readJson<ConfirmWeekResponse>(res)).toEqual({ weekStart: THIS_WEEK, confirmedCount: 2 });

    for (const b of [mine, sunday]) {
      expect(bookingRow(b.id)).toMatchObject({ confirmedAt: NOW.getTime(), confirmedBy: 'comedian' });
    }
    expect(bookingRow(byBooker.id)).toMatchObject({ confirmedAt: 123, confirmedBy: 'booker' });
    for (const b of [cancelled, nextWeek, othersSpot]) {
      expect(bookingRow(b.id)).toMatchObject({ confirmedAt: null, confirmedBy: null });
    }

    // Idempotent.
    const again = await post('/api/portal/spots/confirm', { weekStart: THIS_WEEK });
    expect(await readJson(again)).toEqual({ weekStart: THIS_WEEK, confirmedCount: 0 });
  });

  it('rejects a non-Monday and a week that is over', async () => {
    const tuesday = await post('/api/portal/spots/confirm', { weekStart: TODAY });
    expect(tuesday.status).toBe(400);
    expect(await readJson(tuesday)).toMatchObject({ code: 'invalid_week' });

    const past = await post('/api/portal/spots/confirm', { weekStart: '2026-11-02' });
    expect(past.status).toBe(400);
    expect(await readJson(past)).toMatchObject({ code: 'week_past' });

    const bad = await post('/api/portal/spots/confirm', { weekStart: 'soon' });
    expect(await readJson(bad)).toMatchObject({ code: 'validation_error' });
  });

  it("at 12:30 AM Monday, last week's Sunday-night 1 AM spot can still be confirmed (club night)", async () => {
    const late = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-15', startMin: 1500 }).id,
      comedianId: john.id,
      confirmationSentAt: 1,
    });
    vi.setSystemTime(new Date('2026-11-16T05:30:00Z')); // Mon Nov 16, 12:30 AM in New York
    const res = await post('/api/portal/spots/confirm', { weekStart: THIS_WEEK });
    expect(res.status).toBe(200);
    expect(bookingRow(late.id)).toMatchObject({ confirmedBy: 'comedian' });

    vi.setSystemTime(new Date('2026-11-16T11:00:00Z')); // 6 AM: that night is over
    expect(await readJson(await post('/api/portal/spots/confirm', { weekStart: THIS_WEEK }))).toMatchObject({ code: 'week_past' });
  });
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

describe('portal profile', () => {
  it('reads and updates name, bio and headshot (email stays read-only)', async () => {
    expect(await readJson<PortalProfile>(await get('/api/portal/profile'))).toEqual({
      id: john.id,
      name: 'John Mercer',
      email: 'john@example.test',
      phone: '',
      bio: '',
      headshotUrl: '',
    });

    const res = await put('/api/portal/profile', {
      name: '  Johnny   Mercer ',
      bio: '  Ten years of dry wit.\nOpened for everyone.  ',
      headshotUrl: ' https://cdn.example.test/johnny.jpg ',
      email: 'hacker@example.test',
    });
    expect(res.status).toBe(200);
    const expected = {
      id: john.id,
      name: 'Johnny Mercer',
      email: 'john@example.test',
      phone: '',
      bio: 'Ten years of dry wit.\nOpened for everyone.',
      headshotUrl: 'https://cdn.example.test/johnny.jpg',
    };
    expect(await readJson(res)).toEqual(expected);
    expect(await readJson(await get('/api/portal/profile'))).toEqual(expected);
    // The session name follows.
    expect((await readJson<MeResponse>(await get('/api/auth/me'))).comedian?.name).toBe('Johnny Mercer');

    // Clearing the headshot and bio is fine; a 1000-character bio is the limit.
    const cleared = await put('/api/portal/profile', { name: 'John', bio: 'x'.repeat(1000), headshotUrl: '' });
    expect(cleared.status).toBe(200);
    expect(await readJson(cleared)).toMatchObject({ headshotUrl: '', bio: 'x'.repeat(1000) });
  });

  it('has an optional phone: set, kept when omitted, cleared with an empty string', async () => {
    const valid = { name: 'John Mercer', bio: '', headshotUrl: '' };
    const set = await put('/api/portal/profile', { ...valid, phone: '  (212)  555-0142 x7 ' });
    expect(set.status).toBe(200);
    expect(await readJson(set)).toMatchObject({ phone: '(212) 555-0142 x7' });
    // Older clients that don't send a phone leave it alone.
    expect(await readJson(await put('/api/portal/profile', { ...valid, bio: 'New bio' }))).toMatchObject({
      bio: 'New bio',
      phone: '(212) 555-0142 x7',
    });
    expect(await readJson(await get('/api/portal/me'))).toMatchObject({ comedian: { phone: '(212) 555-0142 x7' } });
    // The booker sees it too.
    expect(t.db.select().from(comedians).where(eq(comedians.id, john.id)).get()!.phone).toBe('(212) 555-0142 x7');
    expect(await readJson(await put('/api/portal/profile', { ...valid, phone: '' }))).toMatchObject({ phone: '' });

    for (const phone of ['call me maybe', '1'.repeat(41), '212/555/0142', 42]) {
      const res = await put('/api/portal/profile', { ...valid, phone });
      expect(res.status, String(phone)).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error', issues: [{ path: 'phone' }] });
    }
  });

  it('validates the name, bio length and headshot URL', async () => {
    const valid = { name: 'John', bio: '', headshotUrl: '' };
    for (const patch of [
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { bio: 'x'.repeat(1001) },
      { headshotUrl: 'not a url' },
      { headshotUrl: 'javascript:alert(1)' },
      { headshotUrl: 'ftp://example.test/a.jpg' },
      { headshotUrl: `https://example.test/${'a'.repeat(500)}` },
      { bio: undefined },
    ]) {
      const res = await put('/api/portal/profile', { ...valid, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error' });
    }
    expect(t.db.select().from(comedians).where(eq(comedians.id, john.id)).get()!.name).toBe('John Mercer');
  });
});

// ---------------------------------------------------------------------------
// Confirm links
// ---------------------------------------------------------------------------

describe('confirm links', () => {
  function setup() {
    const cellar = createLocation(t.db, { name: 'The Cellar', address: '1 Main St' });
    const fri = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-13', startMin: 1260, locationId: cellar.id, name: 'Late Show' }).id,
      comedianId: john.id,
      confirmationSentAt: 1,
    });
    const sat = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-14', startMin: 1140, locationId: cellar.id }).id,
      comedianId: john.id,
      confirmationSentAt: 1,
    });
    const nextWeek = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-17' }).id, comedianId: john.id });
    const cancelled = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-12', status: 'cancelled' }).id,
      comedianId: john.id,
    });
    const other = createComedian(t.db);
    const othersSpot = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-13' }).id, comedianId: other.id });
    const token = tokenFromUrl(createConfirmLink(t.db, john.id, THIS_WEEK));
    return { cellar, fri, sat, nextWeek, cancelled, othersSpot, token };
  }

  it('GET shows the week read-only: no confirmations, no session, token untouched', async () => {
    const { cellar, fri, sat, token } = setup();
    const res = await get(`/api/portal/confirm/${token}`, undefined);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = await readJson<ConfirmLinkInfo>(res);
    expect(body).toMatchObject({ comedianName: 'John Mercer', weekStart: THIS_WEEK, today: TODAY, unconfirmedCount: 2 });
    expect(body.spots.map((s) => [s.date, s.startMin, s.showName, s.location.name, s.location.address, s.status])).toEqual([
      ['2026-11-13', 1260, 'Late Show', cellar.name, '1 Main St', 'awaiting'],
      ['2026-11-14', 1140, '', cellar.name, '1 Main St', 'awaiting'],
    ]);
    // A second prefetch (email scanner) changes nothing either.
    expect((await get(`/api/portal/confirm/${token}`, undefined)).status).toBe(200);

    expect(bookingRow(fri.id).confirmedAt).toBeNull();
    expect(bookingRow(sat.id).confirmedAt).toBeNull();
    expect(t.db.select().from(tokens).where(eq(tokens.purpose, 'confirm')).get()!.lastUsedAt).toBeNull();
    // Only John's own test session exists.
    expect(t.db.select().from(sessions).all()).toHaveLength(1);
  });

  it("POST confirms the week's spots, signs the comedian in, and is idempotent", async () => {
    const { fri, sat, nextWeek, cancelled, othersSpot, token } = setup();
    // Straight from the email: no session yet (`undefined` would mean the default signed-in headers).
    const res = await post(`/api/portal/confirm/${token}`, {}, { cookie: '' });
    expect(res.status).toBe(200);
    const body = await readJson<ConfirmLinkResult>(res);
    expect(body).toMatchObject({
      confirmedCount: 2,
      unconfirmedCount: 0,
      weekStart: THIS_WEEK,
      comedian: { id: john.id, name: 'John Mercer', email: 'john@example.test' },
    });
    expect(body.spots.map((s) => s.status)).toEqual(['confirmed', 'confirmed']);

    for (const b of [fri, sat]) {
      expect(bookingRow(b.id)).toMatchObject({ confirmedAt: NOW.getTime(), confirmedBy: 'comedian' });
    }
    for (const b of [nextWeek, cancelled, othersSpot]) expect(bookingRow(b.id).confirmedAt).toBeNull();
    expect(t.db.select().from(tokens).where(eq(tokens.purpose, 'confirm')).get()!.lastUsedAt).toBe(NOW.getTime());

    // The response sets the comedian cookie, which works for the portal.
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIES.comedian}=`, 'm'));
    expect(setCookie).toMatch(/HttpOnly/);
    // An emailed link signs in for a week, not the 90 days a sign-in code gives.
    expect(setCookie).toMatch(new RegExp(`Max-Age=${CONFIRM_LINK_SESSION_TTL_MS / 1000}\\b`));
    const cookie = { cookie: cookieFrom(res) };
    expect((await readJson<MeResponse>(await get('/api/auth/me', cookie))).comedian?.id).toBe(john.id);
    expect((await get('/api/portal/spots', cookie)).status).toBe(200);
    expect(t.db.select().from(comedians).where(eq(comedians.id, john.id)).get()!.lastLoginAt).toBe(NOW.getTime());

    // Clicking again ("already confirmed") is fine.
    const again = await post(`/api/portal/confirm/${token}`, {}, undefined);
    expect(again.status).toBe(200);
    expect(await readJson(again)).toMatchObject({ confirmedCount: 0, unconfirmedCount: 0 });
    // Already signed in as them (here with a sign-in code's 90-day session): that session is kept.
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it('works for a week with no spots left', async () => {
    const token = tokenFromUrl(createConfirmLink(t.db, john.id, THIS_WEEK));
    expect(await readJson(await get(`/api/portal/confirm/${token}`, undefined))).toMatchObject({ spots: [], unconfirmedCount: 0 });
    const res = await post(`/api/portal/confirm/${token}`, {}, undefined);
    expect(await readJson(res)).toMatchObject({ confirmedCount: 0, spots: [] });
  });

  it('410s an expired link and 404s unknown links, login links and archived comedians — without side effects', async () => {
    const { fri, token } = setup();
    const expired = tokenFromUrl(createConfirmLink(t.db, john.id, '2026-10-26')); // expired Wed Nov 4
    const login = tokenFromUrl(createLoginLink(t.db, john.id));

    for (const method of ['GET', 'POST'] as const) {
      const send = (tok: string) => t.request(`/api/portal/confirm/${tok}`, { method, json: method === 'POST' ? {} : undefined });

      const gone = await send(expired);
      expect(gone.status).toBe(410);
      expect(await readJson(gone)).toEqual({ error: 'This confirmation link has expired', code: 'expired_token' });
      expect(gone.headers.getSetCookie()).toEqual([]);

      for (const bad of [login, 'not-a-real-token', 'x'.repeat(500)]) {
        const res = await send(bad);
        expect(res.status).toBe(404);
        expect(await readJson(res)).toMatchObject({ code: 'invalid_token' });
        expect(res.headers.getSetCookie()).toEqual([]);
      }
    }

    t.db.update(comedians).set({ archived: true }).where(eq(comedians.id, john.id)).run();
    const archived = await post(`/api/portal/confirm/${token}`, {}, undefined);
    expect(archived.status).toBe(404);
    expect(bookingRow(fri.id).confirmedAt).toBeNull();
  });

  it('a confirm link is still valid until two days after the week ends', async () => {
    const { token } = setup();
    vi.setSystemTime(new Date('2026-11-18T04:00:00Z')); // Tue Nov 17, 11 PM in New York
    expect((await get(`/api/portal/confirm/${token}`, undefined)).status).toBe(200);
    vi.setSystemTime(new Date('2026-11-18T05:00:01Z')); // just past midnight → Wed Nov 18
    expect((await get(`/api/portal/confirm/${token}`, undefined)).status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
// Declining a spot ("Can't make it", only when the club allows it)
// ---------------------------------------------------------------------------

describe("declining a spot (Can't make it)", () => {
  function setup() {
    updateSettings(t.db, { allowDeclines: true });
    const fri = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-13', startMin: 1260 }).id,
      comedianId: john.id,
      confirmationSentAt: 1,
    });
    const sat = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-14', startMin: 1260 }).id,
      comedianId: john.id,
      confirmationSentAt: 1,
      confirmedAt: 5,
      confirmedBy: 'comedian',
    });
    return { fri, sat };
  }
  const decline = (id: number, json: unknown = {}, h: AuthHeaders | undefined = headers) =>
    post(`/api/portal/spots/${id}/decline`, json, h);
  const undo = (id: number, h: AuthHeaders | undefined = headers) =>
    t.request(`/api/portal/spots/${id}/decline`, { method: 'DELETE', headers: h });

  it('409s while the club has declines off (the default) — nothing changes', async () => {
    const { fri } = setup();
    updateSettings(t.db, { allowDeclines: false });
    const res = await decline(fri.id, { note: 'Sick' });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ code: 'declines_off' });
    expect(bookingRow(fri.id)).toMatchObject({ declinedAt: null, declineNote: '' });
  });

  it('declines with an optional note; the booking keeps its slot and reads as declined', async () => {
    const { fri } = setup();
    const res = await decline(fri.id, { note: '  Flight got moved  ' });
    expect(res.status).toBe(200);
    const { spot } = await readJson<DeclineSpotResponse>(res);
    expect(spot).toMatchObject({
      bookingId: fri.id,
      status: 'declined',
      declinedAt: NOW.getTime(),
      declineNote: 'Flight got moved',
      startsAt: new Date('2026-11-14T02:00:00Z').getTime(), // Fri 9 PM EST
    });
    expect(bookingRow(fri.id)).toMatchObject({
      showId: fri.showId,
      position: fri.position,
      declinedAt: NOW.getTime(),
      declineNote: 'Flight got moved',
      confirmedAt: null,
    });

    // Idempotent: the first time is kept, the latest note wins; no note is fine.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const again = await decline(fri.id, {});
    expect(again.status).toBe(200);
    expect(bookingRow(fri.id)).toMatchObject({ declinedAt: NOW.getTime(), declineNote: '' });
  });

  it('is not counted as "to confirm" and confirming the week never confirms it', async () => {
    const { fri } = setup();
    const sun = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-15' }).id, comedianId: john.id });
    await decline(fri.id);

    expect((await readJson<PortalMeResponse>(await get('/api/portal/me'))).spots).toEqual({ upcoming: 3, unconfirmed: 1 });
    const week = (await readJson<PortalSpotsResponse>(await get('/api/portal/spots'))).weeks[0]!;
    expect(week).toMatchObject({ weekStart: THIS_WEEK, unconfirmedCount: 1, declinedCount: 1 });
    expect(week.spots.map((s) => s.status)).toEqual(['declined', 'confirmed', 'not_sent']);

    const res = await post('/api/portal/spots/confirm', { weekStart: THIS_WEEK });
    expect(await readJson(res)).toEqual({ weekStart: THIS_WEEK, confirmedCount: 1 });
    expect(bookingRow(sun.id).confirmedAt).toBe(NOW.getTime());
    expect(bookingRow(fri.id)).toMatchObject({ confirmedAt: null, declinedAt: NOW.getTime() });

    // The emailed link's confirm skips it too.
    const token = tokenFromUrl(createConfirmLink(t.db, john.id, THIS_WEEK));
    const viaLink = await readJson<ConfirmLinkResult>(await post(`/api/portal/confirm/${token}`, {}, undefined));
    expect(viaLink).toMatchObject({ confirmedCount: 0, unconfirmedCount: 0, allowDeclines: true });
    expect(bookingRow(fri.id).confirmedAt).toBeNull();
  });

  it('undo puts the spot back exactly as it was, even after declines were switched off', async () => {
    const { fri, sat } = setup();
    await decline(sat.id, { note: 'Double-booked' });
    expect(bookingRow(sat.id)).toMatchObject({ declinedAt: NOW.getTime(), confirmedAt: 5 });
    updateSettings(t.db, { allowDeclines: false });

    const res = await undo(sat.id);
    expect(res.status).toBe(200);
    expect((await readJson<DeclineSpotResponse>(res)).spot).toMatchObject({ status: 'confirmed', declinedAt: null, declineNote: '' });
    expect(bookingRow(sat.id)).toMatchObject({ declinedAt: null, declineNote: '', confirmedAt: 5, confirmedBy: 'comedian' });
    // Undoing a spot that isn't declined is a no-op.
    expect((await undo(fri.id)).status).toBe(200);
    expect(bookingRow(fri.id)).toMatchObject({ declinedAt: null, confirmationSentAt: 1 });
  });

  it("404s someone else's spot, cancelled shows and unknown ids; 409s once the show has started; validates the note", async () => {
    setup();
    const other = createComedian(t.db);
    const othersSpot = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-13' }).id, comedianId: other.id });
    const cancelled = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-13', status: 'cancelled' }).id,
      comedianId: john.id,
    });
    // Last night's 1 AM show (Tue 1 AM, already over) vs. tonight's 1 AM show (still ahead).
    const lastNight = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-09', startMin: 1500 }).id, comedianId: john.id });
    const tonight = createBooking(t.db, { showId: createShow(t.db, { date: TODAY, startMin: 1500 }).id, comedianId: john.id });

    for (const id of [othersSpot.id, cancelled.id, 999_999]) {
      for (const res of [await decline(id), await undo(id)]) {
        expect(res.status).toBe(404);
        expect(await readJson(res)).toMatchObject({ code: 'not_found' });
      }
    }
    expect(bookingRow(othersSpot.id).declinedAt).toBeNull();

    const started = await decline(lastNight.id);
    expect(started.status).toBe(409);
    expect(await readJson(started)).toMatchObject({ code: 'spot_past' });
    expect((await decline(tonight.id)).status).toBe(200);

    const long = await decline(tonight.id, { note: 'x'.repeat(DECLINE_NOTE_MAX + 1) });
    expect(long.status).toBe(400);
    expect(await readJson(long)).toMatchObject({ code: 'validation_error' });
    expect((await post('/api/portal/spots/abc/decline', {})).status).toBe(400);
  });

  it('needs a comedian session', async () => {
    const { fri } = setup();
    const booker = await loginAsBooker(t);
    for (const h of [{}, booker.headers]) {
      const path = `/api/portal/spots/${fri.id}/decline`;
      expect((await t.request(path, { method: 'POST', json: {}, headers: h })).status).toBe(401);
      expect((await t.request(path, { method: 'DELETE', headers: h })).status).toBe(401);
    }
    expect(bookingRow(fri.id).declinedAt).toBeNull();
  });
});

describe('declining from the emailed confirm link', () => {
  function setup() {
    updateSettings(t.db, { allowDeclines: true });
    const fri = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-13' }).id, comedianId: john.id });
    const sat = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-14' }).id, comedianId: john.id });
    const nextWeek = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-17' }).id, comedianId: john.id });
    const url = createConfirmLink(t.db, john.id, THIS_WEEK);
    return { fri, sat, nextWeek, url, token: tokenFromUrl(url) };
  }

  it('the per-spot email link only opens the page: GET with ?decline= changes nothing', async () => {
    const { fri, url } = setup();
    const link = declineLink(url, fri.id);
    expect(link).toBe(`${url}?decline=${fri.id}`);
    const res = await t.request(`/api/portal/confirm/${tokenFromUrl(url)}?decline=${fri.id}`);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ allowDeclines: true, unconfirmedCount: 2 });
    expect(bookingRow(fri.id).declinedAt).toBeNull();
  });

  it('declines and undoes a spot in that week without signing in', async () => {
    const { fri, sat, token } = setup();
    const anonymous = (path: string, json: unknown = {}) => t.request(path, { method: 'POST', json });
    const res = await anonymous(`/api/portal/confirm/${token}/spots/${fri.id}/decline`, { note: 'Sick' });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const info = await readJson<ConfirmLinkInfo>(res);
    expect(info).toMatchObject({ unconfirmedCount: 1, allowDeclines: true });
    expect(info.spots.map((s) => [s.bookingId, s.status, s.declineNote])).toEqual([
      [fri.id, 'declined', 'Sick'],
      [sat.id, 'not_sent', ''],
    ]);
    expect(t.db.select().from(tokens).where(eq(tokens.purpose, 'confirm')).get()!.lastUsedAt).toBe(NOW.getTime());

    // Confirming the rest leaves the declined spot alone.
    const confirmed = await readJson<ConfirmLinkResult>(await anonymous(`/api/portal/confirm/${token}`));
    expect(confirmed.confirmedCount).toBe(1);
    expect(confirmed.spots.map((s) => s.status)).toEqual(['declined', 'confirmed']);

    const undone = await t.request(`/api/portal/confirm/${token}/spots/${fri.id}/decline`, { method: 'DELETE' });
    expect(undone.status).toBe(200);
    expect((await readJson<ConfirmLinkInfo>(undone)).spots[0]).toMatchObject({ status: 'not_sent', declinedAt: null });
  });

  it("404s spots outside the link's week or someone else's, honours declines_off, and rejects bad tokens", async () => {
    const { fri, nextWeek, token } = setup();
    const other = createComedian(t.db);
    const othersSpot = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-13' }).id, comedianId: other.id });
    for (const id of [nextWeek.id, othersSpot.id]) {
      const res = await post(`/api/portal/confirm/${token}/spots/${id}/decline`, {}, undefined);
      expect(res.status).toBe(404);
    }

    const expired = tokenFromUrl(createConfirmLink(t.db, john.id, '2026-10-26'));
    expect((await post(`/api/portal/confirm/${expired}/spots/${fri.id}/decline`, {}, undefined)).status).toBe(410);
    expect((await post(`/api/portal/confirm/nope/spots/${fri.id}/decline`, {}, undefined)).status).toBe(404);

    updateSettings(t.db, { allowDeclines: false });
    const off = await post(`/api/portal/confirm/${token}/spots/${fri.id}/decline`, {}, undefined);
    expect(off.status).toBe(409);
    expect(await readJson(off)).toMatchObject({ code: 'declines_off' });
    for (const b of [fri, nextWeek, othersSpot]) expect(bookingRow(b.id).declinedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ⚠ markers follow availability edits
// ---------------------------------------------------------------------------

describe('PUT /api/portal/availability re-evaluates booked-anyway markers', () => {
  it('flags spots on nights the comedian no longer covers and clears ones they now cover', async () => {
    // Booked 9 PM Fri while marked 7–11 PM (fine); booked anyway 11 PM Sat (not marked).
    createAvailability(t.db, { comedianId: john.id, date: '2026-11-13', startMin: 1140, endMin: 1380 });
    const fri = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-13', startMin: 1260 }).id, comedianId: john.id });
    const sat = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-14', startMin: 1380 }).id,
      comedianId: john.id,
      overrideUnavailable: true,
    });
    // A past night and another month are left alone.
    const past = createBooking(t.db, {
      showId: createShow(t.db, { date: '2026-11-03', startMin: 1260 }).id,
      comedianId: john.id,
      overrideUnavailable: true,
    });
    const december = createBooking(t.db, { showId: createShow(t.db, { date: '2026-12-04', startMin: 1260 }).id, comedianId: john.id });
    const other = createComedian(t.db);
    const othersSpot = createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-13', startMin: 1260 }).id, comedianId: other.id });

    const res = await put('/api/portal/availability', {
      month: '2026-11',
      entries: [
        { date: '2026-11-03', startMin: 1140, endMin: 1380 }, // past: ignored
        { date: '2026-11-13', startMin: 1140, endMin: 1200 }, // now only 7–8 PM: the 9 PM spot no longer fits
        { date: '2026-11-14', startMin: 1320, endMin: 1560 }, // now 10 PM–2 AM: the 11 PM spot fits
      ],
    });
    expect(res.status).toBe(200);
    expect(bookingRow(fri.id).overrideUnavailable).toBe(true);
    expect(bookingRow(sat.id).overrideUnavailable).toBe(false);
    expect(bookingRow(past.id).overrideUnavailable).toBe(true);
    expect(bookingRow(december.id).overrideUnavailable).toBe(false);
    expect(bookingRow(othersSpot.id).overrideUnavailable).toBe(false);

    // Clearing the month flags every remaining spot in it.
    await put('/api/portal/availability', { month: '2026-11', entries: [] });
    expect(bookingRow(sat.id).overrideUnavailable).toBe(true);
  });
});
