import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../db/schema';
import { getClubHosting } from '../lib/hosting';
import { DEFAULT_RATE_LIMITS, rateLimiter } from '../lib/rateLimit';
import { getAppUrl, getSettings } from '../lib/settings';
import { makeHostedTestApp, type HostedTestApp } from '../test/hosted';
import { SlugTakenError } from './registry';

let h: HostedTestApp;

beforeEach(() => {
  h = makeHostedTestApp();
});

afterEach(() => {
  h.close();
});

const owner = { name: 'Rich Brooks', ownerName: 'Rich Brooks', ownerEmail: 'Rich@Broadway.test' };

describe('club registry', () => {
  it('creates a club: a registry row and its own migrated database', () => {
    const { club, db } = h.platform.registry.createClub({ slug: 'Broadway', ...owner });
    expect(club).toMatchObject({
      slug: 'broadway',
      name: 'Rich Brooks',
      status: 'active',
      statusReason: '',
      ownerEmail: 'rich@broadway.test',
    });
    expect(existsSync(h.platform.registry.clubDbFile(club.id))).toBe(true);
    // The ordinary club schema, empty.
    expect(db.select().from(users).all()).toEqual([]);
    expect(getSettings(db).setupComplete).toBe(false);
  });

  it('looks clubs up by slug (case-insensitive) and id', () => {
    const { club } = h.createClub({ slug: 'broadway' });
    expect(h.platform.registry.getClubBySlug('BROADWAY')?.id).toBe(club.id);
    expect(h.platform.registry.getClubById(club.id)?.slug).toBe('broadway');
    expect(h.platform.registry.getClubBySlug('nope')).toBeNull();
    expect(h.platform.registry.getClubById(999)).toBeNull();
  });

  it('refuses a taken slug, whatever the status of the club holding it', () => {
    const { club } = h.createClub({ slug: 'broadway' });
    h.platform.registry.setClubStatus(club.id, 'archived');
    expect(() => h.platform.registry.createClub({ slug: 'broadway', ...owner })).toThrow(SlugTakenError);
    expect(h.platform.registry.listClubs()).toHaveLength(1);
  });

  it('rolls everything back when init fails, freeing the slug', () => {
    expect(() =>
      h.platform.registry.createClub({ slug: 'broadway', ...owner }, () => {
        throw new Error('setup failed');
      }),
    ).toThrow('setup failed');
    expect(h.platform.registry.getClubBySlug('broadway')).toBeNull();
    expect(h.platform.registry.openClubIds()).toEqual([]);
    expect(readdirSync(h.platform.registry.clubsDir).filter((f) => f.endsWith('.db'))).toEqual([]);
    // …and the address can be taken again.
    expect(h.platform.registry.createClub({ slug: 'broadway', ...owner }).club.slug).toBe('broadway');
  });

  it('never hands an orphaned database file to a new club', () => {
    const { registry } = h.platform;
    const nextId = registry.listClubs().length + 1;
    mkdirSync(registry.clubsDir, { recursive: true });
    writeFileSync(registry.clubDbFile(nextId), 'not a database');
    const { club } = registry.createClub({ slug: 'fresh', ...owner });
    expect(club.id).toBe(nextId);
    expect(getSettings(registry.openClubDb(club)).setupComplete).toBe(false);
    expect(readdirSync(registry.clubsDir).some((f) => f.startsWith(`${nextId}.db.orphaned-`))).toBe(true);
  });

  it('lists clubs by status and search', () => {
    const a = h.createClub({ slug: 'alpha', name: 'Alpha Laughs', admin: { email: 'ann@alpha.test' } }).club;
    const b = h.createClub({ slug: 'bravo', name: 'Bravo Room', status: 'suspended' }).club;
    const c = h.createClub({ slug: 'charlie', name: 'Charlie', status: 'archived' }).club;
    const { registry } = h.platform;
    const slugs = (list: { slug: string }[]) => list.map((x) => x.slug);
    expect(slugs(registry.listClubs())).toEqual(['alpha', 'bravo', 'charlie']);
    expect(slugs(registry.listClubs({ status: 'all' }))).toEqual(['alpha', 'bravo', 'charlie']);
    expect(slugs(registry.listClubs({ status: 'active' }))).toEqual(['alpha']);
    expect(slugs(registry.listClubs({ status: ['suspended', 'archived'] }))).toEqual(['bravo', 'charlie']);
    expect(slugs(registry.listClubs({ status: [] }))).toEqual([]);
    expect(slugs(registry.listClubs({ search: 'ROOM' }))).toEqual(['bravo']);
    expect(slugs(registry.listClubs({ search: 'ann@alpha' }))).toEqual(['alpha']);
    expect(slugs(registry.listClubs({ search: '%' }))).toEqual([]);
    expect([a.id, b.id, c.id]).toHaveLength(3);
  });

  it('caches open databases and reopens closed ones', () => {
    const { club } = h.createClub({ slug: 'broadway' });
    const { registry } = h.platform;
    const db = registry.openClubDb(club);
    expect(registry.openClubDb(club.id)).toBe(db);
    registry.closeClubDb(club.id);
    expect(db.$client.open).toBe(false);
    const again = registry.openClubDb(club);
    expect(again).not.toBe(db);
    expect(getSettings(again).clubName).toBe(club.name);
    expect(() => registry.openClubDb(999)).toThrow('No club with id 999');
  });

  it('gives each club database its own sign-in limiter and pins its app URL', () => {
    const a = h.createClub({ slug: 'alpha' });
    const b = h.createClub({ slug: 'bravo' });
    const limitsA = rateLimiter(a.db);
    expect(limitsA).not.toBe(rateLimiter(b.db));
    expect(limitsA.rules.loginFailuresPerIp).toEqual(DEFAULT_RATE_LIMITS.loginFailuresPerIp);
    expect(getAppUrl(a.db)).toBe('http://alpha.localhost:3000');
    expect(getAppUrl(b.db)).toBe('http://bravo.localhost:3000');
    expect(getClubHosting(a.db)).toEqual({
      hosted: h.hosted,
      clubId: a.club.id,
      slug: 'alpha',
      clubUrl: 'http://alpha.localhost:3000',
    });
  });

  it('sets a status with a reason; archiving closes the database', () => {
    const { club, db } = h.createClub({ slug: 'broadway' });
    const { registry } = h.platform;
    const suspended = registry.setClubStatus(club.id, 'suspended', 'Spam reports');
    expect(suspended).toMatchObject({ status: 'suspended', statusReason: 'Spam reports' });
    expect(suspended!.statusChangedAt).toBeGreaterThan(0);
    expect(db.$client.open).toBe(true);

    expect(registry.setClubStatus(club.id, 'archived')).toMatchObject({ status: 'archived', statusReason: '' });
    expect(db.$client.open).toBe(false);
    expect(registry.openClubIds()).not.toContain(club.id);

    expect(registry.setClubStatus(club.id, 'active')?.status).toBe('active');
    expect(getSettings(registry.openClubDb(club)).setupComplete).toBe(true);
    expect(registry.setClubStatus(999, 'active')).toBeNull();
  });

  it('closes everything on close()', () => {
    const { db } = h.createClub();
    h.platform.close();
    expect(db.$client.open).toBe(false);
    expect(h.platform.db.$client.open).toBe(false);
  });
});
