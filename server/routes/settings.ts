/**
 * F6 Settings — feature-owned route module (placeholder from foundation).
 *
 * Mounted by server/app.ts at `/api`, so paths below are written without the prefix
 * (e.g. `/settings`). Attach auth per route — never `router.use('*', …)`:
 *
 *   settingsRoutes.get('/settings', requireBooker, (c) => { const db = c.var.db; const booker = c.var.booker; … });
 *
 * Endpoints (spec §6):
 *   GET/PUT /settings, POST /settings/test-email
 *   GET /email-log, GET /email-log/:id
 *   GET/POST /users, PATCH/DELETE /users/:id, POST /users/:id/resend-invite   (requireAdmin)
 *   GET /backup                                                              (requireAdmin)
 */
import { Hono } from 'hono';
import type { AppEnv } from '../context';

export const settingsRoutes = new Hono<AppEnv>();
