/**
 * Comedian one-time sign-in codes: 6 digits, 10-minute expiry, stored hashed,
 * max 5 attempts per code, max 5 codes per comedian per 15 minutes. Only the newest code
 * works: asking for another one retires the older ones, so a guess is only ever checked
 * against one code. (The sign-in route also caps wrong guesses per email and per IP.)
 */
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { loginCodes } from '../db/schema';
import { randomDigits, safeEqualHex, sha256Hex } from './crypto';

const MINUTE = 60_000;
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * MINUTE;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RATE_LIMIT = 5;
export const CODE_RATE_WINDOW_MS = 15 * MINUTE;

function hashCode(comedianId: number, code: string): string {
  return sha256Hex(`${comedianId}:${code}`);
}

export type IssueCodeResult = { ok: true; code: string } | { ok: false; reason: 'rate_limited' };

export function issueLoginCode(db: DbOrTx, comedianId: number, now = Date.now()): IssueCodeResult {
  const recent = db
    .select({ id: loginCodes.id })
    .from(loginCodes)
    .where(and(eq(loginCodes.comedianId, comedianId), gt(loginCodes.createdAt, now - CODE_RATE_WINDOW_MS)))
    .all();
  if (recent.length >= CODE_RATE_LIMIT) return { ok: false, reason: 'rate_limited' };

  const code = randomDigits(CODE_LENGTH);
  // Retire older live codes (kept as rows so they still count towards the rate limit).
  db.update(loginCodes)
    .set({ expiresAt: now })
    .where(and(eq(loginCodes.comedianId, comedianId), isNull(loginCodes.consumedAt), gt(loginCodes.expiresAt, now)))
    .run();
  db.insert(loginCodes)
    .values({ comedianId, codeHash: hashCode(comedianId, code), expiresAt: now + CODE_TTL_MS, createdAt: now })
    .run();
  return { ok: true, code };
}

export type VerifyCodeResult = 'ok' | 'invalid' | 'too_many_attempts';

/**
 * Check a code against the comedian's live (unexpired, unconsumed) code — normally just
 * the newest one (see `issueLoginCode`). A wrong guess counts against every live code.
 */
export function verifyLoginCode(db: DbOrTx, comedianId: number, code: string, now = Date.now()): VerifyCodeResult {
  const live = db
    .select()
    .from(loginCodes)
    .where(
      and(eq(loginCodes.comedianId, comedianId), isNull(loginCodes.consumedAt), gt(loginCodes.expiresAt, now)),
    )
    .orderBy(desc(loginCodes.createdAt))
    .all();
  if (live.length === 0) return 'invalid';

  const usable = live.filter((row) => row.attempts < CODE_MAX_ATTEMPTS);
  if (usable.length === 0) return 'too_many_attempts';

  const hash = hashCode(comedianId, code);
  const match = usable.find((row) => safeEqualHex(row.codeHash, hash));
  if (match) {
    db.update(loginCodes)
      .set({ consumedAt: now })
      .where(and(eq(loginCodes.comedianId, comedianId), isNull(loginCodes.consumedAt)))
      .run();
    return 'ok';
  }

  for (const row of usable) {
    db.update(loginCodes).set({ attempts: row.attempts + 1 }).where(eq(loginCodes.id, row.id)).run();
  }
  return usable.every((row) => row.attempts + 1 >= CODE_MAX_ATTEMPTS) ? 'too_many_attempts' : 'invalid';
}

/** Remove every code for a comedian (e.g. their email changed: codes sent to the old one die). */
export function deleteLoginCodesFor(db: DbOrTx, comedianId: number): number {
  return db.delete(loginCodes).where(eq(loginCodes.comedianId, comedianId)).run().changes;
}

/** Remove codes that are expired or used (housekeeping for the scheduler). */
export function deleteStaleLoginCodes(db: DbOrTx, now = Date.now()): number {
  return db
    .delete(loginCodes)
    .where(or(lt(loginCodes.expiresAt, now - CODE_RATE_WINDOW_MS), lt(loginCodes.consumedAt, now - CODE_RATE_WINDOW_MS)))
    .run().changes;
}
