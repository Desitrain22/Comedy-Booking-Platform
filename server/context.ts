/**
 * Hono environment types. Every router is `new Hono<AppEnv>()`; auth middleware
 * (`requireBooker`, `requireAdmin`, `requireComedian`) adds a typed `c.var.booker` /
 * `c.var.comedian` to the handlers that follow it in the same route definition.
 */
import type { MeBooker, MeComedian } from '../shared/types';
import type { Db } from './db/client';
import type { Platform } from './platform';
import type { Club } from './platform/schema';

/** The signed-in booker, as put on `c.var.booker` by requireBooker/requireAdmin. */
export type SessionBooker = MeBooker;
/** The signed-in comedian, as put on `c.var.comedian` by requireComedian. */
export type SessionComedian = MeComedian;

export interface AppVariables {
  /**
   * This request's club database. Single-club mode: the one database. Hosted mode: the club
   * whose subdomain this is (unset on the platform host, whose routes never read it).
   */
  db: Db;
  /** Hosted mode only (every host): the registry, platform mailer and limits. */
  platform?: Platform;
  /** Hosted mode, on an active club's host: its registry row. */
  club?: Club;
}

export interface AppEnv {
  Variables: AppVariables;
}

export interface BookerEnv {
  Variables: AppVariables & { booker: SessionBooker };
}

export interface ComedianEnv {
  Variables: AppVariables & { comedian: SessionComedian };
}
