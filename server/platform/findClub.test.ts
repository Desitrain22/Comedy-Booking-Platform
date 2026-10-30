import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../db/schema';
import { createComedian, createUser, readJson } from '../test/helpers';
import { makeHostedTestApp, type HostedTestApp } from '../test/hosted';
import { findClubsFor } from './routes';

let h: HostedTestApp;

beforeEach(() => {
  h = makeHostedTestApp();
});

afterEach(() => {
  h.close();
});

function findClub(email: string) {
  return h.request(h.platformUrl('/api/platform/find-club'), { method: 'POST', json: { email } });
}

const PERSON = 'dana@example.test';

/** Dana: booker at Alpha, comedian at Bravo, both at Charlie; comedian at a suspended and an archived club. */
function seedClubs() {
  const alpha = h.createClub({ slug: 'alpha', name: 'Alpha Laughs' });
  createUser(alpha.db, { email: PERSON, name: 'Dana', role: 'booker' });
  const bravo = h.createClub({ slug: 'bravo', name: 'Bravo Room' });
  createComedian(bravo.db, { email: PERSON, name: 'Dana' });
  const charlie = h.createClub({ slug: 'charlie', name: 'Charlie Club' });
  createUser(charlie.db, { email: PERSON, name: 'Dana', role: 'admin' });
  createComedian(charlie.db, { email: PERSON, name: 'Dana' });
  const paused = h.createClub({ slug: 'paused', name: 'Paused Club' });
  createComedian(paused.db, { email: PERSON });
  h.platform.registry.setClubStatus(paused.club.id, 'suspended');
  const gone = h.createClub({ slug: 'gone', name: 'Gone Club' });
  createComedian(gone.db, { email: PERSON });
  h.platform.registry.setClubStatus(gone.club.id, 'archived');
  // Not Dana: an archived comedian, a booker who never accepted their invite.
  const delta = h.createClub({ slug: 'delta', name: 'Delta' });
  createComedian(delta.db, { email: 'archived@example.test', archived: true });
  createUser(delta.db, { email: 'invited@example.test', passwordHash: null });
  return { alpha, bravo, charlie };
}

describe('POST /api/platform/find-club', () => {
  it('emails one message listing the active clubs, with the right sign-in links', async () => {
    seedClubs();
    const res = await findClub('  DANA@example.test ');
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true });

    const sent = h.platformEmails('find_club');
    expect(sent).toHaveLength(1);
    const email = sent[0]!;
    expect(email).toMatchObject({ toEmail: PERSON, subject: 'Your clubs on Comedy Booking', status: 'outbox' });
    const body = email.bodyText;
    expect(body).toContain('Alpha Laughs');
    expect(body).toContain('Booker sign-in: http://alpha.localhost:3000/login');
    expect(body).not.toContain('http://alpha.localhost:3000/portal/login');
    expect(body).toContain('Bravo Room');
    expect(body).toContain('Comedian sign-in: http://bravo.localhost:3000/portal/login');
    expect(body).not.toContain('http://bravo.localhost:3000/login');
    expect(body).toContain('Booker sign-in: http://charlie.localhost:3000/login');
    expect(body).toContain('Comedian sign-in: http://charlie.localhost:3000/portal/login');
    expect(body).not.toContain('Paused Club');
    expect(body).not.toContain('Gone Club');
  });

  it("uses the club's current name", async () => {
    const { alpha } = seedClubs();
    const { updateSettings } = await import('../lib/settings');
    updateSettings(alpha.db, { clubName: 'Alpha Renamed' });
    expect(findClubsFor(h.platform, PERSON).map((c) => c.clubName)).toEqual(['Alpha Renamed', 'Bravo Room', 'Charlie Club']);
  });

  it('answers the same for unknown addresses and sends nothing (no enumeration)', async () => {
    seedClubs();
    for (const email of ['nobody@example.test', 'archived@example.test', 'invited@example.test']) {
      const res = await findClub(email);
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ ok: true });
    }
    expect(h.platformEmails()).toEqual([]);
  });

  it('validates the email', async () => {
    const res = await findClub('not-an-email');
    expect(res.status).toBe(400);
  });

  it('sends at most 3 emails per address per hour, still answering ok', async () => {
    seedClubs();
    for (let i = 0; i < 5; i++) {
      const res = await findClub(PERSON);
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ ok: true });
    }
    expect(h.platformEmails('find_club')).toHaveLength(3);
  });

  it('rate-limits requests per IP (429), known address or not', async () => {
    h.close();
    h = makeHostedTestApp({ platformRateLimits: { findClubPerIp: { limit: 3, windowMs: 60_000 } } });
    for (let i = 0; i < 3; i++) expect((await findClub(`n${i}@example.test`)).status).toBe(200);
    const limited = await findClub('another@example.test');
    expect(limited.status).toBe(429);
    expect((await readJson<{ code: string }>(limited)).code).toBe('rate_limited');
  });

  it('only on the platform host', async () => {
    seedClubs();
    const res = await h.request(h.clubUrl('alpha', '/api/platform/find-club'), { method: 'POST', json: { email: PERSON } });
    expect(res.status).toBe(404);
    expect(h.platformEmails()).toEqual([]);
  });

  it('keeps going when one club database fails', async () => {
    const { alpha } = seedClubs();
    alpha.db.$client.exec('DROP TABLE comedians');
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      expect((await findClub(PERSON)).status).toBe(200);
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
    const body = h.platformEmails('find_club')[0]!.bodyText;
    expect(body).not.toContain('Alpha Laughs');
    expect(body).toContain('Bravo Room');
    expect(alpha.db.select().from(users).all().length).toBeGreaterThan(0);
  });
});
