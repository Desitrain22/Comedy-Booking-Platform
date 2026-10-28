/**
 * First-run setup (foundation-owned). Only works while settings.setupComplete is false.
 *
 *   GET  /api/setup/status   { setupComplete }
 *   POST /api/setup          club + admin + first location → admin session
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setupSchema } from '../../shared/schemas';
import { hashPassword } from '../auth/password';
import { signIn } from '../auth/sessions';
import type { AppEnv } from '../context';
import { locations, users } from '../db/schema';
import { jsonError } from '../lib/http';
import { getSettings, updateSettings } from '../lib/settings';
import { validate } from '../lib/validate';

export const setupRoutes = new Hono<AppEnv>();

setupRoutes.get('/setup/status', (c) => c.json({ setupComplete: getSettings(c.var.db).setupComplete }));

setupRoutes.post('/setup', validate('json', setupSchema), async (c) => {
  const db = c.var.db;
  if (getSettings(db).setupComplete) {
    return jsonError(c, 409, 'This club is already set up', 'already_setup');
  }
  const input = c.req.valid('json');
  const passwordHash = await hashPassword(input.admin.password);

  const admin = db.transaction((tx) => {
    updateSettings(tx, {
      clubName: input.clubName,
      timezone: input.timezone,
      appUrl: input.appUrl,
      setupComplete: true,
    });
    tx.insert(locations)
      .values({ name: input.location.name, address: input.location.address, color: input.location.color, sortOrder: 0 })
      .run();
    // Re-running setup after a half-finished attempt reuses the same admin email.
    const existing = tx.select().from(users).where(eq(users.email, input.admin.email)).get();
    if (existing) {
      return tx
        .update(users)
        .set({ name: input.admin.name, passwordHash, role: 'admin', lastLoginAt: Date.now() })
        .where(eq(users.id, existing.id))
        .returning()
        .get();
    }
    return tx
      .insert(users)
      .values({
        email: input.admin.email,
        name: input.admin.name,
        passwordHash,
        role: 'admin',
        lastLoginAt: Date.now(),
      })
      .returning()
      .get();
  });

  signIn(c, db, 'booker', admin.id);
  return c.json({ booker: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } }, 201);
});
