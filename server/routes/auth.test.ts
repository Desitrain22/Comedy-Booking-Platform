import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InviteInfo, MagicLinkResponse, MeResponse } from '../../shared/types';
import { CODE_MAX_ATTEMPTS, CODE_RATE_LIMIT } from '../auth/codes';
import { createInvite } from '../auth/invites';
import { requireAdmin, requireBooker } from '../auth/middleware';
import { SESSION_COOKIES } from '../auth/sessions';
import { confirmTokenExpiry, createConfirmLink, createLoginLink, findConfirmToken } from '../auth/tokens';
import type { AppEnv } from '../context';
import { comedians, loginCodes, sessions, tokens, users } from '../db/schema';
import {
  TEST_APP_URL,
  TEST_PASSWORD,
  cookieFrom,
  createComedian,
  createUser,
  emailsTo,
  latestEmail,
  loginAsBooker,
  loginAsComedian,
  makeTestApp,
  readJson,
  withCookies,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';

let t: TestApp;

beforeEach(() => {
  t = makeTestApp();
});

afterEach(() => {
  t.close();
});

async function getMe(headers?: AuthHeaders): Promise<MeResponse> {
  const res = await t.request('/api/auth/me', { headers });
  expect(res.status).toBe(200);
  return readJson<MeResponse>(res);
}

function post(path: string, json: unknown, headers?: AuthHeaders) {
  return t.request(path, { method: 'POST', json, headers });
}

/** The token at the end of an absolute link like http://…/portal/magic/<token>. */
function tokenFromUrl(url: string): string {
  return url.split('/').pop()!;
}

/** The 6-digit code in the newest login email to `email`. */
function latestCode(email: string): string {
  const row = latestEmail(t.db, email);
  expect(row?.kind).toBe('login_code');
  const code = /\b(\d{6})\b/.exec(row!.bodyText)?.[1];
  expect(code).toBeDefined();
  return code!;
}

/** A 6-digit code guaranteed to differ from `code`. */
function wrongCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

// ---------------------------------------------------------------------------
// Bookers
// ---------------------------------------------------------------------------

describe('booker login', () => {
  it('signs in with email + password and /me returns the booker', async () => {
    const user = createUser(t.db, { email: 'dana@example.test', name: 'Dana', role: 'admin' });
    const res = await post('/api/auth/login', { email: '  Dana@Example.TEST ', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ booker: { id: user.id, email: 'dana@example.test', name: 'Dana', role: 'admin' } });

    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIES.booker}=`, 'm'));
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Secure/); // app URL is http

    const me = await getMe({ cookie: cookieFrom(res) });
    expect(me.booker).toEqual({ id: user.id, email: 'dana@example.test', name: 'Dana', role: 'admin' });
    expect(me.comedian).toBeNull();
    expect(me.setupComplete).toBe(true);
    expect(me.club).toEqual({ name: 'Test Comedy Club', timezone: 'America/New_York', allNight: { startMin: 1140, endMin: 1380 } });

    const row = t.db.select().from(users).where(eq(users.id, user.id)).get()!;
    expect(row.lastLoginAt).toBeTypeOf('number');
    // The DB stores only the sha256 of the session token.
    const token = cookieFrom(res).split('=')[1]!;
    const stored = t.db.select().from(sessions).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).not.toBe(token);
    expect(stored[0]!.kind).toBe('booker');
  });

  it('rejects a wrong password, an unknown email and a pending invitee with the same 401', async () => {
    createUser(t.db, { email: 'dana@example.test' });
    createUser(t.db, { email: 'pending@example.test', passwordHash: null });
    for (const body of [
      { email: 'dana@example.test', password: 'nope-nope' },
      { email: 'nobody@example.test', password: TEST_PASSWORD },
      { email: 'pending@example.test', password: TEST_PASSWORD },
    ]) {
      const res = await post('/api/auth/login', body);
      expect(res.status).toBe(401);
      expect(await readJson(res)).toEqual({ error: 'Wrong email or password', code: 'invalid_credentials' });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it('validates the body', async () => {
    const res = await post('/api/auth/login', { email: 'not-an-email', password: '' });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ code: 'validation_error' });
  });

  it('marks the cookie Secure when the app URL is https', async () => {
    t.close();
    t = makeTestApp({ settings: { appUrl: 'https://booking.example.com' } });
    createUser(t.db, { email: 'dana@example.test' });
    const res = await post('/api/auth/login', { email: 'dana@example.test', password: TEST_PASSWORD });
    expect(res.headers.getSetCookie().join('\n')).toMatch(/Secure/);
  });

  it('logs out: deletes the session and clears the cookie', async () => {
    const { headers } = await loginAsBooker(t);
    expect((await getMe(headers)).booker).not.toBeNull();

    const res = await post('/api/auth/logout', {}, headers);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join('\n')).toMatch(new RegExp(`${SESSION_COOKIES.booker}=;`));
    expect(t.db.select().from(sessions).all()).toHaveLength(0);
    expect((await getMe(headers)).booker).toBeNull();
  });

  it('is anonymous without a cookie, with a garbage cookie, or with an expired session', async () => {
    expect(await getMe()).toMatchObject({ booker: null, comedian: null });
    expect(await getMe({ cookie: `${SESSION_COOKIES.booker}=garbage` })).toMatchObject({ booker: null });

    const { headers } = await loginAsBooker(t);
    t.db.update(sessions).set({ expiresAt: Date.now() - 1000 }).run();
    expect((await getMe(headers)).booker).toBeNull();
  });
});

describe('requireBooker / requireAdmin', () => {
  /** A tiny app using the real middleware, to check the guards and the typed c.var.booker. */
  function guardedApp() {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', t.db);
      await next();
    });
    app.get('/booker-only', requireBooker, (c) => c.json({ name: c.var.booker.name }));
    app.get('/admin-only', requireAdmin, (c) => c.json({ role: c.var.booker.role }));
    return app;
  }

  it('401s without a booker session (a comedian session does not count)', async () => {
    const comedian = createComedian(t.db);
    const { headers } = await loginAsComedian(t, comedian.id);
    for (const h of [undefined, headers]) {
      const res = await t.request('/api/locations', { headers: h });
      expect(res.status).toBe(401);
      expect(await readJson(res)).toEqual({ error: 'Please sign in', code: 'unauthorized' });
    }
  });

  it('does not accept a booker token under the comedian cookie name', async () => {
    const { cookie } = await loginAsBooker(t);
    const swapped = cookie.replace(SESSION_COOKIES.booker, SESSION_COOKIES.comedian);
    expect(await getMe({ cookie: swapped })).toMatchObject({ booker: null, comedian: null });
  });

  it('lets bookers through, and only admins through requireAdmin', async () => {
    const app = guardedApp();
    const admin = await loginAsBooker(t, { role: 'admin', name: 'Ada' });
    const booker = await loginAsBooker(t, { role: 'booker', name: 'Bo' });

    expect(await (await app.request('/booker-only', { headers: booker.headers })).json()).toEqual({ name: 'Bo' });
    expect((await app.request('/admin-only', { headers: admin.headers })).status).toBe(200);

    const res = await app.request('/admin-only', { headers: booker.headers });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only admins can do that', code: 'forbidden' });
    expect((await app.request('/admin-only')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

describe('booker invites', () => {
  it('accepts an invite: sets the password, signs in, and burns the link', async () => {
    const { user, inviteUrl } = createInvite(t.db, { email: 'New@Example.test', name: 'Nia New', role: 'booker' });
    expect(user.email).toBe('new@example.test');
    expect(inviteUrl).toMatch(new RegExp(`^${TEST_APP_URL}/accept-invite/[\\w-]{40,}$`));
    const token = tokenFromUrl(inviteUrl);

    const info = await t.request(`/api/auth/invite/${token}`);
    expect(info.status).toBe(200);
    expect(await readJson<InviteInfo>(info)).toEqual({
      email: 'new@example.test',
      name: 'Nia New',
      clubName: 'Test Comedy Club',
    });

    const res = await post('/api/auth/accept-invite', { token, password: 'a-good-password', name: 'Nia' });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ booker: { id: user.id, email: 'new@example.test', name: 'Nia', role: 'booker' } });
    expect((await getMe({ cookie: cookieFrom(res) })).booker?.name).toBe('Nia');

    // The link is single-use…
    expect((await t.request(`/api/auth/invite/${token}`)).status).toBe(404);
    expect((await post('/api/auth/accept-invite', { token, password: 'another-password' })).status).toBe(404);
    // …and the new password works.
    const login = await post('/api/auth/login', { email: 'new@example.test', password: 'a-good-password' });
    expect(login.status).toBe(200);
  });

  it('rejects unknown and expired invites, and short passwords', async () => {
    const { user, inviteUrl } = createInvite(t.db, { email: 'late@example.test', name: 'Late', role: 'booker' });
    const token = tokenFromUrl(inviteUrl);

    const short = await post('/api/auth/accept-invite', { token, password: 'short' });
    expect(short.status).toBe(400);
    expect(await readJson(short)).toMatchObject({ code: 'validation_error' });

    const unknown = await t.request('/api/auth/invite/this-token-does-not-exist');
    expect(unknown.status).toBe(404);
    expect(await readJson(unknown)).toMatchObject({ code: 'invalid_invite' });

    t.db.update(users).set({ inviteExpiresAt: Date.now() - 1000 }).where(eq(users.id, user.id)).run();
    expect((await t.request(`/api/auth/invite/${token}`)).status).toBe(404);
    const expired = await post('/api/auth/accept-invite', { token, password: 'a-good-password' });
    expect(expired.status).toBe(404);
    expect(await readJson(expired)).toMatchObject({ code: 'invalid_invite' });
  });

  it('refuses to invite an existing email', () => {
    createUser(t.db, { email: 'taken@example.test' });
    expect(() => createInvite(t.db, { email: 'TAKEN@example.test', name: 'X', role: 'booker' })).toThrow(
      /already exists/,
    );
  });
});

// ---------------------------------------------------------------------------
// Comedian codes
// ---------------------------------------------------------------------------

describe('comedian sign-in codes', () => {
  it('emails a 6-digit code (stored hashed) and verifying it signs the comedian in', async () => {
    const comedian = createComedian(t.db, { email: 'john@example.test', name: 'John Mercer' });

    const res = await post('/api/auth/comedian/request-code', { email: ' John@Example.test' });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true });

    const email = latestEmail(t.db, 'john@example.test')!;
    expect(email).toMatchObject({ kind: 'login_code', status: 'outbox', comedianId: comedian.id });
    const code = latestCode('john@example.test');
    expect(email.subject).toContain(code);
    expect(email.bodyHtml).toContain(code);
    const stored = t.db.select().from(loginCodes).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.codeHash).not.toContain(code);

    const verify = await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code });
    expect(verify.status).toBe(200);
    expect(await readJson(verify)).toEqual({
      comedian: { id: comedian.id, email: 'john@example.test', name: 'John Mercer' },
    });
    expect(verify.headers.getSetCookie().join('\n')).toMatch(new RegExp(`^${SESSION_COOKIES.comedian}=`, 'm'));

    const me = await getMe({ cookie: cookieFrom(verify) });
    expect(me.comedian).toEqual({ id: comedian.id, email: 'john@example.test', name: 'John Mercer' });
    expect(me.booker).toBeNull();
    expect(t.db.select().from(comedians).where(eq(comedians.id, comedian.id)).get()!.lastLoginAt).toBeTypeOf('number');

    // Codes are single-use.
    const again = await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code });
    expect(again.status).toBe(400);
  });

  it('accepts a pasted code with spaces or dashes', async () => {
    createComedian(t.db, { email: 'john@example.test' });
    await post('/api/auth/comedian/request-code', { email: 'john@example.test' });
    const code = latestCode('john@example.test');
    const pasted = `${code.slice(0, 3)} - ${code.slice(3)}`;
    expect((await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code: pasted })).status).toBe(200);
  });

  it('does not reveal whether an email belongs to a comedian', async () => {
    createComedian(t.db, { email: 'known@example.test' });
    createComedian(t.db, { email: 'archived@example.test', archived: true });

    const responses = await Promise.all(
      ['known@example.test', 'unknown@example.test', 'archived@example.test'].map(async (email) => {
        const res = await post('/api/auth/comedian/request-code', { email });
        return { status: res.status, body: await readJson(res) };
      }),
    );
    expect(responses.every((r) => r.status === 200 && JSON.stringify(r.body) === '{"ok":true}')).toBe(true);
    expect(emailsTo(t.db).map((e) => e.toEmail)).toEqual(['known@example.test']);

    // Verifying for an unknown email fails exactly like a wrong code.
    const unknown = await post('/api/auth/comedian/verify-code', { email: 'unknown@example.test', code: '123456' });
    expect(unknown.status).toBe(400);
    expect(await readJson(unknown)).toEqual({ error: "That code isn't right or has expired", code: 'invalid_code' });
  });

  it('rejects a wrong code and counts the attempt', async () => {
    const comedian = createComedian(t.db, { email: 'john@example.test' });
    await post('/api/auth/comedian/request-code', { email: 'john@example.test' });
    const code = latestCode('john@example.test');

    const res = await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code: wrongCode(code) });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ code: 'invalid_code' });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(t.db.select().from(loginCodes).where(eq(loginCodes.comedianId, comedian.id)).get()!.attempts).toBe(1);

    // The right code still works after a typo.
    expect((await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code })).status).toBe(200);
  });

  it(`locks a code after ${CODE_MAX_ATTEMPTS} wrong attempts; a fresh code works`, async () => {
    createComedian(t.db, { email: 'john@example.test' });
    await post('/api/auth/comedian/request-code', { email: 'john@example.test' });
    const code = latestCode('john@example.test');

    const statuses: number[] = [];
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) {
      const res = await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code: wrongCode(code) });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([...Array<number>(CODE_MAX_ATTEMPTS - 1).fill(400), 429]);

    const locked = await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code });
    expect(locked.status).toBe(429);
    expect(await readJson(locked)).toMatchObject({ code: 'too_many_attempts' });

    await post('/api/auth/comedian/request-code', { email: 'john@example.test' });
    const fresh = latestCode('john@example.test');
    expect((await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code: fresh })).status).toBe(200);
  });

  it('rejects expired codes', async () => {
    createComedian(t.db, { email: 'john@example.test' });
    await post('/api/auth/comedian/request-code', { email: 'john@example.test' });
    const code = latestCode('john@example.test');
    t.db.update(loginCodes).set({ expiresAt: Date.now() - 1000 }).run();
    expect((await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code })).status).toBe(400);
  });

  it('rejects a code once the comedian is archived', async () => {
    const comedian = createComedian(t.db, { email: 'john@example.test' });
    await post('/api/auth/comedian/request-code', { email: 'john@example.test' });
    const code = latestCode('john@example.test');
    t.db.update(comedians).set({ archived: true }).where(eq(comedians.id, comedian.id)).run();
    const res = await post('/api/auth/comedian/verify-code', { email: 'john@example.test', code });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ code: 'invalid_code' });
  });

  it(`sends at most ${CODE_RATE_LIMIT} codes per email per 15 minutes (still answering 200)`, async () => {
    createComedian(t.db, { email: 'john@example.test' });
    for (let i = 0; i < CODE_RATE_LIMIT + 2; i++) {
      const res = await post('/api/auth/comedian/request-code', { email: 'john@example.test' });
      expect(res.status).toBe(200);
    }
    expect(emailsTo(t.db, 'john@example.test')).toHaveLength(CODE_RATE_LIMIT);
  });

  it('signs out of the portal without touching a booker session in the same browser', async () => {
    const comedian = createComedian(t.db);
    const booker = await loginAsBooker(t);
    const comic = await loginAsComedian(t, comedian.id);
    const both = withCookies(booker.headers, comic.headers);

    const me = await getMe(both);
    expect(me.booker?.id).toBe(booker.user.id);
    expect(me.comedian?.id).toBe(comedian.id);

    const res = await post('/api/auth/comedian/logout', {}, both);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join('\n')).toMatch(new RegExp(`${SESSION_COOKIES.comedian}=;`));
    const after = await getMe(both);
    expect(after.comedian).toBeNull();
    expect(after.booker?.id).toBe(booker.user.id);
  });

  it("ends an archived comedian's existing session", async () => {
    const comedian = createComedian(t.db);
    const { headers } = await loginAsComedian(t, comedian.id);
    expect((await getMe(headers)).comedian?.id).toBe(comedian.id);
    t.db.update(comedians).set({ archived: true }).where(eq(comedians.id, comedian.id)).run();
    expect((await getMe(headers)).comedian).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Magic links & confirm links
// ---------------------------------------------------------------------------

describe('magic links', () => {
  it('creates an absolute link that signs the comedian in and redirects, reusable for 30 days', async () => {
    const comedian = createComedian(t.db, { name: 'Maria Delgado' });
    const url = createLoginLink(t.db, comedian.id, { redirectTo: '/portal?month=2026-12' });
    expect(url).toMatch(new RegExp(`^${TEST_APP_URL}/portal/magic/[\\w-]{40,}$`));
    const token = tokenFromUrl(url);

    const row = t.db.select().from(tokens).get()!;
    expect(row.tokenHash).not.toBe(token);
    expect(row.expiresAt - Date.now()).toBeGreaterThan(29 * 86_400_000);

    for (let i = 0; i < 2; i++) {
      const res = await post('/api/auth/magic', { token });
      expect(res.status).toBe(200);
      expect(await readJson<MagicLinkResponse>(res)).toEqual({
        redirectTo: '/portal?month=2026-12',
        comedian: { id: comedian.id, email: comedian.email, name: 'Maria Delgado' },
      });
      expect((await getMe({ cookie: cookieFrom(res) })).comedian?.id).toBe(comedian.id);
    }
    expect(t.db.select().from(tokens).get()!.lastUsedAt).toBeTypeOf('number');
  });

  it('defaults to /portal and never redirects off-site', async () => {
    const comedian = createComedian(t.db);
    for (const redirectTo of [undefined, '//evil.example/steal', 'https://evil.example', '/\\evil']) {
      const token = tokenFromUrl(createLoginLink(t.db, comedian.id, { redirectTo }));
      const res = await post('/api/auth/magic', { token });
      expect((await readJson<MagicLinkResponse>(res)).redirectTo).toBe('/portal');
    }
  });

  it('rejects unknown, expired, confirm-purpose and archived-comedian tokens', async () => {
    const comedian = createComedian(t.db);
    const expect400 = async (token: string) => {
      const res = await post('/api/auth/magic', { token });
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'invalid_token' });
      expect(res.headers.getSetCookie()).toEqual([]);
    };

    await expect400('definitely-not-a-real-token');
    await expect400(tokenFromUrl(createConfirmLink(t.db, comedian.id, '2026-11-02')));

    const expired = tokenFromUrl(createLoginLink(t.db, comedian.id));
    t.db.update(tokens).set({ expiresAt: Date.now() - 1000 }).where(eq(tokens.purpose, 'login')).run();
    await expect400(expired);

    const archived = createComedian(t.db, { archived: true });
    await expect400(tokenFromUrl(createLoginLink(t.db, archived.id)));
  });
});

describe('confirm links', () => {
  it('creates an absolute link valid until the Wednesday after the week (club time)', () => {
    const comedian = createComedian(t.db);
    const url = createConfirmLink(t.db, comedian.id, '2026-11-02');
    expect(url).toMatch(new RegExp(`^${TEST_APP_URL}/portal/confirm/[\\w-]{40,}$`));

    const found = findConfirmToken(t.db, tokenFromUrl(url));
    expect(found).toMatchObject({ comedianId: comedian.id, weekStart: '2026-11-02' });
    // Week Mon Nov 2 – Sun Nov 8 → valid through Tue Nov 10, i.e. until Wed Nov 11 00:00 EST.
    expect(confirmTokenExpiry(t.db, '2026-11-02')).toBe(Date.parse('2026-11-11T05:00:00Z'));
    expect(findConfirmToken(t.db, 'nope-nope-nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe('CSRF protection', () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' };

  it('blocks cross-site form posts', async () => {
    const res = await t.request('/api/auth/logout', {
      method: 'POST',
      headers: { ...form, origin: 'https://evil.example' },
      body: 'x=1',
    });
    expect(res.status).toBe(403);
    expect(await readJson(res)).toMatchObject({ code: 'forbidden' });
  });

  it('allows same-origin posts, including through the Vite dev proxy (Host is preserved)', async () => {
    const viaProxy = await t.app.request('http://localhost:5173/api/auth/logout', {
      method: 'POST',
      headers: { ...form, origin: 'http://localhost:5173' },
      body: 'x=1',
    });
    expect(viaProxy.status).toBe(200);

    const secFetch = await t.app.request('http://club.example/api/auth/logout', {
      method: 'POST',
      headers: { ...form, 'sec-fetch-site': 'same-origin' },
      body: 'x=1',
    });
    expect(secFetch.status).toBe(200);

    // Behind a TLS-terminating proxy the scheme differs but the host matches.
    const tls = await t.app.request('http://booking.example.com/api/auth/logout', {
      method: 'POST',
      headers: { ...form, origin: 'https://booking.example.com' },
      body: 'x=1',
    });
    expect(tls.status).toBe(200);
  });
});
