/**
 * Sign-up handoff (hosted MVP spec §4). Sign-up happens on the platform host, but the new
 * booker's session cookie has to be set by the club's own host (cookies are host-only). The
 * platform creates a one-time token, the browser carries it to
 * `<clubUrl>/welcome#<token>` (a fragment never reaches a server log or a Referer), and the
 * club host redeems it for a booker session: `POST /api/auth/handoff`.
 *
 * Tokens are stored hashed, belong to one club, work once and expire after 2 minutes.
 */
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { randomToken, sha256Hex } from '../auth/crypto';
import type { PlatformDb } from './db';
import { handoffs } from './schema';

export const HANDOFF_TTL_MS = 2 * 60_000;

/** Create a handoff for `userId` in club `clubId`; returns the raw token (only ever in the URL fragment). */
export function createHandoff(db: PlatformDb, clubId: number, userId: number, now = Date.now()): string {
  const token = randomToken();
  db.insert(handoffs)
    .values({ tokenHash: sha256Hex(token), clubId, userId, expiresAt: now + HANDOFF_TTL_MS, createdAt: now })
    .run();
  return token;
}

/** `<clubUrl>/welcome#<token>` */
export function handoffUrl(clubUrl: string, token: string): string {
  return `${clubUrl}/welcome#${token}`;
}

/**
 * Use the token for club `clubId`: marks it used and returns the user id, or null when it is
 * unknown, for another club, already used or expired. Atomic: of two racing requests only
 * one gets the user. A token for another club is left as it was.
 */
export function redeemHandoff(db: PlatformDb, clubId: number, token: string, now = Date.now()): number | null {
  const row = db
    .update(handoffs)
    .set({ usedAt: now })
    .where(
      and(
        eq(handoffs.tokenHash, sha256Hex(token)),
        eq(handoffs.clubId, clubId),
        isNull(handoffs.usedAt),
        gt(handoffs.expiresAt, now),
      ),
    )
    .returning({ userId: handoffs.userId })
    .get();
  return row?.userId ?? null;
}

/** Delete handoffs that expired (or were used) more than a day ago. Returns how many. */
export function deleteStaleHandoffs(db: PlatformDb, now = Date.now()): number {
  const cutoff = now - 24 * 60 * 60_000;
  return db
    .delete(handoffs)
    .where(or(lt(handoffs.expiresAt, cutoff), and(isNotNull(handoffs.usedAt), lt(handoffs.usedAt, cutoff))))
    .run().changes;
}
