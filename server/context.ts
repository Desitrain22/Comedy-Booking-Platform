/**
 * Hono environment types. Every router is `new Hono<AppEnv>()`; auth middleware
 * (`requireBooker`, `requireAdmin`, `requireComedian`) adds a typed `c.var.booker` /
 * `c.var.comedian` to the handlers that follow it in the same route definition.
 */
import type { MeBooker, MeComedian } from '../shared/types';
import type { Db } from './db/client';

/** The signed-in booker, as put on `c.var.booker` by requireBooker/requireAdmin. */
export type SessionBooker = MeBooker;
/** The signed-in comedian, as put on `c.var.comedian` by requireComedian. */
export type SessionComedian = MeComedian;

export interface AppVariables {
  db: Db;
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
