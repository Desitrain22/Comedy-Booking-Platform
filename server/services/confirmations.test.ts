import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declineLink } from '../../shared/api/portal';
import { findConfirmToken } from '../auth/tokens';
import { bookings, type Booking, type Comedian, type LocationRow } from '../db/schema';
import { setTransportFactory } from '../email/mailer';
import { updateSettings } from '../lib/settings';
import {
  createBooking,
  createComedian,
  createLocation,
  createShow,
  createUser,
  emailsTo,
  makeTestApp,
  type TestApp,
} from '../test/helpers';
import {
  countConfirmationRecipients,
  countUnsentSpots,
  sendConfirmationToComedian,
  sendConfirmationsForWeek,
  weekPhrase,
} from './confirmations';

/** Wed 2026-11-04, 12:00 PM in New York (EST). The week runs Mon Nov 2 → Sun Nov 8. */
const NOW = new Date('2026-11-04T17:00:00Z');
const WEEK = '2026-11-02';
const EARLIER = NOW.getTime() - 86_400_000;

let t: TestApp;
let cellar: LocationRow;
let annex: LocationRow;
let john: Comedian;
let maria: Comedian;

function booking(id: number): Booking {
  return t.db.select().from(bookings).where(eq(bookings.id, id)).get()!;
}

beforeEach(() => {
  t = makeTestApp();
  cellar = createLocation(t.db, { name: 'The Cellar', address: '214 Sullivan St, New York, NY', sortOrder: 0 });
  annex = createLocation(t.db, { name: 'The Annex', address: '', sortOrder: 1 });
  john = createComedian(t.db, { name: 'John Mercer', email: 'john@example.com' });
  maria = createComedian(t.db, { name: 'Maria Delgado', email: 'maria@example.com' });
});

afterEach(() => {
  setTransportFactory(null);
  t.close();
});

describe('sendConfirmationsForWeek', () => {
  it("sends one email per comedian listing all of that week's spots and stamps confirmationSentAt", async () => {
    const early = createShow(t.db, { locationId: cellar.id, date: '2026-11-04', startMin: 1140, name: 'Early Show' });
    const late = createShow(t.db, { locationId: annex.id, date: '2026-11-06', startMin: 1260, name: 'Late Show' });
    const b1 = createBooking(t.db, { showId: early.id, comedianId: john.id });
    const b2 = createBooking(t.db, { showId: late.id, comedianId: john.id });
    const b3 = createBooking(t.db, { showId: late.id, comedianId: maria.id });

    const result = await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    expect(result).toEqual({ sent: 2, failed: 0, comedianIds: [john.id, maria.id] });

    const johnMail = emailsTo(t.db, 'john@example.com');
    expect(johnMail).toHaveLength(1);
    const mail = johnMail[0]!;
    expect(mail).toMatchObject({ kind: 'confirmation', status: 'outbox', comedianId: john.id });
    expect(mail.subject).toBe('Please confirm your spots this week at Test Comedy Club');
    expect(mail.bodyText).toContain("Hey John, you're booked for these spots this week. Please click to confirm.");
    expect(mail.bodyText).toContain('• Wed, Nov 4 — 7 PM · Early Show\n  The Cellar, 214 Sullivan St, New York, NY');
    expect(mail.bodyText).toContain('• Fri, Nov 6 — 9 PM · Late Show\n  The Annex');
    expect(mail.bodyText).toContain("Can't make one? Reply to this email.");
    expect(mail.bodyHtml).toContain('Confirm my spots');
    expect(mail.bodyHtml).toContain('214 Sullivan St, New York, NY');
    expect(mail.bodyHtml).toContain('Early Show');

    // The button is a working confirm link for this comedian and week.
    const token = /\/portal\/confirm\/([\w-]+)/.exec(mail.bodyText)?.[1];
    expect(token).toBeTruthy();
    expect(findConfirmToken(t.db, token!)).toMatchObject({ comedianId: john.id, weekStart: WEEK });

    for (const b of [b1, b2, b3]) expect(booking(b.id).confirmationSentAt).toBe(NOW.getTime());
    expect(emailsTo(t.db, 'maria@example.com')).toHaveLength(1);
  });

  it('skips cancelled shows, past days, other weeks and archived comedians', async () => {
    const yesterday = createShow(t.db, { locationId: cellar.id, date: '2026-11-03', startMin: 1200 });
    const cancelled = createShow(t.db, { locationId: cellar.id, date: '2026-11-07', startMin: 1200, status: 'cancelled' });
    const nextWeek = createShow(t.db, { locationId: cellar.id, date: '2026-11-09', startMin: 1200 });
    const sunday = createShow(t.db, { locationId: annex.id, date: '2026-11-08', startMin: 1200, name: 'Sunday Funday' });
    const past = createBooking(t.db, { showId: yesterday.id, comedianId: john.id });
    const off = createBooking(t.db, { showId: cancelled.id, comedianId: john.id });
    const later = createBooking(t.db, { showId: nextWeek.id, comedianId: john.id });
    createBooking(t.db, { showId: sunday.id, comedianId: john.id });

    const archived = createComedian(t.db, { name: 'Wes Calloway', email: 'wes@example.com', archived: true });
    createBooking(t.db, { showId: sunday.id, comedianId: archived.id });
    // Only a cancelled show this week → nothing to confirm.
    createBooking(t.db, { showId: cancelled.id, comedianId: maria.id });

    const result = await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    expect(result.comedianIds).toEqual([john.id]);

    const mail = emailsTo(t.db, 'john@example.com')[0]!;
    expect(mail.subject).toBe('Please confirm your spot this week at Test Comedy Club');
    expect(mail.bodyText).toContain("you're booked for this spot this week");
    expect(mail.bodyText).toContain('Sun, Nov 8 — 8 PM · Sunday Funday');
    expect(mail.bodyText).not.toContain('Nov 3');
    expect(mail.bodyText).not.toContain('Nov 7');
    expect(mail.bodyText).not.toContain('Nov 9');
    for (const b of [past, off, later]) expect(booking(b.id).confirmationSentAt).toBeNull();
    expect(emailsTo(t.db, 'wes@example.com')).toHaveLength(0);
    expect(emailsTo(t.db, 'maria@example.com')).toHaveLength(0);
  });

  it('skips comedians whose spots are all confirmed, but lists confirmed spots for the rest', async () => {
    const fri = createShow(t.db, { locationId: cellar.id, date: '2026-11-06', startMin: 1140 });
    const sat = createShow(t.db, { locationId: cellar.id, date: '2026-11-07', startMin: 1140 });
    createBooking(t.db, { showId: fri.id, comedianId: maria.id, confirmedAt: EARLIER, confirmedBy: 'comedian' });
    createBooking(t.db, { showId: sat.id, comedianId: maria.id, confirmedAt: EARLIER, confirmedBy: 'booker' });
    createBooking(t.db, { showId: fri.id, comedianId: john.id, confirmedAt: EARLIER, confirmedBy: 'comedian' });
    createBooking(t.db, { showId: sat.id, comedianId: john.id });

    const result = await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    expect(result).toEqual({ sent: 1, failed: 0, comedianIds: [john.id] });
    expect(emailsTo(t.db, 'maria@example.com')).toHaveLength(0);
    const text = emailsTo(t.db, 'john@example.com')[0]!.bodyText;
    expect(text).toContain('• Fri, Nov 6 — 7 PM (confirmed)');
    expect(text).toContain('• Sat, Nov 7 — 7 PM\n');
  });

  it('onlyUnsent: only comedians with a spot that was never emailed', async () => {
    const fri = createShow(t.db, { locationId: cellar.id, date: '2026-11-06', startMin: 1140 });
    const sat = createShow(t.db, { locationId: cellar.id, date: '2026-11-07', startMin: 1140 });
    const priya = createComedian(t.db, { name: 'Priya Raman', email: 'priya@example.com' });
    // John: already emailed for everything. Maria: one old, one new spot. Priya: brand new.
    createBooking(t.db, { showId: fri.id, comedianId: john.id, confirmationSentAt: EARLIER });
    createBooking(t.db, { showId: fri.id, comedianId: maria.id, confirmationSentAt: EARLIER });
    const mariaNew = createBooking(t.db, { showId: sat.id, comedianId: maria.id });
    createBooking(t.db, { showId: sat.id, comedianId: priya.id });

    expect(countConfirmationRecipients(t.db, WEEK, { now: NOW })).toEqual({ pendingComedians: 3, unsentComedians: 2 });

    const result = await sendConfirmationsForWeek(t.db, WEEK, { now: NOW, onlyUnsent: true });
    expect(result.comedianIds.sort()).toEqual([maria.id, priya.id].sort());
    expect(emailsTo(t.db, 'john@example.com')).toHaveLength(0);
    // Maria's email still lists both of her spots.
    const text = emailsTo(t.db, 'maria@example.com')[0]!.bodyText;
    expect(text).toContain('Fri, Nov 6');
    expect(text).toContain('Sat, Nov 7');
    expect(booking(mariaNew.id).confirmationSentAt).toBe(NOW.getTime());

    // Without onlyUnsent, everyone with something unconfirmed is emailed again.
    const again = await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    expect(again.sent).toBe(3);
  });

  it('records failed sends without stamping confirmationSentAt', async () => {
    updateSettings(t.db, { smtpHost: 'smtp.example.test', smtpPort: 465, fromEmail: 'club@example.test' });
    setTransportFactory(() => ({
      sendMail: async (message: { to?: unknown }) => {
        if (message.to === 'john@example.com') throw new Error('Mailbox unavailable');
        return {};
      },
    }) as never);
    const show = createShow(t.db, { locationId: cellar.id, date: '2026-11-06', startMin: 1140 });
    const johnBooking = createBooking(t.db, { showId: show.id, comedianId: john.id });
    const mariaBooking = createBooking(t.db, { showId: show.id, comedianId: maria.id });

    const result = await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    expect(result).toEqual({ sent: 1, failed: 1, comedianIds: [maria.id] });
    expect(emailsTo(t.db, 'john@example.com')[0]).toMatchObject({ status: 'failed', error: 'Mailbox unavailable' });
    expect(emailsTo(t.db, 'maria@example.com')[0]).toMatchObject({ status: 'sent' });
    expect(booking(johnBooking.id).confirmationSentAt).toBeNull();
    expect(booking(mariaBooking.id).confirmationSentAt).toBe(NOW.getTime());
  });

  it('says "next week" when sending ahead', async () => {
    const show = createShow(t.db, { locationId: cellar.id, date: '2026-11-10', startMin: 1140 });
    createBooking(t.db, { showId: show.id, comedianId: john.id });
    await sendConfirmationsForWeek(t.db, '2026-11-09', { now: NOW });
    expect(emailsTo(t.db, 'john@example.com')[0]!.subject).toBe(
      'Please confirm your spot next week at Test Comedy Club',
    );
  });
});

describe('declined spots', () => {
  it('are never listed, never a reason to email, never stamped (and never counted)', async () => {
    const fri = createShow(t.db, { locationId: cellar.id, date: '2026-11-06', startMin: 1260, name: 'Late Show' });
    const sat = createShow(t.db, { locationId: cellar.id, date: '2026-11-07', startMin: 1140, name: 'Early Show' });
    // John: one declined, one to confirm. Maria: only a declined spot.
    const johnDeclined = createBooking(t.db, { showId: fri.id, comedianId: john.id, declinedAt: EARLIER, declineNote: 'Sick' });
    createBooking(t.db, { showId: sat.id, comedianId: john.id });
    const mariaDeclined = createBooking(t.db, { showId: sat.id, comedianId: maria.id, declinedAt: EARLIER });

    expect(countConfirmationRecipients(t.db, WEEK, { now: NOW })).toEqual({ pendingComedians: 1, unsentComedians: 1 });
    expect(countUnsentSpots(t.db, WEEK, { now: NOW })).toBe(1);

    const result = await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    expect(result.comedianIds).toEqual([john.id]);
    const mail = emailsTo(t.db, 'john@example.com')[0]!;
    expect(mail.subject).toBe('Please confirm your spot this week at Test Comedy Club');
    expect(mail.bodyText).toContain('Sat, Nov 7 — 7 PM · Early Show');
    expect(mail.bodyText).not.toContain('Late Show');
    expect(booking(johnDeclined.id).confirmationSentAt).toBeNull();
    expect(emailsTo(t.db, 'maria@example.com')).toHaveLength(0);
    expect(booking(mariaDeclined.id).confirmationSentAt).toBeNull();

    // A resend for a comedian whose only spot is declined is skipped.
    expect(await sendConfirmationToComedian(t.db, maria.id, WEEK, { now: NOW })).toEqual({
      status: 'skipped',
      bookingCount: 0,
    });
  });
});

describe('confirmation email content', () => {
  it('names the real day for after-midnight shows (correctness#2)', async () => {
    const late = createShow(t.db, { locationId: cellar.id, date: '2026-11-08', startMin: 1500, name: 'Insomniac Hour' });
    createBooking(t.db, { showId: late.id, comedianId: john.id });
    await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    const mail = emailsTo(t.db, 'john@example.com')[0]!;
    expect(mail.bodyText).toContain('• Sun, Nov 8 — 1 AM (early Mon, Nov 9) · Insomniac Hour');
    expect(mail.bodyHtml).toContain('1 AM (early Mon, Nov 9) · Insomniac Hour');
    expect(mail.bodyHtml).toContain('Nov 8, 1 AM (early Mon, Nov 9) at The Cellar'); // preheader
  });

  it("has a per-spot \"Can't make it?\" link to the confirm page only when declines are allowed", async () => {
    const fri = createShow(t.db, { locationId: cellar.id, date: '2026-11-06', startMin: 1260 });
    const sat = createShow(t.db, { locationId: cellar.id, date: '2026-11-07', startMin: 1260 });
    const b1 = createBooking(t.db, { showId: fri.id, comedianId: john.id });
    const b2 = createBooking(t.db, { showId: sat.id, comedianId: john.id, confirmedAt: EARLIER, confirmedBy: 'comedian' });

    // Off (the default): exactly as before — reply to the email.
    await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    const off = emailsTo(t.db, 'john@example.com')[0]!;
    expect(off.bodyText).not.toContain("Can't make it?");
    expect(off.bodyHtml).not.toContain('decline=');
    expect(off.bodyText).toMatch(/Can't make one\? Reply to this email\.$/);

    updateSettings(t.db, { allowDeclines: true });
    await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    const on = emailsTo(t.db, 'john@example.com')[0]!;
    const url = /Confirm my spots: (\S+)/.exec(on.bodyText)![1]!;
    for (const b of [b1, b2]) {
      const link = declineLink(url, b.id);
      expect(link).toMatch(new RegExp(`/portal/confirm/[\\w-]+\\?decline=${b.id}$`));
      expect(on.bodyText).toContain(`Can't make it? ${link}`);
      expect(on.bodyHtml).toContain(`href="${link}"`);
    }
    expect(on.bodyText).toContain('Can\'t make one? Use the "Can\'t make it?" link under that spot, or reply to this email.');
    expect(on.bodyHtml).toContain('under that spot, or reply to this email');
  });

  it("replies go to the configured Reply-To, else the club's first admin", async () => {
    const replyTos: unknown[] = [];
    setTransportFactory(() => ({
      sendMail: (async (mail: { replyTo?: unknown }) => {
        replyTos.push(mail.replyTo);
        return {};
      }) as never,
    }));
    updateSettings(t.db, { smtpHost: 'smtp.example.test', fromEmail: 'club@example.test', replyTo: '' });
    createUser(t.db, { role: 'admin', email: 'owner@example.test' });
    const show = createShow(t.db, { locationId: cellar.id, date: '2026-11-06', startMin: 1260 });
    createBooking(t.db, { showId: show.id, comedianId: john.id });

    await sendConfirmationsForWeek(t.db, WEEK, { now: NOW });
    updateSettings(t.db, { replyTo: 'desk@example.test' });
    await sendConfirmationToComedian(t.db, john.id, WEEK, { now: NOW });
    expect(replyTos).toEqual(['owner@example.test', 'desk@example.test']);
  });
});

describe('sendConfirmationToComedian', () => {
  it("resends one comedian's week, even if they were emailed before", async () => {
    const show = createShow(t.db, { locationId: cellar.id, date: '2026-11-04', startMin: 1140 });
    const b = createBooking(t.db, { showId: show.id, comedianId: john.id, confirmationSentAt: EARLIER });
    createBooking(t.db, { showId: show.id, comedianId: maria.id });

    expect(await sendConfirmationToComedian(t.db, john.id, WEEK, { now: NOW })).toEqual({
      status: 'outbox',
      bookingCount: 1,
    });
    expect(emailsTo(t.db)).toHaveLength(1);
    expect(emailsTo(t.db, 'john@example.com')).toHaveLength(1);
    expect(booking(b.id).confirmationSentAt).toBe(NOW.getTime());
  });

  it('skips a comedian with nothing left to confirm', async () => {
    const show = createShow(t.db, { locationId: cellar.id, date: '2026-11-04', startMin: 1140 });
    createBooking(t.db, { showId: show.id, comedianId: john.id, confirmedAt: EARLIER, confirmedBy: 'comedian' });
    expect(await sendConfirmationToComedian(t.db, john.id, WEEK, { now: NOW })).toEqual({
      status: 'skipped',
      bookingCount: 0,
    });
    expect(await sendConfirmationToComedian(t.db, maria.id, WEEK, { now: NOW })).toMatchObject({ status: 'skipped' });
    expect(emailsTo(t.db)).toHaveLength(0);
  });
});

describe('weekPhrase', () => {
  it('describes the week relative to today', () => {
    expect(weekPhrase('2026-11-02', '2026-11-04')).toBe('this week');
    expect(weekPhrase('2026-11-09', '2026-11-04')).toBe('next week');
    expect(weekPhrase('2026-11-16', '2026-11-04')).toBe('the week of Mon, Nov 16');
  });
});
