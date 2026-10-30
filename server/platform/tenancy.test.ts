import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClubNotFoundBody, ClubSuspendedBody, HostContext } from '../../shared/api/platform';
import type { MeResponse } from '../../shared/types';
import { createApp } from '../app';
import { getSettings } from '../lib/settings';
import { createComedian, readJson } from '../test/helpers';
import { makeHostedTestApp, type HostedTestApp } from '../test/hosted';

let h: HostedTestApp;

beforeEach(() => {
  h = makeHostedTestApp();
});

afterEach(() => {
  h.close();
});

describe('GET /api/host', () => {
  it('on the platform host (and www.)', async () => {
    for (const url of [h.platformUrl('/api/host'), 'http://www.localhost:3000/api/host']) {
      const res = await h.request(url);
      expect(res.status).toBe(200);
      expect(await readJson<HostContext>(res)).toEqual({
        mode: 'platform',
        platformName: 'Comedy Booking',
        platformUrl: 'http://localhost:3000',
        signupsOpen: true,
        supportEmail: 'help@platform.test',
      });
    }
  });

  it('on an active club host: the club name from its settings', async () => {
    const { db } = h.createClub({ slug: 'broadway', name: 'Broadway Comedy' });
    const res = await h.request(h.clubUrl('broadway', '/api/host'));
    expect(await readJson<HostContext>(res)).toEqual({
      mode: 'club',
      status: 'active',
      clubName: 'Broadway Comedy',
      platformName: 'Comedy Booking',
      platformUrl: 'http://localhost:3000',
      supportEmail: 'help@platform.test',
    });
    expect(getSettings(db).clubName).toBe('Broadway Comedy');
  });

  it('on a suspended club host: still 200, status suspended', async () => {
    h.createClub({ slug: 'broadway', status: 'suspended' });
    const res = await h.request(h.clubUrl('broadway', '/api/host'));
    expect(res.status).toBe(200);
    expect(await readJson<HostContext>(res)).toMatchObject({ mode: 'club', status: 'suspended' });
  });

  it('on an unknown, archived or foreign host: 404 club_not_found with the platform link', async () => {
    h.createClub({ slug: 'gone', status: 'archived' });
    for (const url of [
      h.clubUrl('nope', '/api/host'),
      h.clubUrl('gone', '/api/host'),
      'http://evil.example/api/host',
      'http://a.b.localhost:3000/api/host',
    ]) {
      const res = await h.request(url);
      expect(res.status, url).toBe(404);
      expect(await readJson<ClubNotFoundBody>(res)).toEqual({
        error: "There's no club at this address",
        code: 'club_not_found',
        platformName: 'Comedy Booking',
        platformUrl: 'http://localhost:3000',
      });
    }
  });

  it('never answers { mode: single } in hosted mode', async () => {
    h.createClub({ slug: 'broadway' });
    const head = await h.request(h.clubUrl('broadway', '/api/host'), { method: 'HEAD' });
    expect(head.status).toBe(200);
    const post = await h.request(h.clubUrl('broadway', '/api/host'), { method: 'POST', json: {} });
    expect(post.status).toBe(404);
    expect(await readJson(post)).not.toMatchObject({ mode: 'single' });
  });

  it('in single-club mode: { mode: single }', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cbp-single-'));
    const { createDb, closeDb } = await import('../db/client');
    const db = createDb(path.join(dir, 'club.db'));
    const app = createApp({ db });
    const res = await app.request('http://anything.example/api/host');
    expect(await readJson<HostContext>(res)).toEqual({ mode: 'single' });
    closeDb(db);
  });
});

describe('host routing', () => {
  it('runs every club route against that club’s own database', async () => {
    const a = h.createClub({ slug: 'alpha' });
    const b = h.createClub({ slug: 'bravo' });
    createComedian(a.db, { name: 'Only In Alpha', email: 'alpha-comic@example.test' });
    const { headers: aHeaders } = h.loginAsBooker('alpha');
    const { headers: bHeaders } = h.loginAsBooker('bravo');

    const rosterA = await readJson<{ name: string }[]>(await h.request(h.clubUrl('alpha', '/api/comedians'), { headers: aHeaders }));
    expect(rosterA.map((c) => c.name)).toContain('Only In Alpha');
    const rosterB = await readJson<{ name: string }[]>(await h.request(h.clubUrl('bravo', '/api/comedians'), { headers: bHeaders }));
    expect(rosterB.map((c) => c.name)).not.toContain('Only In Alpha');
    expect(b.db).not.toBe(a.db);
  });

  it("one club's session cookie means nothing on another club's host", async () => {
    h.createClub({ slug: 'alpha' });
    h.createClub({ slug: 'bravo' });
    const { headers } = h.loginAsBooker('bravo');
    const onB = await readJson<MeResponse>(await h.request(h.clubUrl('bravo', '/api/auth/me'), { headers }));
    expect(onB.booker).not.toBeNull();
    const onA = await readJson<MeResponse>(await h.request(h.clubUrl('alpha', '/api/auth/me'), { headers }));
    expect(onA.booker).toBeNull();
    expect((await h.request(h.clubUrl('alpha', '/api/shows?from=2026-11-01&to=2026-11-30'), { headers })).status).toBe(401);
  });

  it('matches hosts case-insensitively', async () => {
    h.createClub({ slug: 'broadway', name: 'Broadway Comedy' });
    const res = await h.request('http://BROADWAY.LocalHost:3000/api/auth/me');
    expect(res.status).toBe(200);
    expect((await readJson<MeResponse>(res)).club.name).toBe('Broadway Comedy');
  });

  it('includes the port: the same slug on another port is not a club', async () => {
    h.createClub({ slug: 'broadway' });
    const res = await h.request('http://broadway.localhost:4000/api/auth/me');
    expect(res.status).toBe(404);
    expect((await readJson<ClubNotFoundBody>(res)).code).toBe('club_not_found');
  });

  it('answers /api/health on every host', async () => {
    h.createClub({ slug: 'paused', status: 'suspended' });
    for (const url of [
      h.platformUrl('/api/health'),
      h.clubUrl('nope', '/api/health'),
      h.clubUrl('paused', '/api/health'),
      'http://10.0.0.7:3000/api/health',
    ]) {
      expect((await h.request(url)).status, url).toBe(200);
    }
  });

  it('unknown and archived clubs: every API call is 404 club_not_found', async () => {
    h.createClub({ slug: 'gone', status: 'archived' });
    for (const slug of ['nope', 'gone']) {
      for (const [method, p] of [
        ['GET', '/api/auth/me'],
        ['GET', '/api/setup/status'],
        ['POST', '/api/auth/login'],
        ['GET', '/api/platform/slug?slug=abc'],
      ] as const) {
        const res = await h.request(h.clubUrl(slug, p), { method, json: method === 'POST' ? {} : undefined });
        expect(res.status, `${slug} ${p}`).toBe(404);
        expect((await readJson<ClubNotFoundBody>(res)).code).toBe('club_not_found');
      }
    }
  });

  it('suspended clubs: 403 club_suspended for every API call but /api/host and /api/health', async () => {
    const { admin } = h.createClub({ slug: 'paused', status: 'suspended' });
    const { headers } = h.loginAsBooker('paused');
    for (const [method, p] of [
      ['GET', '/api/auth/me'],
      ['GET', '/api/shows?from=2026-11-01&to=2026-11-30'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/comedian/request-code'],
      ['GET', '/api/portal/me'],
      ['POST', '/api/auth/handoff'],
      ['GET', '/api/nope'],
    ] as const) {
      const json = method === 'POST' ? { email: admin.email, password: 'password123' } : undefined;
      const res = await h.request(h.clubUrl('paused', p), { method, headers, json });
      expect(res.status, p).toBe(403);
      expect(await readJson<ClubSuspendedBody>(res)).toEqual({
        error: 'This account is paused',
        code: 'club_suspended',
        supportEmail: 'help@platform.test',
      });
    }
  });

  it('takes a status change into account on the very next request', async () => {
    const { club } = h.createClub({ slug: 'broadway' });
    const url = h.clubUrl('broadway', '/api/auth/me');
    expect((await h.request(url)).status).toBe(200);
    h.platform.registry.setClubStatus(club.id, 'suspended');
    expect((await h.request(url)).status).toBe(403);
    h.platform.registry.setClubStatus(club.id, 'archived');
    expect((await h.request(url)).status).toBe(404);
    h.platform.registry.setClubStatus(club.id, 'active');
    expect((await h.request(url)).status).toBe(200);
  });

  it('the platform host serves only the platform API', async () => {
    for (const [method, p] of [
      ['GET', '/api/auth/me'],
      ['GET', '/api/setup/status'],
      ['POST', '/api/setup'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/handoff'],
      ['GET', '/api/settings'],
      ['GET', '/api/nope'],
    ] as const) {
      const res = await h.request(h.platformUrl(p), { method, json: method === 'POST' ? {} : undefined });
      expect(res.status, p).toBe(404);
      expect(await readJson(res)).toEqual({ error: 'Not found', code: 'not_found' });
    }
    expect((await h.request(h.platformUrl('/api/platform/slug?slug=broadway'))).status).toBe(200);
  });

  it('club hosts never serve the platform API', async () => {
    h.createClub({ slug: 'broadway' });
    for (const [method, p] of [
      ['GET', '/api/platform/slug?slug=abc'],
      ['POST', '/api/platform/signup'],
      ['POST', '/api/platform/find-club'],
      ['GET', '/api/platform'],
    ] as const) {
      const res = await h.request(h.clubUrl('broadway', p), { method, json: method === 'POST' ? {} : undefined });
      expect(res.status, p).toBe(404);
      expect((await readJson<{ code: string }>(res)).code).toBe('not_found');
    }
  });

  it('a club is already set up: /setup refuses', async () => {
    h.createClub({ slug: 'broadway' });
    expect(await readJson(await h.request(h.clubUrl('broadway', '/api/setup/status')))).toEqual({ setupComplete: true });
    const res = await h.request(h.clubUrl('broadway', '/api/setup'), {
      method: 'POST',
      json: {
        clubName: 'Hijack',
        timezone: 'UTC',
        appUrl: 'https://evil.example',
        admin: { name: 'X', email: 'x@evil.example', password: 'password123' },
        location: { name: 'X' },
      },
    });
    expect(res.status).toBe(409);
  });

  it('serves the SPA shell on every host', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cbp-client-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    const app = createApp({ platform: h.platform, clientDir: dir });
    h.createClub({ slug: 'broadway', status: 'suspended' });
    for (const url of [
      'http://localhost:3000/',
      'http://localhost:3000/signup',
      'http://broadway.localhost:3000/app',
      'http://nope.localhost:3000/',
      'http://evil.example/whatever',
    ]) {
      const res = await app.request(url);
      expect(res.status, url).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
    }
  });
});

describe('the club app address in hosted mode', () => {
  it('is pinned to the subdomain, whatever settings say', async () => {
    const { db } = h.createClub({ slug: 'broadway' });
    const { headers } = h.loginAsBooker('broadway');
    const settings = await readJson<{ appUrl: string; effectiveAppUrl: string }>(
      await h.request(h.clubUrl('broadway', '/api/settings'), { headers }),
    );
    expect(settings).toMatchObject({ appUrl: 'http://broadway.localhost:3000', effectiveAppUrl: 'http://broadway.localhost:3000' });
    expect(getSettings(db).appUrl).toBe('http://broadway.localhost:3000');
  });

  it("can't be changed through PUT /api/settings (the same value, or no value, is fine)", async () => {
    const { db } = h.createClub({ slug: 'broadway' });
    const { headers } = h.loginAsBooker('broadway');
    const put = (json: unknown) => h.request(h.clubUrl('broadway', '/api/settings'), { method: 'PUT', headers, json });

    const refused = await put({ appUrl: 'https://evil.example', clubName: 'Renamed' });
    expect(refused.status).toBe(400);
    expect(await readJson(refused)).toMatchObject({
      code: 'app_url_locked',
      error: "Your club's address is http://broadway.localhost:3000 and can't be changed",
      issues: [{ path: 'appUrl' }],
    });
    expect(getSettings(db).clubName).not.toBe('Renamed');

    expect(await readJson(await put({ appUrl: '' }))).toMatchObject({ code: 'app_url_locked' });
    expect((await put({ appUrl: 'http://broadway.localhost:3000/', clubName: 'Same URL' })).status).toBe(200);
    expect(getSettings(db).clubName).toBe('Same URL');
    // No address at all: other fields save as usual.
    expect((await put({ clubName: 'No URL' })).status).toBe(200);
    expect(getSettings(db).clubName).toBe('No URL');
  });

  it('starts every emailed link', async () => {
    const { db } = h.createClub({ slug: 'broadway' });
    const comic = createComedian(db, { email: 'comic@example.test' });
    const res = await h.request(h.clubUrl('broadway', '/api/auth/comedian/request-code'), {
      method: 'POST',
      json: { email: comic.email },
    });
    expect(res.status).toBe(200);
    const { emailsTo } = await import('../test/helpers');
    // Code emails carry no link; a booker invite does.
    expect(emailsTo(db, comic.email)).toHaveLength(1);
    const { headers } = h.loginAsBooker('broadway');
    const invite = await h.request(h.clubUrl('broadway', '/api/users'), {
      method: 'POST',
      headers,
      json: { name: 'Eric Hanson', email: 'eric@broadway.test' },
    });
    expect(invite.status).toBe(201);
    expect(emailsTo(db, 'eric@broadway.test')[0]!.bodyText).toContain('http://broadway.localhost:3000/accept-invite/');
  });
});
