/**
 * First-run setup (foundation-owned). Only works while settings.setupComplete is false.
 *
 *   GET  /api/setup/status   { setupComplete }
 *   POST /api/setup          club + admin + first location → admin session
 *
 * The work itself is server/services/setup.ts (hosted sign-up runs it too).
 */
import { Hono } from 'hono';
import { setupSchema } from '../../shared/schemas';
import { signIn } from '../auth/sessions';
import type { AppEnv } from '../context';
import { getSettings } from '../lib/settings';
import { validate } from '../lib/validate';
import { setUpClub } from '../services/setup';

export const setupRoutes = new Hono<AppEnv>();

setupRoutes.get('/setup/status', (c) => c.json({ setupComplete: getSettings(c.var.db).setupComplete }));

setupRoutes.post('/setup', validate('json', setupSchema), async (c) => {
  const db = c.var.db;
  const admin = await setUpClub(db, c.req.valid('json'));
  signIn(c, db, 'booker', admin.id);
  return c.json({ booker: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } }, 201);
});
