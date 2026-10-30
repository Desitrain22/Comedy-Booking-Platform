import { ne } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, findSessionSubject } from '../auth/sessions';
import { bookings, jobRuns, sessions } from '../db/schema';
import { getSettings, updateSettings } from '../lib/settings';
import { createBooking, createComedian, createShow, emailsTo, makeTestApp, type TestApp } from '../test/helpers';
import {
  catchUpJobKey,
  confirmationsJobKey,
  createSchedulerState,
  dueCatchUpDate,
  dueConfirmationWeek,
  lastDueConfirmationSend,
  mondayOnOrAfter,
  nextConfirmationSend,
  runSchedulerTick,
  startScheduler,
} from './scheduler';

/** Instants in New York (EST, UTC-5 after Nov 1 2026). */
const at = (iso: string) => new Date(iso);
const MON_0959 = at('2026-11-09T14:59:00Z');
const MON_1000 = at('2026-11-09T15:00:00Z');
const MON_1500 = at('2026-11-09T20:00:00Z');
const TUE_1000 = at('2026-11-10T15:00:00Z');
const WED_0959 = at('2026-11-11T14:59:00Z');
const WED_1000 = at('2026-11-11T15:00:00Z');
const WED_1500 = at('2026-11-11T20:00:00Z');
const THU_1000 = at('2026-11-12T15:00:00Z');
const SUN_1000 = at('2026-11-08T15:00:00Z');
const NEXT_MON_0959 = at('2026-11-16T14:59:00Z');

let t: TestApp;

beforeEach(() => {
  t = makeTestApp();
});

afterEach(() => {
  vi.useRealTimers();
  t.close();
});

function jobKeys(): string[] {
  return t.db.select().from(jobRuns).all().map((r) => r.key);
}

/** A comedian booked on a show in the week of Mon Nov 9. */
function bookSomeone(date = '2026-11-12', email = 'john@example.com') {
  const comedian = createComedian(t.db, { name: 'John Mercer', email });
  const show = createShow(t.db, { date, startMin: 1260 });
  return createBooking(t.db, { showId: show.id, comedianId: comedian.id });
}

/** Another spot for an existing comedian. */
function bookAgain(comedianId: number, date: string, overrides: Partial<Parameters<typeof createBooking>[1]> = {}) {
  const show = createShow(t.db, { date, startMin: 1260 });
  return createBooking(t.db, { showId: show.id, comedianId, ...overrides });
}

function sentAt(bookingId: number): number | null {
  return t.db.select().from(bookings).all().find((b) => b.id === bookingId)!.confirmationSentAt;
}

describe('dueConfirmationWeek', () => {
  it('is due from the configured local weekday and time, targeting the Monday on/after that day', () => {
    const s = getSettings(t.db); // Monday 10 AM by default
    expect(dueConfirmationWeek(s, MON_0959)).toBeNull(); // last week's send: that week is over
    expect(dueConfirmationWeek(s, MON_1000)).toBe('2026-11-09');
    expect(dueConfirmationWeek(s, MON_1500)).toBe('2026-11-09');

    const thursday = { ...s, confirmationDay: 4, confirmationTimeMin: 17 * 60 };
    expect(dueConfirmationWeek(thursday, at('2026-11-05T22:00:00Z'))).toBe('2026-11-09');

    expect(dueConfirmationWeek({ ...s, confirmationsEnabled: false }, MON_1000)).toBeNull();
  });

  it('stays due for the rest of a week that is not over, so a missed send still goes out (correctness#4)', () => {
    const s = getSettings(t.db);
    // Monday 10 AM schedule: Tue … Sun still point at this week's (Monday) send.
    expect(lastDueConfirmationSend(s, TUE_1000)).toEqual({ date: '2026-11-09', weekStart: '2026-11-09' });
    expect(dueConfirmationWeek(s, SUN_1000)).toBe('2026-11-02');
    expect(dueConfirmationWeek(s, NEXT_MON_0959)).toBeNull(); // the week of Nov 9 is over

    // Thursday 5 PM schedule (sends next week): until it fires, the previous Thursday's week.
    const thursday = { ...s, confirmationDay: 4, confirmationTimeMin: 17 * 60 };
    expect(lastDueConfirmationSend(thursday, at('2026-11-05T21:59:00Z'))).toEqual({
      date: '2026-10-29',
      weekStart: '2026-11-02',
    });
    expect(lastDueConfirmationSend(thursday, at('2026-11-07T15:00:00Z'))).toEqual({
      date: '2026-11-05',
      weekStart: '2026-11-09',
    });
  });

  it('uses the club timezone', () => {
    const la = { ...getSettings(t.db), timezone: 'America/Los_Angeles' };
    expect(dueConfirmationWeek(la, MON_1000)).toBeNull(); // 7 AM Monday in LA: not yet
    expect(dueConfirmationWeek(la, at('2026-11-09T18:00:00Z'))).toBe('2026-11-09');
    // 10:30 PM Sunday in LA is already Monday in UTC: still the LA week of Nov 2.
    expect(dueConfirmationWeek(la, at('2026-11-09T06:30:00Z'))).toBe('2026-11-02');
  });

  it('the daily catch-up is due every day from the confirmation time, when both settings are on', () => {
    const s = getSettings(t.db);
    expect(s.catchUpEnabled).toBe(true);
    expect(dueCatchUpDate(s, WED_0959)).toBeNull();
    expect(dueCatchUpDate(s, WED_1000)).toBe('2026-11-11');
    expect(dueCatchUpDate(s, SUN_1000)).toBe('2026-11-08');
    expect(dueCatchUpDate({ ...s, catchUpEnabled: false }, WED_1000)).toBeNull();
    expect(dueCatchUpDate({ ...s, confirmationsEnabled: false }, WED_1000)).toBeNull();
    expect(catchUpJobKey('2026-11-11')).toBe('catch-up:2026-11-11');
  });

  it('finds the Monday on or after a date', () => {
    expect(mondayOnOrAfter('2026-11-09')).toBe('2026-11-09');
    expect(mondayOnOrAfter('2026-11-08')).toBe('2026-11-09');
    expect(mondayOnOrAfter('2026-11-05')).toBe('2026-11-09');
    expect(mondayOnOrAfter('2026-11-10')).toBe('2026-11-16');
  });
});

describe('runSchedulerTick', () => {
  it('sends the week once at the configured time, idempotently', async () => {
    const booking = bookSomeone();
    const state = createSchedulerState();

    expect((await runSchedulerTick(t.db, { now: MON_0959, state })).confirmations).toBeNull();
    expect(emailsTo(t.db)).toHaveLength(0);

    const fired = await runSchedulerTick(t.db, { now: MON_1000, state });
    expect(fired.confirmations).toEqual({
      weekStart: '2026-11-09',
      sent: 1,
      failed: 0,
      comedianIds: [booking.comedianId],
    });
    expect(emailsTo(t.db, 'john@example.com')).toHaveLength(1);
    expect(emailsTo(t.db)[0]!.kind).toBe('confirmation');
    // The daily catch-up ran too, but the weekly send had just covered this week.
    expect(fired.catchUp).toEqual({ date: '2026-11-09', weekStart: '2026-11-09', sent: 0, failed: 0, comedianIds: [] });
    expect(jobKeys()).toEqual([confirmationsJobKey('2026-11-09'), catchUpJobKey('2026-11-09')]);

    // Later ticks the same day (and a fresh process with new state) don't resend.
    expect((await runSchedulerTick(t.db, { now: MON_1500, state })).confirmations).toBeNull();
    expect((await runSchedulerTick(t.db, { now: MON_1500 })).confirmations).toBeNull();
    expect(emailsTo(t.db)).toHaveLength(1);
  });

  it('does nothing when confirmations are disabled or setup is incomplete', async () => {
    bookSomeone();
    updateSettings(t.db, { confirmationsEnabled: false });
    expect((await runSchedulerTick(t.db, { now: MON_1000 })).confirmations).toBeNull();

    updateSettings(t.db, { confirmationsEnabled: true, setupComplete: false });
    expect((await runSchedulerTick(t.db, { now: MON_1000 })).confirmations).toBeNull();
    expect(emailsTo(t.db)).toHaveLength(0);
    expect(jobKeys()).toEqual([]);
  });

  it('respects the club timezone', async () => {
    bookSomeone();
    updateSettings(t.db, { timezone: 'America/Los_Angeles' });
    expect((await runSchedulerTick(t.db, { now: MON_1000 })).confirmations).toBeNull();
    const fired = await runSchedulerTick(t.db, { now: at('2026-11-09T18:00:00Z') });
    expect(fired.confirmations?.weekStart).toBe('2026-11-09');
  });

  it('sends next week when the send day is before Monday', async () => {
    updateSettings(t.db, { confirmationDay: 4, confirmationTimeMin: 17 * 60, catchUpEnabled: false });
    bookSomeone('2026-11-12');
    const thisWeek = createShow(t.db, { date: '2026-11-06', startMin: 1200 });
    const other = createComedian(t.db, { email: 'maria@example.com' });
    createBooking(t.db, { showId: thisWeek.id, comedianId: other.id });

    const fired = await runSchedulerTick(t.db, { now: at('2026-11-05T22:00:00Z') });
    expect(fired.confirmations?.weekStart).toBe('2026-11-09');
    expect(emailsTo(t.db, 'john@example.com')[0]!.subject).toContain('next week');
    expect(emailsTo(t.db, 'maria@example.com')).toHaveLength(0);
  });

  it('a weekly send missed while the server was down goes out when it is back, that week (correctness#4)', async () => {
    const booking = bookSomeone('2026-11-12');
    const monday = bookAgain(booking.comedianId, '2026-11-09'); // already behind us by Wednesday
    // Down all Monday and Tuesday; the first tick is Wednesday morning, before the send time.
    const fired = await runSchedulerTick(t.db, { now: WED_0959 });
    expect(fired.confirmations).toMatchObject({ weekStart: '2026-11-09', sent: 1 });
    const mail = emailsTo(t.db, 'john@example.com');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toContain('this week');
    expect(mail[0]!.bodyText).toContain('Thu, Nov 12');
    expect(mail[0]!.bodyText).not.toContain('Nov 9');
    expect(sentAt(booking.id)).toBe(WED_0959.getTime());
    expect(sentAt(monday.id)).toBeNull();

    // Once only, and the catch-up later that day has nothing left to send.
    expect((await runSchedulerTick(t.db, { now: WED_1500 })).confirmations).toBeNull();
    expect(emailsTo(t.db)).toHaveLength(1);

    // A week that ended without its send is not sent after the fact.
    const late = bookSomeone('2026-11-15', 'maria@example.com');
    t.db.delete(jobRuns).run();
    updateSettings(t.db, { catchUpEnabled: false });
    expect((await runSchedulerTick(t.db, { now: NEXT_MON_0959 })).confirmations).toBeNull();
    expect(sentAt(late.id)).toBeNull();
  });

  it('a missed Thursday send for next week goes out on Saturday', async () => {
    updateSettings(t.db, { confirmationDay: 4, confirmationTimeMin: 17 * 60, catchUpEnabled: false });
    bookSomeone('2026-11-12');
    const fired = await runSchedulerTick(t.db, { now: at('2026-11-07T15:00:00Z') }); // Sat Nov 7
    expect(fired.confirmations).toMatchObject({ weekStart: '2026-11-09', sent: 1 });
    expect(emailsTo(t.db, 'john@example.com')[0]!.subject).toContain('next week');
  });

  it("doesn't re-email comedians already sent that week (onlyUnsent)", async () => {
    // e.g. the booker hit "Send confirmations now" before the scheduled time.
    bookSomeone('2026-11-12', 'john@example.com');
    const fresh = bookSomeone('2026-11-13', 'maria@example.com');
    t.db.update(bookings).set({ confirmationSentAt: MON_0959.getTime() }).where(ne(bookings.id, fresh.id)).run();

    const fired = await runSchedulerTick(t.db, { now: MON_1000 });
    expect(fired.confirmations).toMatchObject({ weekStart: '2026-11-09', sent: 1, comedianIds: [fresh.comedianId] });
    expect(emailsTo(t.db, 'john@example.com')).toHaveLength(0);
    expect(emailsTo(t.db, 'maria@example.com')).toHaveLength(1);
  });

  it("daily catch-up emails this week's never-emailed bookings at the confirmation time (ux#A1)", async () => {
    // Monday's weekly send went out to John for Thursday.
    const thursday = bookSomeone('2026-11-12');
    const john = thursday.comedianId;
    await runSchedulerTick(t.db, { now: MON_1000 });
    expect(emailsTo(t.db, 'john@example.com')).toHaveLength(1);

    // Booked after the send: John gets a Saturday spot, Maria a Friday one.
    const saturday = bookAgain(john, '2026-11-14');
    const maria = bookSomeone('2026-11-13', 'maria@example.com');
    // Not the catch-up's business: confirmed, declined, already-past, next week, archived, cancelled.
    const priya = createComedian(t.db, { email: 'priya@example.com' });
    bookAgain(priya.id, '2026-11-13', { confirmedAt: 1, confirmedBy: 'booker' });
    const declined = bookAgain(createComedian(t.db, { email: 'dev@example.com' }).id, '2026-11-13', { declinedAt: 1 });
    bookAgain(createComedian(t.db, { email: 'past@example.com' }).id, '2026-11-10');
    bookAgain(createComedian(t.db, { email: 'next@example.com' }).id, '2026-11-17');
    bookAgain(createComedian(t.db, { email: 'gone@example.com', archived: true }).id, '2026-11-13');
    const cancelledShow = createShow(t.db, { date: '2026-11-13', status: 'cancelled' });
    createBooking(t.db, { showId: cancelledShow.id, comedianId: createComedian(t.db, { email: 'off@example.com' }).id });

    // Not before the confirmation time.
    expect((await runSchedulerTick(t.db, { now: WED_0959 })).catchUp).toBeNull();

    const fired = await runSchedulerTick(t.db, { now: WED_1000 });
    expect(fired.confirmations).toBeNull();
    expect(fired.catchUp).toMatchObject({ date: '2026-11-11', weekStart: '2026-11-09', sent: 2, failed: 0 });
    expect(fired.catchUp!.comedianIds.sort()).toEqual([john, maria.comedianId].sort());
    // John's email lists his whole week (both spots); one confirm link covers it.
    const johnMail = emailsTo(t.db, 'john@example.com');
    expect(johnMail).toHaveLength(2);
    expect(johnMail[0]!.bodyText).toContain('Thu, Nov 12'); // newest first
    expect(johnMail[0]!.bodyText).toContain('Sat, Nov 14');
    expect(emailsTo(t.db, 'maria@example.com')).toHaveLength(1);
    for (const email of ['priya', 'dev', 'past', 'next', 'gone', 'off']) {
      expect(emailsTo(t.db, `${email}@example.com`), email).toHaveLength(0);
    }
    expect(sentAt(saturday.id)).toBe(WED_1000.getTime());
    expect(sentAt(maria.id)).toBe(WED_1000.getTime());
    expect(sentAt(declined.id)).toBeNull();
    expect(jobKeys()).toContain(catchUpJobKey('2026-11-11'));

    // Once a day: later today nothing; tomorrow nothing new to send.
    expect((await runSchedulerTick(t.db, { now: WED_1500 })).catchUp).toBeNull();
    const thu = await runSchedulerTick(t.db, { now: THU_1000 });
    expect(thu.catchUp).toMatchObject({ date: '2026-11-12', sent: 0 });
    expect(emailsTo(t.db)).toHaveLength(3);
  });

  it('the catch-up is off with catchUpEnabled or automatic confirmations off', async () => {
    const booking = bookSomeone('2026-11-12');
    t.db.insert(jobRuns).values({ key: confirmationsJobKey('2026-11-09'), ranAt: 1 }).run();
    updateSettings(t.db, { catchUpEnabled: false });
    expect((await runSchedulerTick(t.db, { now: WED_1000 })).catchUp).toBeNull();
    updateSettings(t.db, { catchUpEnabled: true, confirmationsEnabled: false });
    expect((await runSchedulerTick(t.db, { now: WED_1000 })).catchUp).toBeNull();
    expect(emailsTo(t.db)).toHaveLength(0);
    expect(jobKeys()).toEqual([confirmationsJobKey('2026-11-09')]);

    updateSettings(t.db, { confirmationsEnabled: true });
    expect((await runSchedulerTick(t.db, { now: WED_1000 })).catchUp).toMatchObject({ sent: 1 });
    expect(sentAt(booking.id)).toBe(WED_1000.getTime());
  });

  it('a seeded catch-up row for today means no catch-up until tomorrow', async () => {
    bookSomeone('2026-11-12');
    t.db.insert(jobRuns).values([
      { key: confirmationsJobKey('2026-11-09'), ranAt: 1 },
      { key: catchUpJobKey('2026-11-11'), ranAt: 1 },
    ]).run();
    expect((await runSchedulerTick(t.db, { now: WED_1000 })).catchUp).toBeNull();
    expect((await runSchedulerTick(t.db, { now: THU_1000 })).catchUp).toMatchObject({ date: '2026-11-12', sent: 1 });
  });

  it('declined spots are never emailed by the weekly send or the catch-up', async () => {
    const booking = bookSomeone('2026-11-12');
    t.db.update(bookings).set({ declinedAt: 1 }).run();
    const fired = await runSchedulerTick(t.db, { now: MON_1000 });
    expect(fired.confirmations).toMatchObject({ sent: 0 });
    expect((await runSchedulerTick(t.db, { now: TUE_1000 })).catchUp).toMatchObject({ sent: 0 });
    expect(emailsTo(t.db)).toHaveLength(0);
    expect(sentAt(booking.id)).toBeNull();
  });

  it('cleans up expired sessions, codes and tokens once per club-local day', async () => {
    const state = createSchedulerState();
    const live = createSession(t.db, 'booker', 1);
    const first = await runSchedulerTick(t.db, { now: SUN_1000, state });
    expect(first.cleanup).toEqual({ sessions: 0, loginCodes: 0, tokens: 0 });
    // Same club-local day: no second cleanup.
    expect((await runSchedulerTick(t.db, { now: at('2026-11-09T04:59:00Z'), state })).cleanup).toBeNull();

    // A month on, the 30-day booker session has expired and is removed.
    const later = new Date(live.expiresAt + 60_000);
    const next = await runSchedulerTick(t.db, { now: later, state });
    expect(next.cleanup?.sessions).toBe(1);
    expect(findSessionSubject(t.db, 'booker', live.token)).toBeNull();
  });
});

describe('nextConfirmationSend', () => {
  it('is the next configured weekday/time whose week has not been sent', async () => {
    // Thursday Nov 5 with nothing sent this week yet: this week's send is overdue (due now).
    const thu = at('2026-11-05T15:00:00Z');
    expect(nextConfirmationSend(t.db, thu)).toEqual({
      date: '2026-11-02',
      startMin: 600,
      at: thu.getTime(),
      weekStart: '2026-11-02',
    });
    t.db.insert(jobRuns).values({ key: confirmationsJobKey('2026-11-02'), ranAt: 1 }).run();

    expect(nextConfirmationSend(t.db, thu)).toEqual({
      date: '2026-11-09',
      startMin: 600,
      at: MON_1000.getTime(),
      weekStart: '2026-11-09',
    });
    expect(nextConfirmationSend(t.db, MON_0959)).toMatchObject({ date: '2026-11-09' });

    await runSchedulerTick(t.db, { now: MON_1000 });
    expect(nextConfirmationSend(t.db, MON_1500)).toMatchObject({ date: '2026-11-16', weekStart: '2026-11-16' });

    updateSettings(t.db, { confirmationsEnabled: false });
    expect(nextConfirmationSend(t.db, MON_1500)).toBeNull();
  });
});

describe('startScheduler', () => {
  it('ticks shortly after boot and on an interval, and stops cleanly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const expired = () =>
      t.db.insert(sessions).values({ id: `expired-${Math.random()}`, kind: 'booker', subjectId: 1, expiresAt: 1 }).run();
    const count = () => t.db.select().from(sessions).all().length;

    expired();
    const stop = startScheduler(t.db, { intervalMs: 60_000 });
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count()).toBe(0); // first tick ran the daily cleanup

    stop();
    expired();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(count()).toBe(1);
  });
});
