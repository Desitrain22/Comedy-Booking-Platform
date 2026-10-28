/**
 * F3 Comedians, tags, notes — feature-owned route module (placeholder from foundation).
 *
 * Mounted by server/app.ts at `/api`, so paths below are written without the prefix
 * (e.g. `/comedians`). Attach auth per route — never `router.use('*', …)`:
 *
 *   comediansRoutes.get('/comedians', requireBooker, (c) => { const db = c.var.db; const booker = c.var.booker; … });
 *
 * Endpoints (spec §6):
 *   GET/POST /comedians, POST /comedians/bulk, POST /comedians/bulk-tag
 *   GET/PATCH /comedians/:id, PUT /comedians/:id/tags
 *   GET /comedians/:id/availability?month, GET /comedians/:id/bookings?upcoming=1
 *   GET /comedians/:id/card, POST /comedians/:id/send-login-link
 *   GET/POST /comedians/:id/notes, PATCH/DELETE /notes/:id
 *   GET/POST /tags, PATCH/DELETE /tags/:id
 */
import { Hono } from 'hono';
import type { AppEnv } from '../context';

export const comediansRoutes = new Hono<AppEnv>();
