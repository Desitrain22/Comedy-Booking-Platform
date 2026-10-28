import { eq } from 'drizzle-orm';
import type { AvailabilityRange } from '../../shared/availability';
import { todayInTz } from '../../shared/time';
import type { ClubInfo } from '../../shared/types';
import type { DbOrTx } from '../db/client';
import { settings, type Settings, type SettingsUpdate } from '../db/schema';
import { env } from '../env';

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

/** Base URL for links in emails: settings.appUrl → APP_URL env → http://localhost:$PORT. */
export function getAppUrl(db: DbOrTx): string {
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
  return { name: s.clubName, timezone: s.timezone, allNight: getAllNightRange(s) };
}

/** Today's date in the club timezone. */
export function clubToday(db: DbOrTx, now: Date = new Date()): string {
  return todayInTz(getSettings(db).timezone, now);
}
