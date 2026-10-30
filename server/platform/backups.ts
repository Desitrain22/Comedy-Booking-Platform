/**
 * Nightly backups (hosted MVP spec §7), a platform job run by the hosted scheduler:
 *
 *   $BACKUPS_DIR/<YYYY-MM-DD>/platform.db
 *   $BACKUPS_DIR/<YYYY-MM-DD>/clubs/<club id>.db      every active and suspended club
 *
 * Once a day (UTC date) at or after 03:30 UTC, the first tick claims `backup:<date>` and copies
 * each database with SQLite's online backup, which is consistent while the app keeps writing.
 * Each file is written as `<name>.partial` and renamed when complete, so a crash never leaves
 * a half-written copy under a real name. Archived clubs are skipped (their file isn't changing
 * and stays on the volume, which Fly snapshots daily). Days older than `keepDays` are deleted.
 *
 * Restoring is in docs/DEPLOY.md → Backups.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { addDays, todayInTz } from '../../shared/time';
import { env } from '../env';
import type { Platform } from './index';
import { claimPlatformJob, type PlatformJob } from './scheduler';

/** Minutes after midnight UTC when the nightly backup becomes due (03:30). */
export const BACKUP_TIME_UTC_MIN = 3 * 60 + 30;
/** How many daily folders to keep. */
export const BACKUP_KEEP_DAYS = 14;

const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;

export function backupJobKey(date: string): string {
  return `backup:${date}`;
}

export interface BackupResult {
  date: string;
  dir: string;
  /** Club ids copied. */
  clubs: number[];
  /** Clubs that failed, with the error. */
  failed: { clubId: number; error: string }[];
  /** Total bytes written. */
  bytes: number;
  /** Day folders deleted by pruning. */
  pruned: string[];
}

async function copyDatabase(sqlite: Database.Database, file: string): Promise<number> {
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  await sqlite.backup(partial);
  renameSync(partial, file);
  return statSync(file).size;
}

/** Delete day folders older than `keepDays` before `today`. Returns the names deleted. */
export function pruneBackups(backupsDir: string, today: string, keepDays = BACKUP_KEEP_DAYS): string[] {
  let entries: string[];
  try {
    entries = readdirSync(backupsDir);
  } catch {
    return [];
  }
  const oldest = addDays(today, -(keepDays - 1));
  const pruned = entries.filter((name) => DAY_DIR.test(name) && name < oldest).sort();
  for (const name of pruned) rmSync(path.join(backupsDir, name), { recursive: true, force: true });
  return pruned;
}

/** Copy platform.db and every active and suspended club into `<backupsDir>/<date>/`, then prune. */
export async function runBackup(
  platform: Platform,
  backupsDir: string,
  date: string,
  keepDays = BACKUP_KEEP_DAYS,
): Promise<BackupResult> {
  const dir = path.join(backupsDir, date);
  mkdirSync(path.join(dir, 'clubs'), { recursive: true });
  const result: BackupResult = { date, dir, clubs: [], failed: [], bytes: 0, pruned: [] };

  result.bytes += await copyDatabase(platform.db.$client, path.join(dir, 'platform.db'));
  for (const club of platform.registry.listClubs({ status: ['active', 'suspended'] })) {
    try {
      const db = platform.registry.openClubDb(club);
      result.bytes += await copyDatabase(db.$client, path.join(dir, 'clubs', `${club.id}.db`));
      result.clubs.push(club.id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ clubId: club.id, error });
      if (!env.isTest) console.error(`[backup] club ${club.slug} (#${club.id}) failed: ${error}`);
    }
  }
  result.pruned = pruneBackups(backupsDir, date, keepDays);
  return result;
}

export interface NightlyBackupOptions {
  backupsDir: string;
  keepDays?: number;
}

/** The platform job: due daily at 03:30 UTC (or the first tick after), at most once per UTC date. */
export function nightlyBackupJob({ backupsDir, keepDays = BACKUP_KEEP_DAYS }: NightlyBackupOptions): PlatformJob {
  return {
    name: 'nightly-backup',
    async run({ platform, now }) {
      const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      if (minutes < BACKUP_TIME_UTC_MIN) return;
      const date = todayInTz('UTC', now);
      if (!claimPlatformJob(platform, backupJobKey(date), now.getTime())) return;
      const result = await runBackup(platform, backupsDir, date, keepDays);
      if (!env.isTest) {
        const mb = (result.bytes / 1024 / 1024).toFixed(1);
        const failed = result.failed.length ? `, ${result.failed.length} failed` : '';
        console.log(
          `[backup] ${date}: platform + ${result.clubs.length} clubs (${mb} MB) → ${result.dir}${failed}` +
            (result.pruned.length ? `; removed ${result.pruned.join(', ')}` : ''),
        );
      }
    },
  };
}
