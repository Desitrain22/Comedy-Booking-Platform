import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { z } from 'zod';

/**
 * zod validation middleware with the app's error shape. On failure responds
 * 400 `{ error, code: 'validation_error', issues: [{ path, message }] }`.
 *
 *   router.post('/things', requireBooker, validate('json', thingSchema), (c) => {
 *     const body = c.req.valid('json');
 *   });
 */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
      const first = issues[0];
      const error = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'Invalid request';
      return c.json({ error, code: 'validation_error', issues }, 400);
    }
  });
}
