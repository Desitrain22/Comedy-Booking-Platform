/**
 * Auth middleware. Attach per route (routers are mounted at /api, so never use
 * `router.use('*', …)` — it would apply to every API route):
 *
 *   router.get('/shows', requireBooker, (c) => { c.var.booker.id … });
 *   router.delete('/users/:id', requireAdmin, …);
 *   router.get('/portal/me', requireComedian, (c) => { c.var.comedian.id … });
 *
 * Failures: 401 `{ code: 'unauthorized' }`, 403 `{ code: 'forbidden' }`.
 */
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, BookerEnv, ComedianEnv, SessionBooker, SessionComedian } from '../context';
import { comedians, users } from '../db/schema';
import { jsonError } from '../lib/http';
import { findSessionSubject, readSessionToken } from './sessions';

/** The signed-in booker for this request, or null (no 401). */
export function getSessionBooker<E extends AppEnv>(c: Context<E>): SessionBooker | null {
  const token = readSessionToken(c, 'booker');
  if (!token) return null;
  const db = c.var.db;
  const userId = findSessionSubject(db, 'booker', token);
  if (userId == null) return null;
  const user = db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user || !user.passwordHash) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/** The signed-in (non-archived) comedian for this request, or null (no 401). */
export function getSessionComedian<E extends AppEnv>(c: Context<E>): SessionComedian | null {
  const token = readSessionToken(c, 'comedian');
  if (!token) return null;
  const db = c.var.db;
  const comedianId = findSessionSubject(db, 'comedian', token);
  if (comedianId == null) return null;
  return (
    db
      .select({ id: comedians.id, email: comedians.email, name: comedians.name })
      .from(comedians)
      .where(and(eq(comedians.id, comedianId), eq(comedians.archived, false)))
      .get() ?? null
  );
}

export const requireBooker = createMiddleware<BookerEnv>(async (c, next) => {
  const booker = getSessionBooker(c);
  if (!booker) return jsonError(c, 401, 'Please sign in', 'unauthorized');
  c.set('booker', booker);
  await next();
});

export const requireAdmin = createMiddleware<BookerEnv>(async (c, next) => {
  const booker = getSessionBooker(c);
  if (!booker) return jsonError(c, 401, 'Please sign in', 'unauthorized');
  if (booker.role !== 'admin') return jsonError(c, 403, 'Only admins can do that', 'forbidden');
  c.set('booker', booker);
  await next();
});

export const requireComedian = createMiddleware<ComedianEnv>(async (c, next) => {
  const comedian = getSessionComedian(c);
  if (!comedian) return jsonError(c, 401, 'Please sign in', 'unauthorized');
  c.set('comedian', comedian);
  await next();
});
