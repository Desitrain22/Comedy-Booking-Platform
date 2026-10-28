/**
 * Zod schemas shared by client and server. Reusable primitives first, then the request
 * bodies of foundation-owned endpoints. Features put their own request schemas in
 * `shared/api/<feature>.ts` and build on the primitives here.
 */
import { z } from 'zod';
import { isValidDate, isValidMonth, isValidTimeZone } from './time';
import { LOCATION_PALETTE } from './types';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Trimmed, lowercased, valid email. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `YYYY-MM-DD` that is a real calendar date. */
export const dateSchema = z.string().refine(isValidDate, 'Expected a date like 2026-11-08');

/** `YYYY-MM`. */
export const monthSchema = z.string().refine(isValidMonth, 'Expected a month like 2026-11');

/** Positive integer id; coerces strings (path/query params). */
export const idSchema = z.coerce.number().int().positive();

/** Integer minutes after local midnight. */
export const minutesSchema = z.number().int().min(0).max(2880);

/** `#rrggbb` */
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex color like #7c5cff');

export const timeZoneSchema = z.string().refine(isValidTimeZone, 'Unknown timezone');

export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(200);

/** Query-string boolean: "1"/"true" → true, "0"/"false"/missing → false. */
export const queryBooleanSchema = z
  .enum(['1', '0', 'true', 'false'])
  .optional()
  .transform((v) => v === '1' || v === 'true');

/** Comma-separated ids in a query string ("1,2,3") → number[]. Empty/missing → []. */
export const queryIdListSchema = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v) return [];
    const ids = v.split(',').map((s) => Number(s.trim()));
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      ctx.addIssue({ code: 'custom', message: 'Expected comma-separated ids' });
      return z.NEVER;
    }
    return ids;
  });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const requestCodeSchema = z.object({ email: emailSchema });
export type RequestCodeInput = z.infer<typeof requestCodeSchema>;

export const verifyCodeSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .transform((v) => v.replace(/\D/g, ''))
    .pipe(z.string().length(6, 'Enter the 6-digit code')),
});
export type VerifyCodeInput = z.input<typeof verifyCodeSchema>;

export const magicLinkSchema = z.object({ token: z.string().min(10).max(200) });

export const acceptInviteSchema = z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema,
  name: z.string().trim().min(1).max(100).optional(),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export const setupSchema = z.object({
  clubName: z.string().trim().min(1, 'Enter the club name').max(100),
  timezone: timeZoneSchema,
  appUrl: z.url().transform((v) => v.replace(/\/+$/, '')),
  admin: z.object({
    name: z.string().trim().min(1, 'Enter your name').max(100),
    email: emailSchema,
    password: passwordSchema,
  }),
  location: z.object({
    name: z.string().trim().min(1, 'Enter a location name').max(100),
    address: z.string().trim().max(200).default(''),
    color: hexColorSchema.default(LOCATION_PALETTE[0]),
  }),
});
export type SetupInput = z.input<typeof setupSchema>;

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export const createLocationSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  address: z.string().trim().max(200).default(''),
  /** Defaults to the next palette color. */
  color: hexColorSchema.optional(),
});
export type CreateLocationInput = z.input<typeof createLocationSchema>;

export const updateLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    address: z.string().trim().max(200),
    color: hexColorSchema,
    archived: z.boolean(),
  })
  .partial();
export type UpdateLocationInput = z.input<typeof updateLocationSchema>;

export const reorderLocationsSchema = z.object({
  ids: z.array(idSchema).min(1),
});
export type ReorderLocationsInput = z.input<typeof reorderLocationsSchema>;
