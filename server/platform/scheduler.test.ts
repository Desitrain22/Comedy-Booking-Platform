import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobRuns } from '../db/schema';
import type { Db } from '../db/client';
import { confirmationsJobKey } from '../services/scheduler';
import { createBooking, createComedian, createShow, emailsTo } from '../test/helpers';
import { makeHostedTestApp, type HostedTestApp } from '../test/hosted';
import { createHandoff } from './handoffs';
import {
  claimPlatformJob,
  createPlatformSchedulerState,
  handoffCleanupJob,
  runPlatformTick,
  startPlatformScheduler,
  type PlatformJob,
} from './scheduler';
import { createAdminSession, issueAdminCode } from './adminAuth';
import { adminLoginCodes, adminSessions, handoffs, platformJobRuns } from './schema';

/** Monday Nov 9 2026, 10 AM in New York: the default weekly send is due. */
const MON_1000 = new Date('2026-11-09T15:00:00Z');

let h: HostedTestApp;

beforeEach(() => {
  h = makeHostedTestApp();
});

afterEach(() => {
  vi.useRealTimers();
  h.close();
});

/** A comedian booked on Thursday of the week of Nov 9. */
function bookSomeone(db: Db, email: string) {
  const comedian = createComedian(db, { email });
  const show = createShow(db, { date: '2026-11-12', startMin: 1260 });
  createBooking(db, { showId: show.id, comedianId: comedian.id });
}

const keys = (db: Db) => db.select().from(jobRuns).all().map((r) => r.key);

describe('multi-club scheduler', () => {
  it("runs each active club's tick on its own database and skips suspended and archived clubs", async () => {
    const alpha = h.createClub({ slug: 'alpha' });
    const bravo = h.createClub({ slug: 'bravo' });
    const paused = h.createClub({ slug: 'paused' });
    const gone = h.createClub({ slug: 'gone' });
    for (const [club, email] of [
      [alpha, 'a@x.test'],
      [bravo, 'b@x.test'],
      [paused, 'p@x.test'],
      [gone, 'g@x.test'],
    ] as const) {
      bookSomeone(club.db, email);
    }
    h.platform.registry.setClubStatus(paused.club.id, 'suspended');
    h.platform.registry.setClubStatus(gone.club.id, 'archived');

    const result = await runPlatformTick(h.platform, { now: MON_1000 });
    expect(Object.keys(result.clubs).sort()).toEqual(['alpha', 'bravo']);
    expect(result.clubs.alpha).toMatchObject({ confirmations: { weekStart: '2026-11-09', sent: 1 } });
    expect(emailsTo(alpha.db, 'a@x.test')).toHaveLength(1);
    expect(emailsTo(bravo.db, 'b@x.test')).toHaveLength(1);
    expect(emailsTo(alpha.db, 'b@x.test')).toHaveLength(0);
    expect(emailsTo(paused.db, 'p@x.test')).toHaveLength(0);
    expect(keys(paused.db)).not.toContain(confirmationsJobKey('2026-11-09'));
  });

  it('keeps per-club state between ticks (cleanup once per club-local day)', async () => {
    h.createClub({ slug: 'alpha' });
    const state = createPlatformSchedulerState();
    const first = await runPlatformTick(h.platform, { now: MON_1000, state });
    expect(first.clubs.alpha).toMatchObject({ cleanup: expect.any(Object) });
    const second = await runPlatformTick(h.platform, { now: new Date(MON_1000.getTime() + 60_000), state });
    expect(second.clubs.alpha).toMatchObject({ cleanup: null });
    expect(state.clubs.size).toBe(1);

    // A club that stops being active is forgotten.
    h.platform.registry.setClubStatus(h.platform.registry.getClubBySlug('alpha')!.id, 'suspended');
    await runPlatformTick(h.platform, { now: MON_1000, state });
    expect(state.clubs.size).toBe(0);
  });

  it("one club's failure doesn't stop the others", async () => {
    const alpha = h.createClub({ slug: 'alpha' });
    const bravo = h.createClub({ slug: 'bravo' });
    bookSomeone(bravo.db, 'b@x.test');
    alpha.db.$client.exec('DROP TABLE job_runs');
    const result = await runPlatformTick(h.platform, { now: MON_1000 });
    expect(result.clubs.alpha).toMatchObject({ error: expect.stringContaining('job_runs') });
    expect(result.clubs.bravo).toMatchObject({ confirmations: { sent: 1 } });
  });

  it('runs platform jobs after the clubs, each in its own try/catch', async () => {
    h.createClub({ slug: 'alpha' });
    const order: string[] = [];
    const jobs: PlatformJob[] = [
      { name: 'boom', run: () => { order.push('boom'); throw new Error('disk full'); } },
      { name: 'after', run: async ({ now }) => { order.push(`after@${now.toISOString()}`); } },
    ];
    const result = await runPlatformTick(h.platform, { now: MON_1000, jobs });
    expect(order).toEqual(['boom', `after@${MON_1000.toISOString()}`]);
    expect(result.jobErrors).toEqual({ boom: 'disk full' });
  });

  it('claims platform job keys once', () => {
    expect(claimPlatformJob(h.platform, 'backup:2026-11-09')).toBe(true);
    expect(claimPlatformJob(h.platform, 'backup:2026-11-09')).toBe(false);
    expect(h.platform.db.select().from(platformJobRuns).all().map((r) => r.key)).toEqual(['backup:2026-11-09']);
  });

  it('cleans up stale handoffs daily (built-in job)', async () => {
    const { club, admin } = h.createClub({ slug: 'alpha' });
    const old = MON_1000.getTime() - 3 * 24 * 60 * 60_000;
    createHandoff(h.platform.db, club.id, admin.id, old);
    createHandoff(h.platform.db, club.id, admin.id, MON_1000.getTime());
    await runPlatformTick(h.platform, { now: MON_1000 });
    expect(h.platform.db.select().from(handoffs).all()).toHaveLength(1);
    // Once a day: a second run that day doesn't claim again.
    expect(claimPlatformJob(h.platform, 'handoff-cleanup:2026-11-09')).toBe(false);
    expect(handoffCleanupJob.name).toBe('handoff-cleanup');
  });

  it('cleans up expired owner-console sessions and dead sign-in codes in the same daily job', async () => {
    const day = 24 * 60 * 60_000;
    const now = MON_1000.getTime();
    const live = createAdminSession(h.platform.db, 'owner@platform.test', now);
    createAdminSession(h.platform.db, 'owner@platform.test', now - 8 * day); // 7-day session, expired
    issueAdminCode(h.platform.db, 'owner@platform.test', now - 2 * day); // expired a day+ ago
    issueAdminCode(h.platform.db, 'owner@platform.test', now); // still live
    await runPlatformTick(h.platform, { now: MON_1000 });
    expect(h.platform.db.select().from(adminSessions).all().map((r) => r.expiresAt)).toEqual([live.expiresAt]);
    expect(h.platform.db.select().from(adminLoginCodes).all()).toHaveLength(1);
  });

  it('startPlatformScheduler ticks on an interval and stops', async () => {
    vi.useFakeTimers();
    h.createClub({ slug: 'alpha' });
    const runs: number[] = [];
    const stop = startPlatformScheduler(h.platform, {
      intervalMs: 1000,
      jobs: [{ name: 'count', run: () => void runs.push(Date.now()) }],
    });
    await vi.advanceTimersByTimeAsync(1000); // the first pass after boot (1s)
    await vi.advanceTimersByTimeAsync(2000);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    stop();
    const count = runs.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs.length).toBe(count);
  });
});
