import { eq } from 'drizzle-orm';
import type { AvailabilityRange } from '../../shared/availability';
import { clubNightDate, todayInTz } from '../../shared/time';
import type { ClubInfo } from '../../shared/types';
import type { DbOrTx } from '../db/client';
import { settings, type Settings, type SettingsUpdate } from '../db/schema';
import { env } from '../env';
import { getClubHosting } from './hosting';

export type { Settings, SettingsUpdate };

/** The singleton settings row (created with defaults on first access). */
export function getSettings(db: DbOrTx): Settings {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (row) return row;
  db.insert(settings).values({ id: 1 }).onConflictDoNothing().run();
  return db.select().from(settings).where(eq(settings.id, 1)).get()!;
}

export function updateSettings(db: DbOrTx, patch: SettingsUpdate): Settings {
  getSettings(db);
  db.update(settings).set(patch).where(eq(settings.id, 1)).run();
  return getSettings(db);
}

export function isSetupComplete(db: DbOrTx): boolean {
  return getSettings(db).setupComplete;
}

/**
 * Base URL for links in emails: in hosted mode the club's own address
 * (`<protocol>//<slug>.<domain>`, server/lib/hosting.ts), whatever its settings say; else
 * settings.appUrl → APP_URL env → http://localhost:$PORT. (A hosted club's transaction handle
 * falls back to settings.appUrl, which sign-up sets to the same address.)
 */
export function getAppUrl(db: DbOrTx): string {
  const hosted = getClubHosting(db);
  if (hosted) return hosted.clubUrl;
  const fromSettings = getSettings(db).appUrl.trim();
  const base = fromSettings || env.appUrl || `http://localhost:${env.port}`;
  return base.replace(/\/+$/, '');
}

/** Absolute URL for an in-app path, e.g. absoluteUrl(db, '/portal') → https://club.example/portal */
export function absoluteUrl(db: DbOrTx, pathname: string): string {
  return `${getAppUrl(db)}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

export function getAllNightRange(s: Settings): AvailabilityRange {
  return { startMin: s.allNightStartMin, endMin: s.allNightEndMin };
}

/** Public club info (safe for any visitor). */
export function getClubInfo(db: DbOrTx): ClubInfo {
  const s = getSettings(db);
  return { name: s.clubName, timezone: s.timezone, allNight: getAllNightRange(s), allowDeclines: s.allowDeclines };
}

/**
 * Today's *calendar* date in the club timezone. Use for calendar logic: past-day locking,
 * availability editing, month defaults. For "tonight" and red status use `clubNight`.
 */
export function clubToday(db: DbOrTx, now: Date = new Date()): string {
  return todayInTz(getSettings(db).timezone, now);
}

/**
 * The club's current night (`clubNightDate`): yesterday's date until 6 AM club time, so a
 * 1 AM show is still "tonight". Pass it as `today` to `bookingStatus` and use it for
 * "tonight" lists.
 */
export function clubNight(db: DbOrTx, now: Date = new Date()): string {
  return clubNightDate(getSettings(db).timezone, now);
}
