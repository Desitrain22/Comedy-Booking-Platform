/**
 * Cookie sessions. Two independent cookies so a booker can test the portal in the same
 * browser: `cbp_booker` (30 days) and `cbp_comedian` (90 days). The cookie holds a random
 * token; the DB stores only its sha256.
 */
import { and, eq, lt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SessionKind } from '../../shared/types';
import type { DbOrTx } from '../db/client';
import { sessions } from '../db/schema';
import { getAppUrl } from '../lib/settings';
import { randomToken, sha256Hex } from './crypto';

const DAY = 86_400_000;

export const SESSION_COOKIES: Record<SessionKind, string> = {
  booker: 'cbp_booker',
  comedian: 'cbp_comedian',
};

export const SESSION_TTL_MS: Record<SessionKind, number> = {
  booker: 30 * DAY,
  comedian: 90 * DAY,
};

export interface NewSession {
  token: string;
  expiresAt: number;
}

export function createSession(db: DbOrTx, kind: SessionKind, subjectId: number): NewSession {
  const token = randomToken();
  const expiresAt = Date.now() + SESSION_TTL_MS[kind];
  db.insert(sessions).values({ id: sha256Hex(token), kind, subjectId, expiresAt }).run();
  return { token, expiresAt };
}

/** The subject id for a live session token of this kind, or null. */
export function findSessionSubject(db: DbOrTx, kind: SessionKind, token: string): number | null {
  const row = db
    .select({ subjectId: sessions.subjectId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.id, sha256Hex(token)), eq(sessions.kind, kind)))
    .get();
  if (!row || row.expiresAt <= Date.now()) return null;
  return row.subjectId;
}

export function deleteSession(db: DbOrTx, token: string): void {
  db.delete(sessions).where(eq(sessions.id, sha256Hex(token))).run();
}

/** Sign someone out everywhere (e.g. when a booker is removed or a comedian archived). */
export function deleteSessionsFor(db: DbOrTx, kind: SessionKind, subjectId: number): void {
  db.delete(sessions)
    .where(and(eq(sessions.kind, kind), eq(sessions.subjectId, subjectId)))
    .run();
}

export function deleteExpiredSessions(db: DbOrTx, now = Date.now()): number {
  return db.delete(sessions).where(lt(sessions.expiresAt, now)).run().changes;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function readSessionToken(c: Context, kind: SessionKind): string | undefined {
  return getCookie(c, SESSION_COOKIES[kind]) || undefined;
}

function isSecure(db: DbOrTx): boolean {
  return getAppUrl(db).startsWith('https://');
}

export function setSessionCookie(c: Context, db: DbOrTx, kind: SessionKind, session: NewSession): void {
  setCookie(c, SESSION_COOKIES[kind], session.token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecure(db),
    path: '/',
    expires: new Date(session.expiresAt),
    maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
  });
}

export function clearSessionCookie(c: Context, kind: SessionKind): void {
  deleteCookie(c, SESSION_COOKIES[kind], { path: '/' });
}

/** Create a session and set its cookie on the response. */
export function signIn(c: Context, db: DbOrTx, kind: SessionKind, subjectId: number): NewSession {
  const session = createSession(db, kind, subjectId);
  setSessionCookie(c, db, kind, session);
  return session;
}

/** Delete the current session of this kind (if any) and clear its cookie. */
export function signOut(c: Context, db: DbOrTx, kind: SessionKind): void {
  const token = readSessionToken(c, kind);
  if (token) deleteSession(db, token);
  clearSessionCookie(c, kind);
}
