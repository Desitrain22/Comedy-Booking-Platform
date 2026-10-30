import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createComedian } from '../test/helpers';
import { makeHostedTestApp, type HostedTestApp } from '../test/hosted';
import { backupJobKey, nightlyBackupJob, pruneBackups, runBackup } from './backups';
import { runPlatformTick } from './scheduler';
import { platformJobRuns } from './schema';

let h: HostedTestApp;
let backupsDir: string;

beforeEach(() => {
  h = makeHostedTestApp();
  backupsDir = mkdtempSync(path.join(os.tmpdir(), 'cbp-backups-'));
});

afterEach(() => h.close());

/** Rows in `table` of a backed-up SQLite file. */
function count(file: string, table: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const tick = (iso: string) =>
  runPlatformTick(h.platform, { now: new Date(iso), jobs: [nightlyBackupJob({ backupsDir })] });

describe('runBackup', () => {
  it('copies platform.db and every active and suspended club, not archived ones', async () => {
    const alpha = h.createClub({ slug: 'alpha' });
    createComedian(alpha.db, { email: 'one@x.test' });
    createComedian(alpha.db, { email: 'two@x.test' });
    const paused = h.createClub({ slug: 'paused', status: 'suspended' });
    const gone = h.createClub({ slug: 'gone', status: 'archived' });

    const result = await runBackup(h.platform, backupsDir, '2026-11-02');
    const dir = path.join(backupsDir, '2026-11-02');
    expect(result.dir).toBe(dir);
    expect(result.failed).toEqual([]);
    expect(result.clubs.sort()).toEqual([alpha.club.id, paused.club.id].sort());
    expect(count(path.join(dir, 'platform.db'), 'clubs')).toBe(3);
    expect(count(path.join(dir, 'clubs', `${alpha.club.id}.db`), 'comedians')).toBe(2);
    expect(existsSync(path.join(dir, 'clubs', `${paused.club.id}.db`))).toBe(true);
    expect(existsSync(path.join(dir, 'clubs', `${gone.club.id}.db`))).toBe(false);
    expect(readdirSync(path.join(dir, 'clubs')).some((f) => f.endsWith('.partial'))).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('keeps going when one club fails', async () => {
    const ok = h.createClub({ slug: 'okay' });
    const broken = h.createClub({ slug: 'broken' });
    // A folder where its copy should go: the rename onto it fails.
    mkdirSync(path.join(backupsDir, '2026-11-02', 'clubs', `${broken.club.id}.db`, 'in-the-way'), { recursive: true });

    const result = await runBackup(h.platform, backupsDir, '2026-11-02');
    expect(result.clubs).toEqual([ok.club.id]);
    expect(result.failed).toEqual([{ clubId: broken.club.id, error: expect.any(String) }]);
  });
});

describe('pruneBackups', () => {
  it('keeps the last 14 days and leaves other folders alone', () => {
    for (const day of ['2026-10-18', '2026-10-19', '2026-10-20', '2026-11-01', '2026-11-02', 'manual']) {
      mkdirSync(path.join(backupsDir, day));
    }
    expect(pruneBackups(backupsDir, '2026-11-02')).toEqual(['2026-10-18', '2026-10-19']);
    expect(readdirSync(backupsDir).sort()).toEqual(['2026-10-20', '2026-11-01', '2026-11-02', 'manual']);
  });

  it('is a no-op when the folder does not exist yet', () => {
    expect(pruneBackups(path.join(backupsDir, 'missing'), '2026-11-02')).toEqual([]);
  });
});

describe('nightly backup job', () => {
  it('waits for 03:30 UTC, then runs once per UTC date', async () => {
    h.createClub({ slug: 'alpha' });

    await tick('2026-11-02T03:29:00Z');
    expect(existsSync(path.join(backupsDir, '2026-11-02'))).toBe(false);

    await tick('2026-11-02T03:30:00Z');
    expect(existsSync(path.join(backupsDir, '2026-11-02', 'platform.db'))).toBe(true);

    await tick('2026-11-02T22:00:00Z');
    const keys = h.platform.db.select().from(platformJobRuns).all().map((r) => r.key);
    expect(keys.filter((k) => k.startsWith('backup:'))).toEqual([backupJobKey('2026-11-02')]);

    await tick('2026-11-03T09:00:00Z');
    expect(existsSync(path.join(backupsDir, '2026-11-03', 'platform.db'))).toBe(true);
  });

  it('catches up after a restart past 03:30 (the first tick of the day runs it)', async () => {
    h.createClub({ slug: 'alpha' });
    await tick('2026-11-02T14:12:00Z');
    expect(existsSync(path.join(backupsDir, '2026-11-02', 'platform.db'))).toBe(true);
  });
});
