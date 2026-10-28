/**
 * F1 Shows & booker calendar — feature-owned route module (placeholder from foundation).
 *
 * Mounted by server/app.ts at `/api`, so paths below are written without the prefix
 * (e.g. `/shows`). Attach auth per route — never `router.use('*', …)`:
 *
 *   showsRoutes.get('/shows', requireBooker, (c) => { const db = c.var.db; const booker = c.var.booker; … });
 *
 * Endpoints (spec §6):
 *   GET    /shows?from&to[&locationIds]
 *   POST   /shows/bulk
 *   POST   /shows/copy-pattern
 *   GET    /shows/:id
 *   PATCH  /shows/:id
 *   DELETE /shows/:id
 */
import { Hono } from 'hono';
import type { AppEnv } from '../context';

export const showsRoutes = new Hono<AppEnv>();
