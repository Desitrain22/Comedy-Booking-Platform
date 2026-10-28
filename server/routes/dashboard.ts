/**
 * F5 Dashboard, availability requests, confirmations — feature-owned route module (placeholder from foundation).
 *
 * Mounted by server/app.ts at `/api`, so paths below are written without the prefix
 * (e.g. `/dashboard`). Attach auth per route — never `router.use('*', …)`:
 *
 *   dashboardRoutes.get('/dashboard', requireBooker, (c) => { const db = c.var.db; const booker = c.var.booker; … });
 *
 * Endpoints (spec §6):
 *   GET  /dashboard
 *   POST /confirmations/send
 *   POST /confirmations/resend
 *   POST /availability-requests
 *   GET  /availability-requests?month
 *   GET  /availability-requests/preview?month&message
 */
import { Hono } from 'hono';
import type { AppEnv } from '../context';

export const dashboardRoutes = new Hono<AppEnv>();
