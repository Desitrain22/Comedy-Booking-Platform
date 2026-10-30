import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminActionResponse,
  AdminClubDetail,
  AdminInvalidTransitionBody,
  AdminOverview,
} from '../../shared/api/platformAdmin';
import { addDays } from '../../shared/time';
import type { Db } from '../db/client';
import { emailLog, users } from '../db/schema';
import {
  createBooking,
  createComedian,
  createLocation,
  createShow,
  createSubmission,
  createUser,
  readJson,
} from '../test/helpers';
import { makeHostedTestApp, type HostedTestApp } from '../test/hosted';
import { createAdminSession } from './adminAuth';
import { adminEvents } from './schema';

const OWNER = 'owner@platform.test';
/** Wednesday 4 Nov 2026, 12:00 in New York (club time). */
const NOW = Date.parse('2026-11-04T17:00:00Z');
const TODAY = '2026-11-04';
const DAY = 86_400_000;

let h: HostedTestApp;
let headers: { cookie: string };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h = makeHostedTestApp();
  headers = { cookie: `cbp_platform=${createAdminSession(h.platform.db, OWNER).token}` };
});

afterEach(() => {
  h.close();
  vi.useRealTimers();
});

const admin = (path: string) => h.platformUrl(`/api/platform/admin${path}`);
const get = (path: string) => h.request(admin(path), { headers });
const post = (path: string, json: unknown = {}) => h.request(admin(path), { method: 'POST', json, headers });

async function overview(query = ''): Promise<AdminOverview> {
  const res = await get(`/overview${query}`);
  expect(res.status).toBe(200);
  return readJson<AdminOverview>(res);
}

async function detail(id: number): Promise<AdminClubDetail> {
  const res = await get(`/clubs/${id}`);
  expect(res.status).toBe(200);
  return readJson<AdminClubDetail>(res);
}

function logEmail(db: Db, values: Partial<typeof emailLog.$inferInsert> & { createdAt: number }) {
  return db
    .insert(emailLog)
    .values({
      toEmail: 'comic@example.test',
      subject: 'Your spots',
      kind: 'confirmation',
      status: 'sent',
      bodyText: 'SECRET-BODY https://club/portal/confirm/token',
      bodyHtml: '<p>SECRET-BODY</p>',
      ...values,
    })
    .returning()
    .get();
}

/** A club with known numbers (see the expectations in the tests below). */
function seedBusyClub() {
  const created = h.createClub({ slug: 'broadway', name: 'Broadway Comedy', admin: { name: 'Rich Brooks', email: 'rich@bway.test' } });
  const { db, admin: owner } = created;
  db.update(users).set({ lastLoginAt: NOW - 3 * DAY }).run();
  createUser(db, { name: 'Eric Hanson', email: 'eric@bway.test', role: 'booker', lastLoginAt: NOW - 2 * DAY });
  createUser(db, {
    name: 'Invited Ivy',
    email: 'ivy@bway.test',
    passwordHash: null,
    inviteTokenHash: 'ivy-invite',
    inviteExpiresAt: NOW + DAY,
  });
  createUser(db, { name: 'Expired Ed', email: 'ed@bway.test', passwordHash: null, inviteExpiresAt: NOW - DAY });

  const village = createLocation(db, { name: 'Greenwich Village', address: '1 Bleecker St' });
  createLocation(db, { name: 'Old Room', archived: true });

  const comics = [1, 2, 3].map((n) => createComedian(db, { name: `Comic ${n}`, email: `comic${n}@bway.test` }));
  createComedian(db, { name: 'Gone Comic', email: 'gone@bway.test', archived: true });

  // Upcoming = scheduled, today through today+29.
  const today = createShow(db, { locationId: village.id, date: TODAY });
  createShow(db, { locationId: village.id, date: addDays(TODAY, 29) });
  createShow(db, { locationId: village.id, date: addDays(TODAY, 30) }); // too far
  createShow(db, { locationId: village.id, date: addDays(TODAY, -1) }); // past
  createShow(db, { locationId: village.id, date: addDays(TODAY, 3), status: 'cancelled' });

  // Bookings: one this week (Mon 2 Nov…), one three weeks back, one long ago.
  createBooking(db, { showId: today.id, comedianId: comics[0]!.id, bookedById: owner.id, createdAt: NOW - DAY });
  createBooking(db, { showId: today.id, comedianId: comics[1]!.id, createdAt: NOW - 21 * DAY });
  createBooking(db, { showId: today.id, comedianId: comics[2]!.id, createdAt: NOW - 100 * DAY });

  createSubmission(db, comics[0]!.id, '2026-11', NOW - 2 * DAY);
  createSubmission(db, comics[1]!.id, '2026-11', NOW - 8 * DAY);

  // Emails: sent 1d, 6d (platform), 10d, 40d ago; failed 2d (platform) and 20d; outbox 1d.
  logEmail(db, { createdAt: NOW - 1 * DAY, via: 'company-mailbox' });
  logEmail(db, { createdAt: NOW - 6 * DAY, via: 'platform' });
  logEmail(db, { createdAt: NOW - 10 * DAY, via: 'platform' });
  logEmail(db, { createdAt: NOW - 40 * DAY });
  logEmail(db, {
    createdAt: NOW - 2 * DAY,
    status: 'failed',
    via: 'platform',
    error: 'Daily email limit reached — contact support',
    subject: 'Failed one',
    toEmail: 'comic1@bway.test',
  });
  logEmail(db, { createdAt: NOW - 20 * DAY, status: 'failed', via: 'company-mailbox', error: 'Auth failed', subject: 'Failed two' });
  logEmail(db, { createdAt: NOW - 1 * DAY, status: 'outbox', via: 'outbox' });
  return created;
}

// ---------------------------------------------------------------------------

describe('GET /overview', () => {
  it('totals and per-club numbers from each club’s database', async () => {
    const busy = seedBusyClub();
    const quiet = h.createClub({ slug: 'quiet', name: 'Quiet Club' });
    createComedian(quiet.db, { email: 'q@quiet.test' });
    const paused = h.createClub({ slug: 'paused', name: 'Paused Club', status: 'suspended' });
    createComedian(paused.db, { email: 'p@paused.test' });
    const gone = h.createClub({ slug: 'gone', name: 'Gone Club', status: 'archived' });

    const body = await overview();
    expect(body.status).toBe('active');
    expect(body.totals).toEqual({
      clubs: { active: 2, suspended: 1, archived: 1 },
      // Active + suspended clubs: broadway 4 bookers (2 invited), quiet 1, paused 1.
      bookers: 6,
      comedians: 3 + 1 + 1,
      upcomingShows: 2,
      emailsSent7d: 2,
      emailsSent30d: 3,
    });
    expect(body.clubs.map((c) => c.slug)).toEqual(['broadway', 'quiet']);

    const row = body.clubs[0]!;
    expect(row).toMatchObject({
      id: busy.club.id,
      slug: 'broadway',
      name: 'Broadway Comedy',
      url: 'http://broadway.localhost:3000',
      host: 'broadway.localhost:3000',
      status: 'active',
      owner: { name: 'Rich Brooks', email: 'rich@bway.test' },
    });
    expect(row.stats).toEqual({
      bookers: 4,
      // The latest booking (a day ago) beats the latest sign-in (two days ago).
      lastActiveAt: NOW - DAY,
      locations: 2, // Main Room (from setup) + Greenwich Village; the archived one doesn't count
      comedians: 3,
      upcomingShows: 2,
      emailsSent7d: 2,
      emailsSent30d: 3,
      emailsFailed30d: 2,
      platformSent30d: 2,
      platformFailed30d: 1,
      senderMode: 'company',
      companyMailbox: false,
      bookerMailboxes: 0,
    });
    // Sign-up counts as the founder's first sign-in.
    expect(body.clubs[1]!.stats).toMatchObject({ bookers: 1, lastActiveAt: NOW, comedians: 1, emailsSent30d: 0 });
    // Archived clubs are left out of the totals, and the table shows active clubs by default.
    expect(body.clubs.map((c) => c.id)).not.toContain(gone.club.id);
  });

  it('filters by status, and searches name, address and owner email', async () => {
    seedBusyClub();
    h.createClub({ slug: 'quiet', name: 'Quiet Club', admin: { email: 'quinn@quiet.test' } });
    h.createClub({ slug: 'paused', name: 'Paused Club', status: 'suspended' });
    h.createClub({ slug: 'gone', name: 'Gone Club', status: 'archived' });

    const slugs = async (query: string) => (await overview(query)).clubs.map((c) => c.slug);
    expect(await slugs('?status=suspended')).toEqual(['paused']);
    expect(await slugs('?status=archived')).toEqual(['gone']);
    expect(await slugs('?status=all')).toEqual(['broadway', 'quiet', 'paused', 'gone']);
    expect(await slugs('?search=BROAD')).toEqual(['broadway']);
    expect(await slugs('?search=quinn@')).toEqual(['quiet']);
    expect(await slugs('?search=comedy')).toEqual(['broadway']);
    expect(await slugs('?status=all&search=club')).toEqual(['quiet', 'paused', 'gone']);
    expect(await slugs('?search=nothing-matches')).toEqual([]);
    // Totals don't follow the filter.
    expect((await overview('?status=archived&search=zzz')).totals.clubs).toEqual({ active: 2, suspended: 1, archived: 1 });

    const bad = await get('/overview?status=deleted');
    expect(bad.status).toBe(400);
  });

  it('searches the club’s current name too (renamed after sign-up)', async () => {
    const { db } = h.createClub({ slug: 'renamed', name: 'Old Name' });
    db.$client.prepare(`UPDATE settings SET club_name = 'Shiny New Name'`).run();
    const body = await overview('?search=shiny');
    expect(body.clubs.map((c) => [c.slug, c.name])).toEqual([['renamed', 'Shiny New Name']]);
  });

  it('reads archived clubs read-only and leaves them closed, with no files left behind', async () => {
    const { club, db } = h.createClub({ slug: 'gone', name: 'Gone Club' });
    createComedian(db, { email: 'g@gone.test' });
    h.platform.registry.setClubStatus(club.id, 'archived'); // closes its database
    expect(h.platform.registry.openClubIds()).not.toContain(club.id);
    const file = h.platform.registry.clubDbFile(club.id);
    expect(existsSync(`${file}-wal`)).toBe(false);

    const body = await overview('?status=archived');
    expect(body.clubs[0]).toMatchObject({ slug: 'gone', status: 'archived', stats: { comedians: 1 } });
    await detail(club.id);
    expect(h.platform.registry.openClubIds()).not.toContain(club.id);
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(existsSync(`${file}-shm`)).toBe(false);
  });

  it('a club whose database can’t be read still shows, with stats null', async () => {
    const { club } = h.createClub({ slug: 'broken', name: 'Broken Club', status: 'archived' });
    const file = h.platform.registry.clubDbFile(club.id);
    const { rmSync } = await import('node:fs');
    rmSync(file);
    const body = await overview('?status=archived');
    expect(body.clubs[0]).toMatchObject({ slug: 'broken', name: 'Broken Club', stats: null });
    const one = await detail(club.id);
    expect(one.dataError).toBeTruthy();
    expect(one.dbSizeBytes).toBeNull();
  });
});

describe('GET /clubs/:id', () => {
  it('bookers, locations, 8 weeks of usage, failed emails, size and history', async () => {
    const { club } = seedBusyClub();
    const body = await detail(club.id);
    expect(body.timezone).toBe('America/New_York');
    expect(body.dataError).toBeNull();
    expect(body.club.stats?.upcomingShows).toBe(2);

    expect(body.bookers.map((b) => [b.name, b.role, b.status, b.lastLoginAt])).toEqual([
      ['Rich Brooks', 'admin', 'active', NOW - 3 * DAY],
      ['Eric Hanson', 'booker', 'active', NOW - 2 * DAY],
      ['Expired Ed', 'booker', 'invite_expired', null],
      ['Invited Ivy', 'booker', 'invited', null],
    ]);
    expect(body.locations.map((l) => [l.name, l.archived])).toEqual([
      ['Main Room', false],
      ['Greenwich Village', false],
      ['Old Room', true],
    ]);

    // Weeks start on Mondays (club time): this week is Mon 2 Nov.
    expect(body.usage.map((w) => w.weekStart)).toEqual([
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
      '2026-11-02',
    ]);
    const week = (start: string) => body.usage.find((w) => w.weekStart === start)!;
    // Nov 2–4: sent 1d ago, failed 2d ago, booking 1d ago, submission 2d ago.
    expect(week('2026-11-02')).toEqual({ weekStart: '2026-11-02', emailsSent: 1, emailsFailed: 1, bookings: 1, availabilitySubmissions: 1 });
    // Oct 26 – Nov 1: sent 6d ago, submission 8d ago is Oct 27.
    expect(week('2026-10-26')).toEqual({ weekStart: '2026-10-26', emailsSent: 1, emailsFailed: 0, bookings: 0, availabilitySubmissions: 1 });
    // Oct 19–25: sent 10d ago (Oct 25).
    expect(week('2026-10-19').emailsSent).toBe(1);
    // Oct 12–18: failed 20d ago (Oct 15), booking 21d ago (Oct 14).
    expect(week('2026-10-12')).toMatchObject({ emailsFailed: 1, bookings: 1 });
    // Sep 21–27: sent 40d ago (Sep 25).
    expect(week('2026-09-21').emailsSent).toBe(1);
    // The outbox email and the booking 100 days ago (before the 8 weeks) aren't counted.
    const totals = body.usage.reduce((sum, w) => sum + w.emailsSent + w.emailsFailed + w.bookings, 0);
    expect(totals).toBe(4 + 2 + 2);

    expect(body.failedEmails.map((e) => [e.subject, e.via, e.error])).toEqual([
      ['Failed one', 'platform', 'Daily email limit reached — contact support'],
      ['Failed two', 'company-mailbox', 'Auth failed'],
    ]);
    expect(body.failedEmails[0]).toEqual({
      id: expect.any(Number),
      createdAt: NOW - 2 * DAY,
      kind: 'confirmation',
      via: 'platform',
      toEmail: 'comic1@bway.test',
      subject: 'Failed one',
      error: 'Daily email limit reached — contact support',
    });

    expect(body.dbSizeBytes).toBeGreaterThan(4096);
    expect(body.events).toEqual([]);
  });

  it('never returns email bodies (they hold sign-in links)', async () => {
    const { club } = seedBusyClub();
    const res = await get(`/clubs/${club.id}`);
    const text = await res.text();
    expect(text).not.toContain('SECRET-BODY');
    expect(text).not.toContain('/portal/confirm/');
    expect(text).not.toMatch(/body(Html|Text)/);
  });

  it('only the last 10 failed emails, newest first', async () => {
    const { club, db } = h.createClub({ slug: 'noisy' });
    for (let i = 1; i <= 12; i++) {
      logEmail(db, { createdAt: NOW - i * 60_000, status: 'failed', subject: `Failure ${i}`, error: 'boom' });
    }
    const body = await detail(club.id);
    expect(body.failedEmails.map((e) => e.subject)).toEqual(Array.from({ length: 10 }, (_, i) => `Failure ${i + 1}`));
  });

  it('404 for an unknown club, 400 for a bad id', async () => {
    expect((await get('/clubs/999')).status).toBe(404);
    expect((await readJson<{ code: string }>(await get('/clubs/999'))).code).toBe('not_found');
    expect((await get('/clubs/abc')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('actions', () => {
  const events = () =>
    h.platform.db
      .select()
      .from(adminEvents)
      .all()
      .map((e) => [e.action, e.clubId, e.adminEmail, e.reason]);

  async function expectConflict(res: Response, status: string) {
    expect(res.status).toBe(409);
    const body = await readJson<AdminInvalidTransitionBody>(res);
    expect(body.code).toBe('invalid_transition');
    expect(body.status).toBe(status);
    expect(body.error).toBeTruthy();
  }

  it('suspend → reactivate → archive → restore, each logged; the club’s site follows', async () => {
    const { club } = h.createClub({ slug: 'broadway', name: 'Broadway Comedy' });
    const { headers: booker } = h.loginAsBooker('broadway');
    const clubApi = () => h.request(h.clubUrl('broadway', '/api/comedians'), { headers: booker });
    expect((await clubApi()).status).toBe(200);

    // Suspend, with a reason.
    let res = await post(`/clubs/${club.id}/suspend`, { reason: '  Unpaid  ' });
    expect(res.status).toBe(200);
    expect((await readJson<AdminActionResponse>(res)).club).toMatchObject({
      status: 'suspended',
      statusReason: 'Unpaid',
      statusChangedAt: NOW,
      stats: { bookers: 2 },
    });
    expect((await clubApi()).status).toBe(403);
    await expectConflict(await post(`/clubs/${club.id}/suspend`), 'suspended');

    // Reactivate.
    res = await post(`/clubs/${club.id}/reactivate`);
    expect((await readJson<AdminActionResponse>(res)).club).toMatchObject({ status: 'active', statusReason: '' });
    expect((await clubApi()).status).toBe(200);
    await expectConflict(await post(`/clubs/${club.id}/reactivate`), 'active');
    await expectConflict(await post(`/clubs/${club.id}/restore`), 'active');

    // Archive: needs the address typed.
    res = await post(`/clubs/${club.id}/archive`, {});
    expect(res.status).toBe(400);
    res = await post(`/clubs/${club.id}/archive`, { confirmSlug: 'broadwa' });
    expect(res.status).toBe(400);
    expect((await readJson<{ code: string }>(res)).code).toBe('confirm_slug_mismatch');
    expect(h.platform.registry.getClubById(club.id)!.status).toBe('active');

    expect(h.platform.registry.openClubIds()).toContain(club.id);
    res = await post(`/clubs/${club.id}/archive`, { confirmSlug: ' BROADWAY ', reason: 'Closed down' });
    expect(res.status).toBe(200);
    expect((await readJson<AdminActionResponse>(res)).club).toMatchObject({ status: 'archived', statusReason: 'Closed down' });
    // Archiving closed its database, and reading it for the response didn't reopen it.
    expect(h.platform.registry.openClubIds()).not.toContain(club.id);
    const gone = await clubApi();
    expect(gone.status).toBe(404);
    expect((await readJson<{ code: string }>(gone)).code).toBe('club_not_found');
    expect(h.platform.registry.openClubIds()).not.toContain(club.id);

    await expectConflict(await post(`/clubs/${club.id}/archive`, { confirmSlug: 'broadway' }), 'archived');
    await expectConflict(await post(`/clubs/${club.id}/suspend`), 'archived');
    await expectConflict(await post(`/clubs/${club.id}/reactivate`), 'archived');

    // Restore: back as active, data intact.
    res = await post(`/clubs/${club.id}/restore`);
    expect((await readJson<AdminActionResponse>(res)).club).toMatchObject({ status: 'active', statusReason: '' });
    expect((await clubApi()).status).toBe(200);

    expect(events()).toEqual([
      ['suspend', club.id, OWNER, 'Unpaid'],
      ['reactivate', club.id, OWNER, ''],
      ['archive', club.id, OWNER, 'Closed down'],
      ['restore', club.id, OWNER, ''],
    ]);
    const history = (await detail(club.id)).events;
    expect(history.map((e) => e.action)).toEqual(['restore', 'archive', 'reactivate', 'suspend']);
  });

  it('a suspended club can be archived; refused actions write no event', async () => {
    const { club } = h.createClub({ slug: 'paused', status: 'suspended' });
    await expectConflict(await post(`/clubs/${club.id}/suspend`, { reason: 'again' }), 'suspended');
    expect(events()).toEqual([]);
    const res = await post(`/clubs/${club.id}/archive`, { confirmSlug: 'paused' });
    expect(res.status).toBe(200);
    expect(events()).toEqual([['archive', club.id, OWNER, '']]);
  });

  it('404 for an unknown club', async () => {
    for (const action of ['suspend', 'reactivate', 'restore']) {
      expect((await post(`/clubs/999/${action}`)).status).toBe(404);
    }
    expect((await post('/clubs/999/archive', { confirmSlug: 'x' })).status).toBe(404);
    expect((await get('/clubs/999/backup')).status).toBe(404);
  });

  it('a reason is at most 500 characters', async () => {
    const { club } = h.createClub({ slug: 'broadway' });
    expect((await post(`/clubs/${club.id}/suspend`, { reason: 'x'.repeat(501) })).status).toBe(400);
  });
});

describe('GET /clubs/:id/backup', () => {
  async function download(id: number) {
    const res = await get(`/clubs/${id}/backup`);
    expect(res.status).toBe(200);
    return { res, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  function openCopy(bytes: Buffer) {
    return new Database(bytes);
  }

  it('a consistent .db snapshot of an active club, logged', async () => {
    const { club, db } = h.createClub({ slug: 'broadway' });
    createComedian(db, { name: 'Backed Up', email: 'backed@up.test' });
    const { res, bytes } = await download(club.id);
    expect(res.headers.get('content-type')).toBe('application/vnd.sqlite3');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="broadway-backup-2026-11-04.db"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Number(res.headers.get('content-length'))).toBe(bytes.length);
    expect(bytes.subarray(0, 15).toString()).toBe('SQLite format 3');
    const copy = openCopy(bytes);
    expect(copy.prepare('SELECT name FROM comedians').all()).toEqual([{ name: 'Backed Up' }]);
    copy.close();

    const [event] = h.platform.db.select().from(adminEvents).all();
    expect(event).toMatchObject({ action: 'backup_download', clubId: club.id, adminEmail: OWNER });
  });

  it('works for a suspended or archived club, which stays closed', async () => {
    const { club, db } = h.createClub({ slug: 'gone' });
    createComedian(db, { name: 'Archived Comic', email: 'a@gone.test' });
    expect((await post(`/clubs/${club.id}/archive`, { confirmSlug: 'gone' })).status).toBe(200);

    const { bytes } = await download(club.id);
    const copy = openCopy(bytes);
    expect(copy.prepare('SELECT name FROM comedians').all()).toEqual([{ name: 'Archived Comic' }]);
    copy.close();
    expect(h.platform.registry.openClubIds()).not.toContain(club.id);
    const file = h.platform.registry.clubDbFile(club.id);
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(h.platform.db.select().from(adminEvents).all().map((e) => e.action)).toEqual(['archive', 'backup_download']);

    const paused = h.createClub({ slug: 'paused', status: 'suspended' });
    await download(paused.club.id);
  });
});
