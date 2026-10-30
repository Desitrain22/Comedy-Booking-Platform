/**
 * Emailed comedian links.
 * - Login (magic) links: `/portal/magic/:token`, valid 30 days, reusable in that window.
 * - Confirm links: `/portal/confirm/:token`, valid until 2 days after the week ends. Expired
 *   confirm tokens are kept another 30 days so an old link says "expired", not "invalid".
 * Only the sha256 of a token is stored.
 */
import { and, eq, gt, lt, ne, or } from 'drizzle-orm';
import { addDays, zonedTimeToUtc } from '../../shared/time';
import type { TokenPurpose } from '../../shared/types';
import type { DbOrTx } from '../db/client';
import { tokens, type Token } from '../db/schema';
import { absoluteUrl, getSettings } from '../lib/settings';
import { randomToken, sha256Hex } from './crypto';

const DAY = 86_400_000;
export const LOGIN_TOKEN_TTL_MS = 30 * DAY;
/** How long an expired confirm token is kept (so the portal can say the link expired). */
export const EXPIRED_CONFIRM_RETENTION_MS = 30 * DAY;
export const DEFAULT_PORTAL_PATH = '/portal';

/** Only same-app absolute paths are allowed as redirect targets. */
export function safeRedirectPath(value: string | null | undefined, fallback = DEFAULT_PORTAL_PATH): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}

function insertToken(
  db: DbOrTx,
  values: { comedianId: number; purpose: TokenPurpose; expiresAt: number; weekStart?: string; redirectTo?: string },
): string {
  const token = randomToken();
  db.insert(tokens)
    .values({
      tokenHash: sha256Hex(token),
      comedianId: values.comedianId,
      purpose: values.purpose,
      expiresAt: values.expiresAt,
      weekStart: values.weekStart ?? null,
      redirectTo: values.redirectTo ?? null,
    })
    .run();
  return token;
}

export interface LoginLinkOptions {
  /** In-app path to land on after sign-in, e.g. `/portal?month=2026-12`. Default `/portal`. */
  redirectTo?: string;
}

/** Absolute magic-link URL (`<appUrl>/portal/magic/<token>`) for emails. */
export function createLoginLink(db: DbOrTx, comedianId: number, options: LoginLinkOptions = {}): string {
  const token = insertToken(db, {
    comedianId,
    purpose: 'login',
    expiresAt: Date.now() + LOGIN_TOKEN_TTL_MS,
    redirectTo: safeRedirectPath(options.redirectTo),
  });
  return absoluteUrl(db, `/portal/magic/${token}`);
}

/** Expiry for a week's confirm link: midnight (club tz) at the start of the Wednesday after the week. */
export function confirmTokenExpiry(db: DbOrTx, weekStart: string): number {
  return zonedTimeToUtc(addDays(weekStart, 9), 0, getSettings(db).timezone);
}

/** Absolute confirm-link URL (`<appUrl>/portal/confirm/<token>`) for the weekly email. */
export function createConfirmLink(db: DbOrTx, comedianId: number, weekStart: string): string {
  const token = insertToken(db, {
    comedianId,
    purpose: 'confirm',
    weekStart,
    expiresAt: confirmTokenExpiry(db, weekStart),
  });
  return absoluteUrl(db, `/portal/confirm/${token}`);
}

/** The live (unexpired) token row of this purpose, or null. Does not mark it used. */
export function findValidToken(db: DbOrTx, token: string, purpose: TokenPurpose, now = Date.now()): Token | null {
  return (
    db
      .select()
      .from(tokens)
      .where(and(eq(tokens.tokenHash, sha256Hex(token)), eq(tokens.purpose, purpose), gt(tokens.expiresAt, now)))
      .get() ?? null
  );
}

export function touchToken(db: DbOrTx, tokenId: number, now = Date.now()): void {
  db.update(tokens).set({ lastUsedAt: now }).where(eq(tokens.id, tokenId)).run();
}

/** Validate a magic-link token and mark it used. Reusable until it expires. */
export function consumeLoginToken(
  db: DbOrTx,
  token: string,
): { comedianId: number; redirectTo: string } | null {
  const row = findValidToken(db, token, 'login');
  if (!row) return null;
  touchToken(db, row.id);
  return { comedianId: row.comedianId, redirectTo: safeRedirectPath(row.redirectTo) };
}

/** Resolve a confirm-link token (read-only) → comedian + week. Null when invalid/expired. */
export function findConfirmToken(
  db: DbOrTx,
  token: string,
): { tokenId: number; comedianId: number; weekStart: string } | null {
  const row = findValidToken(db, token, 'confirm');
  if (!row || !row.weekStart) return null;
  return { tokenId: row.id, comedianId: row.comedianId, weekStart: row.weekStart };
}

/**
 * Housekeeping: delete expired tokens. Confirm tokens stay `EXPIRED_CONFIRM_RETENTION_MS`
 * past their expiry (an old weekly email then answers 410 "expired", not 404 "invalid").
 */
export function deleteExpiredTokens(db: DbOrTx, now = Date.now()): number {
  return db
    .delete(tokens)
    .where(
      or(
        and(ne(tokens.purpose, 'confirm'), lt(tokens.expiresAt, now)),
        and(eq(tokens.purpose, 'confirm'), lt(tokens.expiresAt, now - EXPIRED_CONFIRM_RETENTION_MS)),
      ),
    )
    .run().changes;
}

/** Delete every emailed link (sign-in and confirm) for a comedian, e.g. when their email changes. */
export function deleteTokensFor(db: DbOrTx, comedianId: number): number {
  return db.delete(tokens).where(eq(tokens.comedianId, comedianId)).run().changes;
}
