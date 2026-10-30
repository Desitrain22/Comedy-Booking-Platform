import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminMeResponse } from '../../shared/api/platformAdmin';
import { cookieFrom, readJson } from '../test/helpers';
import { makeHostedTestApp, type HostedTestApp, type MakeHostedTestAppOptions } from '../test/hosted';
import { ADMIN_CODE_TTL_MS, ADMIN_SESSION_TTL_MS, createAdminSession } from './adminAuth';
import { adminLoginCodes, adminSessions } from './schema';

const OWNER = 'owner@platform.test';
let h: HostedTestApp;

function makeApp(options: MakeHostedTestAppOptions = {}) {
  h?.close();
  h = makeHostedTestApp(options);
  return h;
}

beforeEach(() => {
  h = makeHostedTestApp();
});

afterEach(() => {
  vi.useRealTimers();
  h.close();
});

const admin = (path: string) => h.platformUrl(`/api/platform/admin${path}`);

async function requestCode(email: string, headers?: { cookie: string }) {
  return h.request(admin('/request-code'), { method: 'POST', json: { email }, headers });
}

async function verify(email: string, code: string, headers?: { cookie: string }) {
  return h.request(admin('/verify-code'), { method: 'POST', json: { email, code }, headers });
}

/** The code in the newest owner-console email to `email` (outbox rows keep the body). */
function latestCode(email = OWNER): string {
  const row = h.platformEmails('admin_login_code').find((r) => r.toEmail === email);
  const code = /\b(\d{6})\b/.exec(row?.bodyText ?? '')?.[1];
  if (!code) throw new Error(`No owner-console code for ${email}`);
  return code;
}

async function signIn(email = OWNER): Promise<{ cookie: string }> {
  expect((await requestCode(email)).status).toBe(200);
  const res = await verify(email, latestCode(email));
  expect(res.status).toBe(200);
  return { cookie: cookieFrom(res) };
}

async function me(headers?: { cookie: string }): Promise<AdminMeResponse> {
  return readJson<AdminMeResponse>(await h.request(admin('/me'), { headers }));
}

describe('request a code', () => {
  it('emails a 6-digit code to a listed owner (case-insensitive) and always answers ok', async () => {
    const res = await requestCode('  Owner@Platform.TEST ');
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true });
    const [email] = h.platformEmails('admin_login_code');
    expect(email).toMatchObject({ toEmail: OWNER, status: 'outbox' });
    expect(email!.subject).toMatch(/^\d{6} is your Comedy Booking owner console code$/);
    expect(email!.bodyText).toContain('expires in 10 minutes');
    const codes = h.platform.db.select().from(adminLoginCodes).all();
    expect(codes).toHaveLength(1);
    // Stored hashed, never the code itself.
    expect(codes[0]!.codeHash).not.toContain(latestCode());
  });

  it('sends nothing to an address that isn’t an owner’s, with the same answer', async () => {
    const res = await requestCode('stranger@example.test');
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true });
    expect(h.platformEmails()).toHaveLength(0);
    expect(h.platform.db.select().from(adminLoginCodes).all()).toHaveLength(0);
  });

  it('rejects a malformed email', async () => {
    const res = await requestCode('not-an-email');
    expect(res.status).toBe(400);
    expect((await readJson<{ code: string }>(res)).code).toBe('validation_error');
  });
});

describe('verify a code', () => {
  it('signs in: a 7-day HttpOnly SameSite=Strict cookie, the session stored hashed', async () => {
    await requestCode(OWNER);
    const res = await verify(OWNER, latestCode());
    expect(res.status).toBe(200);
    expect(await readJson<AdminMeResponse>(res)).toEqual({ admin: { email: OWNER } });

    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/^cbp_platform=[^;]+;/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain(`Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`);
    expect(setCookie).not.toContain('Secure');

    const token = /cbp_platform=([^;]+)/.exec(setCookie)![1]!;
    const [session] = h.platform.db.select().from(adminSessions).all();
    expect(session!.email).toBe(OWNER);
    expect(session!.id).not.toBe(token);

    const cookie = cookieFrom(res);
    expect(await me({ cookie })).toEqual({ admin: { email: OWNER } });
    expect((await h.request(admin('/overview'), { headers: { cookie } })).status).toBe(200);
  });

  it('accepts the code with spaces, once only', async () => {
    await requestCode(OWNER);
    const code = latestCode();
    expect((await verify(OWNER, `${code.slice(0, 3)} ${code.slice(3)}`)).status).toBe(200);
    const again = await verify(OWNER, code);
    expect(again.status).toBe(400);
    expect((await readJson<{ code: string }>(again)).code).toBe('invalid_code');
  });

  it('a wrong code: 400 invalid_code; after 5 wrong tries even the right code fails', async () => {
    await requestCode(OWNER);
    const code = latestCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await verify(OWNER, wrong);
      expect(res.status).toBe(400);
      expect((await readJson<{ code: string }>(res)).code).toBe('invalid_code');
    }
    expect((await verify(OWNER, code)).status).toBe(400);
    // A new code works again.
    await requestCode(OWNER);
    expect((await verify(OWNER, latestCode())).status).toBe(200);
  });

  it('a code expires after 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T17:00:00Z'));
    await requestCode(OWNER);
    const code = latestCode();
    vi.setSystemTime(Date.now() + ADMIN_CODE_TTL_MS + 1000);
    expect((await verify(OWNER, code)).status).toBe(400);
  });

  it('still works just inside the 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T17:00:00Z'));
    await requestCode(OWNER);
    const code = latestCode();
    vi.setSystemTime(Date.now() + ADMIN_CODE_TTL_MS - 1000);
    expect((await verify(OWNER, code)).status).toBe(200);
  });

  it('asking again retires the older code', async () => {
    await requestCode(OWNER);
    const first = latestCode();
    await requestCode(OWNER);
    const second = latestCode();
    if (first !== second) expect((await verify(OWNER, first)).status).toBe(400);
    expect((await verify(OWNER, second)).status).toBe(200);
  });

  it('an address that isn’t an owner’s never signs in', async () => {
    const res = await verify('stranger@example.test', '123456');
    expect(res.status).toBe(400);
    expect((await readJson<{ code: string }>(res)).code).toBe('invalid_code');
    expect(h.platform.db.select().from(adminSessions).all()).toHaveLength(0);
  });
});

describe('sessions', () => {
  it('only count while the address is still in PLATFORM_ADMIN_EMAILS', async () => {
    const { cookie } = await signIn();
    h.hosted.adminEmails = ['someone-else@platform.test'];
    expect(await me({ cookie })).toEqual({ admin: null });
    const res = await h.request(admin('/overview'), { headers: { cookie } });
    expect(res.status).toBe(401);
    expect((await readJson<{ code: string }>(res)).code).toBe('unauthorized');
    // The stale session is gone for good: listing the address again doesn't revive it.
    expect(h.platform.db.select().from(adminSessions).all()).toHaveLength(0);
    h.hosted.adminEmails = [OWNER];
    expect(await me({ cookie })).toEqual({ admin: null });
  });

  it('expire after 7 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T17:00:00Z'));
    const { token } = createAdminSession(h.platform.db, OWNER);
    const cookie = `cbp_platform=${token}`;
    vi.setSystemTime(Date.now() + ADMIN_SESSION_TTL_MS - 60_000);
    expect(await me({ cookie })).toEqual({ admin: { email: OWNER } });
    vi.setSystemTime(Date.now() + 120_000);
    expect(await me({ cookie })).toEqual({ admin: null });
  });

  it('sign out deletes the session and clears the cookie', async () => {
    const { cookie } = await signIn();
    const res = await h.request(admin('/logout'), { method: 'POST', json: {}, headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join('\n')).toMatch(/cbp_platform=;/);
    expect(h.platform.db.select().from(adminSessions).all()).toHaveLength(0);
    expect(await me({ cookie })).toEqual({ admin: null });
  });

  it('a club booker session is no owner session', async () => {
    h.createClub({ slug: 'broadway' });
    const { headers } = h.loginAsBooker('broadway');
    expect(await me(headers)).toEqual({ admin: null });
  });

  it('over https: a __Host- Secure cookie, and a plain one is ignored', async () => {
    makeApp({ hosted: { platformUrl: 'https://comedy.test', platformHost: 'comedy.test', protocol: 'https:' } });
    await requestCode(OWNER);
    const res = await verify(OWNER, latestCode());
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/^__Host-cbp_platform=[^;]+;/);
    expect(setCookie).toContain('Secure');
    const token = /__Host-cbp_platform=([^;]+)/.exec(setCookie)![1]!;
    expect(await me({ cookie: `__Host-cbp_platform=${token}` })).toEqual({ admin: { email: OWNER } });
    expect(await me({ cookie: `cbp_platform=${token}` })).toEqual({ admin: null });
  });
});

describe('platform host only', () => {
  it('club hosts answer 404 not_found for every owner-console route', async () => {
    h.createClub({ slug: 'broadway' });
    const { cookie } = await signIn();
    for (const [method, path] of [
      ['GET', '/me'],
      ['POST', '/request-code'],
      ['POST', '/verify-code'],
      ['GET', '/overview'],
      ['GET', '/clubs/1'],
      ['POST', '/clubs/1/suspend'],
      ['GET', '/clubs/1/backup'],
    ] as const) {
      const res = await h.request(h.clubUrl('broadway', `/api/platform/admin${path}`), {
        method,
        headers: { cookie },
        ...(method === 'POST' ? { json: { email: OWNER, code: '123456' } } : {}),
      });
      expect(res.status, path).toBe(404);
      expect((await readJson<{ code: string }>(res)).code, path).toBe('not_found');
    }
    expect(h.platformEmails('admin_login_code')).toHaveLength(1);
  });

  it('www. is the platform host too', async () => {
    const { cookie } = await signIn();
    const res = await h.request('http://www.localhost:3000/api/platform/admin/me', { headers: { cookie } });
    expect(await readJson(res)).toEqual({ admin: { email: OWNER } });
  });

  it('every console route needs a session', async () => {
    const { club } = h.createClub({ slug: 'broadway' });
    for (const [method, path] of [
      ['GET', '/overview'],
      ['GET', `/clubs/${club.id}`],
      ['POST', `/clubs/${club.id}/suspend`],
      ['POST', `/clubs/${club.id}/reactivate`],
      ['POST', `/clubs/${club.id}/archive`],
      ['POST', `/clubs/${club.id}/restore`],
      ['GET', `/clubs/${club.id}/backup`],
    ] as const) {
      const res = await h.request(admin(path), { method, ...(method === 'POST' ? { json: {} } : {}) });
      expect(res.status, path).toBe(401);
    }
    expect(h.platform.registry.getClubById(club.id)!.status).toBe('active');
  });
});

describe('rate limits', () => {
  it('code requests per IP: 429 past the limit', async () => {
    makeApp({ platformRateLimits: { adminCodeRequestsPerIp: { limit: 2, windowMs: 60_000 } } });
    expect((await requestCode('a@example.test')).status).toBe(200);
    expect((await requestCode('b@example.test')).status).toBe(200);
    const res = await requestCode(OWNER);
    expect(res.status).toBe(429);
    expect((await readJson<{ code: string }>(res)).code).toBe('rate_limited');
    expect(h.platformEmails()).toHaveLength(0);
  });

  it('codes per address: past the limit the answer is still ok, but nothing is sent', async () => {
    makeApp({ platformRateLimits: { adminCodeEmailsPerAddress: { limit: 2, windowMs: 60_000 } } });
    for (let i = 0; i < 4; i++) expect((await requestCode(OWNER)).status).toBe(200);
    expect(h.platformEmails('admin_login_code')).toHaveLength(2);
  });

  it('wrong codes per IP and per email: 429 past the limit', async () => {
    makeApp({
      platformRateLimits: {
        adminCodeFailuresPerIp: { limit: 3, windowMs: 60_000 },
        adminCodeFailuresPerEmail: { limit: 100, windowMs: 60_000 },
      },
    });
    for (let i = 0; i < 3; i++) expect((await verify(`x${i}@example.test`, '123456')).status).toBe(400);
    expect((await verify(OWNER, '123456')).status).toBe(429);

    makeApp({
      platformRateLimits: {
        adminCodeFailuresPerIp: { limit: 100, windowMs: 60_000 },
        adminCodeFailuresPerEmail: { limit: 2, windowMs: 60_000 },
      },
    });
    await requestCode(OWNER);
    const code = latestCode();
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await verify(OWNER, wrong)).status).toBe(400);
    expect((await verify(OWNER, wrong)).status).toBe(400);
    const res = await verify(OWNER, code);
    expect(res.status).toBe(429);
    // Another address isn't held up.
    expect((await verify('other@example.test', '123456')).status).toBe(400);
  });

  it('a successful sign-in takes its attempt back', async () => {
    makeApp({ platformRateLimits: { adminCodeFailuresPerIp: { limit: 2, windowMs: 60_000 } } });
    await signIn();
    await signIn();
    await signIn();
    expect(h.platform.db.select().from(adminSessions).where(eq(adminSessions.email, OWNER)).all()).toHaveLength(3);
  });
});
