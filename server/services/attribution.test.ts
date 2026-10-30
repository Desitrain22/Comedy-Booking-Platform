/**
 * Who each email is from (hosted MVP spec §5), end to end through the routes and the
 * scheduler: availability requests and reminders come from the booker who sent them;
 * confirmations from the booker who booked every spot in them, else the company; sign-in
 * codes, magic links and invites always from the company.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, weekStartOf } from '../../shared/time';
import { bookings, type Comedian, type User } from '../db/schema';
import { clubToday, updateSettings } from '../lib/settings';
import { captureMail, restoreEnv, singleClubMode, type CapturedMail } from '../test/emailEnv';
import {
  createBooking,
  createComedian,
  createLocation,
  createShow,
  emailsTo,
  latestEmail,
  loginAsBooker,
  makeTestApp,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';
import { confirmationSenderId, sendConfirmationsForWeek } from './confirmations';
import { createSchedulerState, runSchedulerTick } from './scheduler';

const COMPANY_FROM = '"Test Comedy Club" <bookings@club.test>';
const RICH_FROM = '"Rich Brooks · Test Comedy Club" <bookings@club.test>';
const ERIC_FROM = '"Eric Hanson · Test Comedy Club" <bookings@club.test>';

let t: TestApp;
let sent: CapturedMail[];
let admin: { user: User; headers: AuthHeaders };
let rich: { user: User; headers: AuthHeaders };
let eric: { user: User; headers: AuthHeaders };
let john: Comedian;
let maria: Comedian;

beforeEach(async () => {
  singleClubMode();
  t = makeTestApp();
  sent = captureMail();
  updateSettings(t.db, {
    smtpHost: 'smtp.club.test',
    smtpUser: 'bookings@club.test',
    smtpPass: 'club-pass',
    senderMode: 'booker',
  });
  admin = await loginAsBooker(t, { role: 'admin', name: 'Ada Admin', email: 'ada@club.test' });
  rich = await loginAsBooker(t, { role: 'booker', name: 'Rich Brooks', email: 'rich@club.test' });
  eric = await loginAsBooker(t, { role: 'booker', name: 'Eric Hanson', email: 'eric@club.test' });
  john = createComedian(t.db, { name: 'John Mercer', email: 'john@example.com' });
  maria = createComedian(t.db, { name: 'Maria Delgado', email: 'maria@example.com' });
});

afterEach(() => {
  restoreEnv();
  t.close();
});

function mailTo(to: string): CapturedMail[] {
  return sent.filter((m) => m.to === to);
}

describe('availability requests and reminders', () => {
  it('come from the booker who pressed Send', async () => {
    const res = await t.request('/api/availability-requests', {
      method: 'POST',
      headers: rich.headers,
      json: { month: '2026-12', audience: 'all', message: '', kind: 'request' },
    });
    expect(res.status).toBe(201);
    for (const comedian of [john, maria]) {
      expect(mailTo(comedian.email)[0]).toMatchObject({ from: RICH_FROM, replyTo: 'rich@club.test' });
      expect(latestEmail(t.db, comedian.email)).toMatchObject({
        kind: 'availability_request',
        senderUserId: rich.user.id,
        via: 'company-mailbox',
      });
    }

    const reminder = await t.request('/api/availability-requests', {
      method: 'POST',
      headers: eric.headers,
      json: { month: '2026-12', audience: 'all', message: '', kind: 'reminder' },
    });
    expect(reminder.status).toBe(201);
    expect(mailTo(john.email)[1]).toMatchObject({ from: ERIC_FROM, replyTo: 'eric@club.test' });
    expect(latestEmail(t.db, john.email)).toMatchObject({ kind: 'availability_reminder', senderUserId: eric.user.id });
  });

  it('come from the company in company mode, still recording who sent them', async () => {
    updateSettings(t.db, { senderMode: 'company', replyTo: 'desk@club.test' });
    await t.request('/api/availability-requests', {
      method: 'POST',
      headers: rich.headers,
      json: { month: '2026-12', audience: 'all', message: '', kind: 'request' },
    });
    expect(mailTo(john.email)[0]).toMatchObject({ from: COMPANY_FROM, replyTo: 'desk@club.test' });
    expect(latestEmail(t.db, john.email)?.senderUserId).toBe(rich.user.id);
  });
});

describe('confirmations', () => {
  // Next week, so every spot is still ahead whatever the real clock says.
  const nextWeek = () => addDays(weekStartOf(clubToday(t.db)), 7);

  function book(comedian: Comedian, date: string, bookedById: number | null) {
    const show = createShow(t.db, { locationId: createLocation(t.db).id, date, startMin: 1260 });
    return createBooking(t.db, { showId: show.id, comedianId: comedian.id, bookedById });
  }

  it('picks the booker who booked every spot, else the company', () => {
    expect(confirmationSenderId([{ bookedById: 4 }, { bookedById: 4 }])).toBe(4);
    expect(confirmationSenderId([{ bookedById: 4 }, { bookedById: 5 }])).toBeNull();
    expect(confirmationSenderId([{ bookedById: 4 }, { bookedById: null }])).toBeNull();
    expect(confirmationSenderId([{ bookedById: null }, { bookedById: 4 }])).toBeNull();
    expect(confirmationSenderId([])).toBeNull();
  });

  it('"send now": one booker → from them; two bookers → from the company', async () => {
    const week = nextWeek();
    book(john, addDays(week, 1), rich.user.id);
    book(john, addDays(week, 3), rich.user.id);
    book(maria, addDays(week, 1), rich.user.id);
    book(maria, addDays(week, 4), eric.user.id);

    const res = await t.request('/api/confirmations/send', { method: 'POST', headers: eric.headers, json: { weekStart: week } });
    expect(res.status).toBe(200);
    expect(mailTo(john.email)).toHaveLength(1);
    expect(mailTo(john.email)[0]).toMatchObject({ from: RICH_FROM, replyTo: 'rich@club.test' });
    expect(latestEmail(t.db, john.email)).toMatchObject({ kind: 'confirmation', senderUserId: rich.user.id });
    // Shared week: the company, and replies still reach a person (no company email: the admin).
    expect(mailTo(maria.email)[0]).toMatchObject({ from: COMPANY_FROM, replyTo: 'ada@club.test' });
    expect(latestEmail(t.db, maria.email)).toMatchObject({ kind: 'confirmation', senderUserId: null });
  });

  it('per-comedian resend comes from the booker who booked, not whoever pressed resend', async () => {
    const week = nextWeek();
    book(john, addDays(week, 2), rich.user.id);
    const res = await t.request('/api/confirmations/resend', {
      method: 'POST',
      headers: eric.headers,
      json: { comedianId: john.id, weekStart: week },
    });
    expect(res.status).toBe(200);
    expect(mailTo(john.email)[0]).toMatchObject({ from: RICH_FROM, replyTo: 'rich@club.test' });
  });

  it('a removed booker: from the company (and removing them works after they sent email)', async () => {
    const week = nextWeek();
    const booking = book(john, addDays(week, 2), rich.user.id);
    await t.request('/api/confirmations/send', { method: 'POST', headers: rich.headers, json: { weekStart: week } });
    expect(latestEmail(t.db, john.email)?.senderUserId).toBe(rich.user.id);

    // email_log.sender_user_id references them: migration 0003's ON DELETE SET NULL lets the
    // delete through (with foreign keys on, NO ACTION would refuse it).
    const removed = await t.request(`/api/users/${rich.user.id}`, { method: 'DELETE', headers: admin.headers });
    expect(removed.status).toBe(200);
    expect(t.db.select().from(bookings).where(eq(bookings.id, booking.id)).get()?.bookedById).toBeNull();
    // Their earlier emails stay in the log, now as the company's.
    expect(emailsTo(t.db, john.email).map((r) => r.senderUserId)).toEqual([null]);
    expect(
      t.db.$client.prepare('SELECT COUNT(*) AS n FROM email_log WHERE sender_user_id IS NOT NULL').get(),
    ).toEqual({ n: 0 });

    await t.request('/api/confirmations/resend', {
      method: 'POST',
      headers: eric.headers,
      json: { comedianId: john.id, weekStart: week },
    });
    expect(mailTo(john.email)[1]).toMatchObject({ from: COMPANY_FROM, replyTo: 'ada@club.test' });
    expect(latestEmail(t.db, john.email)?.senderUserId).toBeNull();
  });

  it('a spot with no known booker makes the email the company’s', async () => {
    const week = nextWeek();
    book(john, addDays(week, 1), rich.user.id);
    book(john, addDays(week, 2), null);
    await t.request('/api/confirmations/send', { method: 'POST', headers: rich.headers, json: { weekStart: week } });
    expect(mailTo(john.email)[0]?.from).toBe(COMPANY_FROM);
  });

  it('company mode: from the company, recording the booker who booked every spot', async () => {
    updateSettings(t.db, { senderMode: 'company', replyTo: 'desk@club.test' });
    const week = nextWeek();
    book(john, addDays(week, 1), rich.user.id);
    await sendConfirmationsForWeek(t.db, week);
    expect(mailTo(john.email)[0]).toMatchObject({ from: COMPANY_FROM, replyTo: 'desk@club.test' });
    expect(latestEmail(t.db, john.email)?.senderUserId).toBe(rich.user.id);
  });

  it('the weekly scheduled send and the daily catch-up use the same attribution', async () => {
    // Weekly send: Monday 2026-11-09 at 10 AM New York; spots that week.
    book(john, '2026-11-11', rich.user.id);
    book(maria, '2026-11-12', eric.user.id);
    const state = createSchedulerState();
    const weekly = await runSchedulerTick(t.db, { now: new Date('2026-11-09T15:00:00Z'), state });
    expect(weekly.confirmations).toMatchObject({ sent: 2 });
    expect(mailTo(john.email)[0]?.from).toBe(RICH_FROM);
    expect(mailTo(maria.email)[0]?.from).toBe(ERIC_FROM);

    // Booked after the weekly send by Rich: Tuesday's catch-up lists Maria's spots from two
    // bookers, so it comes from the company.
    book(maria, '2026-11-13', rich.user.id);
    const catchUp = await runSchedulerTick(t.db, { now: new Date('2026-11-10T15:00:00Z'), state });
    expect(catchUp.catchUp).toMatchObject({ sent: 1, comedianIds: [maria.id] });
    expect(mailTo(maria.email)[1]?.from).toBe(COMPANY_FROM);
  });
});

describe('sign-in codes, magic links and booker invites', () => {
  it('always come from the company, even in booker mode', async () => {
    // A sign-in code (sent in the background).
    const code = await t.request('/api/auth/comedian/request-code', { method: 'POST', json: { email: john.email } });
    expect(code.status).toBe(200);
    await vi.waitFor(() => expect(latestEmail(t.db, john.email)?.kind).toBe('login_code'));

    // A magic link, emailed when Rich adds a comedian.
    const added = await t.request('/api/comedians', {
      method: 'POST',
      headers: rich.headers,
      json: { name: 'Dana Kim', email: 'dana@example.com', sendLoginLink: true },
    });
    expect(added.status).toBe(201);

    // A booker invite.
    const invite = await t.request('/api/users', {
      method: 'POST',
      headers: admin.headers,
      json: { name: 'Sam New', email: 'sam@club.test', role: 'booker' },
    });
    expect(invite.status).toBe(201);

    for (const [to, kind] of [
      [john.email, 'login_code'],
      ['dana@example.com', 'login_link'],
      ['sam@club.test', 'booker_invite'],
    ] as const) {
      expect(latestEmail(t.db, to)).toMatchObject({ kind, senderUserId: null, via: 'company-mailbox' });
      expect(mailTo(to)[0]?.from, kind).toBe(COMPANY_FROM);
    }
  });
});
