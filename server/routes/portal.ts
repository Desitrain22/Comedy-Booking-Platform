/**
 * F4 Comedian portal API — feature-owned route module (placeholder from foundation).
 *
 * Mounted by server/app.ts at `/api`, so paths below are written without the prefix
 * (e.g. `/portal/me`). Attach auth per route — never `router.use('*', …)`:
 *
 *   portalRoutes.get('/portal/me', requireComedian, (c) => { const db = c.var.db; const comedian = c.var.comedian; … });
 *
 * Endpoints (spec §6):
 *   GET  /portal/me                          (requireComedian)
 *   GET  /portal/availability?month          (requireComedian)
 *   PUT  /portal/availability                (requireComedian)
 *   GET  /portal/spots                       (requireComedian)
 *   POST /portal/spots/confirm               (requireComedian)
 *   GET/PUT /portal/profile                  (requireComedian)
 *   GET/POST /portal/confirm/:token          (no session; token-based)
 */
import { Hono } from 'hono';
import type { AppEnv } from '../context';

export const portalRoutes = new Hono<AppEnv>();
