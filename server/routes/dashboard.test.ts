import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AvailabilityRequestPreview,
  AvailabilityRequestSummary,
  CreateAvailabilityRequestResponse,
  DashboardResponse,
  ResendConfirmationResponse,
  SendConfirmationsResponse,
} from '../../shared/api/dashboard';
import { addDays, weekStartOf } from '../../shared/time';
import type { DayResponse } from '../../shared/api/lineup';
import type { MagicLinkResponse } from '../../shared/types';
import { availabilityRequests, bookings, jobRuns, tokens, type Comedian, type LocationRow } from '../db/schema';
import { clubNight, clubToday, updateSettings } from '../lib/settings';
import { buildDashboard } from '../services/dashboard';
import { confirmationsJobKey, runSchedulerTick } from '../services/scheduler';
import {
  createBooking,
  createComedian,
  createLocation,
  createShow,
  createSubmission,
  createTag,
  createUser,
  emailsTo,
  loginAsBooker,
  makeTestApp,
  readJson,
  tagComedian,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';

let t: TestApp;
let headers: AuthHeaders;

beforeEach(async () => {
  t = makeTestApp();
  ({ headers } = await loginAsBooker(t, { role: 'booker', name: 'Marco Bellini' }));
});

afterEach(() => {
  t.close();
});

describe('auth', () => {
  it('every endpoint requires a booker', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/dashboard'],
      ['POST', '/api/confirmations/send', { weekStart: '2026-11-02' }],
      ['POST', '/api/confirmations/resend', { comedianId: 1, weekStart: '2026-11-02' }],
      ['POST', '/api/availability-requests', { month: '2026-12' }],
      ['GET', '/api/availability-requests'],
      ['GET', '/api/availability-requests/preview?month=2026-12'],
    ];
    for (const [method, path, json] of calls) {
      expect((await t.request(path, { method, json })).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Dashboard payload
// ---------------------------------------------------------------------------

describe('buildDashboard', () => {
  /** Wed 2026-11-04, 12:00 PM in New York. Week: Mon Nov 2 → Sun Nov 8. */
  const NOW = new Date('2026-11-04T17:00:00Z');
  const EARLIER = NOW.getTime() - 86_400_000;
  let cellar: LocationRow;
  let annex: LocationRow;
  let john: Comedian;
  let maria: Comedian;
  let priya: Comedian;
  let devon: Comedian;
  let wes: Comedian;
  let ids: Record<string, number>;

  beforeEach(() => {
    cellar = createLocation(t.db, { name: 'The Cellar', address: '214 Sullivan St', color: '#7c5cff', sortOrder: 0 });
    annex = createLocation(t.db, { name: 'The Annex', address: '216 Sullivan St', color: '#f08c2e', sortOrder: 1 });
    john = createComedian(t.db, { name: 'John Mercer', email: 'john@example.com' });
    maria = createComedian(t.db, { name: 'Maria Delgado', email: 'maria@example.com' });
    priya = createComedian(t.db, { name: 'Priya Raman', email: 'priya@example.com' });
    devon = createComedian(t.db, { name: 'Devon Hayes', email: 'devon@example.com' });
    wes = createComedian(t.db, { name: 'Wes Calloway', email: 'wes@example.com', archived: true });

    const show = (date: string, startMin: number, location: LocationRow, extra: Parameters<typeof createShow>[1] = {}) =>
      createShow(t.db, { date, startMin, locationId: location.id, slotCount: 5, ...extra });

    const monday = show('2026-11-02', 1200, cellar);
    const early = show('2026-11-04', 1140, cellar, { name: 'Early Show' });
    const annexEarly = show('2026-11-04', 1140, annex, { slotCount: 4 });
    const late = show('2026-11-04', 1260, annex, { name: 'Late Show', slotCount: 6 });
    const cancelled = show('2026-11-04', 1320, cellar, { status: 'cancelled' });
    const thursday = show('2026-11-05', 1200, cellar);
    const sunday = show('2026-11-08', 1200, annex);
    const nextWeek = show('2026-11-09', 1200, cellar);

    createBooking(t.db, { showId: monday.id, comedianId: maria.id, confirmedAt: EARLIER - 5000 });
    createBooking(t.db, { showId: monday.id, comedianId: john.id, confirmationSentAt: EARLIER - 9000 });
    const priyaEarly = createBooking(t.db, { showId: early.id, comedianId: priya.id, position: 0 });
    const mariaEarly = createBooking(t.db, {
      showId: early.id,
      comedianId: maria.id,
      position: 1,
      confirmedAt: EARLIER,
      confirmedBy: 'comedian',
      confirmationSentAt: EARLIER - 1000,
    });
    const devonAnnex = createBooking(t.db, { showId: annexEarly.id, comedianId: devon.id, overrideUnavailable: true });
    const johnLate = createBooking(t.db, { showId: late.id, comedianId: john.id, confirmationSentAt: EARLIER });
    createBooking(t.db, { showId: cancelled.id, comedianId: devon.id });
    createBooking(t.db, { showId: thursday.id, comedianId: john.id, confirmationSentAt: EARLIER });
    createBooking(t.db, { showId: sunday.id, comedianId: priya.id, confirmationSentAt: EARLIER + 1000 });
    createBooking(t.db, { showId: nextWeek.id, comedianId: wes.id, confirmationSentAt: NOW.getTime() });

    ids = {
      early: early.id,
      annexEarly: annexEarly.id,
      late: late.id,
      cancelled: cancelled.id,
      thursday: thursday.id,
      priyaEarly: priyaEarly.id,
      mariaEarly: mariaEarly.id,
      devonAnnex: devonAnnex.id,
      johnLate: johnLate.id,
    };
  });

  it('lists the unconfirmed bookings on tonight’s scheduled shows, by time then location', () => {
    const d = buildDashboard(t.db, NOW);
    expect(d.today).toBe('2026-11-04');
    expect(d.nowMin).toBe(720);
    expect(d.emailConfigured).toBe(false);
    expect(d.unconfirmedTonight).toEqual([
      {
        bookingId: ids.priyaEarly,
        showId: ids.early,
        comedianId: priya.id,
        comedianName: 'Priya Raman',
        comedianEmail: 'priya@example.com',
        comedianArchived: false,
        startMin: 1140,
        showName: 'Early Show',
        location: { id: cellar.id, name: 'The Cellar', address: '214 Sullivan St', color: '#7c5cff' },
        confirmationSentAt: null,
      },
      expect.objectContaining({ bookingId: ids.devonAnnex, comedianName: 'Devon Hayes', startMin: 1140 }),
      expect.objectContaining({
        bookingId: ids.johnLate,
        comedianName: 'John Mercer',
        startMin: 1260,
        showName: 'Late Show',
        confirmationSentAt: EARLIER,
      }),
    ]);
    expect(d.unconfirmedTonight[1]!.location.name).toBe('The Annex');
  });

  it("lists tonight's shows with lineups in slot order and status colors, cancelled last", () => {
    const d = buildDashboard(t.db, NOW);
    expect(d.tonight.map((s) => [s.id, s.status])).toEqual([
      [ids.early, 'scheduled'],
      [ids.annexEarly, 'scheduled'],
      [ids.late, 'scheduled'],
      [ids.cancelled, 'cancelled'],
    ]);
    const early = d.tonight[0]!;
    expect(early).toMatchObject({ name: 'Early Show', startMin: 1140, slotCount: 5, bookedCount: 2, confirmedCount: 1 });
    expect(early.bookings).toEqual([
      {
        id: ids.priyaEarly,
        position: 0,
        comedianId: priya.id,
        comedianName: 'Priya Raman',
        status: 'unconfirmed_today',
        overrideUnavailable: false,
      },
      expect.objectContaining({ id: ids.mariaEarly, position: 1, status: 'confirmed' }),
    ]);
    expect(d.tonight[1]!.bookings[0]).toMatchObject({ comedianName: 'Devon Hayes', overrideUnavailable: true });
  });

  it('summarizes this week (Mon–Sun) and the confirmation schedule', () => {
    // This week's automatic send already ran on Monday, so the next one is next Monday.
    t.db.insert(jobRuns).values({ key: confirmationsJobKey('2026-11-02'), ranAt: EARLIER }).run();
    const { week } = buildDashboard(t.db, NOW);
    expect(week.weekStart).toBe('2026-11-02');
    expect(week.weekEnd).toBe('2026-11-08');
    expect(week.days.map((d) => d.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
    expect(week.days[0]).toEqual({
      date: '2026-11-02',
      shows: 1,
      slots: 5,
      booked: 2,
      openSlots: 3,
      confirmed: 1,
      unconfirmed: 1,
      declined: 0,
    });
    // Wednesday: three scheduled shows (the cancelled one doesn't count).
    expect(week.days[2]).toEqual({
      date: '2026-11-04',
      shows: 3,
      slots: 15,
      booked: 4,
      openSlots: 11,
      confirmed: 1,
      unconfirmed: 3,
      declined: 0,
    });
    expect(week.days[1]).toMatchObject({ shows: 0, slots: 0, booked: 0 });
    // Today → Sunday only.
    expect(week.remaining).toEqual({ confirmed: 1, unconfirmed_today: 3, awaiting: 2, not_sent: 0, declined: 0 });
    expect(week.confirmations).toEqual({
      enabled: true,
      day: 1,
      timeMin: 600,
      lastSentAt: EARLIER + 1000,
      nextSend: {
        date: '2026-11-09',
        startMin: 600,
        at: new Date('2026-11-09T15:00:00Z').getTime(),
        weekStart: '2026-11-09',
      },
      pendingComedians: 3, // Priya, Devon, John (Maria is all confirmed)
      unsentComedians: 2, // Priya and Devon have spots never emailed
      unsentBookings: 2, // Priya's and Devon's spots tonight
      catchUpEnabled: true,
    });
  });

  it('reports next automatic send as off when disabled', () => {
    updateSettings(t.db, { confirmationsEnabled: false });
    expect(buildDashboard(t.db, NOW).week.confirmations).toMatchObject({ enabled: false, nextSend: null });
  });

  it('uses the club timezone and the club *night* for "today" (until 6 AM it is still last night)', () => {
    // 11:30 PM Wednesday in New York is already Thursday in UTC.
    const lateNight = buildDashboard(t.db, new Date('2026-11-05T04:30:00Z'));
    expect(lateNight.today).toBe('2026-11-04');
    expect(lateNight.nowMin).toBe(23 * 60 + 30);
    expect(lateNight.unconfirmedTonight).toHaveLength(3);

    // 12:30 AM Thursday: still Wednesday night — its late shows stay on the dashboard, red.
    const afterMidnight = buildDashboard(t.db, new Date('2026-11-05T05:30:00Z'));
    expect(afterMidnight.today).toBe('2026-11-04');
    expect(afterMidnight.tonight.map((s) => s.id)).toEqual([ids.early, ids.annexEarly, ids.late, ids.cancelled]);
    expect(afterMidnight.unconfirmedTonight).toHaveLength(3);
    expect(afterMidnight.tonight[2]!.bookings.map((b) => b.status)).toEqual(['unconfirmed_today']);

    // 6 AM Thursday: a new night; Thursday's show is tonight.
    const morning = buildDashboard(t.db, new Date('2026-11-05T11:00:00Z'));
    expect(morning.today).toBe('2026-11-05');
    expect(morning.tonight.map((s) => s.id)).toEqual([ids.thursday]);
    expect(morning.unconfirmedTonight.map((r) => r.comedianName)).toEqual(['John Mercer']);

    // 5:30 AM Thursday in New York is 2:30 AM in Los Angeles: still Wednesday night there.
    updateSettings(t.db, { timezone: 'America/Los_Angeles' });
    const la = buildDashboard(t.db, new Date('2026-11-05T10:30:00Z'));
    expect(la.today).toBe('2026-11-04');
    expect(la.unconfirmedTonight).toHaveLength(3);
  });

  it('shows availability progress for this month and next, per audience, with the latest requests', () => {
    const hosts = createTag(t.db, { name: 'Hosts', color: '#3b82f6' });
    const all = createTag(t.db, { name: 'All Stars', color: '#d946ef' });
    for (const c of [john, maria, wes]) tagComedian(t.db, c.id, hosts.id);
    for (const c of [john, maria, priya, devon]) createSubmission(t.db, c.id, '2026-11');
    createSubmission(t.db, wes.id, '2026-11');
    createSubmission(t.db, priya.id, '2026-12');
    const sender = createUser(t.db, { name: 'Dana Whitfield' });
    t.db.insert(availabilityRequests)
      .values([
        { month: '2026-12', kind: 'request', audience: 'all', recipientCount: 4, sentById: sender.id, sentAt: EARLIER - 5000, message: 'Holidays!' },
        { month: '2026-12', kind: 'reminder', audience: `tag:${hosts.id}`, recipientCount: 2, sentById: null, sentAt: EARLIER },
        { month: '2026-12', kind: 'request', audience: 'all', recipientCount: 1, sentById: sender.id, sentAt: EARLIER - 9000 },
      ])
      .run();

    const d = buildDashboard(t.db, NOW);
    expect(d.planningMonth).toBe('2026-11');
    expect(d.availability.map((m) => m.month)).toEqual(['2026-11', '2026-12']);
    expect(d.tags.map((tag) => tag.name)).toEqual(['All Stars', 'Hosts']);
    const [nov, dec] = d.availability;
    expect(nov).toMatchObject({ month: '2026-11', total: 4, submitted: 4, notSubmitted: 0, lastRequest: null, lastReminder: null });
    expect(dec).toMatchObject({ month: '2026-12', total: 4, submitted: 1, notSubmitted: 3 });
    expect(dec!.audiences).toEqual([
      { audience: 'all', label: 'Everyone', color: null, total: 4, submitted: 1 },
      { audience: `tag:${all.id}`, label: 'All Stars', color: '#d946ef', total: 0, submitted: 0 },
      { audience: `tag:${hosts.id}`, label: 'Hosts', color: '#3b82f6', total: 2, submitted: 0 },
    ]);
    expect(dec!.lastRequest).toMatchObject({
      kind: 'request',
      audience: 'all',
      audienceLabel: 'Everyone',
      message: 'Holidays!',
      recipientCount: 4,
      sentByName: 'Dana Whitfield',
    });
    expect(dec!.lastReminder).toMatchObject({ audienceLabel: 'Hosts', recipientCount: 2, sentByName: null });
  });

  it('keeps after-midnight shows on the dashboard, red, until 6 AM (correctness#3)', () => {
    // A 1 AM show "on" Wednesday night (startMin 1500 = Thu 1:00 AM).
    const afterHours = createShow(t.db, { date: '2026-11-04', startMin: 1500, locationId: cellar.id, name: 'After Hours' });
    const late = createBooking(t.db, { showId: afterHours.id, comedianId: devon.id, confirmationSentAt: EARLIER });

    for (const at of ['2026-11-05T05:30:00Z', '2026-11-05T06:30:00Z', '2026-11-05T10:59:00Z']) {
      // 12:30 AM, 1:30 AM (the show is on stage) and 5:59 AM Thursday in New York.
      const d = buildDashboard(t.db, new Date(at));
      expect(d.today, at).toBe('2026-11-04');
      expect(d.tonight.map((s) => s.id), at).toContain(afterHours.id);
      expect(d.unconfirmedTonight.map((r) => r.bookingId), at).toContain(late.id);
      expect(d.tonight.find((s) => s.id === afterHours.id)!.bookings[0]!.status, at).toBe('unconfirmed_today');
    }

    // 6 AM: Thursday's night begins and the 1 AM show is behind us.
    const morning = buildDashboard(t.db, new Date('2026-11-05T11:00:00Z'));
    expect(morning.tonight.map((s) => s.id)).not.toContain(afterHours.id);
    expect(morning.unconfirmedTonight.map((r) => r.bookingId)).not.toContain(late.id);
  });

  it('flags archived comedians in Unconfirmed tonight instead of offering a resend (correctness#5a)', () => {
    const show = createShow(t.db, { date: '2026-11-04', startMin: 1200, locationId: cellar.id, slotCount: 3 });
    const b = createBooking(t.db, { showId: show.id, comedianId: wes.id, confirmationSentAt: EARLIER });
    const row = buildDashboard(t.db, NOW).unconfirmedTonight.find((r) => r.bookingId === b.id);
    expect(row).toMatchObject({ comedianName: 'Wes Calloway', comedianArchived: true });
    expect(buildDashboard(t.db, NOW).unconfirmedTonight.filter((r) => r.comedianArchived)).toHaveLength(1);
  });

  it('moves declined spots out of the unconfirmed counts into "Needs a replacement"', () => {
    const declinedAt = NOW.getTime() - 3_600_000;
    // Priya declines tonight's early spot; John declines Thursday's after confirming it first.
    t.db.update(bookings).set({ declinedAt, declineNote: 'Sick' }).where(eq(bookings.id, ids.priyaEarly)).run();
    const thursdayJohn = t.db.select().from(bookings).where(eq(bookings.showId, ids.thursday)).get()!;
    t.db.update(bookings)
      .set({ declinedAt: declinedAt + 1, confirmedAt: EARLIER, confirmedBy: 'comedian' })
      .where(eq(bookings.id, thursdayJohn.id))
      .run();
    // Not "needs a replacement": a past show, a cancelled show.
    const past = createShow(t.db, { date: '2026-11-03', startMin: 1200, locationId: annex.id });
    createBooking(t.db, { showId: past.id, comedianId: maria.id, declinedAt });
    createBooking(t.db, { showId: ids.cancelled, comedianId: john.id, declinedAt });
    // Next week still needs a replacement.
    const later = createShow(t.db, { date: '2026-11-12', startMin: 1260, locationId: annex.id, name: 'Late' });
    const laterDecline = createBooking(t.db, { showId: later.id, comedianId: devon.id, position: 2, declinedAt });

    const d = buildDashboard(t.db, NOW);
    expect(d.unconfirmedTonight.map((r) => r.bookingId)).toEqual([ids.devonAnnex, ids.johnLate]);
    expect(d.needsReplacement).toEqual([
      {
        bookingId: ids.priyaEarly,
        showId: ids.early,
        date: '2026-11-04',
        startMin: 1140,
        showName: 'Early Show',
        location: { id: cellar.id, name: 'The Cellar', address: '214 Sullivan St', color: '#7c5cff' },
        position: 0,
        comedianId: priya.id,
        comedianName: 'Priya Raman',
        declinedAt,
        declineNote: 'Sick',
      },
      expect.objectContaining({ bookingId: thursdayJohn.id, date: '2026-11-05', comedianName: 'John Mercer', declineNote: '' }),
      expect.objectContaining({ bookingId: laterDecline.id, date: '2026-11-12', position: 2, showName: 'Late' }),
    ]);

    const early = d.tonight.find((s) => s.id === ids.early)!;
    expect(early.bookings.map((b) => b.status)).toEqual(['declined', 'confirmed']);
    expect(early).toMatchObject({ bookedCount: 2, confirmedCount: 1 });

    // Wednesday: Priya no longer counts as unconfirmed; Thursday's confirmed-then-declined spot isn't confirmed.
    expect(d.week.days[2]).toMatchObject({ booked: 4, confirmed: 1, unconfirmed: 2, declined: 1 });
    expect(d.week.days[3]).toMatchObject({ booked: 1, confirmed: 0, unconfirmed: 0, declined: 1 });
    expect(d.week.remaining).toEqual({ confirmed: 1, unconfirmed_today: 2, awaiting: 1, not_sent: 0, declined: 2 });
    // Priya's declined spot is no longer "never emailed".
    expect(d.week.confirmations.unsentBookings).toBe(1);
  });

  it('counts this week’s never-emailed spots from tonight to Sunday for the catch-up nudge', () => {
    // Already counted: Priya (tonight) and Devon (tonight). Add a mix around them.
    const friday = createShow(t.db, { date: '2026-11-06', startMin: 1200, locationId: cellar.id, slotCount: 8 });
    createBooking(t.db, { showId: friday.id, comedianId: john.id }); // counts
    createBooking(t.db, { showId: friday.id, comedianId: maria.id }); // counts
    createBooking(t.db, { showId: friday.id, comedianId: priya.id, confirmationSentAt: EARLIER }); // emailed
    createBooking(t.db, { showId: friday.id, comedianId: devon.id, confirmedAt: EARLIER, confirmedBy: 'booker' }); // confirmed
    createBooking(t.db, { showId: friday.id, comedianId: wes.id }); // archived: never emailed
    const fridayCancelled = createShow(t.db, { date: '2026-11-06', startMin: 1320, locationId: annex.id, status: 'cancelled' });
    createBooking(t.db, { showId: fridayCancelled.id, comedianId: john.id }); // cancelled show
    const tuesday = createShow(t.db, { date: '2026-11-03', startMin: 1200, locationId: annex.id });
    createBooking(t.db, { showId: tuesday.id, comedianId: john.id }); // already past
    const nextWeek = createShow(t.db, { date: '2026-11-10', startMin: 1200, locationId: annex.id });
    createBooking(t.db, { showId: nextWeek.id, comedianId: john.id }); // next week

    const { confirmations } = buildDashboard(t.db, NOW).week;
    expect(confirmations.unsentBookings).toBe(4);
    expect(confirmations.catchUpEnabled).toBe(true);

    updateSettings(t.db, { catchUpEnabled: false });
    expect(buildDashboard(t.db, NOW).week.confirmations.catchUpEnabled).toBe(false);
  });

  it('shows this month, the planning month and the month after it (ux#B8)', () => {
    // Oct 30: planning November → October, November, December.
    const oct30 = buildDashboard(t.db, new Date('2026-10-30T16:00:00Z'));
    expect(oct30.planningMonth).toBe('2026-11');
    expect(oct30.availability.map((m) => m.month)).toEqual(['2026-10', '2026-11', '2026-12']);
    // Oct 5: still planning October → October, November.
    const oct5 = buildDashboard(t.db, new Date('2026-10-05T16:00:00Z'));
    expect(oct5.planningMonth).toBe('2026-10');
    expect(oct5.availability.map((m) => m.month)).toEqual(['2026-10', '2026-11']);
    // Dec 20 → December, January, February (year wraps).
    const dec20 = buildDashboard(t.db, new Date('2026-12-20T16:00:00Z'));
    expect(dec20.planningMonth).toBe('2027-01');
    expect(dec20.availability.map((m) => m.month)).toEqual(['2026-12', '2027-01', '2027-02']);
    // Months follow the calendar date, not the club night: 1 AM Nov 20 already plans December.
    const earlyNov20 = buildDashboard(t.db, new Date('2026-11-20T06:00:00Z'));
    expect(earlyNov20.today).toBe('2026-11-19');
    expect(earlyNov20.planningMonth).toBe('2026-12');
  });

  it('reports the new-club checklist counts (ux#B12)', () => {
    expect(buildDashboard(t.db, NOW).setup).toEqual({ locations: 2, comedians: 4, shows: 8, availabilityRequests: 0 });
    createLocation(t.db, { name: 'Old Room', archived: true });
    t.db.insert(availabilityRequests).values({ month: '2026-12', kind: 'request', audience: 'all', recipientCount: 4 }).run();
    expect(buildDashboard(t.db, NOW).setup).toEqual({ locations: 2, comedians: 4, shows: 8, availabilityRequests: 1 });
  });
});

describe('a brand-new club', () => {
  it('has nothing to show yet and an empty checklist', () => {
    const fresh = makeTestApp();
    try {
      const d = buildDashboard(fresh.db, new Date('2026-11-04T17:00:00Z'));
      expect(d.setup).toEqual({ locations: 0, comedians: 0, shows: 0, availabilityRequests: 0 });
      expect(d.tonight).toEqual([]);
      expect(d.unconfirmedTonight).toEqual([]);
      expect(d.needsReplacement).toEqual([]);
      expect(d.week.confirmations).toMatchObject({ pendingComedians: 0, unsentBookings: 0 });
      expect(d.availability.map((m) => [m.month, m.total])).toEqual([
        ['2026-11', 0],
        ['2026-12', 0],
      ]);
    } finally {
      fresh.close();
    }
  });
});

describe('GET /api/dashboard', () => {
  it('returns the payload for tonight in the club', async () => {
    const today = clubNight(t.db);
    const show = createShow(t.db, { date: today, startMin: 1140 });
    const comedian = createComedian(t.db, { name: 'John Mercer' });
    createBooking(t.db, { showId: show.id, comedianId: comedian.id });

    const res = await t.request('/api/dashboard', { headers });
    expect(res.status).toBe(200);
    const body = await readJson<DashboardResponse>(res);
    expect(body.today).toBe(today);
    expect(body.week.weekStart).toBe(weekStartOf(today));
    expect(body.unconfirmedTonight.map((r) => r.comedianName)).toEqual(['John Mercer']);
    expect(body.tonight).toHaveLength(1);
    expect(body.availability.map((m) => m.month)).toContain(body.planningMonth);
  });
});

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

/**
 * Wed Nov 4, 2026, noon in New York. Sends only list spots that haven't started, so tests that
 * book "tonight" pin the clock instead of failing when run in the evening.
 */
function pinClockToWednesdayNoon() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T17:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

describe('POST /api/confirmations/send', () => {
  pinClockToWednesdayNoon();

  it('emails comedians with unconfirmed spots this week; onlyUnsent skips those already emailed', async () => {
    const today = clubToday(t.db);
    const weekStart = weekStartOf(today);
    const show = createShow(t.db, { date: today, startMin: 1200 });
    const john = createComedian(t.db, { name: 'John Mercer', email: 'john@example.com' });
    const maria = createComedian(t.db, { name: 'Maria Delgado', email: 'maria@example.com' });
    const keisha = createComedian(t.db, { name: 'Keisha Grant', email: 'keisha@example.com' });
    createBooking(t.db, { showId: show.id, comedianId: john.id });
    createBooking(t.db, { showId: show.id, comedianId: maria.id, confirmationSentAt: Date.now() - 1000 });
    createBooking(t.db, { showId: show.id, comedianId: keisha.id, confirmedAt: Date.now() - 1000 });

    const unsentOnly = await t.request('/api/confirmations/send', {
      method: 'POST',
      headers,
      json: { weekStart, onlyUnsent: true },
    });
    expect(unsentOnly.status).toBe(200);
    expect(await readJson<SendConfirmationsResponse>(unsentOnly)).toEqual({
      weekStart,
      sent: 1,
      failed: 0,
      comedianIds: [john.id],
    });

    const all = await t.request('/api/confirmations/send', { method: 'POST', headers, json: { weekStart } });
    expect((await readJson<SendConfirmationsResponse>(all)).comedianIds).toEqual([john.id, maria.id]);
    expect(emailsTo(t.db, 'john@example.com')).toHaveLength(2);
    expect(emailsTo(t.db, 'maria@example.com')).toHaveLength(1);
    expect(emailsTo(t.db, 'keisha@example.com')).toHaveLength(0);
  });

  it('validates weekStart', async () => {
    for (const weekStart of ['2026-11-03', 'nope', '2026-02-30']) {
      const res = await t.request('/api/confirmations/send', { method: 'POST', headers, json: { weekStart } });
      expect(res.status).toBe(400);
    }
  });
});

describe('POST /api/confirmations/resend', () => {
  pinClockToWednesdayNoon();

  it("resends one comedian's confirmation for the week", async () => {
    const today = clubToday(t.db);
    const weekStart = weekStartOf(today);
    const john = createComedian(t.db, { name: 'John Mercer', email: 'john@example.com' });
    const tonight = createShow(t.db, { date: today, startMin: 1140, name: 'Early Show' });
    const b = createBooking(t.db, { showId: tonight.id, comedianId: john.id, confirmationSentAt: 1 });

    const res = await t.request('/api/confirmations/resend', {
      method: 'POST',
      headers,
      json: { comedianId: john.id, weekStart },
    });
    expect(res.status).toBe(200);
    expect(await readJson<ResendConfirmationResponse>(res)).toEqual({ status: 'outbox', bookingCount: 1 });
    const mail = emailsTo(t.db, 'john@example.com')[0]!;
    expect(mail.kind).toBe('confirmation');
    expect(mail.bodyText).toContain('Early Show');
    expect(t.db.select().from(bookings).where(eq(bookings.id, b.id)).get()!.confirmationSentAt).toBeGreaterThan(1);

    // Once confirmed there is nothing to resend.
    t.db.update(bookings).set({ confirmedAt: Date.now(), confirmedBy: 'comedian' }).run();
    const skipped = await t.request('/api/confirmations/resend', {
      method: 'POST',
      headers,
      json: { comedianId: john.id, weekStart },
    });
    expect(await readJson(skipped)).toEqual({ status: 'skipped', bookingCount: 0 });
  });

  it('says "archived" (and sends nothing) for an archived comedian (correctness#5a)', async () => {
    const today = clubToday(t.db);
    const wes = createComedian(t.db, { name: 'Wes Calloway', email: 'wes@example.com', archived: true });
    const tonight = createShow(t.db, { date: today, startMin: 1140 });
    const b = createBooking(t.db, { showId: tonight.id, comedianId: wes.id, confirmationSentAt: 1 });

    const res = await t.request('/api/confirmations/resend', {
      method: 'POST',
      headers,
      json: { comedianId: wes.id, weekStart: weekStartOf(today) },
    });
    expect(res.status).toBe(200);
    expect(await readJson<ResendConfirmationResponse>(res)).toEqual({ status: 'archived', bookingCount: 0 });
    expect(emailsTo(t.db, 'wes@example.com')).toHaveLength(0);
    expect(t.db.select().from(bookings).where(eq(bookings.id, b.id)).get()!.confirmationSentAt).toBe(1);
  });

  it('404s for an unknown comedian and validates input', async () => {
    const weekStart = weekStartOf(clubToday(t.db));
    const missing = await t.request('/api/confirmations/resend', {
      method: 'POST',
      headers,
      json: { comedianId: 999, weekStart },
    });
    expect(missing.status).toBe(404);
    const bad = await t.request('/api/confirmations/resend', {
      method: 'POST',
      headers,
      json: { comedianId: 1, weekStart: addDays(weekStart, 1) },
    });
    expect(bad.status).toBe(400);
  });
});

describe('after midnight: one club night for tonight, Resend and the catch-up nudge', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T05:30:00Z')); // Sat Nov 7, 12:30 AM in New York
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Resend for a Friday-night 1 AM spot still emails it', async () => {
    const lena = createComedian(t.db, { name: 'Lena Late', email: 'lena@example.com' });
    const late = createShow(t.db, { date: '2026-11-06', startMin: 1500 });
    createBooking(t.db, { showId: late.id, comedianId: lena.id, confirmationSentAt: 1 });

    const dash = await readJson<DashboardResponse>(await t.request('/api/dashboard', { headers }));
    expect(dash.unconfirmedTonight.map((r) => r.comedianName)).toEqual(['Lena Late']);
    const res = await t.request('/api/confirmations/resend', {
      method: 'POST',
      headers,
      json: { comedianId: lena.id, weekStart: dash.week.weekStart },
    });
    expect(await readJson<ResendConfirmationResponse>(res)).toEqual({ status: 'outbox', bookingCount: 1 });
    expect(emailsTo(t.db, 'lena@example.com')[0]!.bodyText).toContain('1 AM (early Sat, Nov 7)');
  });

  it('the dashboard nudge, the day board and Send agree, so Send clears the nudge', async () => {
    const [john, maria, keisha] = ['john', 'maria', 'keisha'].map((n) => createComedian(t.db, { email: `${n}@example.com` }));
    // Never emailed: Friday 9 PM (already played), Friday's 1 AM show (ahead) and Saturday 8 PM.
    createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-06', startMin: 1260 }).id, comedianId: john!.id });
    createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-06', startMin: 1500 }).id, comedianId: maria!.id });
    createBooking(t.db, { showId: createShow(t.db, { date: '2026-11-07', startMin: 1200 }).id, comedianId: keisha!.id });

    const nudges = async () => {
      const dash = await readJson<DashboardResponse>(await t.request('/api/dashboard', { headers }));
      const day = await readJson<DayResponse>(await t.request('/api/days/2026-11-07', { headers }));
      return [dash.week.confirmations.unsentBookings, day.unsentThisWeek.count];
    };
    expect(await nudges()).toEqual([2, 2]);

    const send = await t.request('/api/confirmations/send', {
      method: 'POST',
      headers,
      json: { weekStart: '2026-11-02', onlyUnsent: true },
    });
    expect((await readJson<SendConfirmationsResponse>(send)).comedianIds.sort()).toEqual([maria!.id, keisha!.id].sort());
    expect(emailsTo(t.db, 'john@example.com')).toHaveLength(0);
    expect(await nudges()).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Availability requests
// ---------------------------------------------------------------------------

describe('availability requests', () => {
  let john: Comedian;
  let maria: Comedian;
  let priya: Comedian;
  let hostsId: number;

  beforeEach(() => {
    john = createComedian(t.db, { name: 'John Mercer', email: 'john@example.com' });
    maria = createComedian(t.db, { name: 'Maria Delgado', email: 'maria@example.com' });
    priya = createComedian(t.db, { name: 'Priya Raman', email: 'priya@example.com' });
    createComedian(t.db, { name: 'Wes Calloway', email: 'wes@example.com', archived: true });
    const hosts = createTag(t.db, { name: 'Hosts' });
    hostsId = hosts.id;
    tagComedian(t.db, john.id, hosts.id);
    tagComedian(t.db, maria.id, hosts.id);
  });

  async function send(json: Record<string, unknown>) {
    return t.request('/api/availability-requests', { method: 'POST', headers, json });
  }

  it('blasts everyone (non-archived) with a magic link to that month in the portal', async () => {
    const res = await send({ month: '2026-12', audience: 'all', message: 'Holiday shows are filling up!' });
    expect(res.status).toBe(201);
    const body = await readJson<CreateAvailabilityRequestResponse>(res);
    expect(body).toMatchObject({
      recipientCount: 3,
      sent: 3,
      failed: 0,
      request: {
        month: '2026-12',
        kind: 'request',
        audience: 'all',
        audienceLabel: 'Everyone',
        message: 'Holiday shows are filling up!',
        recipientCount: 3,
        sentByName: 'Marco Bellini',
      },
    });
    expect(emailsTo(t.db, 'wes@example.com')).toHaveLength(0);

    const mail = emailsTo(t.db, 'john@example.com')[0]!;
    expect(mail).toMatchObject({ kind: 'availability_request', comedianId: john.id, status: 'outbox' });
    expect(mail.subject).toBe('Test Comedy Club is booking December — when are you free?');
    expect(mail.bodyText).toContain("Hey John — Test Comedy Club is booking December. Tell us which nights you're free:");
    expect(mail.bodyText).toContain('Holiday shows are filling up!');
    expect(mail.bodyHtml).toContain('Mark my availability');

    // The link signs John in and lands on December in the portal.
    const token = /\/portal\/magic\/([\w-]+)/.exec(mail.bodyText)?.[1];
    expect(token).toBeTruthy();
    const magic = await t.request('/api/auth/magic', { method: 'POST', json: { token } });
    expect(magic.status).toBe(200);
    expect(await readJson<MagicLinkResponse>(magic)).toMatchObject({
      redirectTo: '/portal?month=2026-12',
      comedian: { id: john.id },
    });

    const rows = t.db.select().from(availabilityRequests).all();
    expect(rows).toEqual([
      expect.objectContaining({ month: '2026-12', kind: 'request', audience: 'all', recipientCount: 3 }),
    ]);
  });

  it('sends to a tag audience only', async () => {
    const res = await send({ month: '2026-12', audience: `tag:${hostsId}` });
    const body = await readJson<CreateAvailabilityRequestResponse>(res);
    expect(body.recipientCount).toBe(2);
    expect(body.request.audienceLabel).toBe('Hosts');
    expect(emailsTo(t.db).map((m) => m.toEmail).sort()).toEqual(['john@example.com', 'maria@example.com']);
  });

  it('reminds only the audience members who have not submitted the month', async () => {
    createSubmission(t.db, john.id, '2026-12');
    createSubmission(t.db, priya.id, '2026-11'); // other month: doesn't count

    const all = await send({ month: '2026-12', kind: 'reminder' });
    expect((await readJson<CreateAvailabilityRequestResponse>(all)).recipientCount).toBe(2);
    expect(emailsTo(t.db).map((m) => m.toEmail).sort()).toEqual(['maria@example.com', 'priya@example.com']);
    const reminder = emailsTo(t.db, 'maria@example.com')[0]!;
    expect(reminder.kind).toBe('availability_reminder');
    expect(reminder.subject).toBe('Reminder: when are you free in December?');

    const hosts = await send({ month: '2026-12', kind: 'reminder', audience: `tag:${hostsId}` });
    expect((await readJson<CreateAvailabilityRequestResponse>(hosts)).recipientCount).toBe(1);

    createSubmission(t.db, maria.id, '2026-12');
    const nobody = await send({ month: '2026-12', kind: 'reminder', audience: `tag:${hostsId}` });
    expect(nobody.status).toBe(409);
    expect(await readJson(nobody)).toMatchObject({ code: 'no_recipients' });
  });

  it('rejects unknown tags and bad input', async () => {
    const unknown = await send({ month: '2026-12', audience: 'tag:999' });
    expect(unknown.status).toBe(400);
    expect(await readJson(unknown)).toMatchObject({ code: 'unknown_tag' });
    for (const json of [{ month: '2026-13' }, { month: '2026-12', audience: 'everyone' }, { month: '2026-12', kind: 'nag' }]) {
      expect((await send(json)).status).toBe(400);
    }
    expect((await send({ month: '2026-12', message: 'x'.repeat(1001) })).status).toBe(400);
    expect(emailsTo(t.db)).toHaveLength(0);
  });

  it('lists requests newest first, optionally by month', async () => {
    await send({ month: '2026-12' });
    await send({ month: '2026-12', kind: 'reminder' });
    await send({ month: '2027-01' });
    const res = await t.request('/api/availability-requests?month=2026-12', { headers });
    const list = await readJson<AvailabilityRequestSummary[]>(res);
    expect(list.map((r) => r.kind)).toEqual(['reminder', 'request']);
    const everything = await readJson<AvailabilityRequestSummary[]>(
      await t.request('/api/availability-requests', { headers }),
    );
    expect(everything).toHaveLength(3);
    expect(everything[0]!.month).toBe('2027-01');
  });

  it('previews the email for the first recipient without sending or creating links', async () => {
    const res = await t.request(
      `/api/availability-requests/preview?month=2026-12&message=${encodeURIComponent('<b>Hi</b>\nSee you')}`,
      { headers },
    );
    expect(res.status).toBe(200);
    const preview = await readJson<AvailabilityRequestPreview>(res);
    expect(preview.subject).toBe('Test Comedy Club is booking December — when are you free?');
    expect(preview.sampleName).toBe('John Mercer');
    expect(preview.recipientCount).toBe(3);
    expect(preview.html).toContain('Hey John — Test Comedy Club is booking December.');
    expect(preview.html).toContain('&lt;b&gt;Hi&lt;/b&gt;<br>See you');
    expect(preview.html).toContain('http://localhost:5173/portal?month=2026-12');
    expect(preview.text).toContain('Mark my availability: http://localhost:5173/portal?month=2026-12');

    createSubmission(t.db, john.id, '2026-12');
    const reminder = await readJson<AvailabilityRequestPreview>(
      await t.request(`/api/availability-requests/preview?month=2026-12&kind=reminder&audience=tag:${hostsId}`, {
        headers,
      }),
    );
    expect(reminder.sampleName).toBe('Maria Delgado');
    expect(reminder.recipientCount).toBe(1);
    expect(reminder.subject).toBe('Reminder: when are you free in December?');

    expect(t.db.select().from(tokens).all()).toHaveLength(0);
    expect(emailsTo(t.db)).toHaveLength(0);
    expect((await t.request('/api/availability-requests/preview', { headers })).status).toBe(400);
  });
});

describe('scheduler + dashboard', () => {
  it('after the automatic send, the dashboard shows it as last sent and moves on to next week', async () => {
    const show = createShow(t.db, { date: '2026-11-10', startMin: 1140 });
    const john = createComedian(t.db, { email: 'john@example.com' });
    createBooking(t.db, { showId: show.id, comedianId: john.id });
    const sendAt = new Date('2026-11-09T15:00:00Z');
    await runSchedulerTick(t.db, { now: sendAt });
    const d = buildDashboard(t.db, new Date('2026-11-09T16:00:00Z'));
    expect(d.week.confirmations.lastSentAt).toBe(sendAt.getTime());
    expect(d.week.confirmations.nextSend?.date).toBe('2026-11-16');
    expect(d.week.remaining.awaiting).toBe(1);
  });
});
