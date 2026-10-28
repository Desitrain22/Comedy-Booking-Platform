import { ne } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, findSessionSubject } from '../auth/sessions';
import { bookings, jobRuns, sessions } from '../db/schema';
import { getSettings, updateSettings } from '../lib/settings';
import { createBooking, createComedian, createShow, emailsTo, makeTestApp, type TestApp } from '../test/helpers';
import {
  confirmationsJobKey,
  createSchedulerState,
  dueConfirmationWeek,
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
const SUN_1000 = at('2026-11-08T15:00:00Z');

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

describe('dueConfirmationWeek', () => {
  it('is due from the configured local weekday and time, targeting the Monday on/after today', () => {
    const s = getSettings(t.db); // Monday 10 AM by default
    expect(dueConfirmationWeek(s, MON_0959)).toBeNull();
    expect(dueConfirmationWeek(s, MON_1000)).toBe('2026-11-09');
    expect(dueConfirmationWeek(s, MON_1500)).toBe('2026-11-09');
    expect(dueConfirmationWeek(s, TUE_1000)).toBeNull();
    expect(dueConfirmationWeek(s, SUN_1000)).toBeNull();

    const thursday = { ...s, confirmationDay: 4, confirmationTimeMin: 17 * 60 };
    expect(dueConfirmationWeek(thursday, at('2026-11-05T21:59:00Z'))).toBeNull();
    expect(dueConfirmationWeek(thursday, at('2026-11-05T22:00:00Z'))).toBe('2026-11-09');

    expect(dueConfirmationWeek({ ...s, confirmationsEnabled: false }, MON_1000)).toBeNull();
  });

  it('uses the club timezone', () => {
    const la = { ...getSettings(t.db), timezone: 'America/Los_Angeles' };
    expect(dueConfirmationWeek(la, MON_1000)).toBeNull(); // 7 AM in LA
    expect(dueConfirmationWeek(la, at('2026-11-09T18:00:00Z'))).toBe('2026-11-09');
    // 10:30 PM Sunday in LA is already Monday in UTC: not due.
    expect(dueConfirmationWeek(la, at('2026-11-09T06:30:00Z'))).toBeNull();
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
    expect(jobKeys()).toEqual([confirmationsJobKey('2026-11-09')]);

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
    updateSettings(t.db, { confirmationDay: 4, confirmationTimeMin: 17 * 60 });
    bookSomeone('2026-11-12');
    const thisWeek = createShow(t.db, { date: '2026-11-06', startMin: 1200 });
    const other = createComedian(t.db, { email: 'maria@example.com' });
    createBooking(t.db, { showId: thisWeek.id, comedianId: other.id });

    const fired = await runSchedulerTick(t.db, { now: at('2026-11-05T22:00:00Z') });
    expect(fired.confirmations?.weekStart).toBe('2026-11-09');
    expect(emailsTo(t.db, 'john@example.com')[0]!.subject).toContain('next week');
    expect(emailsTo(t.db, 'maria@example.com')).toHaveLength(0);
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
    expect(nextConfirmationSend(t.db, at('2026-11-05T15:00:00Z'))).toEqual({
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
