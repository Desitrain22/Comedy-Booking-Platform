import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkBulkRows,
  parseBulkLines,
  type BulkAddResult,
  type BulkUpdateResult,
  type ComedianAvailability,
  type ComedianBooking,
  type ComedianCard,
  type ComedianDetail,
  type ComedianListItem,
  type NoteDto,
  type SendLoginLinkResponse,
  type TagSummary,
  type TagWithCount,
} from '../../shared/api/comedians';
import { addDays, addMonths, monthOf } from '../../shared/time';
import { TAG_PALETTE, type MagicLinkResponse } from '../../shared/types';
import { createSession } from '../auth/sessions';
import { comedians, comedianTags, notes, sessions, tags } from '../db/schema';
import { clubToday } from '../lib/settings';
import {
  TEST_APP_URL,
  cookieFrom,
  createAvailability,
  createBooking,
  createComedian,
  createLocation,
  createNote,
  createShow,
  createSubmission,
  createTag,
  emailsTo,
  latestEmail,
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

beforeEach(async () => {
  t = makeTestApp();
  const login = await loginAsBooker(t, { role: 'booker', name: 'Dana Booker' });
  headers = login.headers;
  bookerId = login.user.id;
});

afterEach(() => {
  t.close();
});

function get(path: string, h: AuthHeaders | undefined = headers) {
  return t.request(path, { headers: h });
}
function send(method: string, path: string, json?: unknown, h: AuthHeaders | undefined = headers) {
  return t.request(path, { method, json, headers: h });
}
async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`Expected ${status}, got ${r.status}: ${await r.text()}`);
  return readJson<T>(r);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('guards', () => {
  const endpoints: [string, string][] = [
    ['GET', '/api/comedians'],
    ['POST', '/api/comedians'],
    ['POST', '/api/comedians/bulk'],
    ['POST', '/api/comedians/bulk-tag'],
    ['POST', '/api/comedians/bulk-archive'],
    ['GET', '/api/comedians/1'],
    ['PATCH', '/api/comedians/1'],
    ['PUT', '/api/comedians/1/tags'],
    ['GET', '/api/comedians/1/availability'],
    ['GET', '/api/comedians/1/bookings'],
    ['GET', '/api/comedians/1/card'],
    ['POST', '/api/comedians/1/send-login-link'],
    ['GET', '/api/comedians/1/notes'],
    ['POST', '/api/comedians/1/notes'],
    ['PATCH', '/api/notes/1'],
    ['DELETE', '/api/notes/1'],
    ['GET', '/api/tags'],
    ['POST', '/api/tags'],
    ['PATCH', '/api/tags/1'],
    ['DELETE', '/api/tags/1'],
  ];

  it('rejects anonymous requests and comedian sessions with 401', async () => {
    const comic = createComedian(t.db);
    const { headers: comedianHeaders } = await loginAsComedian(t, comic.id);
    for (const [method, path] of endpoints) {
      for (const h of [undefined, comedianHeaders]) {
        const res = await send(method, path, method === 'GET' || method === 'DELETE' ? undefined : {}, h ?? { cookie: '' });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(await readJson(res)).toMatchObject({ code: 'unauthorized' });
      }
    }
  });

  it('404s unknown comedians, notes and tags and 400s bad ids', async () => {
    expect((await get('/api/comedians/999')).status).toBe(404);
    expect((await get('/api/comedians/999/card')).status).toBe(404);
    expect((await get('/api/comedians/999/notes')).status).toBe(404);
    expect((await send('PATCH', '/api/notes/999', { body: 'x' })).status).toBe(404);
    expect((await send('DELETE', '/api/tags/999')).status).toBe(404);
    const bad = await get('/api/comedians/abc');
    expect(bad.status).toBe(400);
    expect(await readJson(bad)).toMatchObject({ code: 'invalid_id' });
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('GET /api/comedians', () => {
  it('lists active comedians by name with tags, next-month submission and upcoming count', async () => {
    const today = clubToday(t.db);
    const nextMonth = addMonths(monthOf(today), 1);
    const zed = createComedian(t.db, { name: 'zed Alpha', email: 'zed@example.test' });
    const amy = createComedian(t.db, { name: 'Amy Beta', email: 'amy@example.test' });
    createComedian(t.db, { name: 'Old Timer', email: 'old@example.test', archived: true });
    const hosts = createTag(t.db, { name: 'Hosts' });
    const allStars = createTag(t.db, { name: 'All Stars' });
    tagComedian(t.db, amy.id, hosts.id);
    tagComedian(t.db, amy.id, allStars.id);
    createSubmission(t.db, amy.id, nextMonth);
    createSubmission(t.db, zed.id, monthOf(today)); // this month doesn't count

    const location = createLocation(t.db);
    const future = createShow(t.db, { locationId: location.id, date: addDays(today, 3) });
    const todayShow = createShow(t.db, { locationId: location.id, date: today });
    const past = createShow(t.db, { locationId: location.id, date: addDays(today, -3) });
    const cancelled = createShow(t.db, { locationId: location.id, date: addDays(today, 5), status: 'cancelled' });
    for (const show of [future, todayShow, past, cancelled]) createBooking(t.db, { showId: show.id, comedianId: amy.id });

    const list = await ok<ComedianListItem[]>(get('/api/comedians'));
    expect(list.map((c) => c.name)).toEqual(['Amy Beta', 'zed Alpha']);
    expect(list[0]).toMatchObject({
      id: amy.id,
      email: 'amy@example.test',
      archived: false,
      nextMonthSubmitted: true,
      upcomingCount: 2, // today + future; not past or cancelled
      tags: [
        { id: allStars.id, name: 'All Stars', color: allStars.color },
        { id: hosts.id, name: 'Hosts', color: hosts.color },
      ],
    });
    expect(list[1]).toMatchObject({ nextMonthSubmitted: false, upcomingCount: 0, tags: [] });
  });

  it('includes archived comedians only with archived=1', async () => {
    createComedian(t.db, { name: 'Active' });
    createComedian(t.db, { name: 'Archived', archived: true });
    expect((await ok<ComedianListItem[]>(get('/api/comedians'))).map((c) => c.name)).toEqual(['Active']);
    const all = await ok<ComedianListItem[]>(get('/api/comedians?archived=1'));
    expect(all.map((c) => [c.name, c.archived])).toEqual([
      ['Active', false],
      ['Archived', true],
    ]);
  });

  it('searches name and email case-insensitively, treating % and _ literally', async () => {
    createComedian(t.db, { name: 'Jason Lee', email: 'jl@example.test' });
    createComedian(t.db, { name: 'Maria Gomez', email: 'maria.jason@example.test' });
    createComedian(t.db, { name: 'Pat Smith', email: 'pat_s@example.test' });
    createComedian(t.db, { name: 'Pete Simms', email: 'petes@example.test' });
    const names = async (q: string) =>
      (await ok<ComedianListItem[]>(get(`/api/comedians?search=${encodeURIComponent(q)}`))).map((c) => c.name);
    expect(await names('JASON')).toEqual(['Jason Lee', 'Maria Gomez']);
    expect(await names('t_s')).toEqual(['Pat Smith']);
    expect(await names('%')).toEqual([]);
    expect(await names('  gomez ')).toEqual(['Maria Gomez']);
  });

  it('filters by any of several tags', async () => {
    const a = createComedian(t.db, { name: 'A' });
    const b = createComedian(t.db, { name: 'B' });
    createComedian(t.db, { name: 'C' });
    const hosts = createTag(t.db);
    const headliners = createTag(t.db);
    tagComedian(t.db, a.id, hosts.id);
    tagComedian(t.db, b.id, headliners.id);
    tagComedian(t.db, b.id, hosts.id);
    const names = async (q: string) => (await ok<ComedianListItem[]>(get(`/api/comedians?${q}`))).map((c) => c.name);
    expect(await names(`tagIds=${hosts.id}`)).toEqual(['A', 'B']);
    expect(await names(`tagIds=${headliners.id}`)).toEqual(['B']);
    expect(await names(`tagIds=${hosts.id},${headliners.id}`)).toEqual(['A', 'B']);
    expect((await get('/api/comedians?tagIds=x')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Create, update, archive
// ---------------------------------------------------------------------------

describe('POST /api/comedians', () => {
  it('creates a comedian from just a name and email (lowercased)', async () => {
    const res = await send('POST', '/api/comedians', { name: '  Jason   Lee ', email: ' Jason@Example.TEST ' });
    const body = await ok<ComedianDetail>(res, 201);
    expect(body).toMatchObject({
      name: 'Jason Lee',
      email: 'jason@example.test',
      bio: '',
      headshotUrl: '',
      archived: false,
      tags: [],
      upcomingCount: 0,
      lastLoginAt: null,
    });
    expect(t.db.select().from(comedians).where(eq(comedians.id, body.id)).get()?.email).toBe('jason@example.test');
  });

  it('409s email_taken (case-insensitively, including archived comedians)', async () => {
    const existing = createComedian(t.db, { name: 'Jason Lee', email: 'jason@example.test', archived: true });
    const res = await send('POST', '/api/comedians', { name: 'Other Jason', email: 'JASON@example.test' });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({
      code: 'email_taken',
      existing: { id: existing.id, name: 'Jason Lee', archived: true },
    });
  });

  it('validates name and email', async () => {
    for (const body of [{ name: '', email: 'a@b.test' }, { name: 'A', email: 'nope' }, { name: 'A' }, {}]) {
      const res = await send('POST', '/api/comedians', body);
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error' });
    }
  });
});

describe('GET/PATCH /api/comedians/:id', () => {
  it('returns the profile and lets a booker edit name, email, bio and headshot', async () => {
    const comic = createComedian(t.db, { name: 'Jason', email: 'jason@example.test' });
    const tag = createTag(t.db, { name: 'Hosts' });
    tagComedian(t.db, comic.id, tag.id);
    expect(await ok<ComedianDetail>(get(`/api/comedians/${comic.id}`))).toMatchObject({
      id: comic.id,
      name: 'Jason',
      tags: [{ id: tag.id, name: 'Hosts' }],
    });

    const updated = await ok<ComedianDetail>(
      send('PATCH', `/api/comedians/${comic.id}`, {
        name: 'Jason Lee',
        email: 'NEW@example.test',
        bio: '  Dry wit.  ',
        headshotUrl: 'https://img.example.test/jason.jpg',
      }),
    );
    expect(updated).toMatchObject({
      name: 'Jason Lee',
      email: 'new@example.test',
      bio: 'Dry wit.',
      headshotUrl: 'https://img.example.test/jason.jpg',
    });
    // Clearing the headshot is allowed.
    expect((await ok<ComedianDetail>(send('PATCH', `/api/comedians/${comic.id}`, { headshotUrl: '' }))).headshotUrl).toBe('');
  });

  it('409s when changing to another comedian’s email, allows keeping your own', async () => {
    const a = createComedian(t.db, { email: 'a@example.test' });
    createComedian(t.db, { email: 'b@example.test' });
    const clash = await send('PATCH', `/api/comedians/${a.id}`, { email: 'B@example.test' });
    expect(clash.status).toBe(409);
    expect(await readJson(clash)).toMatchObject({ code: 'email_taken' });
    await ok(send('PATCH', `/api/comedians/${a.id}`, { email: 'a@example.test', name: 'Still A' }));
  });

  it('validates the patch', async () => {
    const comic = createComedian(t.db);
    for (const body of [{}, { headshotUrl: 'javascript:alert(1)' }, { headshotUrl: 'not a url' }, { bio: 'x'.repeat(1001) }, { name: ' ' }]) {
      const res = await send('PATCH', `/api/comedians/${comic.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('archiving hides them from the list, revokes their sessions and blocks sign-in; restoring brings them back', async () => {
    const comic = createComedian(t.db, { name: 'Jason', email: 'jason@example.test' });
    const { headers: comedianHeaders } = await loginAsComedian(t, comic.id);
    expect((await get('/api/auth/me', comedianHeaders)).status).toBe(200);

    const archived = await ok<ComedianDetail>(send('PATCH', `/api/comedians/${comic.id}`, { archived: true }));
    expect(archived.archived).toBe(true);
    expect(await ok<ComedianListItem[]>(get('/api/comedians'))).toEqual([]);
    expect(t.db.select().from(sessions).where(eq(sessions.subjectId, comic.id)).all().filter((s) => s.kind === 'comedian')).toEqual([]);
    expect((await readJson<{ comedian: unknown }>(await get('/api/auth/me', comedianHeaders))).comedian).toBeNull();

    // Code sign-in is refused (no code is emailed to archived comedians).
    await send('POST', '/api/auth/comedian/request-code', { email: 'jason@example.test' }, { cookie: '' });
    expect(emailsTo(t.db, 'jason@example.test')).toEqual([]);

    await ok(send('PATCH', `/api/comedians/${comic.id}`, { archived: false }));
    expect((await ok<ComedianListItem[]>(get('/api/comedians'))).map((c) => c.id)).toEqual([comic.id]);
  });
});

// ---------------------------------------------------------------------------
// Bulk add
// ---------------------------------------------------------------------------

describe('bulk add', () => {
  it('parses Name, email / Name <email> / email, Name / tabs / "Name email" lines', () => {
    const text = [
      'Jason Lee, Jason@Example.com',
      '',
      '  "Maria Gomez" <maria@example.com>  ',
      'pat@example.com, Pat Smith',
      'Sam Jones\tsam@example.com',
      'Chris Rock chris@example.com',
      'no email here',
      'only@example.com',
      'Bad Email, nope@',
    ].join('\n');
    expect(parseBulkLines(text)).toEqual([
      { line: 1, raw: 'Jason Lee, Jason@Example.com', name: 'Jason Lee', email: 'jason@example.com' },
      { line: 3, raw: '"Maria Gomez" <maria@example.com>', name: 'Maria Gomez', email: 'maria@example.com' },
      { line: 4, raw: 'pat@example.com, Pat Smith', name: 'Pat Smith', email: 'pat@example.com' },
      { line: 5, raw: 'Sam Jones\tsam@example.com', name: 'Sam Jones', email: 'sam@example.com' },
      { line: 6, raw: 'Chris Rock chris@example.com', name: 'Chris Rock', email: 'chris@example.com' },
      { line: 7, raw: 'no email here', name: 'no email here', email: '' },
      { line: 8, raw: 'only@example.com', name: '', email: 'only@example.com' },
      { line: 9, raw: 'Bad Email, nope@', name: 'Bad Email', email: 'nope@' },
    ]);
  });

  it('flags missing names, invalid emails and in-batch duplicates without a database', () => {
    expect(
      checkBulkRows([
        { name: 'A', email: 'a@example.com' },
        { name: '', email: 'b@example.com' },
        { name: 'C', email: 'nope' },
        { name: 'A again', email: 'A@example.com' },
        { name: 'D', email: 'd@example.com' },
      ]),
    ).toEqual([null, 'missing_name', 'invalid_email', 'duplicate', null]);
  });

  it('dry run previews without writing; the real run creates valid rows and reports skips', async () => {
    const existing = createComedian(t.db, { name: 'Already Here', email: 'here@example.test' });
    const rows = [
      { name: 'New One', email: 'One@Example.test' },
      { name: '', email: 'noname@example.test' },
      { name: 'Bad', email: 'bad@' },
      { name: 'Dup', email: 'one@example.test' },
      { name: 'Here Again', email: 'HERE@example.test' },
      { name: 'New Two', email: 'two@example.test' },
    ];

    const preview = await ok<BulkAddResult>(send('POST', '/api/comedians/bulk', { rows, dryRun: true }));
    expect(preview.dryRun).toBe(true);
    expect(preview.created).toEqual([
      { index: 0, id: 0, name: 'New One', email: 'one@example.test' },
      { index: 5, id: 0, name: 'New Two', email: 'two@example.test' },
    ]);
    expect(preview.skipped).toEqual([
      { index: 1, row: rows[1], reason: 'missing_name' },
      { index: 2, row: rows[2], reason: 'invalid_email' },
      { index: 3, row: rows[3], reason: 'duplicate' },
      { index: 4, row: rows[4], reason: 'email_taken', existing: { id: existing.id, name: 'Already Here', archived: false } },
    ]);
    expect(t.db.select().from(comedians).all()).toHaveLength(1);

    const result = await ok<BulkAddResult>(send('POST', '/api/comedians/bulk', { rows }), 201);
    expect(result.dryRun).toBe(false);
    expect(result.created.map((c) => c.email)).toEqual(['one@example.test', 'two@example.test']);
    expect(result.created.every((c) => c.id > 0)).toBe(true);
    expect(result.skipped.map((s) => s.reason)).toEqual(['missing_name', 'invalid_email', 'duplicate', 'email_taken']);
    const names = (await ok<ComedianListItem[]>(get('/api/comedians'))).map((c) => c.name);
    expect(names).toEqual(['Already Here', 'New One', 'New Two']);

    // Re-running is idempotent: everything is now taken.
    const again = await ok<BulkAddResult>(send('POST', '/api/comedians/bulk', { rows: [rows[0], rows[5]] }));
    expect(again.created).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(['email_taken', 'email_taken']);
  });

  it('validates the envelope', async () => {
    expect((await send('POST', '/api/comedians/bulk', { rows: [] })).status).toBe(400);
    expect((await send('POST', '/api/comedians/bulk', { rows: [{ name: 'x' }] })).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ name: `C ${i}`, email: `c${i}@example.test` }));
    expect((await send('POST', '/api/comedians/bulk', { rows: tooMany })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tags on comedians
// ---------------------------------------------------------------------------

describe('comedian tags', () => {
  it('PUT /comedians/:id/tags replaces the set', async () => {
    const comic = createComedian(t.db);
    const a = createTag(t.db, { name: 'Alpha' });
    const b = createTag(t.db, { name: 'Bravo' });
    const c = createTag(t.db, { name: 'Charlie' });
    tagComedian(t.db, comic.id, a.id);

    const set = await ok<TagSummary[]>(send('PUT', `/api/comedians/${comic.id}/tags`, { tagIds: [c.id, b.id, b.id] }));
    expect(set.map((tag) => tag.name)).toEqual(['Bravo', 'Charlie']);
    expect(await ok<TagSummary[]>(send('PUT', `/api/comedians/${comic.id}/tags`, { tagIds: [] }))).toEqual([]);

    const unknown = await send('PUT', `/api/comedians/${comic.id}/tags`, { tagIds: [a.id, 999] });
    expect(unknown.status).toBe(400);
    expect(await readJson(unknown)).toMatchObject({ code: 'unknown_tag', missing: [999] });
    expect(t.db.select().from(comedianTags).all()).toEqual([]); // unchanged by the failed request
  });

  it('POST /comedians/bulk-tag adds and removes a tag for many comedians', async () => {
    const [x, y, z] = [createComedian(t.db), createComedian(t.db), createComedian(t.db)];
    const tag = createTag(t.db);
    tagComedian(t.db, x.id, tag.id);

    const added = await ok<BulkUpdateResult>(
      send('POST', '/api/comedians/bulk-tag', { comedianIds: [x.id, y.id, z.id], tagId: tag.id, action: 'add' }),
    );
    expect(added.updated).toBe(2); // x already had it
    expect(t.db.select().from(comedianTags).where(eq(comedianTags.tagId, tag.id)).all()).toHaveLength(3);

    const removed = await ok<BulkUpdateResult>(
      send('POST', '/api/comedians/bulk-tag', { comedianIds: [x.id, y.id], tagId: tag.id, action: 'remove' }),
    );
    expect(removed.updated).toBe(2);
    expect(t.db.select().from(comedianTags).all().map((r) => r.comedianId)).toEqual([z.id]);

    expect((await send('POST', '/api/comedians/bulk-tag', { comedianIds: [x.id], tagId: 999, action: 'add' })).status).toBe(404);
    const unknown = await send('POST', '/api/comedians/bulk-tag', { comedianIds: [x.id, 999], tagId: tag.id, action: 'add' });
    expect(unknown.status).toBe(400);
    expect(await readJson(unknown)).toMatchObject({ code: 'unknown_comedian' });
    expect((await send('POST', '/api/comedians/bulk-tag', { comedianIds: [x.id], tagId: tag.id, action: 'toggle' })).status).toBe(400);
  });

  it('POST /comedians/bulk-archive archives and restores many comedians', async () => {
    const [x, y] = [createComedian(t.db), createComedian(t.db)];
    createSession(t.db, 'comedian', x.id);
    const res = await ok<BulkUpdateResult>(send('POST', '/api/comedians/bulk-archive', { comedianIds: [x.id, y.id], archived: true }));
    expect(res.updated).toBe(2);
    expect(await ok<ComedianListItem[]>(get('/api/comedians'))).toEqual([]);
    expect(t.db.select().from(sessions).all().filter((s) => s.kind === 'comedian')).toEqual([]);
    const restored = await ok<BulkUpdateResult>(send('POST', '/api/comedians/bulk-archive', { comedianIds: [x.id], archived: false }));
    expect(restored.updated).toBe(1);
    expect((await ok<ComedianListItem[]>(get('/api/comedians'))).map((c) => c.id)).toEqual([x.id]);
  });
});

// ---------------------------------------------------------------------------
// Tags CRUD
// ---------------------------------------------------------------------------

describe('tags', () => {
  it('lists tags by name with active member counts', async () => {
    const hosts = createTag(t.db, { name: 'hosts' });
    const allStars = createTag(t.db, { name: 'All Stars' });
    const active = createComedian(t.db);
    const archived = createComedian(t.db, { archived: true });
    tagComedian(t.db, active.id, hosts.id);
    tagComedian(t.db, archived.id, hosts.id);
    const list = await ok<TagWithCount[]>(get('/api/tags'));
    expect(list.map((tag) => [tag.name, tag.memberCount])).toEqual([
      ['All Stars', 0],
      ['hosts', 1],
    ]);
    expect(list[0]).toMatchObject({ id: allStars.id, color: allStars.color });
    expect(list[0]!.createdAt).toBeTypeOf('number');
  });

  it('creates with a default palette color, rejects duplicate names case-insensitively', async () => {
    const first = await ok<TagWithCount>(send('POST', '/api/tags', { name: '  Bullet   Spots ' }), 201);
    expect(first).toMatchObject({ name: 'Bullet Spots', color: TAG_PALETTE[0], memberCount: 0 });
    const second = await ok<TagWithCount>(send('POST', '/api/tags', { name: 'Hosts', color: TAG_PALETTE[2] }), 201);
    expect(second.color).toBe(TAG_PALETTE[2]);
    // The default skips colors already in use.
    const third = await ok<TagWithCount>(send('POST', '/api/tags', { name: 'Headliners' }), 201);
    expect(third.color).toBe(TAG_PALETTE[1]);

    const dup = await send('POST', '/api/tags', { name: 'bullet spots' });
    expect(dup.status).toBe(409);
    expect(await readJson(dup)).toMatchObject({ code: 'tag_exists', existing: { id: first.id } });
    expect((await send('POST', '/api/tags', { name: '' })).status).toBe(400);
    expect((await send('POST', '/api/tags', { name: 'X', color: 'red' })).status).toBe(400);
  });

  it('renames and recolors; rename clashes 409 but changing your own case is fine', async () => {
    const tag = createTag(t.db, { name: 'Hosts', color: '#7c5cff' });
    createTag(t.db, { name: 'Headliners' });
    expect(await ok<TagWithCount>(send('PATCH', `/api/tags/${tag.id}`, { name: 'MCs', color: '#3b82f6' }))).toMatchObject({
      name: 'MCs',
      color: '#3b82f6',
    });
    expect((await send('PATCH', `/api/tags/${tag.id}`, { name: 'mcs' })).status).toBe(200);
    const clash = await send('PATCH', `/api/tags/${tag.id}`, { name: 'HEADLINERS' });
    expect(clash.status).toBe(409);
    expect(await readJson(clash)).toMatchObject({ code: 'tag_exists' });
    expect((await send('PATCH', `/api/tags/${tag.id}`, {})).status).toBe(400);
  });

  it('deletes a tag and its memberships, not the comedians', async () => {
    const tag = createTag(t.db);
    const comic = createComedian(t.db);
    tagComedian(t.db, comic.id, tag.id);
    expect(await ok(send('DELETE', `/api/tags/${tag.id}`))).toEqual({ ok: true });
    expect(t.db.select().from(tags).all()).toEqual([]);
    expect(t.db.select().from(comedianTags).all()).toEqual([]);
    expect((await ok<ComedianListItem[]>(get('/api/comedians'))).map((c) => c.id)).toEqual([comic.id]);
  });
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

describe('notes', () => {
  it('any booker adds notes; listed newest first with author names', async () => {
    const comic = createComedian(t.db);
    const created = await ok<NoteDto>(send('POST', `/api/comedians/${comic.id}/notes`, { body: '  Killed at the late show.  ' }), 201);
    expect(created).toMatchObject({
      comedianId: comic.id,
      body: 'Killed at the late show.',
      authorId: bookerId,
      authorName: 'Dana Booker',
      canEdit: true,
    });
    createNote(t.db, { comedianId: comic.id, authorId: null, body: 'From a removed booker', createdAt: Date.now() - 60_000 });
    createNote(t.db, { comedianId: comic.id, authorId: bookerId, body: 'Newest', createdAt: Date.now() + 60_000 });

    const list = await ok<NoteDto[]>(get(`/api/comedians/${comic.id}/notes`));
    expect(list.map((n) => n.body)).toEqual(['Newest', 'Killed at the late show.', 'From a removed booker']);
    expect(list[2]).toMatchObject({ authorId: null, authorName: null, canEdit: false });

    expect((await send('POST', `/api/comedians/${comic.id}/notes`, { body: '   ' })).status).toBe(400);
    expect((await send('POST', `/api/comedians/${comic.id}/notes`, { body: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('only the author or an admin can edit or delete a note', async () => {
    const comic = createComedian(t.db);
    const mine = createNote(t.db, { comedianId: comic.id, authorId: bookerId, body: 'Mine' });
    const other = await loginAsBooker(t, { role: 'booker', name: 'Other Booker' });
    const admin = await loginAsBooker(t, { role: 'admin', name: 'Admin' });

    const otherView = await ok<NoteDto[]>(get(`/api/comedians/${comic.id}/notes`, other.headers));
    expect(otherView[0]!.canEdit).toBe(false);

    const denied = await send('PATCH', `/api/notes/${mine.id}`, { body: 'Hacked' }, other.headers);
    expect(denied.status).toBe(403);
    expect(await readJson(denied)).toMatchObject({ code: 'forbidden' });
    expect((await send('DELETE', `/api/notes/${mine.id}`, undefined, other.headers)).status).toBe(403);

    const edited = await ok<NoteDto>(send('PATCH', `/api/notes/${mine.id}`, { body: 'Mine, edited' }));
    expect(edited).toMatchObject({ body: 'Mine, edited', canEdit: true });
    expect(edited.updatedAt).toBeGreaterThanOrEqual(edited.createdAt);

    const adminEdit = await ok<NoteDto>(send('PATCH', `/api/notes/${mine.id}`, { body: 'Admin fix' }, admin.headers));
    expect(adminEdit).toMatchObject({ body: 'Admin fix', authorName: 'Dana Booker', canEdit: true });
    expect(await ok(send('DELETE', `/api/notes/${mine.id}`, undefined, admin.headers))).toEqual({ ok: true });
    expect(t.db.select().from(notes).all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hover card
// ---------------------------------------------------------------------------

describe('GET /api/comedians/:id/card', () => {
  it('returns profile basics, tags and the latest 3 notes with the total count', async () => {
    const comic = createComedian(t.db, {
      name: 'Jason Lee',
      email: 'jason@example.test',
      bio: 'Deadpan storyteller.',
      headshotUrl: 'https://img.example.test/j.jpg',
    });
    const tag = createTag(t.db, { name: 'Hosts' });
    tagComedian(t.db, comic.id, tag.id);
    const base = Date.now() - 10 * 60_000;
    for (let i = 1; i <= 5; i++) createNote(t.db, { comedianId: comic.id, authorId: bookerId, body: `Note ${i}`, createdAt: base + i * 1000 });
    createNote(t.db, { comedianId: createComedian(t.db).id, authorId: bookerId, body: 'Someone else' });

    const card = await ok<ComedianCard>(get(`/api/comedians/${comic.id}/card`));
    expect(card).toMatchObject({
      id: comic.id,
      name: 'Jason Lee',
      email: 'jason@example.test',
      bio: 'Deadpan storyteller.',
      headshotUrl: 'https://img.example.test/j.jpg',
      archived: false,
      tags: [{ id: tag.id, name: 'Hosts', color: tag.color }],
      noteCount: 5,
    });
    expect(card.notes.map((n) => n.body)).toEqual(['Note 5', 'Note 4', 'Note 3']);
    expect(card.notes[0]).toMatchObject({ authorName: 'Dana Booker' });
  });

  it('works for archived comedians and comedians without notes', async () => {
    const comic = createComedian(t.db, { archived: true });
    expect(await ok<ComedianCard>(get(`/api/comedians/${comic.id}/card`))).toMatchObject({
      archived: true,
      notes: [],
      noteCount: 0,
      tags: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Availability & bookings
// ---------------------------------------------------------------------------

describe('GET /api/comedians/:id/availability', () => {
  it('returns the month’s entries, submission time, all-night range and spots', async () => {
    const comic = createComedian(t.db);
    createAvailability(t.db, { comedianId: comic.id, date: '2026-12-04', startMin: 1260, endMin: 1380 });
    createAvailability(t.db, { comedianId: comic.id, date: '2026-12-31' });
    createAvailability(t.db, { comedianId: comic.id, date: '2026-11-30' }); // other month
    createAvailability(t.db, { comedianId: createComedian(t.db).id, date: '2026-12-05' }); // other comedian
    createSubmission(t.db, comic.id, '2026-12', 1_790_000_000_000);
    const show = createShow(t.db, { date: '2026-12-04', startMin: 1290, name: 'Late Show' });
    createBooking(t.db, { showId: show.id, comedianId: comic.id, confirmedAt: Date.now() });
    const cancelled = createShow(t.db, { date: '2026-12-11', status: 'cancelled' });
    createBooking(t.db, { showId: cancelled.id, comedianId: comic.id });

    const dec = await ok<ComedianAvailability>(get(`/api/comedians/${comic.id}/availability?month=2026-12`));
    expect(dec.month).toBe('2026-12');
    expect(dec.entries).toEqual([
      { date: '2026-12-04', startMin: 1260, endMin: 1380 },
      { date: '2026-12-31', startMin: 1140, endMin: 1380 },
    ]);
    expect(dec.submittedAt).toBe(1_790_000_000_000);
    expect(dec.allNight).toEqual({ startMin: 1140, endMin: 1380 });
    expect(dec.bookings).toHaveLength(1);
    expect(dec.bookings[0]).toMatchObject({ date: '2026-12-04', startMin: 1290, showName: 'Late Show', status: 'confirmed' });

    const jan = await ok<ComedianAvailability>(get(`/api/comedians/${comic.id}/availability?month=2027-01`));
    expect(jan).toMatchObject({ entries: [], submittedAt: null, bookings: [] });

    const current = await ok<ComedianAvailability>(get(`/api/comedians/${comic.id}/availability`));
    expect(current.month).toBe(monthOf(clubToday(t.db)));
    expect(current.today).toBe(clubToday(t.db));

    expect((await get(`/api/comedians/${comic.id}/availability?month=2026-13`)).status).toBe(400);
  });
});

describe('GET /api/comedians/:id/bookings', () => {
  it('upcoming=1 lists scheduled spots from today on, soonest first, with derived status', async () => {
    const today = clubToday(t.db);
    const comic = createComedian(t.db);
    const cellar = createLocation(t.db, { name: 'The Cellar', address: '1 Main St', color: '#7c5cff' });
    const tonight = createShow(t.db, { locationId: cellar.id, date: today, startMin: 1140, name: 'Early' });
    const later = createShow(t.db, { locationId: cellar.id, date: addDays(today, 2), startMin: 1260 });
    const laterEarly = createShow(t.db, { locationId: cellar.id, date: addDays(today, 2), startMin: 1170 });
    const past = createShow(t.db, { locationId: cellar.id, date: addDays(today, -1) });
    const cancelled = createShow(t.db, { locationId: cellar.id, date: addDays(today, 1), status: 'cancelled' });
    createBooking(t.db, { showId: tonight.id, comedianId: comic.id, confirmationSentAt: Date.now() });
    createBooking(t.db, { showId: later.id, comedianId: comic.id, confirmationSentAt: Date.now(), position: 2 });
    createBooking(t.db, { showId: laterEarly.id, comedianId: comic.id, confirmedAt: Date.now(), overrideUnavailable: true });
    createBooking(t.db, { showId: past.id, comedianId: comic.id });
    createBooking(t.db, { showId: cancelled.id, comedianId: comic.id });

    const upcoming = await ok<ComedianBooking[]>(get(`/api/comedians/${comic.id}/bookings?upcoming=1`));
    expect(upcoming.map((b) => [b.date, b.startMin, b.status])).toEqual([
      [today, 1140, 'unconfirmed_today'],
      [addDays(today, 2), 1170, 'confirmed'],
      [addDays(today, 2), 1260, 'awaiting'],
    ]);
    expect(upcoming[0]).toMatchObject({
      showId: tonight.id,
      showName: 'Early',
      showStatus: 'scheduled',
      position: 0,
      location: { id: cellar.id, name: 'The Cellar', color: '#7c5cff', address: '1 Main St' },
    });
    expect(upcoming[1]!.overrideUnavailable).toBe(true);
    expect(upcoming[2]!.position).toBe(2);

    const all = await ok<ComedianBooking[]>(get(`/api/comedians/${comic.id}/bookings`));
    expect(all).toHaveLength(5);
    expect(all[0]!.date >= all[4]!.date).toBe(true); // newest first
    expect(all.find((b) => b.showId === cancelled.id)?.showStatus).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// Send sign-in link
// ---------------------------------------------------------------------------

describe('POST /api/comedians/:id/send-login-link', () => {
  it('emails a working magic link (outbox when SMTP is not configured)', async () => {
    const comic = createComedian(t.db, { name: 'Jason Lee', email: 'jason@example.test' });
    const res = await ok<SendLoginLinkResponse>(send('POST', `/api/comedians/${comic.id}/send-login-link`));
    expect(res).toEqual({ ok: true, status: 'outbox' });

    const email = latestEmail(t.db, 'jason@example.test');
    expect(email).toMatchObject({ kind: 'login_link', status: 'outbox', comedianId: comic.id });
    expect(email!.subject).toContain('Test Comedy Club');
    expect(email!.bodyText).toContain('Hey Jason');
    const url = new RegExp(`${TEST_APP_URL}/portal/magic/([A-Za-z0-9_-]+)`).exec(email!.bodyText);
    expect(url).not.toBeNull();
    expect(email!.bodyHtml).toContain(url![0]);

    const magic = await send('POST', '/api/auth/magic', { token: url![1] }, { cookie: '' });
    const body = await ok<MagicLinkResponse>(magic);
    expect(body).toMatchObject({ redirectTo: '/portal', comedian: { id: comic.id, email: 'jason@example.test' } });
    const me = await readJson<{ comedian: { id: number } | null }>(await get('/api/auth/me', { cookie: cookieFrom(magic) }));
    expect(me.comedian?.id).toBe(comic.id);
  });

  it('refuses archived comedians', async () => {
    const comic = createComedian(t.db, { archived: true });
    const res = await send('POST', `/api/comedians/${comic.id}/send-login-link`);
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ code: 'archived' });
    expect(emailsTo(t.db)).toEqual([]);
  });
});
