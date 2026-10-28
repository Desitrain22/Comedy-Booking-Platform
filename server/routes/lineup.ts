/**
 * F2 Day view / lineup board — feature-owned route module (placeholder from foundation).
 *
 * Mounted by server/app.ts at `/api`, so paths below are written without the prefix
 * (e.g. `/days/:date`). Attach auth per route — never `router.use('*', …)`:
 *
 *   lineupRoutes.get('/days/:date', requireBooker, (c) => { const db = c.var.db; const booker = c.var.booker; … });
 *
 * Endpoints (spec §6):
 *   GET    /days/:date
 *   POST   /bookings
 *   PATCH  /bookings/:id
 *   DELETE /bookings/:id
 *   POST   /bookings/:id/confirm
 */
import { Hono } from 'hono';
import type { AppEnv } from '../context';

export const lineupRoutes = new Hono<AppEnv>();
