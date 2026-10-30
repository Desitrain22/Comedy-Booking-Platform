import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffResponse, SignupRequest, SignupResponse, SlugCheckResponse } from '../../shared/api/platform';
import type { MeResponse } from '../../shared/types';
import { verifyPassword } from '../auth/password';
import { locations, users } from '../db/schema';
import { getAppUrl, getSettings } from '../lib/settings';
import { cookieFrom, readJson } from '../test/helpers';
import { makeHostedTestApp, type HostedTestApp } from '../test/hosted';
import { createHandoff, HANDOFF_TTL_MS } from './handoffs';
import { handoffs } from './schema';

let h: HostedTestApp;

beforeEach(() => {
  h = makeHostedTestApp();
});

afterEach(() => {
  vi.useRealTimers();
  h.close();
});

const input: SignupRequest = {
  clubName: 'Broadway Comedy',
  slug: 'broadway',
  timezone: 'America/New_York',
  location: { name: 'Broadway Comedy Club', address: '318 W 53rd St' },
  admin: { name: 'Rich Brooks', email: 'Rich@Broadway.test', password: 'laughs-1234' },
  website: '',
};

function signup(body: unknown = input) {
  return h.request(h.platformUrl('/api/platform/signup'), { method: 'POST', json: body });
}

function handoff(slug: string, token: string) {
  return h.request(h.clubUrl(slug, '/api/auth/handoff'), { method: 'POST', json: { token } });
}

const tokenOf = (handoffUrl: string) => new URL(handoffUrl).hash.slice(1);

describe('GET /api/platform/slug', () => {
  const check = async (slug: string) =>
    readJson<SlugCheckResponse>(await h.request(h.platformUrl(`/api/platform/slug?slug=${encodeURIComponent(slug)}`)));

  it('says whether an address is free, and why not', async () => {
    h.createClub({ slug: 'taken' });
    h.createClub({ slug: 'archived-one', status: 'archived' });
    expect(await check(' Broadway ')).toEqual({ slug: 'broadway', available: true });
    expect(await check('taken')).toEqual({ slug: 'taken', available: false, reason: 'That address is taken' });
    expect(await check('archived-one')).toMatchObject({ available: false, reason: 'That address is taken' });
    expect(await check('admin')).toEqual({ slug: 'admin', available: false, reason: 'That address is reserved' });
    expect(await check('ab')).toMatchObject({ available: false, reason: 'At least 3 characters' });
    expect(await check('-bad')).toMatchObject({ available: false, reason: expect.stringContaining('dashes') });
    expect(await check('')).toMatchObject({ available: false });
  });
});

describe('POST /api/platform/signup', () => {
  it('creates the club, sets it up, emails the owner and hands back a handoff URL', async () => {
    const res = await signup();
    expect(res.status).toBe(201);
    const body = await readJson<SignupResponse>(res);
    expect(body.clubUrl).toBe('http://broadway.localhost:3000');
    expect(body.handoffUrl).toMatch(/^http:\/\/broadway\.localhost:3000\/welcome#[\w-]{40,}$/);
    // No cookie on the platform host: the session belongs to the club host.
    expect(res.headers.getSetCookie()).toEqual([]);

    const club = h.platform.registry.getClubBySlug('broadway')!;
    expect(club).toMatchObject({
      name: 'Broadway Comedy',
      status: 'active',
      ownerName: 'Rich Brooks',
      ownerEmail: 'rich@broadway.test',
    });
    const db = h.platform.registry.openClubDb(club);
    expect(getSettings(db)).toMatchObject({
      clubName: 'Broadway Comedy',
      timezone: 'America/New_York',
      appUrl: 'http://broadway.localhost:3000',
      setupComplete: true,
    });
    expect(getAppUrl(db)).toBe('http://broadway.localhost:3000');
    expect(db.select().from(locations).all()).toMatchObject([
      { name: 'Broadway Comedy Club', address: '318 W 53rd St', sortOrder: 0 },
    ]);
    const admin = db.select().from(users).all();
    expect(admin).toMatchObject([{ email: 'rich@broadway.test', name: 'Rich Brooks', role: 'admin' }]);
    expect(await verifyPassword('laughs-1234', admin[0]!.passwordHash)).toBe(true);

    const notices = h.platformEmails('signup_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      toEmail: 'owner@platform.test',
      subject: 'New club: Broadway Comedy — broadway.localhost:3000 — Rich Brooks <rich@broadway.test>',
      status: 'outbox',
    });
    expect(notices[0]!.bodyText).toContain('http://broadway.localhost:3000');
    expect(notices[0]!.bodyText).toContain('America/New_York');
  });

  it('emails every PLATFORM_ADMIN_EMAILS address, and nobody when there are none', async () => {
    h.close();
    h = makeHostedTestApp({ hosted: { adminEmails: ['a@platform.test', 'b@platform.test'] } });
    expect((await signup()).status).toBe(201);
    expect(h.platformEmails('signup_notice').map((e) => e.toEmail).sort()).toEqual(['a@platform.test', 'b@platform.test']);

    h.close();
    h = makeHostedTestApp({ hosted: { adminEmails: [] } });
    expect((await signup()).status).toBe(201);
    expect(h.platformEmails()).toEqual([]);
  });

  it('validates the input (400 with field issues), creating nothing', async () => {
    const cases: [unknown, string][] = [
      [{ ...input, clubName: ' ' }, 'clubName'],
      [{ ...input, slug: 'a' }, 'slug'],
      [{ ...input, slug: 'Bad Slug!' }, 'slug'],
      [{ ...input, timezone: 'Mars/Olympus' }, 'timezone'],
      [{ ...input, location: { name: '' } }, 'location.name'],
      [{ ...input, admin: { ...input.admin, email: 'nope' } }, 'admin.email'],
      [{ ...input, admin: { ...input.admin, password: 'short' } }, 'admin.password'],
      [{}, 'clubName'],
    ];
    for (const [body, path] of cases) {
      const res = await signup(body);
      expect(res.status, path).toBe(400);
      const err = await readJson<{ code: string; issues: { path: string }[] }>(res);
      expect(err.code).toBe('validation_error');
      expect(err.issues.map((i) => i.path), path).toContain(path);
    }
    expect(h.platform.registry.listClubs()).toEqual([]);
  });

  it('refuses reserved and taken addresses', async () => {
    const reserved = await signup({ ...input, slug: 'admin' });
    expect(reserved.status).toBe(400);
    expect(await readJson(reserved)).toMatchObject({ issues: [{ path: 'slug', message: 'That address is reserved' }] });

    expect((await signup()).status).toBe(201);
    const taken = await signup({ ...input, slug: 'BROADWAY', admin: { ...input.admin, email: 'other@x.test' } });
    expect(taken.status).toBe(409);
    expect(await readJson(taken)).toMatchObject({ code: 'slug_taken', issues: [{ path: 'slug' }] });

    const archived = h.platform.registry.getClubBySlug('broadway')!;
    h.platform.registry.setClubStatus(archived.id, 'archived');
    expect((await signup()).status).toBe(409);
    expect(h.platform.registry.listClubs()).toHaveLength(1);
  });

  it('a filled honeypot creates nothing and sends nothing', async () => {
    const res = await signup({ ...input, website: 'http://spam.example' });
    expect(res.status).toBe(400);
    expect((await readJson<{ code: string }>(res)).code).toBe('signup_rejected');
    expect(h.platform.registry.listClubs()).toEqual([]);
    expect(h.platformEmails()).toEqual([]);
  });

  it('allows 5 sign-ups per IP per hour', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T12:00:00Z'), toFake: ['Date'] });
    // The limiter reads the clock it was made with: make the app under the fake clock.
    h.close();
    h = makeHostedTestApp();
    for (let i = 0; i < 5; i++) {
      const res = await signup({ ...input, slug: `club-${i}`, admin: { ...input.admin, email: `o${i}@x.test` } });
      expect(res.status).toBe(201);
    }
    const limited = await signup({ ...input, slug: 'club-5' });
    expect(limited.status).toBe(429);
    expect(await readJson(limited)).toMatchObject({ code: 'rate_limited', retryAfter: expect.any(Number) });
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(h.platform.registry.getClubBySlug('club-5')).toBeNull();

    vi.setSystemTime(new Date('2026-11-02T13:00:01Z'));
    expect((await signup({ ...input, slug: 'club-5' })).status).toBe(201);
  });

  it("a taken slug doesn't use up the limit; the honeypot does", async () => {
    expect((await signup()).status).toBe(201);
    for (let i = 0; i < 6; i++) expect((await signup()).status).toBe(409);
    for (let i = 0; i < 4; i++) expect((await signup({ ...input, slug: `x-${i}`, website: 'spam' })).status).toBe(400);
    expect((await signup({ ...input, slug: 'one-more' })).status).toBe(429);
  });

  it('SIGNUPS=closed: 403 signups_closed with the support email', async () => {
    h.close();
    h = makeHostedTestApp({ hosted: { signupsOpen: false } });
    const res = await signup();
    expect(res.status).toBe(403);
    expect(await readJson(res)).toMatchObject({ code: 'signups_closed', supportEmail: 'help@platform.test' });
    expect(h.platform.registry.listClubs()).toEqual([]);
    const host = await readJson<{ signupsOpen: boolean }>(await h.request(h.platformUrl('/api/host')));
    expect(host.signupsOpen).toBe(false);
  });

  it('rolls the club back when setup fails', async () => {
    const { registry } = h.platform;
    const original = registry.openClubDb.bind(registry);
    const spy = vi.spyOn(registry, 'openClubDb').mockImplementationOnce((club) => {
      const db = original(club);
      db.$client.exec('DROP TABLE locations');
      return db;
    });
    const res = await signup();
    expect(res.status).toBe(500);
    spy.mockRestore();
    expect(registry.getClubBySlug('broadway')).toBeNull();
    expect(h.platformEmails()).toEqual([]);
    expect((await signup()).status).toBe(201);
  });
});

describe('POST /api/auth/handoff', () => {
  async function signedUp() {
    const body = await readJson<SignupResponse>(await signup());
    return tokenOf(body.handoffUrl);
  }

  it('signs the new booker in on the club host, once', async () => {
    const token = await signedUp();
    const res = await handoff('broadway', token);
    expect(res.status).toBe(200);
    expect(await readJson<HandoffResponse>(res)).toMatchObject({
      ok: true,
      booker: { email: 'rich@broadway.test', name: 'Rich Brooks', role: 'admin' },
    });
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/^cbp_booker=/);
    const me = await readJson<MeResponse>(await h.request(h.clubUrl('broadway', '/api/auth/me'), { headers: { cookie } }));
    expect(me.booker?.email).toBe('rich@broadway.test');

    // Reused: refused.
    const again = await handoff('broadway', token);
    expect(again.status).toBe(400);
    expect((await readJson<{ code: string }>(again)).code).toBe('invalid_handoff');
  });

  it("refuses another club's token, and leaves it usable on its own club", async () => {
    const token = await signedUp();
    h.createClub({ slug: 'other' });
    const wrong = await handoff('other', token);
    expect(wrong.status).toBe(400);
    expect((await readJson<{ code: string }>(wrong)).code).toBe('invalid_handoff');
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect((await handoff('broadway', token)).status).toBe(200);
  });

  it('refuses an expired token (2 minutes)', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T12:00:00Z'), toFake: ['Date'] });
    const token = await signedUp();
    vi.setSystemTime(Date.now() + HANDOFF_TTL_MS + 1);
    const res = await handoff('broadway', token);
    expect(res.status).toBe(400);
    expect((await readJson<{ code: string }>(res)).code).toBe('invalid_handoff');
  });

  it('works just before it expires', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T12:00:00Z'), toFake: ['Date'] });
    const token = await signedUp();
    vi.setSystemTime(Date.now() + HANDOFF_TTL_MS - 1000);
    expect((await handoff('broadway', token)).status).toBe(200);
  });

  it('refuses unknown tokens and a booker who no longer exists', async () => {
    await signedUp();
    expect((await handoff('broadway', 'x'.repeat(43))).status).toBe(400);
    const club = h.platform.registry.getClubBySlug('broadway')!;
    const db = h.platform.registry.openClubDb(club);
    const admin = db.select().from(users).get()!;
    const token = createHandoff(h.platform.db, club.id, admin.id);
    db.update(users).set({ passwordHash: null }).where(eq(users.id, admin.id)).run();
    expect((await handoff('broadway', token)).status).toBe(400);
  });

  it('stores only a hash of the token', async () => {
    const token = await signedUp();
    const rows = h.platform.db.select().from(handoffs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is not on the platform host, and 404s in single-club mode', async () => {
    const token = await signedUp();
    const res = await h.request(h.platformUrl('/api/auth/handoff'), { method: 'POST', json: { token } });
    expect(res.status).toBe(404);
    const { makeTestApp } = await import('../test/helpers');
    const single = makeTestApp();
    const res2 = await single.request('/api/auth/handoff', { method: 'POST', json: { token } });
    expect(res2.status).toBe(404);
    expect((await readJson<{ code: string }>(res2)).code).toBe('not_found');
    single.close();
  });
});
