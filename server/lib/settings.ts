import { eq } from 'drizzle-orm';
import type { AvailabilityRange } from '../../shared/availability';
import { clubNightDate, todayInTz } from '../../shared/time';
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

/**
 * Hosted mode: each club database's address is fixed by its subdomain
 * (`<protocol>//<slug>.<domain>`), whatever its settings say. The registry pins it when it
 * opens the database (server/platform/registry.ts). Keyed by the db handle, so a transaction
 * handle falls back to settings.appUrl, which sign-up sets to the same address.
 */
const fixedAppUrls = new WeakMap<object, string>();

/** Pin this database's app URL (hosted mode). Pass null to unpin. */
export function setFixedAppUrl(db: DbOrTx, url: string | null): void {
  if (url) fixedAppUrls.set(db, url.replace(/\/+$/, ''));
  else fixedAppUrls.delete(db);
}

/** The pinned app URL for this database (hosted mode), or null. */
export function getFixedAppUrl(db: DbOrTx): string | null {
  return fixedAppUrls.get(db) ?? null;
}

/**
 * Base URL for links in emails: the pinned club address (hosted mode) → settings.appUrl →
 * APP_URL env → http://localhost:$PORT.
 */
export function getAppUrl(db: DbOrTx): string {
  const fixed = fixedAppUrls.get(db);
  if (fixed) return fixed;
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
