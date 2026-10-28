import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SetupInput } from '../../shared/schemas';
import type { MeResponse } from '../../shared/types';
import { locations, users } from '../db/schema';
import { getSettings } from '../lib/settings';
import { cookieFrom, makeTestApp, readJson, type TestApp } from '../test/helpers';

let t: TestApp;

beforeEach(() => {
  t = makeTestApp({ setupComplete: false, settings: { clubName: '', appUrl: '' } });
});

afterEach(() => {
  t.close();
});

const input: SetupInput = {
  clubName: 'The Laugh Track',
  timezone: 'America/Chicago',
  appUrl: 'https://booking.laughtrack.test/',
  admin: { name: 'Dana Whitfield', email: 'Dana@LaughTrack.test', password: 'comedy123' },
  location: { name: 'The Cellar', address: '214 Sullivan St' },
};

function postSetup(body: unknown) {
  return t.request('/api/setup', { method: 'POST', json: body });
}

describe('first-run setup', () => {
  it('reports that setup is needed', async () => {
    const status = await t.request('/api/setup/status');
    expect(await readJson(status)).toEqual({ setupComplete: false });
    const me = await readJson<MeResponse>(await t.request('/api/auth/me'));
    expect(me).toMatchObject({ setupComplete: false, booker: null, comedian: null });
  });

  it('creates the club, the first location and the admin, and signs the admin in', async () => {
    const res = await postSetup(input);
    expect(res.status).toBe(201);
    const body = await readJson<{ booker: MeResponse['booker'] }>(res);
    expect(body.booker).toMatchObject({ email: 'dana@laughtrack.test', name: 'Dana Whitfield', role: 'admin' });

    const settings = getSettings(t.db);
    expect(settings).toMatchObject({
      clubName: 'The Laugh Track',
      timezone: 'America/Chicago',
      appUrl: 'https://booking.laughtrack.test',
      setupComplete: true,
    });
    expect(t.db.select().from(locations).all()).toMatchObject([
      { name: 'The Cellar', address: '214 Sullivan St', color: '#7c5cff', sortOrder: 0, archived: false },
    ]);
    const admins = t.db.select().from(users).all();
    expect(admins).toHaveLength(1);
    expect(admins[0]!.passwordHash).toMatch(/^\$2[aby]\$/);

    // https app URL → Secure cookie; the session works.
    expect(res.headers.getSetCookie().join('\n')).toMatch(/Secure/);
    const me = await readJson<MeResponse>(await t.request('/api/auth/me', { headers: { cookie: cookieFrom(res) } }));
    expect(me).toMatchObject({ setupComplete: true, booker: { role: 'admin' }, club: { name: 'The Laugh Track' } });

    // The admin can now log in with the password.
    const login = await t.request('/api/auth/login', {
      method: 'POST',
      json: { email: 'dana@laughtrack.test', password: 'comedy123' },
    });
    expect(login.status).toBe(200);
  });

  it('only works once', async () => {
    expect((await postSetup(input)).status).toBe(201);
    const again = await postSetup({ ...input, clubName: 'Hijacked' });
    expect(again.status).toBe(409);
    expect(await readJson(again)).toMatchObject({ code: 'already_setup' });
    expect(getSettings(t.db).clubName).toBe('The Laugh Track');
    expect(t.db.select().from(users).all()).toHaveLength(1);
  });

  it('is refused on an app that is already set up', async () => {
    t.close();
    t = makeTestApp();
    const res = await postSetup(input);
    expect(res.status).toBe(409);
  });

  it('validates the input', async () => {
    for (const bad of [
      { ...input, timezone: 'Mars/Olympus_Mons' },
      { ...input, appUrl: 'not a url' },
      { ...input, admin: { ...input.admin, password: 'short' } },
      { ...input, admin: { ...input.admin, email: 'nope' } },
      { ...input, location: { name: '' } },
      { ...input, clubName: '   ' },
    ]) {
      const res = await postSetup(bad);
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error' });
    }
    expect(getSettings(t.db).setupComplete).toBe(false);
  });
});
