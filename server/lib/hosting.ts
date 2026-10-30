/**
 * Hosted mode, seen from a club database: which club it is and the platform it runs on.
 * The registry tags each club database when it opens it (server/platform/registry.ts);
 * a single-club database has no tag.
 *
 *   const hosting = getClubHosting(db);   // null in single-club mode
 *   if (hosting) hosting.hosted.dailyEmailCap …
 *
 * Club code should ask this rather than the global `env.hosted`: tests run hosted apps
 * (server/test/hosted.ts) without PLATFORM_URL in the environment. Keyed by the db handle; a
 * transaction handle (`tx`) has no tag, so read it from the outer `db`.
 */
import type { HostedEnv } from '../env';

export interface ClubHosting {
  hosted: HostedEnv;
  clubId: number;
  slug: string;
  /** `<protocol>//<slug>.<platformHost>`: the club's app URL (links in emails start with it). */
  clubUrl: string;
}

const hostings = new WeakMap<object, ClubHosting>();

/** Tag a club database as hosted (null untags it). */
export function setClubHosting(db: object, hosting: ClubHosting | null): void {
  if (hosting) hostings.set(db, { ...hosting, clubUrl: hosting.clubUrl.replace(/\/+$/, '') });
  else hostings.delete(db);
}

/** This club database's hosting, or null (single-club mode, or a transaction handle). */
export function getClubHosting(db: object): ClubHosting | null {
  return hostings.get(db) ?? null;
}
