import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OnboardingResponse } from '../../shared/api/onboarding';
import { availabilityRequests, users } from '../db/schema';
import { updateSettings } from '../lib/settings';
import { buildOnboarding, guideMode, pickSuggestedMonth } from '../services/onboarding';
import {
  createComedian,
  createLocation,
  createShow,
  createUser,
  loginAsBooker,
  loginAsComedian,
  makeTestApp,
  readJson,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';

let t: TestApp;
/** The club's first account (the one /setup would have created). */
let founder: { user: { id: number }; headers: AuthHeaders };

beforeEach(async () => {
  t = makeTestApp();
  founder = await loginAsBooker(t, { role: 'admin', name: 'Rich Brooks' });
});

afterEach(() => {
  t.close();
});

async function getOnboarding(headers: AuthHeaders): Promise<OnboardingResponse> {
  const res = await t.request('/api/onboarding', { headers });
  expect(res.status).toBe(200);
  return readJson<OnboardingResponse>(res);
}

async function post(action: 'dismiss' | 'resume' | 'complete', headers: AuthHeaders): Promise<OnboardingResponse> {
  const res = await t.request(`/api/onboarding/${action}`, { method: 'POST', headers });
  expect(res.status).toBe(200);
  return readJson<OnboardingResponse>(res);
}

const statuses = (o: OnboardingResponse) => o.steps.map((s) => [s.key, s.status]);

function requestAvailability(month: string, kind: 'request' | 'reminder' = 'request') {
  t.db.insert(availabilityRequests)
    .values({ month, kind, message: '', audience: 'all', recipientCount: 1, sentById: founder.user.id, sentAt: Date.now() })
    .run();
}

describe('auth', () => {
  it('every endpoint requires a booker', async () => {
    const comedian = createComedian(t.db);
    const { headers: comedianHeaders } = await loginAsComedian(t, comedian.id);
    const calls: [string, string][] = [
      ['GET', '/api/onboarding'],
      ['POST', '/api/onboarding/dismiss'],
      ['POST', '/api/onboarding/resume'],
      ['POST', '/api/onboarding/complete'],
    ];
    for (const [method, path] of calls) {
      expect((await t.request(path, { method })).status).toBe(401);
      expect((await t.request(path, { method, headers: comedianHeaders })).status).toBe(401);
    }
  });

  it('plain bookers can use it too (it is per booker, not admin-only)', async () => {
    const { headers } = await loginAsBooker(t, { role: 'booker' });
    expect((await t.request('/api/onboarding', { headers })).status).toBe(200);
    expect((await t.request('/api/onboarding/complete', { method: 'POST', headers })).status).toBe(200);
  });
});

describe('steps (derived from club data)', () => {
  it('a club without an active location is still on the club step', async () => {
    const o = await getOnboarding(founder.headers);
    expect(statuses(o)).toEqual([
      ['club', 'current'],
      ['shows', 'todo'],
      ['comedians', 'todo'],
    ]);
    expect(o.currentStep).toBe('club');
    expect(o.counts.locations).toBe(0);
  });

  it('shows: done at 3 scheduled shows; cancelled shows do not count', async () => {
    const location = createLocation(t.db);
    createShow(t.db, { locationId: location.id, date: '2026-11-06' });
    createShow(t.db, { locationId: location.id, date: '2026-11-13' });
    createShow(t.db, { locationId: location.id, date: '2026-11-20', status: 'cancelled' });

    let o = await getOnboarding(founder.headers);
    expect(statuses(o)).toEqual([
      ['club', 'done'],
      ['shows', 'current'],
      ['comedians', 'todo'],
    ]);
    expect(o.steps[1]!.progress).toEqual({ count: 2, target: 3 });
    expect(o.steps[0]!.progress).toBeUndefined();

    createShow(t.db, { locationId: location.id, date: '2026-11-27' });
    o = await getOnboarding(founder.headers);
    expect(o.steps[1]).toEqual({ key: 'shows', status: 'done', progress: { count: 3, target: 3 } });
    expect(o.currentStep).toBe('comedians');
  });

  it('comedians: needs a non-archived comedian AND a request for a month that has shows', async () => {
    const location = createLocation(t.db);
    for (const date of ['2026-11-06', '2026-11-13', '2026-11-20']) createShow(t.db, { locationId: location.id, date });

    createComedian(t.db, { archived: true });
    let o = await getOnboarding(founder.headers);
    expect(o.counts.comedians).toBe(0);
    expect(o.currentStep).toBe('comedians');

    createComedian(t.db);
    o = await getOnboarding(founder.headers);
    expect(o.counts.comedians).toBe(1);
    expect(o.availabilityRequested).toBe(false);
    expect(o.currentStep).toBe('comedians');

    // A request for a month without shows doesn't count.
    requestAvailability('2027-03');
    o = await getOnboarding(founder.headers);
    expect(o.availabilityRequested).toBe(false);
    expect(o.steps[2]!.status).toBe('current');

    requestAvailability('2026-11');
    o = await getOnboarding(founder.headers);
    expect(o.availabilityRequested).toBe(true);
    expect(statuses(o)).toEqual([
      ['club', 'done'],
      ['shows', 'done'],
      ['comedians', 'done'],
    ]);
    expect(o.currentStep).toBeNull();
  });

  it('the real "Request availability" endpoint completes the comedians step (outbox mode)', async () => {
    const location = createLocation(t.db);
    for (const date of ['2026-12-04', '2026-12-11', '2026-12-18']) createShow(t.db, { locationId: location.id, date });
    createComedian(t.db);

    const res = await t.request('/api/availability-requests', {
      method: 'POST',
      headers: founder.headers,
      json: { month: '2026-12', audience: 'all' },
    });
    expect(res.status).toBe(201);
    const o = await getOnboarding(founder.headers);
    expect(o.emailConfigured).toBe(false);
    expect(o.currentStep).toBeNull();
  });

  it('a reminder for a month with shows counts as asking', async () => {
    const location = createLocation(t.db);
    createShow(t.db, { locationId: location.id, date: '2026-11-06' });
    createComedian(t.db);
    requestAvailability('2026-11', 'reminder');
    expect((await getOnboarding(founder.headers)).availabilityRequested).toBe(true);
  });

  it('counts bookers including pending invites, and reports email configuration', async () => {
    createUser(t.db, { passwordHash: null, inviteTokenHash: 'pending', inviteExpiresAt: Date.now() + 60_000 });
    let o = await getOnboarding(founder.headers);
    expect(o.counts.bookers).toBe(2);
    expect(o.emailConfigured).toBe(false);

    updateSettings(t.db, { smtpHost: 'smtp.example.com', fromEmail: 'club@example.com' });
    o = await getOnboarding(founder.headers);
    expect(o.emailConfigured).toBe(true);
  });
});

describe('suggestedMonth', () => {
  it('is the planning month while nothing is scheduled', () => {
    // Oct 30 → planning November (from the 20th on, the next month).
    const o = buildOnboarding(t.db, { id: founder.user.id, role: 'admin' }, new Date('2026-10-30T16:00:00Z'));
    expect(o.suggestedMonth).toBe('2026-11');
    const early = buildOnboarding(t.db, { id: founder.user.id, role: 'admin' }, new Date('2026-10-05T16:00:00Z'));
    expect(early.suggestedMonth).toBe('2026-10');
  });

  it('prefers the planning month when it has shows, else the upcoming month with the most shows', () => {
    const location = createLocation(t.db);
    const now = new Date('2026-10-30T16:00:00Z');
    const booker = { id: founder.user.id, role: 'admin' as const };
    // Past months never win.
    for (const date of ['2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25']) createShow(t.db, { locationId: location.id, date });
    createShow(t.db, { locationId: location.id, date: '2027-01-08' });
    createShow(t.db, { locationId: location.id, date: '2026-12-04' });
    createShow(t.db, { locationId: location.id, date: '2026-12-11' });
    expect(buildOnboarding(t.db, booker, now).suggestedMonth).toBe('2026-12');

    createShow(t.db, { locationId: location.id, date: '2026-11-06' });
    expect(buildOnboarding(t.db, booker, now).suggestedMonth).toBe('2026-11');
  });

  it('pickSuggestedMonth breaks ties on the earliest month', () => {
    expect(pickSuggestedMonth('2026-11', new Map())).toBe('2026-11');
    expect(pickSuggestedMonth('2026-11', new Map([['2027-01', 2], ['2026-12', 2]]))).toBe('2026-12');
    expect(pickSuggestedMonth('2026-11', new Map([['2026-11', 1], ['2026-12', 9]]))).toBe('2026-11');
    expect(pickSuggestedMonth('2026-11', new Map([['2026-11', 0], ['2026-12', 1]]))).toBe('2026-12');
  });
});

describe('mode', () => {
  function setUpClub() {
    const location = createLocation(t.db);
    for (const date of ['2026-11-06', '2026-11-13', '2026-11-20']) createShow(t.db, { locationId: location.id, date });
    createComedian(t.db);
    requestAvailability('2026-11');
  }

  it('the founding admin always gets the setup guide', async () => {
    expect((await getOnboarding(founder.headers)).mode).toBe('setup');
    setUpClub();
    expect((await getOnboarding(founder.headers)).mode).toBe('setup');
  });

  it('another admin helps with setup while it is unfinished, then gets the tour', async () => {
    const second = await loginAsBooker(t, { role: 'admin' });
    expect((await getOnboarding(second.headers)).mode).toBe('setup');
    setUpClub();
    expect((await getOnboarding(second.headers)).mode).toBe('tour');
  });

  it('bookers always get the welcome tour', async () => {
    const booker = await loginAsBooker(t, { role: 'booker' });
    expect((await getOnboarding(booker.headers)).mode).toBe('tour');
    setUpClub();
    expect((await getOnboarding(booker.headers)).mode).toBe('tour');
  });

  it('a demoted founder gets the tour (setup is an admin job)', () => {
    const notDone = { club: true, shows: false, comedians: false };
    expect(guideMode({ id: 1, role: 'booker' }, true, notDone)).toBe('tour');
    expect(guideMode({ id: 1, role: 'admin' }, false, notDone)).toBe('setup');
    expect(guideMode({ id: 1, role: 'admin' }, false, { club: true, shows: true, comedians: false })).toBe('setup');
    expect(guideMode({ id: 1, role: 'admin' }, false, { club: true, shows: true, comedians: true })).toBe('tour');
  });
});

describe('dismiss / resume / complete', () => {
  it('starts fresh: not dismissed, not completed', async () => {
    const o = await getOnboarding(founder.headers);
    expect(o.dismissedAt).toBeNull();
    expect(o.completedAt).toBeNull();
  });

  it('dismiss and resume are per booker and return the fresh state', async () => {
    const other = await loginAsBooker(t, { role: 'booker' });
    const dismissed = await post('dismiss', founder.headers);
    expect(dismissed.dismissedAt).toEqual(expect.any(Number));
    expect((await getOnboarding(founder.headers)).dismissedAt).toBe(dismissed.dismissedAt);
    expect((await getOnboarding(other.headers)).dismissedAt).toBeNull();

    const resumed = await post('resume', founder.headers);
    expect(resumed.dismissedAt).toBeNull();
    expect(resumed.completedAt).toBeNull();
  });

  it('complete keeps the first completion time, and resuming does not un-finish it', async () => {
    const first = await post('complete', founder.headers);
    expect(first.completedAt).toEqual(expect.any(Number));
    t.db.update(users).set({ guideCompletedAt: 1_000 }).where(eq(users.id, founder.user.id)).run();
    expect((await post('complete', founder.headers)).completedAt).toBe(1_000);

    await post('dismiss', founder.headers);
    const resumed = await post('resume', founder.headers);
    expect(resumed.completedAt).toBe(1_000);
    expect(resumed.dismissedAt).toBeNull();
  });

  it('ignores a request body', async () => {
    const res = await t.request('/api/onboarding/dismiss', { method: 'POST', headers: founder.headers, json: { anything: 1 } });
    expect(res.status).toBe(200);
  });
});
