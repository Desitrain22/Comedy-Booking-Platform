/**
 * Locations API (foundation-owned; F6 builds the Settings UI on top).
 *
 *   GET   /api/locations[?includeArchived=1]   Location[] ordered by sortOrder
 *   POST  /api/locations                       { name, address?, color? } → 201 Location
 *   PATCH /api/locations/:id                   { name?, address?, color?, archived? } → Location
 *   POST  /api/locations/reorder               { ids: number[] } → Location[] (all, incl. archived)
 */
import { asc, count, eq, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createLocationSchema,
  queryBooleanSchema,
  reorderLocationsSchema,
  updateLocationSchema,
} from '../../shared/schemas';
import { paletteColor, type Location } from '../../shared/types';
import { requireBooker } from '../auth/middleware';
import type { AppEnv } from '../context';
import type { DbOrTx } from '../db/client';
import { locations } from '../db/schema';
import { httpError, orNotFound, parseId } from '../lib/http';
import { validate } from '../lib/validate';

export const locationsRoutes = new Hono<AppEnv>();

export function listLocations(db: DbOrTx, options: { includeArchived?: boolean } = {}): Location[] {
  const rows = db.select().from(locations).orderBy(asc(locations.sortOrder), asc(locations.id)).all();
  return options.includeArchived ? rows : rows.filter((l) => !l.archived);
}

locationsRoutes.get(
  '/locations',
  requireBooker,
  validate('query', z.object({ includeArchived: queryBooleanSchema })),
  (c) => c.json(listLocations(c.var.db, c.req.valid('query'))),
);

locationsRoutes.post('/locations', requireBooker, validate('json', createLocationSchema), (c) => {
  const db = c.var.db;
  const input = c.req.valid('json');
  const stats = db.select({ total: count(), maxOrder: max(locations.sortOrder) }).from(locations).get();
  const location = db
    .insert(locations)
    .values({
      name: input.name,
      address: input.address,
      color: input.color ?? paletteColor(stats?.total ?? 0),
      sortOrder: (stats?.maxOrder ?? -1) + 1,
    })
    .returning()
    .get();
  return c.json(location satisfies Location, 201);
});

locationsRoutes.patch('/locations/:id', requireBooker, validate('json', updateLocationSchema), (c) => {
  const db = c.var.db;
  const id = parseId(c.req.param('id'));
  orNotFound(db.select({ id: locations.id }).from(locations).where(eq(locations.id, id)).get(), 'Location');
  const patch = c.req.valid('json');
  if (Object.keys(patch).length === 0) throw httpError(400, 'Nothing to update', 'validation_error');
  const location = db.update(locations).set(patch).where(eq(locations.id, id)).returning().get();
  return c.json(location satisfies Location);
});

locationsRoutes.post('/locations/reorder', requireBooker, validate('json', reorderLocationsSchema), (c) => {
  const db = c.var.db;
  const { ids } = c.req.valid('json');
  const known = new Set(db.select({ id: locations.id }).from(locations).all().map((l) => l.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw httpError(400, `Unknown location ids: ${unknown.join(', ')}`, 'validation_error');

  db.transaction((tx) => {
    // Listed ids first, in order; any unlisted locations keep their relative order after them.
    const unlisted = listLocations(tx, { includeArchived: true }).filter((l) => !ids.includes(l.id));
    [...ids, ...unlisted.map((l) => l.id)].forEach((id, index) => {
      tx.update(locations).set({ sortOrder: index }).where(eq(locations.id, id)).run();
    });
  });
  return c.json(listLocations(db, { includeArchived: true }));
});
